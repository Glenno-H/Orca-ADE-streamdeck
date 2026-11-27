// Turns Orca's per-worktree tab snapshots (session.tabs.listAll / subscribeAll) into a flat list
// of agents, ranks them for Auto keys, and hands them out to keys without reshuffling.
// Pure functions only: nothing here talks to Orca or Stream Deck.

/** Orca's agent states. Terminal agents report working/blocked/waiting/done; chats the same set. */
export type AgentState = "working" | "blocked" | "waiting" | "done";

export type Agent = {
	/** Stable identity across polls: host + worktree + tab. */
	key: string;
	hostId: string;
	worktreeId: string;
	tabId: string;
	/** Terminal agents only: the split pane the agent runs in. */
	leafId?: string;
	/** Chat (agent-session) agents only. */
	sessionId?: string;
	kind: "terminal" | "chat";
	/** "claude", "codex", ... */
	agentType: string;
	title: string;
	worktreeName: string;
	state: AgentState;
	/** blocked (wants permission) or waiting (wants input). */
	needsYou: boolean;
	interrupted: boolean;
	/** False once you've looked at the agent's worktree in Orca since it last finished (Orca's "unread" dot). */
	unread: boolean;
	/** Tool the agent is asking to use, when Orca says (terminal agents). */
	toolName?: string;
	updatedAt: number;
};

// The parts of Orca's wire types we read. Everything is optional: old or new Orca versions may
// leave fields out, and unknown fields are ignored.
type WireStatus = {
	state?: unknown;
	interrupted?: unknown;
	updatedAt?: unknown;
	toolName?: unknown;
	agentType?: unknown;
};
type WireTab = {
	type?: unknown;
	id?: unknown;
	title?: unknown;
	customTitle?: unknown;
	generatedTitle?: unknown;
	leafId?: unknown;
	sessionId?: unknown;
	agent?: unknown;
	launchAgent?: unknown;
	agentStatus?: WireStatus | null;
	chatStatus?: WireStatus | null;
};
export type WireSnapshot = { worktree?: unknown; removed?: unknown; tabs?: unknown };

