// Draws key images as SVG data URLs (Stream Deck's recommended format for images made at runtime).
import type { Agent } from "./orca/agents";
import { usageLevel, type UsageView } from "./orca/usage";

export const COLORS = {
	working: "#1e6fd9",
	needsYou: "#e08a00",
	needsYouDim: "#7a4b00",
	done: "#2e8b57",
	stopped: "#5a5f66",
	deny: "#c0392b",
	// Pure black: any grey glows on the backlit keys, so idle keys would look lit.
	empty: "#000000",
	offline: "#000000",
	text: "#ffffff",
	muted: "#c9ced6",
} as const;

const SIZE = 144;

function escapeXml(text: string): string {
	return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Splits `text` into at most `lines` lines of about `width` characters, ending with … if cut. */
export function wrap(text: string, width: number, lines: number): string[] {
	const words = text.split(/\s+/).filter(Boolean).map((w) => (w.length > width ? `${w.slice(0, width - 1)}…` : w));
	const out: string[] = [];
	let i = 0;
	while (i < words.length && out.length < lines) {
		let line = words[i++]!;
		while (i < words.length && `${line} ${words[i]}`.length <= width) line += ` ${words[i++]}`;
		out.push(line);
	}
	if (i < words.length && out.length > 0) {
		const last = out[out.length - 1]!;
		if (!last.endsWith("…")) out[out.length - 1] = `${last.length >= width ? last.slice(0, width - 1) : last}…`;
	}
	return out;
}

/** Bold text averages about 0.62em per character; keys are 144 px with a little margin. */
const charsThatFit = (size: number) => Math.floor(134 / (size * 0.62));

/** Shrinks one line of text from `max` down to `min` px to fit the key, then cuts it with …. */
export function fitLine(value: string, max: number, min: number): { text: string; size: number } {
	for (let size = max; size >= min; size--) if (value.length <= charsThatFit(size)) return { text: value, size };
	const room = charsThatFit(min);
	return { text: `${value.slice(0, room - 1)}…`, size: min };
}

function svgUrl(body: string, background: string): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
		`<rect width="${SIZE}" height="${SIZE}" fill="${background}"/>${body}</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function text(value: string, y: number, size: number, opts: { color?: string; weight?: number } = {}): string {
	return `<text x="72" y="${y}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${size}" ` +
		`font-weight="${opts.weight ?? 600}" fill="${opts.color ?? COLORS.text}">${escapeXml(value)}</text>`;
}

export function stateLabel(agent: Agent): string {
	if (agent.state === "blocked") return agent.toolName ? `Allow ${agent.toolName}?` : "Needs OK";
	if (agent.state === "waiting") return "Your turn";
	if (agent.state === "working") return "Working";
	if (agent.interrupted) return "Stopped";
	return agent.unread ? "Done" : "Checked";
}

export function agentBackground(agent: Agent, dim = false): string {
	if (agent.needsYou) return dim ? COLORS.needsYouDim : COLORS.needsYou;
	if (agent.state === "working") return COLORS.working;
	return agent.interrupted || !agent.unread ? COLORS.stopped : COLORS.done;
}

/**
 * Agent key: worktree name on top, the session title in the middle, state at the bottom.
 * `dim` draws the second frame of the "pulse" alert style.
 */
export type KeyTextSize = "large" | "detailed";

/** Dark text on the bright amber background reads far better than white. */
function textColorOn(background: string): string {
	return background === COLORS.needsYou ? "#111111" : COLORS.text;
}

/** Short, shouted state for the large layout. */
export function bigStateLabel(agent: Agent): string {
	if (agent.state === "blocked") return "ALLOW?";
	if (agent.state === "waiting") return "YOUR GO";
	if (agent.state === "working") return "WORKING";
	return agent.interrupted ? "STOPPED" : agent.unread ? "DONE" : "SEEN";
}

/**
 * Splits a name into at most `lines` lines of `width` characters, breaking after - _ . / or spaces
 * where it can, so "billing-service-config" becomes "billing-" / "service-…" rather than mid-word.
 */
export function wrapName(name: string, width: number, lines: number): string[] {
	const parts = name.match(/[^-_./ ]+[-_./ ]?|[-_./ ]/g) ?? [name];
	const out: string[] = [];
	let line = "";
	for (const part of parts) {
		if ((line + part).trimEnd().length <= width) {
			line += part;
			continue;
		}
		if (line) out.push(line.trimEnd());
		line = part;
		while (line.length > width) {
			out.push(line.slice(0, width));
			line = line.slice(width);
		}
	}
	if (line.trim()) out.push(line.trimEnd());
	if (out.length <= lines) return out;
	const kept = out.slice(0, lines);
	const last = kept[lines - 1]!;
	kept[lines - 1] = `${last.length >= width ? last.slice(0, width - 1) : last}…`;
	return kept;
}

/**
 * Large layout: just the worktree name (big, up to two lines) and a one-word state. The chat title
 * is left out; colour does most of the talking.
 */
/**
 * Large layout without the state word: colour alone tells the state, so the name and two lines of
 * the chat title get the whole key.
 */
function largeAgentKeyImageNoState(agent: Agent, dim: boolean): string {
	const background = agentBackground(agent, dim);
	const color = textColorOn(background);
	const oneLine = wrapName(agent.worktreeName, 8, 1);
	const fitsOne = oneLine.length === 1 && !oneLine[0]!.endsWith("…");
	const lines = fitsOne ? oneLine : wrapName(agent.worktreeName, 9, 2);
	const nameSize = fitsOne ? 28 : 23;
	const nameTop = fitsOne || lines.length === 1 ? 44 : 32;
	const name = lines.map((line, i) => text(line, nameTop + i * (nameSize + 4), nameSize, { color, weight: 800 })).join("");
	// Bold 19 px fits ~10 characters a line.
	const title = wrap(agent.title, 10, 2).map((line, i) => text(line, 104 + i * 24, 19, { color, weight: 700 })).join("");
	return svgUrl(name + title, background);
}

function largeAgentKeyImage(agent: Agent, dim: boolean): string {
	const background = agentBackground(agent, dim);
	const color = textColorOn(background);
	// Bold glyphs average ~0.6em: 26 px fits ~8-9 characters a line, 21 px ~10.
	const oneLine = wrapName(agent.worktreeName, 8, 1);
	const fitsOne = oneLine.length === 1 && !oneLine[0]!.endsWith("…");
	const lines = fitsOne ? oneLine : wrapName(agent.worktreeName, 10, 2);
	const size = fitsOne ? 26 : 20;
	const top = fitsOne || lines.length === 1 ? 36 : 26;
	const name = lines.map((line, i) => text(line, top + i * (size + 3), size, { color, weight: 800 })).join("");
	// The chat's own title tells apart several chats in one worktree.
	const title = fitLine(agent.title.replace(/\s+/g, " ").trim(), 16, 16);
	const titleLine = text(title.text, 84, title.size, { color, weight: 700 });
	const state = bigStateLabel(agent);
	const band = `<rect x="0" y="100" width="${SIZE}" height="44" fill="#000000" fill-opacity="0.32"/>`;
	return svgUrl(name + titleLine + band + text(state, 132, state.length > 7 ? 22 : 25, { weight: 800 }), background);
}

export function agentKeyImage(agent: Agent, dim = false, size: KeyTextSize = "large", showState = true): string {
	if (size === "large") return showState ? largeAgentKeyImage(agent, dim) : largeAgentKeyImageNoState(agent, dim);
	const name = fitLine(agent.worktreeName, 19, 13);
	const title = wrap(agent.title, 15, 3);
	const lines = title.map((line, i) => text(line, 62 + i * 21, 17, { weight: 500 })).join("");
	const body =
		text(name.text, 28, name.size, { weight: 700 }) +
		lines +
		`<rect x="0" y="114" width="${SIZE}" height="30" fill="#000000" fill-opacity="0.28"/>` +
		text(stateLabel(agent), 135, 18, { weight: 700 });
	return svgUrl(body, agentBackground(agent, dim));
}

export type ApprovalKeyView = {
	choice: "allow" | "deny";
	/** True when the target agent is waiting on a permission request this key can answer. */
	active: boolean;
	/** The agent the key would answer (the deck's last jump), shown so it's never a blind answer. */
	target?: string;
	toolName?: string;
};

/** Approve / Deny key: green or red while there's a request to answer, dim grey otherwise. */
export function approvalKeyImage(view: ApprovalKeyView, size: KeyTextSize = "large"): string {
	const allow = view.choice === "allow";
	const background = view.active ? (allow ? COLORS.done : COLORS.deny) : COLORS.empty;
	const color = view.active ? COLORS.text : COLORS.muted;
	if (size === "large") {
		// Big verb; the tool and whose request on the lines below.
		const verb = text(allow ? "ALLOW" : "DENY", 52, 32, { color, weight: 800 });
		const tool = view.active && view.toolName ? fitLine(view.toolName, 22, 16) : undefined;
		const target = view.target ? fitLine(view.target, 20, 15) : undefined;
		return svgUrl(
			verb +
				(tool ? text(tool.text, 86, tool.size, { color, weight: 700 }) : view.active ? "" : text("nothing", 86, 18, { color: COLORS.muted, weight: 600 })) +
				(target ? text(target.text, 124, target.size, { color, weight: 600 }) : ""),
			background,
		);
	}
	const verb = allow ? "Allow" : "Deny";
	const head = fitLine(view.active && view.toolName ? `${verb} ${view.toolName}` : verb, 24, 15);
	const target = view.target ? fitLine(view.target, 16, 12) : undefined;
	const body =
		text(head.text, 70, head.size, { color, weight: 700 }) +
		(target ? text(target.text, 104, target.size, { color, weight: 500 }) : "") +
		(view.active ? "" : text("nothing waiting", 132, 13, { color: COLORS.muted, weight: 400 }));
	return svgUrl(body, background);
}

/** A key with no agent to show (Auto key with nothing to fill it, or a pinned worktree that's quiet). */
export function emptyKeyImage(label = "No agent", size: KeyTextSize = "large"): string {
	if (!label) return svgUrl("", COLORS.empty);
	if (size === "detailed") return svgUrl(text(label, 80, 18, { color: COLORS.muted, weight: 500 }), COLORS.empty);
	const lines = wrapName(label, 9, 2);
	return svgUrl(lines.map((l, i) => text(l, (lines.length === 1 ? 82 : 66) + i * 30, 24, { color: COLORS.muted, weight: 700 })).join(""), COLORS.empty);
}

/** Next Waiting key: a big count of jobs waiting on you, amber when there are any. */
export function nextKeyImage(waiting: number | undefined): string {
	if (waiting === undefined) return svgUrl(text("NEXT", 82, 26, { color: COLORS.muted, weight: 800 }), COLORS.empty);
	if (waiting === 0) return svgUrl(text("0", 72, 54, { color: COLORS.muted, weight: 800 }) + text("waiting", 116, 22, { color: COLORS.muted, weight: 700 }), COLORS.empty);
	const color = textColorOn(COLORS.needsYou);
	return svgUrl(text(String(waiting), 74, 60, { color, weight: 800 }) + text("WAITING", 118, 24, { color, weight: 800 }), COLORS.needsYou);
}

/** Every key's look while the plugin can't reach Orca, or hasn't been paired yet. */
export function offlineKeyImage(label: string): string {
	const [first = "", second = ""] = wrap(label, 10, 2);
	return svgUrl(text(first, 66, 23, { color: COLORS.muted, weight: 700 }) + text(second, 96, 23, { color: COLORS.muted, weight: 700 }), COLORS.offline);
}

const USAGE_COLORS = { ok: COLORS.done, warn: COLORS.needsYou, high: COLORS.deny } as const;

/** Usage key: provider, big "% used" of the tightest limit, and which limit / when it resets. */
export function usageKeyImage(view: UsageView | undefined, size: KeyTextSize = "large"): string {
	const name = view?.provider === "codex" ? "CODEX" : "CLAUDE";
	if (!view || view.status !== "ok") {
		const why = wrapName(view?.status === "unavailable" ? view.reason : "…", 10, 2);
		return svgUrl(
			text(name, 44, 24, { color: COLORS.muted, weight: 800 }) +
				why.map((line, i) => text(line, 86 + i * 24, 20, { color: COLORS.muted, weight: 600 })).join(""),
			COLORS.empty,
		);
	}
	const background = USAGE_COLORS[usageLevel(view.usedPercent)];
	const color = textColorOn(background);
	const big = size === "large";
	const detail = view.usedPercent >= 100 && view.resetText ? `back ${view.resetText}` : `${view.window}${view.resetText ? ` · ${view.resetText}` : ""}`;
	const fit = fitLine(detail, big ? 19 : 16, 12);
	return svgUrl(
		text(name, 30, big ? 22 : 18, { color, weight: 800 }) +
			text(`${view.usedPercent}%`, big ? 88 : 84, (big ? 50 : 40) - (view.usedPercent >= 100 ? 10 : 0), { color, weight: 800 }) +
			text(fit.text, 128, fit.size, { color, weight: 700 }),
		background,
	);
}
