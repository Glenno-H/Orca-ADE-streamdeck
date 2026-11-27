import assert from "node:assert/strict";
import { test } from "node:test";

import { agentForWorktree, agentsFromSnapshots, orderBoard, rankForAuto, worktreeNameFromId, type Agent } from "../src/orca/agents";

const chat = (id: string, state: string, updatedAt: number, extra: Record<string, unknown> = {}) => ({
	type: "agent-session",
	id: `agent-session:${id}`,
	title: `Chat ${id}`,
	sessionId: id,
	agent: "claude",
	isActive: false,
	chatStatus: { state, updatedAt, ...extra },
});

const snapshots = [
	{
		worktree: "repo1::/home/me/Projects/Alpha",
		tabs: [
			chat("a", "done", 100),
			chat("b", "blocked", 300),
			{ type: "terminal", id: "t1::leaf1", title: "bash", leafId: "leaf1", parentTabId: "t1", isActive: true }, // plain shell
			{ type: "terminal", id: "t2::leaf2", title: "claude", customTitle: "Fix tests", leafId: "leaf2", parentTabId: "t2", isActive: false, agentStatus: { state: "working", agentType: "claude", updatedAt: 400 } },
			{ type: "browser", id: "b1", title: "docs", isActive: false },
		],
	},
	{ worktree: "repo2::/home/me/Projects/Beta::workspace:xyz", tabs: [chat("c", "waiting", 200), chat("d", "nonsense", 1)] },
	{ worktree: "repo3::/gone", removed: true, tabs: [chat("e", "working", 1)] },
];

test("flattens snapshots into agents, skipping tabs with no agent", () => {
	const agents = agentsFromSnapshots("local", snapshots);
	assert.deepEqual(agents.map((a) => [a.tabId, a.state, a.kind, a.worktreeName]), [
		["agent-session:a", "done", "chat", "Alpha"],
		["agent-session:b", "blocked", "chat", "Alpha"],
		["t2::leaf2", "working", "terminal", "Alpha"],
		["agent-session:c", "waiting", "chat", "Beta"],
	]);
	const term = agents.find((a) => a.kind === "terminal")!;
	assert.equal(term.title, "Fix tests");
	assert.equal(term.leafId, "leaf2");
	assert.equal(agents.find((a) => a.tabId === "agent-session:b")!.sessionId, "b");
	assert.equal(agents.filter((a) => a.needsYou).length, 2);
});

test("survives junk input", () => {
	assert.deepEqual(agentsFromSnapshots("h", [{}, { worktree: 5 }, { worktree: "x", tabs: "no" }, { worktree: "x", tabs: [null, 3, {}] } as never]), []);
});

test("worktree names come from the folder", () => {
	assert.equal(worktreeNameFromId("r::/home/me/Projects/Acme/API"), "API");
	assert.equal(worktreeNameFromId("r::C:\\Users\\me\\code\\App::workspace:1"), "App");
	assert.equal(worktreeNameFromId("plain"), "plain");
});

test("auto order: needs-you (longest waiting first), then working, then newest done", () => {
	const agents = agentsFromSnapshots("local", snapshots);
	assert.deepEqual(rankForAuto(agents).map((a) => a.tabId), ["agent-session:c", "agent-session:b", "t2::leaf2", "agent-session:a"]);
});

const agent = (key: string, state: Agent["state"], updatedAt = 0): Agent => ({
	key, hostId: "h", worktreeId: key, tabId: key, kind: "chat", agentType: "claude", title: key, worktreeName: key,
	state, needsYou: state === "blocked" || state === "waiting", interrupted: false, unread: false, updatedAt,
});

test("the board has no gaps: when a job leaves, the rest slide up", () => {
	const first = orderBoard(rankForAuto([agent("A", "working", 3), agent("B", "working", 2), agent("C", "working", 1)]), []);
	assert.deepEqual(first.map((a) => a.key), ["A", "B", "C"]);
	// A finishes and leaves; B and C move up rather than leaving a hole.
	const second = orderBoard(rankForAuto([agent("B", "working", 9), agent("C", "working", 1)]), first.map((a) => a.key));
	assert.deepEqual(second.map((a) => a.key), ["B", "C"]);
});

