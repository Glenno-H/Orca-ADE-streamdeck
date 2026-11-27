// Approve / deny a structured chat agent's pending permission request, the way Orca's phone app does.
//
// Reading (all UNARY, no subscription needed): `agentSession.history` { direction: "tail" } returns
//   - page.fence               -> the runtime fence the phone passes as envelope.expectedRuntimeFence
//   - page.items               -> journal rows; the pending approval is an item whose body.kind is
//                                 "approval" with resolution.state "pending" (itemId, revision, options[])
//   - page.actionablePromptIds -> the host's list of prompts a live agent can still answer (absent on
//                                 older hosts = no filter)
// The phone gets the same data from the `agentSession.subscribe` snapshot (plus an optional
// `currentRequests` marker that `agentSession.currentRequests` pages through). currentRequests alone
// can't be used: it needs the marker's `version` uuid, which only the stream carries. Without a marker
// the phone falls back to the pending rows in the loaded items, which is what we do. Limit: an approval
// that has scrolled out of the newest HISTORY_LIMIT rows is not seen (a fresh approval is newest).
//
// Answering is ONE unary call, `agentSession.respondToApproval`, mirroring mobile/src/session/
// use-mobile-structured-prompt-responses.ts + mobile-structured-agent-session-rpc.ts.
import { randomUUID } from "node:crypto";

import { OrcaRpcError } from "./connection";
import type { Agent } from "./agents";
import { createStructuredAgentSessionOperationId, structuredAgentSessionPayloadFingerprint } from "./vendor/structured-agent-session-fingerprint";

/** The slice of OrcaConnection this module needs (same as hub's `Rpc`). */
export interface ApprovalRpc {
	call<T = unknown>(method: string, params?: unknown, opts?: { executionHost?: string; timeoutMs?: number }): Promise<T>;
}

export type PendingApproval = {
	sessionId: string;
	itemId: string;
	/** The item's revision; sent as expectedRevision so a changed prompt is refused as stale. */
	expectedRevision: number;
	/** Runtime fence from the history page; sent as envelope.expectedRuntimeFence. */
	fence: number;
	toolName?: string;
	summary?: string;
	/** Option id of the allow-ONCE choice, if one clearly exists. */
	allowOptionId?: string;
	/** Option id of the deny/reject choice, if one clearly exists. */
	denyOptionId?: string;
};

export type ApprovalResult = "accepted" | "stale" | "unknown" | "rejected";

const HISTORY_LIMIT = 100;
const HISTORY_TIMEOUT_MS = 8000;
// The phone's STRUCTURED_SEND_TIMEOUT_MS.
const RESPOND_TIMEOUT_MS = 15_000;

type WireOption = { id?: unknown; label?: unknown };
type WireItem = {
	itemId?: unknown;
	revision?: unknown;
	sequence?: unknown;
	body?: {
		kind?: unknown;
		title?: unknown;
		displayName?: unknown;
		description?: unknown;
		detail?: unknown;
		blockedPath?: unknown;
		matchedAskRule?: { toolName?: unknown } | null;
		subject?: unknown;
		options?: unknown;
		resolution?: { state?: unknown } | null;
	};
};
type HistoryResult = { ok?: unknown; page?: { fence?: unknown; items?: unknown; actionablePromptIds?: unknown } };

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Finds the pending approval of a chat agent, or null when the agent isn't a chat agent, nothing is
 * pending, or the host can't take an answer (no fence). Orca errors (e.g. session gone) propagate.
 */
export async function fetchPendingApproval(rpc: ApprovalRpc, agent: Agent, executionHost?: string): Promise<PendingApproval | null> {
	if (agent.kind !== "chat" || !agent.sessionId) return null;
	const sessionId = agent.sessionId;
	const result = await rpc.call<HistoryResult>(
		"agentSession.history",
		{ sessionId, direction: "tail", limit: HISTORY_LIMIT },
		{ ...(executionHost ? { executionHost } : {}), timeoutMs: HISTORY_TIMEOUT_MS },
	);
	if (!result || result.ok !== true || !result.page) return null;
	const { fence, items, actionablePromptIds } = result.page;
	if (typeof fence !== "number" || !Number.isInteger(fence) || fence <= 0 || !Array.isArray(items)) return null;
	const actionable = Array.isArray(actionablePromptIds) ? (actionablePromptIds as unknown[]) : undefined;

	// Same selection as the phone's pendingStructuredSessionPrompts + actionableStructuredApproval: the
	// first pending approval the host calls actionable.
	for (const item of items as WireItem[]) {
		const body = item?.body;
		if (body?.kind !== "approval" || body.resolution?.state !== "pending") continue;
		if (!isStr(item.itemId) || typeof item.revision !== "number" || !Number.isInteger(item.revision) || item.revision <= 0) continue;
		if (actionable && !actionable.includes(item.itemId)) continue;
		const options = Array.isArray(body.options) ? (body.options as WireOption[]) : [];
		// Plan reviews and approval kinds this build doesn't know are never answered from a key.
		const keyable = body.subject === undefined || body.subject === null ? true : false;
		const choice = keyable ? chooseApprovalOptions(options) : {};
		const toolName = toolNameOf(body);
		const summary = [body.description, body.detail, body.blockedPath, body.title].find(isStr);
		return {
			sessionId,
			itemId: item.itemId,
			expectedRevision: item.revision,
			fence,
			...(toolName ? { toolName } : {}),
			...(summary ? { summary: summary.slice(0, 300) } : {}),
			...choice,
		};
	}
	return null;
}