const STATES = new Set<AgentState>(["working", "blocked", "waiting", "done"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Orca worktree ids look like "<repoId>::<path>[::workspace:<id>]". The folder name is the friendly bit. */
export function worktreeNameFromId(worktreeId: string): string {
	const parts = worktreeId.split("::");
	const path = parts.length > 1 ? parts[1]! : worktreeId;
	const segments = path.split(/[\\/]/).filter(Boolean);
	return segments[segments.length - 1] ?? worktreeId;
}

export type WorktreeInfo = { name?: string; unread: boolean };

/**
 * Worktree id → name and unread flag, from a worktree.ps result. A repo's main checkout is named
 * after the repo (its display name is just the branch, e.g. "main"); other worktrees keep Orca's name.
 */
export function worktreeInfoFromPs(result: unknown): Map<string, WorktreeInfo> {
	const info = new Map<string, WorktreeInfo>();
	const rows = (result as { worktrees?: unknown })?.worktrees;
	if (!Array.isArray(rows)) return info;
	for (const row of rows as { worktreeId?: unknown; displayName?: unknown; repo?: unknown; isMainWorktree?: unknown; unread?: unknown }[]) {
		const id = str(row?.worktreeId);
		if (!id) continue;
		const name = (row.isMainWorktree === true ? str(row.repo) : undefined) ?? str(row.displayName);
		info.set(id, { name, unread: row.unread !== false });
	}
	return info;
}

/**
 * Flattens one host's snapshots into agents. Tabs without an agent status (plain shells, files,
 * browsers) are skipped. `names` optionally maps worktree id to a display name (from worktree.ps).
 */
export function agentsFromSnapshots(hostId: string, snapshots: readonly WireSnapshot[], worktrees?: ReadonlyMap<string, WorktreeInfo>): Agent[] {
	const agents: Agent[] = [];
	for (const snap of snapshots) {
		const worktreeId = str(snap.worktree);
		if (!worktreeId || snap.removed === true || !Array.isArray(snap.tabs)) continue;
		const info = worktrees?.get(worktreeId);
		const worktreeName = info?.name ?? worktreeNameFromId(worktreeId);
		for (const tab of snap.tabs as WireTab[]) {
			const tabId = str(tab?.id);
			if (!tabId) continue;
			const isChat = tab.type === "agent-session";
			const isTerminal = tab.type === "terminal";
			if (!isChat && !isTerminal) continue;
			const status = isChat ? tab.chatStatus : tab.agentStatus;
			const state = status?.state;
			if (!status || typeof state !== "string" || !STATES.has(state as AgentState)) continue;
			agents.push({
				key: `${hostId}|${worktreeId}|${tabId}`,
				hostId,
				worktreeId,
				tabId,
				leafId: isTerminal ? str(tab.leafId) : undefined,
				sessionId: isChat ? str(tab.sessionId) : undefined,
				kind: isChat ? "chat" : "terminal",
				agentType: str(tab.agent) ?? str(status.agentType) ?? str(tab.launchAgent) ?? "agent",
				title: str(tab.customTitle) ?? str(tab.generatedTitle) ?? str(tab.title) ?? "Agent",
				worktreeName,
				state: state as AgentState,
				needsYou: state === "blocked" || state === "waiting",
				interrupted: status.interrupted === true,
				// Unknown (no worktree.ps row yet) counts as unread, so nothing vanishes before it's known.
				unread: info?.unread ?? true,
				toolName: str(status.toolName),
				updatedAt: num(status.updatedAt),
			});
		}
	}
	return agents;
}

const rank = (a: Agent): number => (a.needsYou ? 0 : a.state === "working" ? 1 : 2);

/**
 * Order for Auto keys: agents that need you first (longest waiting first, so nobody starves),
 * then working ones, then finished ones (most recent first).
 */
export function rankForAuto(agents: readonly Agent[]): Agent[] {
	return [...agents].sort((a, b) => {
		const r = rank(a) - rank(b);
		if (r !== 0) return r;
		return rank(a) === 0 ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt;
	});
}

/**
 * Hands ranked agents to Auto keys. A key keeps its agent while that agent is still among the
 * ones that deserve a key, so keys don't jump around on every update; free keys take the
 * highest-ranked agents that aren't shown yet. `exclude` holds agents already on Pinned keys.
 * @param slots Auto key ids in reading order (device, row, column).
 */
export function assignAutoSlots(
	slots: readonly string[],
	ranked: readonly Agent[],
	previous: ReadonlyMap<string, string>,
	exclude: ReadonlySet<string> = new Set(),
): Map<string, Agent | undefined> {
	const candidates = ranked.filter((a) => !exclude.has(a.key));
	const deserving = candidates.slice(0, slots.length);
	const byKey = new Map(candidates.map((a) => [a.key, a]));
	const result = new Map<string, Agent | undefined>();
	const taken = new Set<string>();

	// A needs-you agent outranks a sticky finished one: let urgent agents bump stale keys.
	const deservingKeys = new Set(deserving.map((a) => a.key));
	for (const slot of slots) {
		const prevKey = previous.get(slot);
		const agent = prevKey ? byKey.get(prevKey) : undefined;
		if (agent && deservingKeys.has(agent.key)) {
			result.set(slot, agent);
			taken.add(agent.key);
		}
	}
	const queue = deserving.filter((a) => !taken.has(a.key));
	for (const slot of slots) {
		if (result.has(slot)) continue;
		const next = queue.shift();
		result.set(slot, next);
		if (next) taken.add(next.key);
	}
	return result;
}

/** The agent a Pinned key shows: the most urgent agent in that worktree. */
export function agentForWorktree(agents: readonly Agent[], hostId: string, worktreeId: string): Agent | undefined {
	return rankForAuto(agents.filter((a) => a.hostId === hostId && a.worktreeId === worktreeId))[0];
}

/** What the Auto-key board shows: only agents waiting on you; those plus working and unchecked finished ones; or everything. */
export type BoardShow = "waiting" | "active" | "all";

export function filterForBoard(agents: readonly Agent[], show: BoardShow | undefined): Agent[] {
	if (show === "all") return [...agents];
	if (show === "waiting") return agents.filter((a) => a.needsYou);
	// Default board: waiting, working, and finished jobs you haven't looked at yet. Orca's unread
	// flag is per worktree, so only that worktree's most recently finished agent stands for it.
	const newestDone = new Map<string, Agent>();
	for (const a of agents) {
		if (a.state !== "done" || !a.unread) continue;
		const at = `${a.hostId}|${a.worktreeId}`;
		const prev = newestDone.get(at);
		if (!prev || a.updatedAt > prev.updatedAt) newestDone.set(at, a);
	}
	return agents.filter((a) => a.needsYou || a.state === "working" || newestDone.get(`${a.hostId}|${a.worktreeId}`) === a);
}
