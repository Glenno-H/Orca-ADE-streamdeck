// Turns Orca's accounts snapshot (accounts.list) into what a Usage key shows: the limit window
// closest to running out for one provider. Pure: no I/O.

export type UsageProvider = "claude" | "codex";

export type UsageView =
	| { status: "ok"; provider: UsageProvider; usedPercent: number; window: string; resetsAt?: number; resetText?: string }
	| { status: "unavailable"; provider: UsageProvider; reason: string };

type WireWindow = { usedPercent?: unknown; windowMinutes?: unknown; resetsAt?: unknown; resetDescription?: unknown } | null | undefined;
type WireLimits = { status?: unknown; error?: unknown; session?: WireWindow; weekly?: WireWindow; fableWeekly?: WireWindow; monthly?: WireWindow };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Orca's own reset wording ("Thu 1:00 AM") without the ":00", else a time worked out from resetsAt. */
export function resetLabel(window: WireWindow, now = Date.now()): string | undefined {
	const desc = typeof window?.resetDescription === "string" ? window.resetDescription.trim() : "";
	if (desc) return desc.replace(/:00(?=\s*[AP]M)/i, "").replace(/\s+(?=[AP]M)/i, "");
	const at = num(window?.resetsAt);
	if (!at || at <= now) return undefined;
	const mins = Math.round((at - now) / 60_000);
	if (mins < 60) return `in ${mins}m`;
	if (mins < 48 * 60) return `in ${Math.round(mins / 60)}h`;
	return `in ${Math.round(mins / 1440)}d`;
}

/** Picks the most-used window (5-hour session, week, Fable week, month) for `provider`. */
export function usageView(snapshot: unknown, provider: UsageProvider, now = Date.now()): UsageView {
	const limits = (snapshot as { rateLimits?: Record<string, WireLimits> } | undefined)?.rateLimits?.[provider];
	if (!limits) return { status: "unavailable", provider, reason: "No data" };
	const windows: [string, WireWindow][] = [
		["5h", limits.session],
		["week", limits.weekly],
		["Fable wk", limits.fableWeekly],
		["month", limits.monthly],
	];
	let best: { name: string; w: WireWindow; used: number } | undefined;
	for (const [name, w] of windows) {
		const used = num(w?.usedPercent);
		if (used === undefined) continue;
		if (!best || used > best.used) best = { name, w, used };
	}
	if (!best) {
		const reason = limits.status === "unavailable" ? "Not signed in" : typeof limits.error === "string" && limits.error ? "No reading" : "No data";
		return { status: "unavailable", provider, reason };
	}
	return {
		status: "ok",
		provider,
		usedPercent: Math.max(0, Math.min(100, Math.round(best.used))),
		window: best.name,
		resetsAt: num(best.w?.resetsAt),
		resetText: resetLabel(best.w, now),
	};
}

export type UsageLevel = "ok" | "warn" | "high";

export function usageLevel(usedPercent: number): UsageLevel {
	return usedPercent >= 90 ? "high" : usedPercent >= 70 ? "warn" : "ok";
}
