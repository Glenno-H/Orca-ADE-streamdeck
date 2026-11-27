import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type { Agent } from "../src/orca/agents";
import { chooseApprovalOptions, fetchPendingApproval, respondToApproval, type ApprovalRpc, type PendingApproval } from "../src/orca/approvals";
import { OrcaRpcError } from "../src/orca/connection";

type Call = { method: string; params: any; opts?: { executionHost?: string; timeoutMs?: number } };

function fakeRpc(handler: (method: string, params: any) => unknown): ApprovalRpc & { calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		async call<T>(method: string, params?: unknown, opts?: { executionHost?: string; timeoutMs?: number }): Promise<T> {
			calls.push({ method, params, opts });
			return (await handler(method, params)) as T;
		},
	};
}

const chat: Agent = {
	key: "k", hostId: "runtime:gkw", worktreeId: "w", tabId: "t", sessionId: "sess-1", kind: "chat", agentType: "claude",
	title: "t", worktreeName: "w", state: "blocked", needsYou: true, interrupted: false, updatedAt: 1,
};

// Option sets and approval body shape follow Orca's providers:
//   src/main/claude/structured/journal/claude-structured-prompt-items.ts (APPROVAL_OPTIONS, claudeApprovalItem)
//   src/main/codex/codex-structured-prompt-items.ts (APPROVAL_DECISION_LABELS)
// and the history page shape from src/shared/agent-session/agent-session-wire.ts (AgentSessionHistoryResult).
const CLAUDE_OPTIONS = [
	{ id: "allow", label: "Allow" },
	{ id: "allowForSession", label: "Allow for this session" },
	{ id: "deny", label: "Deny" },
];
const pendingRes = { state: "pending", selectedOptionId: null, resolvedBy: null, resolvedAt: null };

function approvalItem(over: Record<string, unknown> = {}, bodyOver: Record<string, unknown> = {}) {
	return {
		itemId: "claude-prompt:sess-1:tool-1", revision: 3, sequence: 12, observedAt: 1,
		body: { kind: "approval", title: "Allow Bash?", detail: "ls -la", options: CLAUDE_OPTIONS, resolution: { ...pendingRes }, ...bodyOver },
		...over,
	};
}
const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({
	ok: true,
	page: { sessionId: "sess-1", epoch: "e1", fence: 7, direction: "tail", items, removedItemIds: [], submissions: [], hasOlder: false, hasNewer: false, ...extra },
});
const message = { itemId: "m1", revision: 1, sequence: 1, observedAt: 1, body: { kind: "message", role: "assistant", text: "hi" } };

test("finds the pending approval with fence, revision and chosen options", async () => {
	const rpc = fakeRpc(() => page([message, approvalItem()], { actionablePromptIds: ["claude-prompt:sess-1:tool-1"] }));
	const p = await fetchPendingApproval(rpc, chat, "runtime:gkw");
	assert.deepEqual(p, {
		sessionId: "sess-1", itemId: "claude-prompt:sess-1:tool-1", expectedRevision: 3, fence: 7,
		toolName: "Bash", summary: "ls -la", allowOptionId: "allow", denyOptionId: "deny",
	});
	assert.equal(rpc.calls[0]!.method, "agentSession.history");
	assert.deepEqual(rpc.calls[0]!.params, { sessionId: "sess-1", direction: "tail", limit: 100 });
	assert.equal(rpc.calls[0]!.opts?.executionHost, "runtime:gkw");
});

test("returns null when nothing is pending, or it is resolved, not actionable or not a chat agent", async () => {
	assert.equal(await fetchPendingApproval(fakeRpc(() => page([message])), chat), null);
	const resolved = approvalItem({}, { resolution: { state: "resolved", selectedOptionId: "allow", resolvedBy: "x", resolvedAt: 2 } });
	assert.equal(await fetchPendingApproval(fakeRpc(() => page([resolved])), chat), null);
	assert.equal(await fetchPendingApproval(fakeRpc(() => page([approvalItem()], { actionablePromptIds: [] })), chat), null);
	assert.equal(await fetchPendingApproval(fakeRpc(() => page([approvalItem()], { fence: undefined })), chat), null);
	const rpc = fakeRpc(() => page([approvalItem()]));
	assert.equal(await fetchPendingApproval(rpc, { ...chat, kind: "terminal", sessionId: undefined }), null);
	assert.equal(rpc.calls.length, 0);
});

test("plan reviews and unknown subjects get no option ids", async () => {
	const plan = approvalItem({}, { subject: { kind: "plan", text: "do it" }, options: [{ id: "allow", label: "Approve plan" }, { id: "deny", label: "Keep planning" }] });
	const p = await fetchPendingApproval(fakeRpc(() => page([plan])), chat);
	assert.ok(p);
	assert.equal(p.allowOptionId, undefined);
	assert.equal(p.denyOptionId, undefined);
});

