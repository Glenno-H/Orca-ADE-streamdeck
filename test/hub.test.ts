import assert from "node:assert/strict";
import { test } from "node:test";

import { OrcaHub, type Rpc } from "../src/orca/hub";

type Call = { method: string; params: unknown; executionHost?: string };

function fakeRpc(handlers: Record<string, (params: unknown, host?: string) => unknown>): Rpc & { calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		async call<T>(method: string, params?: unknown, opts?: { executionHost?: string }): Promise<T> {
			calls.push({ method, params, executionHost: opts?.executionHost });
			const handler = handlers[method];
			if (!handler) throw new Error(`unexpected ${method}`);
			return handler(params, opts?.executionHost) as T;
		},
	};
}

const tabs = (state: string, id = "s1") => ({
	snapshots: [{ worktree: `repo::/srv/${id}`, tabs: [{ type: "agent-session", id: `agent-session:${id}`, title: id, sessionId: id, agent: "claude", isActive: true, chatStatus: { state, updatedAt: 1 } }] }],
});

test("lists agents from the desktop and every ready remote host", async () => {
	const rpc = fakeRpc({
		"status.get": () => ({ capabilities: ["mobile.desktop-relay.v1"] }),
		"mobileRelay.hosts.list": () => ({ hosts: [
			{ hostId: "runtime:gkw", label: "GKW-Dev", relay: "ready" },
			{ hostId: "runtime:old", label: "Old box", relay: "update-needed" },
		] }),
		"worktree.ps": (_p, host) => ({ worktrees: host ? [{ worktreeId: "repo::/srv/remote", displayName: "Remote WT" }] : [] }),
		"session.tabs.listAll": (_p, host) => (host === "runtime:gkw" ? tabs("blocked", "remote") : tabs("working", "local")),
	});
	const hub = new OrcaHub(rpc, { worktreeEvery: 1000 });
	let changes = 0;
	hub.onChange(() => changes++);
	await hub.refresh(1_000_000);
	assert.deepEqual(hub.hosts.map((h) => h.hostId), ["desktop", "runtime:gkw"]);
	assert.deepEqual(hub.agents.map((a) => [a.hostId, a.state, a.worktreeName]), [
		["runtime:gkw", "blocked", "Remote WT"],
		["desktop", "working", "local"],
	]);
	assert.equal(changes, 1);
	// Never asks the host that isn't ready.
	assert.ok(!rpc.calls.some((c) => c.executionHost === "runtime:old"));

	// A quiet second round (within the slow window) only re-reads tabs, and reports no change.
	rpc.calls.length = 0;
	await hub.refresh(1_000_500);
	assert.deepEqual(rpc.calls.map((c) => c.method).sort(), ["session.tabs.listAll", "session.tabs.listAll"]);
	assert.equal(changes, 1);
});

test("old desktops without relay support still show this PC's agents", async () => {
	const rpc = fakeRpc({
		"status.get": () => ({ capabilities: [] }),
		"worktree.ps": () => ({ worktrees: [] }),
		"session.tabs.listAll": () => tabs("waiting"),
	});
	const hub = new OrcaHub(rpc);
	await hub.refresh(1_000_000);
	assert.equal(hub.agents.length, 1);
	assert.ok(!rpc.calls.some((c) => c.method === "mobileRelay.hosts.list"));
});

test("a failing host keeps its last agents and reports the error", async () => {
	let fail = false;
	const rpc = fakeRpc({
		"status.get": () => ({ capabilities: [] }),
		"worktree.ps": () => ({ worktrees: [] }),
		"session.tabs.listAll": () => {
			if (fail) throw new Error("timeout");
			return tabs("working");
		},
	});
	const hub = new OrcaHub(rpc);
	await hub.refresh(1_000_000);
	fail = true;
	await hub.refresh(1_000_100);
	assert.equal(hub.agents.length, 1);
	assert.equal(hub.hostErrors.get("desktop"), "timeout");
});

test("reveal switches worktree then tab on the agent's own host, for every window", async () => {
	const rpc = fakeRpc({
		"status.get": () => ({ capabilities: ["mobile.desktop-relay.v1"] }),
		"mobileRelay.hosts.list": () => ({ hosts: [{ hostId: "runtime:gkw", label: "GKW-Dev", relay: "ready" }] }),
		"worktree.ps": () => ({ worktrees: [] }),
		"session.tabs.listAll": (_p, host) => (host ? tabs("blocked", "remote") : { snapshots: [] }),
		"worktree.activate": () => ({}),
		"session.tabs.activate": () => ({}),
	});
	const hub = new OrcaHub(rpc);
	await hub.refresh(1_000_000);
	rpc.calls.length = 0;
	await hub.reveal(hub.agents[0]!);
	assert.deepEqual(rpc.calls, [
		{ method: "worktree.activate", params: { worktree: "id:repo::/srv/remote", navigation: "all" }, executionHost: "runtime:gkw" },
		{ method: "session.tabs.activate", params: { worktree: "id:repo::/srv/remote", tabId: "agent-session:remote", navigation: "all" }, executionHost: "runtime:gkw" },
	]);
});

test("stop clears agents", async () => {
	const rpc = fakeRpc({ "status.get": () => ({}), "worktree.ps": () => ({}), "session.tabs.listAll": () => tabs("working") });
	const hub = new OrcaHub(rpc);
	await hub.refresh(1_000_000);
	hub.stop();
	assert.equal(hub.agents.length, 0);
});