test("jobs keep their place when their order would otherwise change", () => {
	// C becomes the most recently updated, but stays behind A and B; newcomers join at the end.
	const next = orderBoard(rankForAuto([agent("A", "working", 1), agent("B", "working", 2), agent("C", "working", 9), agent("D", "working", 5)]), ["A", "B", "C"]);
	assert.deepEqual(next.map((a) => a.key), ["A", "B", "C", "D"]);
});

test("a job that starts needing you moves to the front", () => {
	const next = orderBoard(rankForAuto([agent("A", "working", 1), agent("B", "working", 2), agent("C", "waiting", 3)]), ["A", "B", "C"]);
	assert.deepEqual(next.map((a) => a.key), ["C", "A", "B"]);
});

test("pinned agents are left off the board", () => {
	assert.deepEqual(orderBoard([agent("A", "working"), agent("B", "working")], [], new Set(["A"])).map((a) => a.key), ["B"]);
});

test("a pinned worktree shows its most urgent agent", () => {
	const agents = agentsFromSnapshots("local", snapshots);
	assert.equal(agentForWorktree(agents, "local", "repo1::/home/me/Projects/Alpha")?.tabId, "agent-session:b");
	assert.equal(agentForWorktree(agents, "local", "nope"), undefined);
});

test("worktree names and unread flags come from worktree.ps", async () => {
	const { worktreeInfoFromPs } = await import("../src/orca/agents");
	const info = worktreeInfoFromPs({ worktrees: [
		{ worktreeId: "repo2::/home/me/Projects/Beta::workspace:xyz", displayName: "Beta Workspace", unread: false },
		{ worktreeId: "repo1::/home/me/Projects/Alpha", displayName: "main", repo: "Alpha-Repo", isMainWorktree: true, unread: true },
		{ worktreeId: 1 }, null,
	] });
	assert.equal(info.size, 2);
	const agents = agentsFromSnapshots("local", snapshots, info);
	const c = agents.find((a) => a.tabId === "agent-session:c")!;
	assert.equal(c.worktreeName, "Beta Workspace");
	assert.equal(c.unread, false);
	// A main checkout is named after its repo, not "main".
	assert.equal(agents.find((a) => a.tabId === "agent-session:a")!.worktreeName, "Alpha-Repo");
	assert.equal(worktreeInfoFromPs(undefined).size, 0);
	// Without worktree.ps data, agents count as unread so nothing disappears early.
	assert.ok(agentsFromSnapshots("local", snapshots).every((a) => a.unread));
});

test("the board filter drops finished agents once you've checked them", async () => {
	const { filterForBoard } = await import("../src/orca/agents");
	const fresh = { ...agent("F", "done"), unread: true };
	const all = [agent("W", "waiting"), agent("B", "blocked"), agent("R", "working"), agent("D", "done"), fresh];
	assert.deepEqual(filterForBoard(all, undefined).map((a) => a.key), ["W", "B", "R", "F"]);
	assert.deepEqual(filterForBoard(all, "active").map((a) => a.key), ["W", "B", "R", "F"]);
	assert.deepEqual(filterForBoard(all, "waiting").map((a) => a.key), ["W", "B"]);
	assert.deepEqual(filterForBoard(all, "all").map((a) => a.key), ["W", "B", "R", "D", "F"]);
});

test("an unread worktree shows only its newest finished agent", async () => {
	const { filterForBoard } = await import("../src/orca/agents");
	const old = { ...agent("old", "done", 1), worktreeId: "wt", unread: true };
	const recent = { ...agent("recent", "done", 9), worktreeId: "wt", unread: true };
	const other = { ...agent("other", "done", 5), worktreeId: "wt2", unread: true };
	assert.deepEqual(filterForBoard([old, recent, other], "active").map((a) => a.key), ["recent", "other"]);
});
