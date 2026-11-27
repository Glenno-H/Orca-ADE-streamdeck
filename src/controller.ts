// The one place that owns the Orca connection and decides what every key shows.
// Actions register their keys here and forward presses; nothing else talks to Orca.
import streamDeck, { type KeyAction } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { agentForWorktree, filterForBoard, orderBoard, type Agent, type BoardShow } from "./orca/agents";
import { OrcaConnection } from "./orca/connection";
import { fetchPendingApproval, respondToApproval, type PendingApproval } from "./orca/approvals";
import { CLIENT_CAPABILITIES, OrcaHub } from "./orca/hub";
import { parsePairingCode, type PairingOffer } from "./orca/pairing";
import { usageView, type UsageProvider } from "./orca/usage";
import { agentKeyImage, approvalKeyImage, emptyKeyImage, type KeyTextSize, nextKeyImage, offlineKeyImage, usageKeyImage } from "./render";
import { focusOrca } from "./win32";

export type AlertStyle = "key" | "pulse";
export type GlobalSettings = JsonObject & {
	/** The orca://pair code. It holds this plugin's device token: global settings only, never logged. */
	pairingCode?: string;
	/** Where to reach Orca. Blank: this PC, on the port from the pairing code. */
	address?: string;
	alertStyle?: AlertStyle;
	/** Which agents the Auto keys fill with. Default: waiting and working. */
	boardShow?: BoardShow;
	/** Large (default): big name and one-word state. Detailed: smaller text plus the chat title. */
	keyText?: KeyTextSize;
};
export type AgentSettings = JsonObject & {
	mode?: "auto" | "pinned";
	/** "<hostId>|<worktreeId>" for Pinned keys. */
	pin?: string;
	pinLabel?: string;
};

type Status = "unpaired" | "connecting" | "connected" | "offline" | "unauthorized";

const STATUS_LABEL: Record<Exclude<Status, "connected">, string> = {
	unpaired: "Pair in settings",
	connecting: "Connecting…",
	offline: "Orca not reachable",
	unauthorized: "Pairing revoked",
};

const PULSE_MS = 700;

type AgentKey = { action: KeyAction<AgentSettings>; settings: AgentSettings };
type PlainKey = { action: KeyAction<JsonObject>; label: string };
export type ApprovalChoice = "allow" | "deny";
type ApprovalKey = { action: KeyAction<JsonObject>; choice: ApprovalChoice };
export type UsageSettings = JsonObject & { provider?: UsageProvider };
type UsageKey = { action: KeyAction<UsageSettings>; provider: UsageProvider };

/** Usage is read from the paired desktop every minute, asking it to re-measure every 5 minutes. */
const USAGE_POLL_MS = 60_000;
const USAGE_REFRESH_MS = 5 * 60_000;

/** Loopback on the offer's port: the plugin runs on the same PC as Orca. */
export function endpointFor(offer: PairingOffer, address: string | undefined): string {
	const typed = address?.trim();
	if (typed) return /^wss?:\/\//.test(typed) ? typed : `ws://${typed.includes(":") ? typed : `${typed}:${portOf(offer.endpoint)}`}`;
	return `ws://127.0.0.1:${portOf(offer.endpoint)}`;
}

function portOf(endpoint: string): string {
	try {
		return new URL(endpoint).port || "6768";
	} catch {
		return "6768";
	}
}

/** Reading order across devices: device, then row, then column. */
function readingOrder(a: KeyAction<AgentSettings>, b: KeyAction<AgentSettings>): number {
	const ca = a.coordinates ?? { row: 99, column: 99 };
	const cb = b.coordinates ?? { row: 99, column: 99 };
	return a.device.id.localeCompare(b.device.id) || ca.row - cb.row || ca.column - cb.column;
}

