import assert from "node:assert/strict";
import { test } from "node:test";

import type { Agent } from "../src/orca/agents";
import { agentBackground, agentKeyImage, COLORS, stateLabel, wrap } from "../src/render";

const agent = (over: Partial<Agent> = {}): Agent => ({
	key: "k", hostId: "h", worktreeId: "w", tabId: "t", kind: "chat", agentType: "claude", title: "Fix the <flaky> tests & ship",
	worktreeName: "API", state: "working", needsYou: false, interrupted: false, unread: true, updatedAt: 0, ...over,
});

test("wraps words into lines and marks cut text", () => {
	assert.deepEqual(wrap("one two three", 20, 2), ["one two three"]);
	assert.deepEqual(wrap("one two three four", 8, 2), ["one two", "three…"]);
	assert.deepEqual(wrap("supercalifragilistic", 6, 1), ["super…"]);
	assert.deepEqual(wrap("   ", 6, 2), []);
});

test("state labels", () => {
	assert.equal(stateLabel(agent({ state: "blocked", needsYou: true, toolName: "Bash" })), "Allow Bash?");
	assert.equal(stateLabel(agent({ state: "blocked", needsYou: true })), "Needs OK");
	assert.equal(stateLabel(agent({ state: "waiting", needsYou: true })), "Your turn");
	assert.equal(stateLabel(agent({ state: "done", interrupted: true })), "Stopped");
});

test("colours follow state, with a dim frame for pulsing", () => {
	assert.equal(agentBackground(agent()), COLORS.working);
	assert.equal(agentBackground(agent({ state: "waiting", needsYou: true })), COLORS.needsYou);
	assert.equal(agentBackground(agent({ state: "waiting", needsYou: true }), true), COLORS.needsYouDim);
	assert.equal(agentBackground(agent({ state: "done" })), COLORS.done);
	// Finished and already looked at: grey, labelled Checked.
	assert.equal(agentBackground(agent({ state: "done", unread: false })), COLORS.stopped);
	assert.equal(stateLabel(agent({ state: "done", unread: false })), "Checked");
});

test("key image is an escaped SVG data URL", () => {
	const url = agentKeyImage(agent(), false, "detailed");
	assert.ok(url.startsWith("data:image/svg+xml,"));
	const svg = decodeURIComponent(url.slice("data:image/svg+xml,".length));
	assert.ok(svg.includes("&#60;flaky&#62;"));
	assert.ok(!svg.includes("<flaky>"));
	assert.ok(svg.includes("API"));
});

test("long names shrink, then get cut", async () => {
	const { fitLine } = await import("../src/render");
	assert.deepEqual(fitLine("Acme-API", 19, 13), { text: "Acme-API", size: 19 });
	assert.equal(fitLine("WeatherStation-E290", 19, 13).size < 19, true);
	const cut = fitLine("an-extremely-long-worktree-name-here", 19, 13);
	assert.equal(cut.size, 13);
	assert.ok(cut.text.endsWith("…"));
});

test("approval keys say what they'd answer, and for whom", async () => {
	const { approvalKeyImage } = await import("../src/render");
	const svg = (url: string) => decodeURIComponent(url.slice("data:image/svg+xml,".length));
	const live = svg(approvalKeyImage({ choice: "allow", active: true, target: "Acme-API", toolName: "Bash" }, "detailed"));
	assert.ok(live.includes("Allow Bash") && live.includes("Acme-API") && live.includes(COLORS.done));
	const deny = svg(approvalKeyImage({ choice: "deny", active: true, target: "Acme-API" }, "detailed"));
	assert.ok(deny.includes("Deny") && deny.includes(COLORS.deny));
	const idle = svg(approvalKeyImage({ choice: "allow", active: false, target: "Acme-API", toolName: "Bash" }, "detailed"));
	assert.ok(idle.includes("nothing waiting") && !idle.includes("Allow Bash") && idle.includes(COLORS.empty));
});

test("large layout: big name, one-word state, dark text on amber", async () => {
	const { agentKeyImage, bigStateLabel, wrapName, nextKeyImage } = await import("../src/render");
	const svg = (url: string) => decodeURIComponent(url.slice("data:image/svg+xml,".length));
	assert.deepEqual(wrapName("billing-service-config", 10, 2), ["billing-", "service-…"]);
	assert.deepEqual(wrapName("Acme-API", 8, 1), ["Acme-API"]);
	assert.equal(bigStateLabel(agent({ state: "blocked", needsYou: true })), "ALLOW?");
	assert.equal(bigStateLabel(agent({ state: "done", unread: false })), "SEEN");
	const waiting = svg(agentKeyImage(agent({ state: "waiting", needsYou: true }), false, "large"));
	assert.ok(waiting.includes("YOUR GO") && waiting.includes("#111111") && !waiting.includes("Fix the"));
	const detailed = svg(agentKeyImage(agent(), false, "detailed"));
	assert.ok(detailed.includes("Fix the"));
	assert.ok(svg(nextKeyImage(3)).includes(">3<"));
});