test("option choice never picks always/session options", () => {
	assert.deepEqual(chooseApprovalOptions(CLAUDE_OPTIONS), { allowOptionId: "allow", denyOptionId: "deny" });
	// Codex: accept / acceptForSession / decline / cancel
	assert.deepEqual(
		chooseApprovalOptions([
			{ id: "accept", label: "Allow" }, { id: "acceptForSession", label: "Allow for this session" },
			{ id: "decline", label: "Deny" }, { id: "cancel", label: "Stop" },
		]),
		{ allowOptionId: "accept", denyOptionId: "decline" },
	);
	// ACP agents pick their own ids and names
	assert.deepEqual(
		chooseApprovalOptions([{ id: "o1", label: "Allow always" }, { id: "o2", label: "Allow once" }, { id: "o3", label: "Reject" }]),
		{ allowOptionId: "o2", denyOptionId: "o3" },
	);
	// Only an "always" allow: refuse rather than pick it
	assert.deepEqual(chooseApprovalOptions([{ id: "allow_always", label: "Always allow" }, { id: "reject_once", label: "Reject" }]), { denyOptionId: "reject_once" });
	assert.deepEqual(chooseApprovalOptions([{ id: "x", label: "Do thing" }]), {});
	assert.deepEqual(chooseApprovalOptions([]), {});
});

const pending: PendingApproval = { sessionId: "sess-1", itemId: "claude-prompt:sess-1:tool-1", expectedRevision: 3, fence: 7, allowOptionId: "allow", denyOptionId: "deny" };

test("respond builds the phone's envelope and fingerprint", async () => {
	const rpc = fakeRpc(() => ({ ok: true, replayed: false, fence: 7, cursor: { epoch: "e1", sequence: 13 }, value: { itemId: pending.itemId, revision: 4, resolution: { state: "resolved" } } }));
	assert.equal(await respondToApproval(rpc, pending, "allow", "runtime:gkw"), "accepted");
	const call = rpc.calls[0]!;
	assert.equal(call.method, "agentSession.respondToApproval");
	assert.equal(call.opts?.executionHost, "runtime:gkw");
	const { envelope, ...fields } = call.params;
	assert.deepEqual(fields, { itemId: pending.itemId, expectedRevision: 3, optionId: "allow" });
	assert.equal(envelope.sessionId, "sess-1");
	assert.equal(envelope.expectedRuntimeFence, 7);
	assert.match(envelope.clientOperationId, /^\d{13}-[0-9a-f]{32}$/);
	// sha256 of Orca's canonical JSON (sorted keys) of { method, sessionId, fields }
	const canonical = `{"fields":{"expectedRevision":3,"itemId":"claude-prompt:sess-1:tool-1","optionId":"allow"},"method":"agentSession.respondTo:approval","sessionId":"sess-1"}`;
	assert.equal(envelope.payloadFingerprint, createHash("sha256").update(canonical).digest("hex"));
	assert.deepEqual(Object.keys(envelope).sort(), ["clientOperationId", "expectedRuntimeFence", "payloadFingerprint", "sessionId"]);
});

test("deny sends the deny option; a missing option is rejected without calling Orca", async () => {
	const rpc = fakeRpc(() => ({ ok: true }));
	await respondToApproval(rpc, pending, "deny");
	assert.equal(rpc.calls[0]!.params.optionId, "deny");
	assert.equal(rpc.calls[0]!.opts?.executionHost, undefined);
	const none = fakeRpc(() => ({ ok: true }));
	assert.equal(await respondToApproval(none, { ...pending, allowOptionId: undefined }, "allow"), "rejected");
	assert.equal(none.calls.length, 0);
});

test("maps refusals and errors", async () => {
	const refuse = (code: string) => respondToApproval(fakeRpc(() => ({ ok: false, refusal: { code, message: "m" } })), pending, "allow");
	assert.equal(await refuse("agent_session_item_revision_stale"), "stale");
	assert.equal(await refuse("agent_session_already_resolved"), "stale");
	assert.equal(await refuse("agent_session_checkpoint_stale"), "stale");
	assert.equal(await refuse("agent_session_operation_unknown"), "unknown");
	assert.equal(await refuse("agent_session_ownership_unknown"), "unknown");
	assert.equal(await refuse("structured_agent_session_unsupported"), "rejected");
	const thrown = (e: unknown) => respondToApproval(fakeRpc(() => { throw e; }), pending, "allow");
	assert.equal(await thrown(new OrcaRpcError("timeout", "t")), "unknown");
	assert.equal(await thrown(new OrcaRpcError("disconnected", "d")), "unknown");
	assert.equal(await thrown(new OrcaRpcError("not_connected", "n")), "rejected");
	assert.equal(await thrown(new OrcaRpcError("invalid_params", "bad")), "rejected");
	assert.equal(await thrown(new OrcaRpcError("agent_session_item_revision_stale", "stale", { refusal: { code: "agent_session_item_revision_stale" } })), "stale");
	assert.equal(await thrown(new Error("weird")), "unknown");
});