class Controller {
	#settings: GlobalSettings = {};
	#conn: OrcaConnection | undefined;
	#hub: OrcaHub | undefined;
	#status: Status = "unpaired";
	#agentKeys = new Map<string, AgentKey>();
	#plainKeys = new Map<string, PlainKey>();
	#approvalKeys = new Map<string, ApprovalKey>();
	#usageKeys = new Map<string, UsageKey>();
	#accounts: unknown;
	#usageTimer: ReturnType<typeof setTimeout> | undefined;
	#usageRefreshedAt = 0;
	#usageLoading = false;
	/** The permission request the Approve/Deny keys are showing, for the deck's last-jumped agent. */
	#pending: PendingApproval | null = null;
	#pendingLoading = false;
	#pendingAgain = false;
	/** Agent keys in the order the Auto board showed them last time (keeps jobs from jumping around). */
	#boardOrder: string[] = [];
	#shown = new Map<string, Agent | undefined>();
	/** Last image sent per key, so pulses and polls only redraw keys that changed. */
	#lastImage = new Map<string, string>();
	#pulseOn = false;
	#pulseTimer: ReturnType<typeof setInterval> | undefined;
	#nextIndex = 0;
	/** The agent the deck last jumped to (what Approve/Deny will act on, once they exist). */
	lastJumped: Agent | undefined;

