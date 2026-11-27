// Keeps an up-to-date list of agents across every Orca host the paired desktop can reach, by
// asking each host for its tabs every couple of seconds. Talks to Orca only through `Rpc`, so it
// can be tested without a network.
import { agentsFromSnapshots, rankForAuto, worktreeInfoFromPs, type Agent, type WorktreeInfo, type WireSnapshot } from "./agents";

/** The slice of OrcaConnection the hub needs. */
export interface Rpc {
	call<T = unknown>(method: string, params?: unknown, opts?: { executionHost?: string; timeoutMs?: number }): Promise<T>;
}

/** Capabilities the plugin tells Orca it understands, so chat agents come back with real titles and status. */
export const CLIENT_CAPABILITIES = [
	"agent-session.structured.v1",
	"agent-session.structured.claude.v1",
	"agent-session.structured.registered-agents.v1",
	"agent-session.current-requests.v1",
];

const DESKTOP_RELAY_CAPABILITY = "mobile.desktop-relay.v1";
/** The desktop itself (no executionHost on requests). */
export const DESKTOP_HOST = "desktop";

export type Host = { hostId: string; label: string; executionHost?: string };

export type HubOptions = {
	pollMs?: number;
	/** How often to re-read the host list. */
	slowRefreshMs?: number;
	/** Re-read worktree names and unread flags every this many polls (worktree.ps is heavier than the tab list). */
	worktreeEvery?: number;
	log?: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
};

type HostState = { worktrees: Map<string, WorktreeInfo>; agents: Agent[]; error?: string };

export class OrcaHub {
	readonly #rpc: Rpc;
	readonly #pollMs: number;
	readonly #slowMs: number;
	readonly #worktreeEvery: number;
	#round = 0;
	readonly #log: NonNullable<HubOptions["log"]>;
	#hosts: Host[] = [];
	#byHost = new Map<string, HostState>();
	#agents: Agent[] = [];
	#listeners = new Set<(agents: readonly Agent[]) => void>();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running = false;
	#lastSlow = 0;
	#relaySupported = false;

	constructor(rpc: Rpc, opts: HubOptions = {}) {
		this.#rpc = rpc;
		this.#pollMs = opts.pollMs ?? 1500;
		this.#slowMs = opts.slowRefreshMs ?? 30_000;
		this.#worktreeEvery = Math.max(1, opts.worktreeEvery ?? 2);
		this.#log = opts.log ?? (() => {});
	}

	get agents(): readonly Agent[] {
		return this.#agents;
	}

	get hosts(): readonly Host[] {
		return this.#hosts;
	}

