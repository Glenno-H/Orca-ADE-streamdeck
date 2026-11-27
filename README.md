# Orca ADE Plugin for Stream Deck

A Stream Deck plugin for [Orca](https://onorca.dev): see which of your agents need you at a glance,
and jump straight to them. Unofficial; not made by Stably.

**Status: 0.6.** Pairing, live agent keys and jumping are confirmed working on Windows (26 Nov
2026). Approve/Deny arrived in 0.2; the board filter in 0.3; large, easy-to-read keys in 0.4; the Usage key in 0.5.

## Keys

| Key | What it does |
|---|---|
| **Agent** | Shows one agent: worktree, title and state. Blue working, amber needs you, green finished (not looked at yet), grey checked or stopped. Press to jump to it in Orca. Set to **Auto** or **One worktree**. All Auto keys together form one live board with no gaps: agents that need you first, then the rest in a steady order; when a job leaves, the ones after it slide up. **Board shows** picks what fills it: waiting, working and finished-but-unchecked (default; a finished job drops off once you've looked at it in Orca, e.g. by pressing its key), only waiting on you, or everything. |
| **Next Waiting** | Shows, big, how many agents are waiting on you; each press jumps to the next one. |
| **Usage** | How much of your **Claude** or **Codex** limit is used (pick in its settings): the tightest of the 5-hour, weekly and Fable-weekly limits, and when it resets. Green under 70%, amber 70–89%, red 90%+. Read from the Orca app on this PC every minute, re-measured every 5 minutes; press to refresh now. |
| **Show Orca** | Brings the Orca window to the front. |
| **Approve** / **Deny** | Answer the permission request of the agent you **last jumped to from the deck** (its name is on the key). Approve allows once, never "always". Green/red while there's a request; dim otherwise. Before answering, the plugin re-checks that the same request is still waiting. Chat agents only for now. |

**Key text** (any key's settings): **Large** (default) shows a big worktree name, one line of the chat's title (so two chats in one worktree are told apart) and a one-word state (YOUR GO, ALLOW?, WORKING, DONE, SEEN), with dark text on amber for contrast. **State word → Hide** drops the state word and lets the colour say it, giving the name and two lines of chat title more room. **Detailed** is smaller and shows more of the chat title.

## How it connects

The plugin pairs with the Orca desktop app on the same PC **exactly like Orca's phone app**, and
sees every host that desktop is connected to (including remote Orca servers). Traffic is
end-to-end encrypted with Orca's own protocol; the pairing can be revoked in Orca at any time.
Like the phone app, it only works while the Orca desktop app is open.

## Install and pair (Windows)

1. Download [`releases/au.gkw.orcadeck.streamDeckPlugin`](releases/au.gkw.orcadeck.streamDeckPlugin) and double-click it. Stream Deck installs it.
2. Drag an **Agent** key onto your deck. It shows **Pair in settings**.
3. In Orca, open the phone pairing page (account / status menu → mobile), choose the **local
   network** option rather than Relay, and press **Copy code**.
4. In Stream Deck, click the Agent key. Paste the code into **Pairing code** and press **Pair**.
5. Within a few seconds the status line says **Connected · N agents** and the keys fill in.

Pair once: every key, page and profile shares the one pairing. If a phone is mid-pairing, finish
that first: each pairing code is for one device.

## Troubleshooting

- Logs: `%APPDATA%\Elgato\StreamDeck\Plugins\au.gkw.orcadeck.sdPlugin\logs\`. They list the hosts
  and agent counts it sees and any errors. They never contain the pairing code.
- **Orca not reachable**: is the Orca desktop app open? If Orca listens somewhere other than
  this PC, put its address in **Orca address**.
- **Pairing revoked**: pair again with a fresh code.

## Security

The pairing gives the plugin the same reach into Orca as a paired phone: it can see your agents
and answer their permission prompts. The code is stored in Stream Deck's
global plugin settings on this PC, never in key settings or profile exports.

## Develop

```
npm install
npm run check   # typecheck + tests
npm run pack    # builds dist/au.gkw.orcadeck.streamDeckPlugin
```

The connection tests can also run against Orca's own desktop-side encryption code: set
`ORCA_SRC` to a checkout of [stablyai/orca](https://github.com/stablyai/orca).

Parts of `src/orca/vendor/` are copied from Orca (MIT); see `NOTICE.md`. MIT licensed.
