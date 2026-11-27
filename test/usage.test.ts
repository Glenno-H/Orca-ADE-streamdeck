import assert from "node:assert/strict";
import { test } from "node:test";

import { resetLabel, usageLevel, usageView } from "../src/orca/usage";

// Shape from a real accounts.list reply (values changed, personal fields removed).
const snapshot = {
	rateLimits: {
		claude: {
			provider: "claude", status: "ok", error: null, session: null,
			weekly: { usedPercent: 11, windowMinutes: 10080, resetsAt: 1796259600250, resetDescription: "Thu 1:00 AM" },
			fableWeekly: { usedPercent: 9, windowMinutes: 10080, resetsAt: 1796259600250, resetDescription: "Thu 1:00 AM" },
			monthly: null,
		},
		codex: {
			provider: "codex", status: "ok", error: null,
			session: { usedPercent: 74.6, windowMinutes: 300, resetsAt: 0, resetDescription: "3:40 PM" },
			weekly: { usedPercent: 2, windowMinutes: 10080, resetsAt: 1796123714000, resetDescription: "Tue 11:15 AM" },
		},
	},
};

test("shows the window closest to running out", () => {
	assert.deepEqual(usageView(snapshot, "claude"), { status: "ok", provider: "claude", usedPercent: 11, window: "week", resetsAt: 1796259600250, resetText: "Thu 1AM" });
	const codex = usageView(snapshot, "codex");
	assert.equal(codex.status, "ok");
	if (codex.status === "ok") {
		assert.equal(codex.usedPercent, 75);
		assert.equal(codex.window, "5h");
		assert.equal(codex.resetText, "3:40PM");
	}
});

test("unavailable providers say why", () => {
	assert.deepEqual(usageView({ rateLimits: { claude: { status: "unavailable", error: "Not signed in", session: null, weekly: null } } }, "claude"), { status: "unavailable", provider: "claude", reason: "Not signed in" });
	assert.deepEqual(usageView({}, "codex"), { status: "unavailable", provider: "codex", reason: "No data" });
	assert.deepEqual(usageView(undefined, "codex"), { status: "unavailable", provider: "codex", reason: "No data" });
});

test("reset label falls back to a countdown", () => {
	const now = 1_000_000_000_000;
	assert.equal(resetLabel({ resetsAt: now + 25 * 60_000 }, now), "in 25m");
	assert.equal(resetLabel({ resetsAt: now + 5 * 3_600_000 }, now), "in 5h");
	assert.equal(resetLabel({ resetsAt: now + 3 * 86_400_000 }, now), "in 3d");
	assert.equal(resetLabel({ resetsAt: now - 1 }, now), undefined);
});

test("colour levels", () => {
	assert.equal(usageLevel(69), "ok");
	assert.equal(usageLevel(70), "warn");
	assert.equal(usageLevel(90), "high");
});