	/** Per-host problems from the last refresh, for the diagnostics log. */
	get hostErrors(): ReadonlyMap<string, string> {
		const out = new Map<string, string>();
		for (const [id, state] of this.#byHost) if (state.error) out.set(id, state.error);
		return out;
	}

	onChange(listener: (agents: readonly Agent[]) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Starts polling. Call when the connection becomes connected. */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#lastSlow = 0;
		void this.#loop();
	}

	/** Stops polling and clears what it knew. Call when the connection drops. */
	stop(): void {
		this.#running = false;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#setAgents([]);
	}

	async #loop(): Promise<void> {
		if (!this.#running) return;
		try {
			await this.refresh();
		} catch (err) {
			this.#log("warn", `refresh failed: ${message(err)}`);
		}
		if (this.#running) this.#timer = setTimeout(() => void this.#loop(), this.#pollMs);
	}

	/** One round: (sometimes) hosts and names, then every host's tabs. Exposed for tests. */
	async refresh(now = Date.now()): Promise<void> {
		const slow = now - this.#lastSlow >= this.#slowMs;
		if (slow) {
			this.#lastSlow = now;
			await this.#refreshHosts();
		}
		const due = this.#round++ % this.#worktreeEvery === 0;
		const withWorktrees = slow || due;
		await Promise.all(this.#hosts.map((host) => this.#refreshHost(host, withWorktrees)));
		this.#setAgents(rankForAuto(this.#hosts.flatMap((h) => this.#byHost.get(h.hostId)?.agents ?? [])));
	}

	async #refreshHosts(): Promise<void> {
		const hosts: Host[] = [{ hostId: DESKTOP_HOST, label: "This PC" }];
		try {
			const status = await this.#rpc.call<{ capabilities?: unknown }>("status.get", null, { timeoutMs: 8000 });
			this.#relaySupported = Array.isArray(status?.capabilities) && status.capabilities.includes(DESKTOP_RELAY_CAPABILITY);
		} catch (err) {
			this.#log("warn", `status.get failed: ${message(err)}`);
		}
		if (this.#relaySupported) {
			try {
				const res = await this.#rpc.call<{ hosts?: { hostId?: unknown; label?: unknown; relay?: unknown }[] }>("mobileRelay.hosts.list", null, { timeoutMs: 8000 });
				for (const h of res?.hosts ?? []) {
					if (typeof h.hostId !== "string") continue;
					if (h.relay !== "ready") {
						this.#log("info", `host ${String(h.label)} not reachable through the desktop (${String(h.relay)})`);
						continue;
					}
					hosts.push({ hostId: h.hostId, label: typeof h.label === "string" ? h.label : h.hostId, executionHost: h.hostId });
				}
			} catch (err) {
				this.#log("warn", `mobileRelay.hosts.list failed: ${message(err)}`);
			}
		} else {
			this.#log("info", "desktop doesn't offer remote hosts to phones; showing this PC's agents only");
		}
		const ids = new Set(hosts.map((h) => h.hostId));
		for (const id of this.#byHost.keys()) if (!ids.has(id)) this.#byHost.delete(id);
		this.#hosts = hosts;
	}

	async #refreshHost(host: Host, withWorktrees: boolean): Promise<void> {
		const state: HostState = this.#byHost.get(host.hostId) ?? { worktrees: new Map(), agents: [] };
		this.#byHost.set(host.hostId, state);
		const opts = { executionHost: host.executionHost, timeoutMs: 8000 };
		try {
			if (withWorktrees) {
				try {
					state.worktrees = worktreeInfoFromPs(await this.#rpc.call("worktree.ps", { limit: 1000 }, opts));
				} catch (err) {
					this.#log("debug", `worktree.ps on ${host.label} failed: ${message(err)}`);
				}
			}
			const res = await this.#rpc.call<{ snapshots?: WireSnapshot[] }>("session.tabs.listAll", null, opts);
			state.agents = agentsFromSnapshots(host.hostId, res?.snapshots ?? [], state.worktrees);
			state.error = undefined;
		} catch (err) {
			// Keep the last known agents for a flaky host rather than blanking its keys.
			state.error = message(err);
			this.#log("warn", `session.tabs.listAll on ${host.label} failed: ${state.error}`);
		}
	}

	#setAgents(agents: Agent[]): void {
		if (sameAgents(this.#agents, agents)) return;
		this.#agents = agents;
		for (const listener of this.#listeners) listener(agents);
	}

	/**
	 * Asks Orca to show an agent: switch the desktop to its worktree, then to its tab.
	 * `navigation: "all"` asks the host to move every attached window, including the desktop's.
	 * Raising the window itself is the caller's job (Windows only).
	 */
	async reveal(agent: Agent): Promise<void> {
		const opts = { executionHost: this.#hosts.find((h) => h.hostId === agent.hostId)?.executionHost, timeoutMs: 8000 };
		const worktree = `id:${agent.worktreeId}`;
		await this.#rpc.call("worktree.activate", { worktree, navigation: "all" }, opts);
		await this.#rpc.call("session.tabs.activate", { worktree, tabId: agent.tabId, ...(agent.leafId ? { leafId: agent.leafId } : {}), navigation: "all" }, opts);
	}
}

function sameAgents(a: readonly Agent[], b: readonly Agent[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((x, i) => {
		const y = b[i]!;
		return x.key === y.key && x.state === y.state && x.title === y.title && x.worktreeName === y.worktreeName && x.toolName === y.toolName && x.interrupted === y.interrupted && x.unread === y.unread;
	});
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
