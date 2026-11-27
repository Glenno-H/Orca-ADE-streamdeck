// Builds the Elgato Marketplace listing images into marketplace/ from the plugin's own key
// renderer and made-up sample agents (never real project names).
//   app-icon.png        288 × 288   Marketplace app icon
//   thumbnail.png       1920 × 960  listing thumbnail
//   gallery-1..4.png    1920 × 960  gallery
// Run with: node --import tsx scripts/marketplace.ts
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";

import type { Agent } from "../src/orca/agents";
import { agentKeyImage, approvalKeyImage, emptyKeyImage, nextKeyImage, usageKeyImage } from "../src/render";

const OUT = "marketplace";
const FONT = "assets/fonts/DejaVuSans-Bold.ttf";
const BG = "#0e1116";
const ACCENT = "#e08a00";
const W = 1920;
const H = 960;

fs.mkdirSync(OUT, { recursive: true });

const resvgOpts = (width?: number) => ({
	font: { fontFiles: [FONT], loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" },
	...(width ? { fitTo: { mode: "width" as const, value: width } } : {}),
});

/** A key image (SVG data URL) rasterised at `px` and returned as a PNG data URL. */
function keyPng(url: string, px: number): string {
	const svg = decodeURIComponent(url.slice("data:image/svg+xml,".length));
	return `data:image/png;base64,${Buffer.from(new Resvg(svg, resvgOpts(px)).render().asPng()).toString("base64")}`;
}

function save(name: string, svg: string): void {
	fs.writeFileSync(`${OUT}/${name}`, new Resvg(svg, resvgOpts()).render().asPng());
	console.log(`${OUT}/${name}`);
}

const agent = (worktreeName: string, title: string, state: Agent["state"], extra: Partial<Agent> = {}): Agent => ({
	key: `${worktreeName}|${title}`, hostId: "h", worktreeId: worktreeName, tabId: title, kind: "chat", agentType: "claude",
	title, worktreeName, state, needsYou: state === "blocked" || state === "waiting", interrupted: false, unread: true, updatedAt: 0, ...extra,
});

const board: (Agent | undefined)[] = [
	agent("web-app", "Add dark mode toggle", "blocked"),
	agent("api", "Fix flaky login test", "waiting"),
	agent("billing", "Refactor invoice export", "working"),
	agent("docs-site", "Write release notes", "working"),
	agent("mobile-app", "Upgrade to Expo 55", "working"),
	agent("infra", "Rotate staging certs", "done"),
	agent("search", "Tune ranking weights", "done"),
];

/** Rounded key slot with an image inside, the way keys look on a deck. */
function key(x: number, y: number, size: number, url: string | undefined): string {
	const r = Math.round(size * 0.14);
	const id = `k${x}_${y}`;
	const img = url ? `<image x="${x}" y="${y}" width="${size}" height="${size}" href="${keyPng(url, size)}" clip-path="url(#${id})"/>` : "";
	return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}"/></clipPath>` +
		`<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="#000"/>` + img +
		`<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="none" stroke="#2b3038" stroke-width="3"/>`;
}

/** A 5 × 3 deck of keys: a dark plate with evenly spaced keys. */
function deck(x: number, y: number, size: number, keys: (string | undefined)[]): string {
	const gap = Math.round(size * 0.22);
	const pad = Math.round(size * 0.32);
	const w = 5 * size + 4 * gap + 2 * pad;
	const h = 3 * size + 2 * gap + 2 * pad;
	let out = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${pad}" fill="#181b21" stroke="#2b3038" stroke-width="4"/>`;
	keys.forEach((url, i) => {
		out += key(x + pad + (i % 5) * (size + gap), y + pad + Math.floor(i / 5) * (size + gap), size, url);
	});
	return out;
}

function headline(title: string, sub: string, x = 110, y = 170): string {
	return `<text x="${x}" y="${y}" font-family="DejaVu Sans" font-weight="700" font-size="76" fill="#ffffff">${title}</text>` +
		`<text x="${x}" y="${y + 70}" font-family="DejaVu Sans" font-weight="700" font-size="38" fill="#9aa3ad">${sub}</text>`;
}

