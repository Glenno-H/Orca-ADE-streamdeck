# Elgato Marketplace listing

Everything for the Maker Console submission ([submitting products](https://docs.elgato.com/maker-console/submitting-products)). Rebuild the images with `node --import tsx scripts/marketplace.ts`.

| Maker Console field | Use |
|---|---|
| Product file | `releases/au.gkw.orcadeck.streamDeckPlugin` (run `npm run pack` first) |
| Name (permanent) | **Orca ADE Plugin** |
| Organisation / author | **GKW** (matches the manifest `Author`) |
| Description (250–1,500 chars) | `description.txt` |
| Pricing | Free |
| Additional links | Setup guide and support: https://github.com/Glenno-H/Orca-ADE-streamdeck |
| App icon (288 × 288 PNG) | `app-icon.png` |
| Thumbnail (1920 × 960 PNG) | `thumbnail.png` |
| Gallery (3–10, 1920 × 960 PNG) | `gallery-1.png` … `gallery-4.png` |
| Release notes | `release-notes.txt` |

Notes for review:
- Windows only (manifest `OS`); requirements are stated in the description.
- No data is collected, so no privacy policy link is needed.
- AI use is declared in the description, as Elgato requires.
- Images are drawn by the plugin's own key renderer with made-up sample projects.