	async init(): Promise<void> {
		this.#settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
		streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
			const before = this.#settings;
			this.#settings = ev.settings;
			if (before.address !== ev.settings.address) this.#connect();
			this.#render();
		});
		this.#connect();
	}

	get status(): Status {
		return this.#status;
	}

	describe(): JsonObject {
		const hub = this.#hub;
		return {
			event: "status",
			status: this.#status,
			label: this.#status === "connected" ? `Connected · ${hub?.agents.length ?? 0} agents` : STATUS_LABEL[this.#status],
			error: this.#conn?.lastError ?? "",
			hosts: (hub?.hosts ?? []).map((h) => h.label).join(", "),
			worktrees: this.#worktreeChoices(),
		};
	}

	async pair(code: string): Promise<string | undefined> {
		try {
			parsePairingCode(code);
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
		this.#settings = { ...this.#settings, pairingCode: code.trim() };
		await streamDeck.settings.setGlobalSettings(this.#settings);
		streamDeck.logger.info("Paired with a new code; connecting.");
		this.#connect();
		return undefined;
	}

	async forget(): Promise<void> {
		const { pairingCode: _drop, ...rest } = this.#settings;
		this.#settings = rest;
		await streamDeck.settings.setGlobalSettings(this.#settings);
		this.#connect();
	}

	#connect(): void {
		this.#hub?.stop();
		this.#conn?.stop();
		this.#hub = undefined;
		this.#conn = undefined;
		let offer: PairingOffer;
		try {
			if (!this.#settings.pairingCode) throw new Error("not paired");
			offer = parsePairingCode(this.#settings.pairingCode);
		} catch {
			this.#setStatus("unpaired");
			return;
		}
		const log = (level: "debug" | "info" | "warn" | "error", msg: string) => streamDeck.logger[level](msg);
		const endpoint = endpointFor(offer, this.#settings.address);
		streamDeck.logger.info(`Connecting to Orca at ${endpoint}`);
		const conn = new OrcaConnection({ offer, endpoint, capabilities: CLIENT_CAPABILITIES, log });
		const hub = new OrcaHub(conn, { log });
		this.#conn = conn;
		this.#hub = hub;
		hub.onChange(() => {
			this.#logSummary();
			this.#render();
			void this.#refreshPending();
		});
		conn.onState((state) => {
			if (conn !== this.#conn) return;
			if (state === "connected") {
				hub.start();
				this.#startUsage();
			} else {
				hub.stop();
				this.#stopUsage();
			}
			this.#setStatus(state);
		});
		this.#setStatus("connecting");
		conn.start();
	}

	#setStatus(status: Status): void {
		if (status === this.#status) return this.#render();
		this.#status = status;
		streamDeck.logger.info(`Orca connection: ${status}${this.#conn?.lastError ? ` (${this.#conn.lastError})` : ""}`);
		this.#render();
		void streamDeck.ui.sendToPropertyInspector(this.describe()).catch(() => {});
	}

	#logSummary(): void {
		const hub = this.#hub;
		if (!hub) return;
		const by = (pred: (a: Agent) => boolean) => hub.agents.filter(pred).length;
		const errors = [...hub.hostErrors].map(([h, e]) => `${h}: ${e}`).join("; ");
		streamDeck.logger.info(
			`Hosts: ${hub.hosts.map((h) => h.label).join(", ")} · agents ${hub.agents.length} ` +
				`(needs you ${by((a) => a.needsYou)}, working ${by((a) => a.state === "working")}, done ${by((a) => a.state === "done")})` +
				(errors ? ` · errors: ${errors}` : ""),
		);
	}

	#worktreeChoices(): { value: string; label: string }[] {
		const seen = new Map<string, string>();
		for (const a of this.#hub?.agents ?? []) {
			const value = `${a.hostId}|${a.worktreeId}`;
			const host = this.#hub?.hosts.find((h) => h.hostId === a.hostId)?.label ?? a.hostId;
			if (!seen.has(value)) seen.set(value, `${a.worktreeName} (${host})`);
		}
		return [...seen].map(([value, label]) => ({ value, label })).sort((x, y) => x.label.localeCompare(y.label));
	}

	// ---------- keys ----------

	addAgentKey(action: KeyAction<AgentSettings>, settings: AgentSettings): void {
		this.#agentKeys.set(action.id, { action, settings });
		this.#lastImage.delete(action.id); // a key that (re)appears needs drawing
		this.#render();
	}

	updateAgentKey(action: KeyAction<AgentSettings>, settings: AgentSettings): void {
		this.addAgentKey(action, settings);
	}

	removeKey(id: string): void {
		this.#agentKeys.delete(id);
		this.#plainKeys.delete(id);
		this.#approvalKeys.delete(id);
		this.#usageKeys.delete(id);
		if (!this.#usageKeys.size) this.#stopUsage();
		this.#shown.delete(id);
		this.#lastImage.delete(id);
		this.#render();
	}

	addPlainKey(action: KeyAction<JsonObject>, label: string): void {
		this.#plainKeys.set(action.id, { action, label });
		this.#lastImage.delete(action.id);
		// 0.1–0.3 wrote "N waiting" as a title; the count is drawn in the image now.
		if (label === "next") void action.setTitle("").catch(() => {});
		this.#renderPlain(action.id);
	}

	#render(): void {
		const connected = this.#status === "connected";
		const agents = this.#hub?.agents ?? [];
		const keys = [...this.#agentKeys.values()];

		const pinned = keys.filter((k) => k.settings.mode === "pinned");
		const autoKeys = keys.filter((k) => k.settings.mode !== "pinned").map((k) => k.action).sort(readingOrder);

		const shown = new Map<string, Agent | undefined>();
		const pinnedKeys = new Set<string>();
		for (const k of pinned) {
			const [hostId, worktreeId] = splitPin(k.settings.pin);
			const agent = hostId && worktreeId ? agentForWorktree(agents, hostId, worktreeId) : undefined;
			shown.set(k.action.id, agent);
			if (agent) pinnedKeys.add(agent.key);
		}
		const board = filterForBoard(agents, this.#settings.boardShow);
		// Fill Auto keys in reading order with no gaps.
		const ordered = orderBoard(board, this.#boardOrder, pinnedKeys);
		this.#boardOrder = ordered.map((a) => a.key);
		const assignment = new Map(autoKeys.map((action, i) => [action.id, ordered[i]] as [string, Agent | undefined]));
		for (const [slot, agent] of assignment) shown.set(slot, agent);
		const boardEmpty = ![...assignment.values()].some(Boolean);
		this.#shown = shown;

		const pulsing = this.#settings.alertStyle === "pulse" && [...shown.values()].some((a) => a?.needsYou);
		this.#setPulse(pulsing);

		for (const k of keys) {
			const agent = shown.get(k.action.id);
			let image: string;
			if (!connected) image = offlineKeyImage(STATUS_LABEL[this.#status as Exclude<Status, "connected">]);
			else if (agent) image = agentKeyImage(agent, pulsing && agent.needsYou && !this.#pulseOn, this.#textSize());
			else if (k.settings.mode === "pinned") image = emptyKeyImage(k.settings.pin ? (k.settings.pinLabel ?? "Quiet") : "Pick a worktree", this.#textSize());
			// Spare keys stay plain; only an entirely empty board says so.
			else image = emptyKeyImage(boardEmpty ? (this.#settings.boardShow === "all" ? "No agents" : this.#settings.boardShow === "waiting" ? "Nothing waiting" : "All quiet") : "", this.#textSize());
			if (this.#lastImage.get(k.action.id) === image) continue;
			this.#lastImage.set(k.action.id, image);
			void k.action.setImage(image).catch(() => {});
		}
		for (const id of this.#plainKeys.keys()) this.#renderPlain(id);
		this.#renderApprovals();
		this.#renderUsage();
	}

	#renderPlain(id: string): void {
		const key = this.#plainKeys.get(id);
		if (!key) return;
		if (key.label !== "next") return;
		const waiting = this.#status === "connected" ? (this.#hub?.agents ?? []).filter((a) => a.needsYou).length : undefined;
		const image = nextKeyImage(waiting);
		if (this.#lastImage.get(id) === image) return;
		this.#lastImage.set(id, image);
		void key.action.setImage(image).catch(() => {});
	}

	#textSize(): KeyTextSize {
		return this.#settings.keyText === "detailed" ? "detailed" : "large";
	}

	#setPulse(on: boolean): void {
		if (on && !this.#pulseTimer) {
			this.#pulseTimer = setInterval(() => {
				this.#pulseOn = !this.#pulseOn;
				this.#render();
			}, PULSE_MS);
		} else if (!on && this.#pulseTimer) {
			clearInterval(this.#pulseTimer);
			this.#pulseTimer = undefined;
			this.#pulseOn = false;
		}
	}

	// ---------- presses ----------

	async pressAgentKey(action: KeyAction<AgentSettings>): Promise<void> {
		const agent = this.#shown.get(action.id);
		if (!agent || this.#status !== "connected") return void action.showAlert();
		await this.#jump(agent, action);
	}

	async pressNextWaiting(action: KeyAction<JsonObject>): Promise<void> {
		const waiting = (this.#hub?.agents ?? []).filter((a) => a.needsYou);
		if (!waiting.length || this.#status !== "connected") return void action.showAlert();
		const agent = waiting[this.#nextIndex++ % waiting.length]!;
		await this.#jump(agent, action);
	}

	// ---------- approve / deny ----------

	addApprovalKey(action: KeyAction<JsonObject>, choice: ApprovalChoice): void {
		this.#approvalKeys.set(action.id, { action, choice });
		this.#lastImage.delete(action.id);
		this.#renderApprovals();
	}

	/** The deck's last-jumped agent as Orca reports it now. */
	#target(): Agent | undefined {
		const key = this.lastJumped?.key;
		return key ? this.#hub?.agents.find((a) => a.key === key) : undefined;
	}

	#executionHost(agent: Agent): string | undefined {
		return this.#hub?.hosts.find((h) => h.hostId === agent.hostId)?.executionHost;
	}

	/** Re-reads the target's permission request. Runs one at a time; a request made meanwhile runs once more after. */
	async #refreshPending(): Promise<void> {
		if (this.#pendingLoading) {
			this.#pendingAgain = true;
			return;
		}
		this.#pendingLoading = true;
		try {
			do {
				this.#pendingAgain = false;
				const target = this.#target();
				const conn = this.#conn;
				let pending: PendingApproval | null = null;
				if (target && conn && target.kind === "chat" && target.state === "blocked") {
					try {
						pending = await fetchPendingApproval(conn, target, this.#executionHost(target));
					} catch (err) {
						streamDeck.logger.warn(`Couldn't read the permission request: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				this.#pending = pending;
				this.#renderApprovals();
			} while (this.#pendingAgain);
		} finally {
			this.#pendingLoading = false;
		}
	}

	#renderApprovals(): void {
		const target = this.#target() ?? this.lastJumped;
		const connected = this.#status === "connected";
		for (const { action, choice } of this.#approvalKeys.values()) {
			const optionReady = choice === "allow" ? this.#pending?.allowOptionId : this.#pending?.denyOptionId;
			const image = connected
				? approvalKeyImage({ choice, active: !!this.#pending && !!optionReady, target: target?.worktreeName, toolName: this.#pending?.toolName }, this.#textSize())
				: offlineKeyImage(STATUS_LABEL[this.#status as Exclude<Status, "connected">]);
			if (this.#lastImage.get(action.id) === image) continue;
			this.#lastImage.set(action.id, image);
			void action.setImage(image).catch(() => {});
		}
	}

	async pressApproval(action: KeyAction<JsonObject>, choice: ApprovalChoice): Promise<void> {
		const target = this.#target();
		const shown = this.#pending;
		const conn = this.#conn;
		if (!target || !shown || !conn || this.#status !== "connected") return void action.showAlert();
		try {
			// Re-check right before answering: only answer the exact request the key was showing.
			const host = this.#executionHost(target);
			const fresh = await fetchPendingApproval(conn, target, host);
			if (!fresh || fresh.itemId !== shown.itemId) {
				streamDeck.logger.info("Permission request changed before the key press; not answering.");
				void action.showAlert();
				return;
			}
			if (!(choice === "allow" ? fresh.allowOptionId : fresh.denyOptionId)) {
				streamDeck.logger.warn(`No safe "${choice}" option on this request; answer it in Orca.`);
				void action.showAlert();
				return;
			}
			const outcome = await respondToApproval(conn, fresh, choice, host);
			streamDeck.logger.info(`${choice === "allow" ? "Allowed" : "Denied"} ${fresh.toolName ?? "request"} for ${target.worktreeName}: ${outcome}`);
			if (outcome === "accepted") void action.showOk();
			else void action.showAlert();
		} catch (err) {
			streamDeck.logger.warn(`Answer failed: ${err instanceof Error ? err.message : String(err)}`);
			void action.showAlert();
		} finally {
			void this.#refreshPending();
		}
	}

	// ---------- usage ----------

	addUsageKey(action: KeyAction<UsageSettings>, settings: UsageSettings): void {
		this.#usageKeys.set(action.id, { action, provider: settings.provider === "codex" ? "codex" : "claude" });
		this.#lastImage.delete(action.id);
		this.#renderUsage();
		if (this.#status === "connected") this.#startUsage();
	}

	#startUsage(): void {
		if (this.#usageTimer || !this.#usageKeys.size) return;
		void this.#pollUsage();
	}

	#stopUsage(): void {
		clearTimeout(this.#usageTimer);
		this.#usageTimer = undefined;
	}

	async #pollUsage(force = false): Promise<void> {
		this.#stopUsage();
		const conn = this.#conn;
		if (conn && this.#status === "connected" && !this.#usageLoading) {
			this.#usageLoading = true;
			const refreshUsage = force || Date.now() - this.#usageRefreshedAt >= USAGE_REFRESH_MS;
			try {
				// Answered by the paired desktop itself: the PC's view of each account's limits.
				// refreshUsage defaults to true in Orca, so the light poll must say false explicitly.
				this.#accounts = await conn.call("accounts.list", { refreshUsage }, { timeoutMs: refreshUsage ? 30_000 : 10_000 });
				if (refreshUsage) this.#usageRefreshedAt = Date.now();
			} catch (err) {
				streamDeck.logger.warn(`Couldn't read usage: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				this.#usageLoading = false;
			}
			this.#renderUsage();
		}
		if (this.#usageKeys.size && this.#status === "connected") this.#usageTimer = setTimeout(() => void this.#pollUsage(), USAGE_POLL_MS);
	}

	#renderUsage(): void {
		const connected = this.#status === "connected";
		for (const { action, provider } of this.#usageKeys.values()) {
			const image = connected
				? usageKeyImage(this.#accounts === undefined ? undefined : usageView(this.#accounts, provider), this.#textSize())
				: offlineKeyImage(STATUS_LABEL[this.#status as Exclude<Status, "connected">]);
			if (this.#lastImage.get(action.id) === image) continue;
			this.#lastImage.set(action.id, image);
			void action.setImage(image).catch(() => {});
		}
	}

	async pressUsage(action: KeyAction<UsageSettings>): Promise<void> {
		if (this.#status !== "connected") return void action.showAlert();
		await this.#pollUsage(true);
		void action.showOk();
	}

	pressShowOrca(action: KeyAction<JsonObject>): void {
		if (!raiseOrca()) void action.showAlert();
	}

	async #jump(agent: Agent, action: KeyAction<JsonObject> | KeyAction<AgentSettings>): Promise<void> {
		try {
			await this.#hub!.reveal(agent);
			this.lastJumped = agent;
			void this.#refreshPending();
			streamDeck.logger.info(`Jumped to ${agent.worktreeName} / ${agent.kind} tab on ${agent.hostId}`);
		} catch (err) {
			streamDeck.logger.warn(`Jump failed: ${err instanceof Error ? err.message : String(err)}`);
			void action.showAlert();
		}
		raiseOrca();
	}
}

function raiseOrca(): boolean {
	try {
		return focusOrca();
	} catch (err) {
		streamDeck.logger.warn(`Couldn't bring Orca to the front: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

function splitPin(pin: string | undefined): [string | undefined, string | undefined] {
	if (!pin) return [undefined, undefined];
	const at = pin.indexOf("|");
	return at < 0 ? [undefined, undefined] : [pin.slice(0, at), pin.slice(at + 1)];
}

export const controller = new Controller();