function toolNameOf(body: NonNullable<WireItem["body"]>): string | undefined {
	if (isStr(body.displayName)) return body.displayName;
	if (isStr(body.matchedAskRule?.toolName)) return body.matchedAskRule.toolName;
	// Claude titles are "Allow <tool>?".
	const m = typeof body.title === "string" ? /^Allow (.+)\?$/.exec(body.title) : null;
	return m?.[1];
}

// Orca's approval options carry only { id, label, description? } (no "kind"), so they are recognised by
// id or label. Known providers: Claude  allow / allowForSession / deny; Codex  accept / acceptForSession /
// decline / cancel (labels Allow, Allow for this session, Deny, Stop); ACP agents choose their own ids
// and names (e.g. allow_once / allow_always / reject_once, "Allow once" / "Reject"); Pi yes / no.
const ALLOW_IDS = new Set(["allow", "accept", "allow_once", "allow-once", "allowonce", "yes"]);
const ALLOW_LABELS = new Set(["allow", "allow once", "approve", "yes"]);
const DENY_IDS = new Set(["deny", "decline", "reject", "reject_once", "reject-once", "rejectonce", "no"]);
const DENY_LABELS = new Set(["deny", "decline", "reject", "reject once", "no"]);
// Anything that grants more than this one call (or isn't a plain deny) is never picked.
const BROADER = /always|session|forever|persist|remember|don'?t ask|do not ask|every|all\b|stop|cancel|abort/i;

/**
 * Picks the allow-once and deny options. An option counts only if its id or label is an exact known
 * word (above) and neither id nor label mentions always/session/remember/stop/etc. When there is no
 * clear match the id stays undefined (the key must refuse), and when two options match the same
 * choice that choice is left undefined rather than guessed.
 */
export function chooseApprovalOptions(options: readonly WireOption[]): { allowOptionId?: string; denyOptionId?: string } {
	const rows = options.flatMap((o) => (isStr(o?.id) ? [{ id: o.id, label: typeof o.label === "string" ? o.label : "" }] : []));
	const pick = (ids: Set<string>, labels: Set<string>): string | undefined => {
		const hits = rows.filter((r) => !BROADER.test(r.id) && !BROADER.test(r.label) && (ids.has(r.id.toLowerCase()) || labels.has(r.label.trim().toLowerCase())));
		return hits.length === 1 ? hits[0]!.id : undefined;
	};
	const allowOptionId = pick(ALLOW_IDS, ALLOW_LABELS);
	const denyOptionId = pick(DENY_IDS, DENY_LABELS);
	return { ...(allowOptionId ? { allowOptionId } : {}), ...(denyOptionId ? { denyOptionId } : {}) };
}

const STALE_CODES = new Set(["agent_session_item_revision_stale", "agent_session_already_resolved", "agent_session_checkpoint_stale", "agent_session_conflict"]);
const UNKNOWN_CODES = new Set(["agent_session_operation_unknown", "agent_session_ownership_unknown", "execution_owner_reconciling"]);

function mapRefusalCode(code: unknown): ApprovalResult {
	if (typeof code === "string" && STALE_CODES.has(code)) return "stale";
	if (typeof code === "string" && UNKNOWN_CODES.has(code)) return "unknown";
	return "rejected";
}

/**
 * Sends the answer. `rejected` also covers "no matching option" and "never sent". `unknown` means a
 * request may have reached Orca without a confirmed reply (timeout/disconnect): don't retry, look at
 * the chat. `stale` means the prompt changed or was already answered (re-fetch).
 */
export async function respondToApproval(
	rpc: ApprovalRpc,
	pending: PendingApproval,
	choice: "allow" | "deny",
	executionHost?: string,
): Promise<ApprovalResult> {
	const optionId = choice === "allow" ? pending.allowOptionId : pending.denyOptionId;
	if (!optionId) return "rejected";
	// Exactly the phone's fields: the response target, which is also what the fingerprint covers.
	const fields = { itemId: pending.itemId, expectedRevision: pending.expectedRevision, optionId };
	const params = {
		envelope: {
			sessionId: pending.sessionId,
			clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
			expectedRuntimeFence: pending.fence,
			payloadFingerprint: structuredAgentSessionPayloadFingerprint({ method: "agentSession.respondTo:approval", sessionId: pending.sessionId, fields }),
		},
		...fields,
	};
	try {
		const result = await rpc.call<{ ok?: unknown; refusal?: { code?: unknown } }>("agentSession.respondToApproval", params, {
			...(executionHost ? { executionHost } : {}),
			timeoutMs: RESPOND_TIMEOUT_MS,
		});
		if (result?.ok === true) return "accepted";
		if (result?.ok === false) return mapRefusalCode(result.refusal?.code);
		return "unknown";
	} catch (error) {
		if (error instanceof OrcaRpcError) {
			// Never written to the socket.
			if (error.code === "not_connected") return "rejected";
			// Lost after sending: Orca may or may not have applied it.
			if (error.code === "timeout" || error.code === "disconnected" || error.code === "stopped") return "unknown";
			// The host answered with an error; a thrown refusal carries its reason in data.refusal.
			const refusal = (error.data as { refusal?: { code?: unknown } } | undefined)?.refusal;
			if (refusal) return mapRefusalCode(refusal.code);
			return "rejected";
		}
		return "unknown";
	}
}
