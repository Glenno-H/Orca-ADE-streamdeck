// Builds the plugin's static images (PNG, from inline SVG) and copies the settings-page library.
//   imgs/plugin/marketplace(.png, @2x)   256 / 512  (plugin icon in Stream Deck preferences)
//   imgs/plugin/category-icon            28 / 56
//   imgs/actions/<action>/icon           20 / 40
//   imgs/actions/<action>/key            72 / 144
// Run with: npm run assets
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import path from "node:path";

const SD = "au.gkw.orcadeck.sdPlugin";
const FONT = "assets/fonts/DejaVuSans-Bold.ttf";
const ACCENT = "#e08a00";
const BLUE = "#1e6fd9";
const KEY_BG = "#1b1e22";

// A stylised orca fin over a wave: the plugin mark. Drawn in a 100x100 box.
const mark = (fill) => `<path d="M30 70 C38 48 46 28 62 14 C60 34 64 52 74 70 Z" fill="${fill}"/>
<path d="M12 78 C24 70 36 70 50 78 C64 86 76 86 88 78" fill="none" stroke="${fill}" stroke-width="7" stroke-linecap="round"/>`;

const glyphs = {
	agent: (c) => `<rect x="14" y="14" width="72" height="72" rx="14" fill="none" stroke="${c}" stroke-width="8"/><circle cx="50" cy="50" r="15" fill="${c}"/>`,
	next: (c) => `<path d="M22 20 L58 50 L22 80 Z" fill="${c}"/><rect x="66" y="20" width="12" height="60" rx="3" fill="${c}"/>`,
	approve: (c) => `<path d="M18 52 L40 74 L84 28" fill="none" stroke="${c}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>`,
	deny: (c) => `<path d="M24 24 L76 76 M76 24 L24 76" fill="none" stroke="${c}" stroke-width="12" stroke-linecap="round"/>`,
	usage: (c) => `<rect x="14" y="56" width="16" height="30" rx="3" fill="${c}"/><rect x="42" y="38" width="16" height="48" rx="3" fill="${c}"/><rect x="70" y="16" width="16" height="70" rx="3" fill="${c}"/>`,
	show: (c) => `<rect x="12" y="20" width="76" height="60" rx="8" fill="none" stroke="${c}" stroke-width="8"/><rect x="12" y="20" width="76" height="16" fill="${c}"/>`,
};

function png(svgBody, size, background) {
	const bg = background ? `<rect width="100" height="100" fill="${background}"/>` : "";
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">${bg}${svgBody}</svg>`;
	return new Resvg(svg, { font: { fontFiles: [FONT], loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" } }).render().asPng();
}

function write(rel, data) {
	const file = path.join(SD, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data);
}

function pair(rel, body, size, background) {
	write(`${rel}.png`, png(body, size, background));
	write(`${rel}@2x.png`, png(body, size * 2, background));
}

// Plugin and category icons.
pair("imgs/plugin/marketplace", mark(ACCENT), 256, KEY_BG);
pair("imgs/plugin/category-icon", mark("#ffffff"), 28);

// Action list icons (white on transparent) and default key art.
const keyText = { agent: "Agent", next: "Next", show: "Orca", approve: "Allow", deny: "Deny", usage: "Usage" };
const keyColor = { agent: BLUE, approve: "#2e8b57", deny: "#c0392b" };
for (const [name, glyph] of Object.entries(glyphs)) {
	pair(`imgs/actions/${name}/icon`, glyph("#ffffff"), 20);
	// Next Waiting draws its own title ("2 waiting") at the bottom, so its art has no label.
	const body = name === "next"
		? `<g transform="translate(25 10) scale(0.5)">${glyph(ACCENT)}</g>`
		: `<g transform="translate(25 14) scale(0.5)">${glyph(keyColor[name] ?? ACCENT)}</g>` +
			`<text x="50" y="86" text-anchor="middle" font-family="DejaVu Sans" font-weight="700" font-size="15" fill="#ffffff">${keyText[name]}</text>`;
	pair(`imgs/actions/${name}/key`, body, 72, KEY_BG);
}

fs.copyFileSync("assets/sdpi-components.js", path.join(SD, "ui/sdpi-components.js"));
fs.copyFileSync("LICENSE", path.join(SD, "LICENSE.txt"));
if (fs.existsSync("NOTICE.md")) fs.copyFileSync("NOTICE.md", path.join(SD, "NOTICE.md"));
console.log("assets built");