const page = (body: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
	`<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#151a22"/><stop offset="1" stop-color="${BG}"/></linearGradient></defs>` +
	`<rect width="${W}" height="${H}" fill="url(#bg)"/>${body}</svg>`;

/** The plugin's mark: a fin over a wave (same shape as the plugin icon). */
const mark = (x: number, y: number, size: number, fill: string) =>
	`<g transform="translate(${x} ${y}) scale(${size / 100})"><path d="M30 70 C38 48 46 28 62 14 C60 34 64 52 74 70 Z" fill="${fill}"/>` +
	`<path d="M12 78 C24 70 36 70 50 78 C64 86 76 86 88 78" fill="none" stroke="${fill}" stroke-width="7" stroke-linecap="round"/></g>`;

const boardKeys = (size: "large" = "large", showState = true) => [
	...board.slice(0, 5).map((a) => (a ? agentKeyImage(a, false, size, showState) : undefined)),
	...board.slice(5).map((a) => (a ? agentKeyImage(a, false, size, showState) : undefined)),
	emptyKeyImage(""), emptyKeyImage(""), emptyKeyImage(""),
	nextKeyImage(2), approvalKeyImage({ choice: "allow", active: true, target: "web-app", toolName: "Bash" }), approvalKeyImage({ choice: "deny", active: true, target: "web-app" }),
	usageKeyImage({ status: "ok", provider: "claude", usedPercent: 42, window: "week", resetText: "Thu 1AM" }), emptyKeyImage(""),
];

// App icon: the mark on a dark tile.
save("app-icon.png", `<svg xmlns="http://www.w3.org/2000/svg" width="288" height="288"><rect width="288" height="288" rx="56" fill="#1b1e22"/>${mark(34, 30, 220, ACCENT)}</svg>`);

// Thumbnail: name and the board.
save("thumbnail.png", page(
	mark(110, 250, 150, ACCENT) +
	`<text x="110" y="500" font-family="DejaVu Sans" font-weight="700" font-size="92" fill="#ffffff">Orca ADE</text>` +
	`<text x="110" y="580" font-family="DejaVu Sans" font-weight="700" font-size="44" fill="#9aa3ad">Your agents on Stream Deck</text>` +
	deck(860, 170, 150, boardKeys()),
));

// 1: the live board.
save("gallery-1.png", page(headline("See who needs you", "Agents that need you come first. Press to jump there.") + deck(370, 330, 150, boardKeys())));

// 2: approve / deny.
const askKey = agentKeyImage(board[0]!, false, "large", true);
save("gallery-2.png", page(
	headline("Approve or deny from your desk", "Allow once or deny the agent's request, without the keyboard.") +
	key(470, 420, 260, askKey) +
	`<path d="M790 550 L900 550 M870 520 L900 550 L870 580" fill="none" stroke="#9aa3ad" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>` +
	key(960, 420, 260, approvalKeyImage({ choice: "allow", active: true, target: "web-app", toolName: "Bash" })) +
	key(1270, 420, 260, approvalKeyImage({ choice: "deny", active: true, target: "web-app" })),
));

// 3: big, readable keys.
const four = board.slice(0, 4).map((a) => a!);
save("gallery-3.png", page(
	headline("Big, easy-to-read keys", "Colour says the state. Show or hide the state word.") +
	four.map((a, i) => key(330 + i * 330, 340, 270, agentKeyImage(a, false, "large", false))).join(""),
));

// 4: usage and waiting count.
save("gallery-4.png", page(
	headline("Limits and queue at a glance", "Claude and Codex usage, and how many agents are waiting.") +
	key(330, 360, 270, usageKeyImage({ status: "ok", provider: "claude", usedPercent: 42, window: "week", resetText: "Thu 1AM" })) +
	key(660, 360, 270, usageKeyImage({ status: "ok", provider: "codex", usedPercent: 78, window: "5h", resetText: "3:40PM" })) +
	key(990, 360, 270, nextKeyImage(2)) +
	key(1320, 360, 270, agentKeyImage(board[1]!, false, "large", true)),
));
