// Client connection to the Orca desktop app: E2EE v2 ("direct" transport, token auth) over a WebSocket,
// the same way Orca's mobile companion connects. Behaviour reimplemented from stablyai/orca
// mobile/src/transport/rpc-client*.ts @ 8538b07f9a4 (MIT) without the React Native bits.
//
// Logging policy: the device token and keys are never logged; decrypted payloads are never logged.
// Debug logs carry method names and sizes only.
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { PairingOffer } from "./pairing";
import { createPairedE2EEClientHandshake, type PairedE2EEClientHandshake } from "./vendor/paired-e2ee-client-handshake";
import { PAIRED_E2EE_HANDSHAKE_DEADLINE_MS } from "./vendor/paired-e2ee-handshake-deadline";
import { NODE_PAIRED_E2EE_PRIMITIVES } from "./vendor/paired-e2ee-node-primitives";

export type ConnectionState = "connecting" | "connected" | "offline" | "unauthorized";
export type LogLevel = "debug" | "info" | "warn" | "error";

export class OrcaRpcError extends Error {
	readonly code: string;
	readonly data?: unknown;
	constructor(code: string, message: string, data?: unknown) {
		super(message);
		this.name = "OrcaRpcError";
		this.code = code;
		this.data = data;
	}
}

export type OrcaTiming = {
	/** Reconnect backoff steps; the last step repeats until trickleAfterAttempts. Default 500..60000 ms. */
	reconnectDelaysMs?: readonly number[];
	/** After this many failed attempts, retry every trickleDelayMs. Default 12 / 90000. */
	trickleAfterAttempts?: number;
	trickleDelayMs?: number;
	connectTimeoutMs?: number;
	handshakeTimeoutMs?: number;
	livenessIdleMs?: number;
	livenessProbeTimeoutMs?: number;
	livenessMissedLimit?: number;
	defaultCallTimeoutMs?: number;
};

export type OrcaConnectionOptions = {
	offer: PairingOffer;
	/** Overrides offer.endpoint, e.g. ws://127.0.0.1:<port> when running on the desktop's own PC. */
	endpoint?: string;
	/** Sent via runtime.clientCapabilities.update after authentication (max 64). */
	capabilities: string[];
	log?: (level: LogLevel, msg: string) => void;
	WebSocketImpl?: typeof WebSocket;
	timing?: OrcaTiming;
};

export type CallOptions = { executionHost?: string; timeoutMs?: number };
export type SubscribeOptions = {
	executionHost?: string;
	/** Called when the host rejects the subscription (the subscription is then dropped). */
	onError?: (error: OrcaRpcError) => void;
};

const MAX_CAPABILITIES = 64;
const DEFAULT_RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000, 60_000];
const UNAUTHORIZED_CLOSE_CODE = 4001;

// Streams whose host names its registration in the `ready` frame; closing sends the matching release.
const READY_STREAM_RELEASE: ReadonlyMap<string, string> = new Map([
	["browser.screencast", "browser.screencast.unsubscribe"],
	["runtime.clientEvents.subscribe", "runtime.clientEvents.unsubscribe"],
	["notifications.subscribe", "notifications.unsubscribe"],
	["accounts.subscribe", "accounts.unsubscribe"]
]);

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: OrcaRpcError) => void;
	timer: ReturnType<typeof setTimeout>;
	method: string;
};

type Stream = {
	id: string | null;
	method: string;
	params: unknown;
	executionHost?: string;
	onFrame: ((result: unknown) => void) | null;
	onError?: (error: OrcaRpcError) => void;
	subscriptionId?: string;
	sent: boolean;
};

type Session = {
	socket: WebSocket;
	handshake: PairedE2EEClientHandshake;
	phase: "awaiting_ready" | "awaiting_auth" | "ready";
	timers: Set<ReturnType<typeof setTimeout>>;
	readyAccepted: boolean;
	authRejected: boolean;
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class OrcaConnection extends EventEmitter {
	private readonly offer: PairingOffer;
	private readonly endpoint: string;
	private readonly capabilities: string[];
	private readonly logFn: (level: LogLevel, msg: string) => void;
	private readonly WS: typeof WebSocket;
	private readonly timing: Required<OrcaTiming>;

	private _state: ConnectionState = "offline";
	private _lastError = "";
	private started = false;
	private session: Session | null = null;
	private attempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private nextId = 1;
	private readonly pending = new Map<string, Pending>();
	private readonly streams = new Set<Stream>();
	private readonly streamsById = new Map<string, Stream>();
	private readonly stateListeners = new Set<(state: ConnectionState) => void>();

	private livenessTimer: ReturnType<typeof setTimeout> | null = null;
	private missedProbes = 0;
	private probing = false;

	constructor(opts: OrcaConnectionOptions) {
		super();
		if (opts.capabilities.length > MAX_CAPABILITIES) {
			throw new Error(`At most ${MAX_CAPABILITIES} client capabilities are allowed`);
		}
		this.offer = opts.offer;
		this.endpoint = opts.endpoint ?? opts.offer.endpoint;
		this.capabilities = [...opts.capabilities];
		this.logFn = opts.log ?? (() => {});
		this.WS = opts.WebSocketImpl ?? WebSocket;
		const t = opts.timing ?? {};
		this.timing = {
			reconnectDelaysMs: t.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS,
			trickleAfterAttempts: t.trickleAfterAttempts ?? 12,
			trickleDelayMs: t.trickleDelayMs ?? 90_000,
			connectTimeoutMs: t.connectTimeoutMs ?? 12_000,
			handshakeTimeoutMs: t.handshakeTimeoutMs ?? PAIRED_E2EE_HANDSHAKE_DEADLINE_MS,
			livenessIdleMs: t.livenessIdleMs ?? 20_000,
			livenessProbeTimeoutMs: t.livenessProbeTimeoutMs ?? 8_000,
			livenessMissedLimit: t.livenessMissedLimit ?? 3,
			defaultCallTimeoutMs: t.defaultCallTimeoutMs ?? 30_000
		};
	}

	get state(): ConnectionState {
		return this._state;
	}

	/** Human-readable reason for the most recent failure; empty when none. */
	get lastError(): string {
		return this._lastError;
	}

	/** Subscribe to state changes. Returns an unsubscribe function. */
	onState(cb: (state: ConnectionState) => void): () => void {
		this.stateListeners.add(cb);
		return () => {
			this.stateListeners.delete(cb);
		};
	}

	/** Begin connecting (and keep reconnecting) until stop(). Also restarts after 'unauthorized'. */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.attempt = 0;
		this.openSocket();
	}

	/** Close the socket, cancel retries, fail outstanding calls. State becomes 'offline'. */
	stop(): void {
		this.started = false;
		this.clearReconnect();
		this.teardownSession();
		this.failAllPending("stopped", "Connection stopped");
		// Streams are kept registered only while started; a stopped connection forgets them.
		this.streams.clear();
		this.streamsById.clear();
		this.setState("offline");
	}

	/** Sends one request and resolves with its result. Rejects with OrcaRpcError. */
	async call<T = unknown>(method: string, params?: unknown, opts?: CallOptions): Promise<T> {
		const timeoutMs = opts?.timeoutMs ?? this.timing.defaultCallTimeoutMs;
		if (this._state === "connecting") await this.waitForConnected(timeoutMs);
		if (this._state !== "connected" || !this.session || this.session.phase !== "ready") {
			throw new OrcaRpcError("not_connected", `Not connected to Orca (${this._state})`);
		}
		return (await this.sendRequest(method, params, opts?.executionHost, timeoutMs)) as T;
	}

	/**
	 * Starts a streaming request. onFrame receives each streaming result (ready/snapshot/updated/end...).
	 * It is re-sent automatically after every reconnect. close() stops delivery and, for known
	 * ready-id streams, tells the host to release it.
	 */
	subscribe(
		method: string,
		params: unknown,
		onFrame: (result: unknown) => void,
		opts?: SubscribeOptions
	): { close(): void } {
		const stream: Stream = {
			id: null,
			method,
			params: params ?? {},
			executionHost: opts?.executionHost,
			onFrame,
			onError: opts?.onError,
			sent: false
		};
		this.streams.add(stream);
		this.flushStreams();
		return {
			close: () => {
				if (!this.streams.has(stream)) return;
				stream.onFrame = null;
				this.releaseStream(stream);
			}
		};
	}

	// ---- socket lifecycle ----

	private openSocket(): void {
		if (!this.started) return;
		this.clearReconnect();
		this.setState("connecting");
		let socket: WebSocket;
		try {
			socket = new this.WS(this.endpoint, { maxPayload: 32 * 1024 * 1024, handshakeTimeout: this.timing.connectTimeoutMs });
		} catch (error) {
			this.fail(`Could not open a connection: ${errMessage(error)}`);
			return;
		}
		const session: Session = {
			socket,
			handshake: createPairedE2EEClientHandshake({
				framing: "v2",
				transport: "direct",
				primitives: NODE_PAIRED_E2EE_PRIMITIVES,
				hostPublicKeyB64: this.offer.publicKeyB64
			}),
			phase: "awaiting_ready",
			timers: new Set(),
			readyAccepted: false,
			authRejected: false
		};
		this.session = session;
		this.log("debug", `Opening socket (attempt ${this.attempt + 1})`);

		socket.on("open", () => {
			if (this.session !== session) return;
			try {
				socket.send(session.handshake.helloText());
			} catch (error) {
				this.dropSession(session, `Handshake failed: ${errMessage(error)}`);
				return;
			}
			this.armTimer(session, this.timing.handshakeTimeoutMs, () =>
				this.dropSession(session, "Timed out waiting for Orca to finish the secure handshake")
			);
		});
		socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
			if (this.session !== session) return;
			this.onInbound();
			void this.handleMessage(session, data, isBinary).catch((error) =>
				this.dropSession(session, `Protocol error: ${errMessage(error)}`)
			);
		});
		socket.on("ping", () => {
			if (this.session === session && session.phase === "ready") this.onInbound();
		});
		socket.on("error", (error: Error) => {
			// 'close' always follows; remember why for lastError.
			if (this.session === session && !session.readyAccepted) this._lastError = `Connection error: ${error.message}`;
		});
		socket.on("close", (code: number, reasonBuf: Buffer) => {
			if (this.session !== session) return;
			this.handleClose(session, code, reasonBuf.toString("utf-8"));
		});
	}

	private async handleMessage(session: Session, data: WebSocket.RawData, isBinary: boolean): Promise<void> {
		const { handshake } = session;
		if (isBinary) {
			// Text frames are base64 text; binary frames carry no RPC we use, but opening one keeps counters aligned.
			if (session.phase !== "ready") throw new Error("binary frame before authentication");
			handshake.channel.openBinary(toBytes(data));
			return;
		}
		const text = rawToString(data);
		if (session.phase === "awaiting_ready") {
			const verdict = handshake.acceptReadyText(text);
			if (verdict !== "accepted") {
				const mismatch = verdict === "unexpected";
				this.dropSession(
					session,
					mismatch
						? "Orca presented an unexpected security key or handshake. Is this the Orca you paired with?"
						: "Orca sent an unreadable handshake reply"
				);
				return;
			}
			session.readyAccepted = true;
			session.phase = "awaiting_auth";
			const auth = await handshake.sealAuth({ kind: "token", deviceToken: this.offer.deviceToken });
			if (this.session !== session) return;
			session.socket.send(auth);
			return;
		}
		const plaintext = handshake.channel.openText(text);
		if (plaintext === null) {
			throw new Error("could not decrypt a frame");
		}
		if (session.phase === "awaiting_auth") {
			const reply = handshake.classifyAuthReply(plaintext);
			if (reply.kind === "authenticated") {
				this.clearTimers(session);
				session.phase = "ready";
				void this.onAuthenticated(session);
			} else if (reply.kind === "rejected") {
				session.authRejected = true;
				const code = reply.errorCode ?? "unknown";
				this.log("warn", `Orca rejected authentication (${code})`);
				this._lastError =
					code === "device_revoked" || code === "bad_auth" || code === "unauthorized"
						? "Orca no longer accepts this pairing. Pair again with a fresh code."
						: `Orca rejected authentication (${code})`;
				// The server closes with 4001 next; handleClose turns this into 'unauthorized'.
			} else {
				throw new Error("unreadable authentication reply");
			}
			return;
		}
		this.handleRpcText(plaintext);
	}

	private async onAuthenticated(session: Session): Promise<void> {
		this.log("info", "Authenticated with Orca");
		// Capabilities go out before we announce 'connected', so first calls already see our feature set.
		try {
			await this.sendRequest(
				"runtime.clientCapabilities.update",
				{ clientCapabilities: this.capabilities },
				undefined,
				10_000,
				true
			);
		} catch (error) {
			if (this.session !== session) return;
			// Older desktops may not know the method; the connection is still usable.
			this.log("warn", `Could not send client capabilities: ${errMessage(error)}`);
		}
		if (this.session !== session) return;
		this.attempt = 0;
		this._lastError = "";
		this.missedProbes = 0;
		this.setState("connected");
		this.emit("connected");
		this.armLiveness();
		this.flushStreams();
	}

	private handleClose(session: Session, code: number, reason: string): void {
		this.clearTimers(session);
		this.session = null;
		this.clearLiveness();
		this.failAllPending("disconnected", "Disconnected from Orca");
		for (const stream of this.streams) this.markStreamUnsent(stream);
		this.log("info", `Socket closed (code ${code}${reason ? `, ${reason}` : ""})`);
		if (!this.started) return;
		if (code === UNAUTHORIZED_CLOSE_CODE && (session.readyAccepted || session.authRejected)) {
			// Revoked or invalid token: retrying cannot help.
			if (!this._lastError) this._lastError = "Orca no longer accepts this pairing. Pair again with a fresh code.";
			this.started = false;
			this.setState("unauthorized");
			return;
		}
		if (code === UNAUTHORIZED_CLOSE_CODE && !this._lastError) {
			this._lastError = "Orca refused the secure handshake";
		}
		this.scheduleReconnect();
	}

	/** Tear down a socket for a local reason, then fall into the normal reconnect path. */
	private dropSession(session: Session, reason: string): void {
		if (this.session !== session) return;
		this._lastError = reason;
		this.log("warn", reason);
		this.clearTimers(session);
		this.session = null;
		this.clearLiveness();
		this.failAllPending("disconnected", "Disconnected from Orca");
		for (const stream of this.streams) this.markStreamUnsent(stream);
		try {
			session.socket.removeAllListeners("message");
			session.socket.on("error", () => {});
			session.socket.terminate();
		} catch {
			// already gone
		}
		if (this.started) this.scheduleReconnect();
	}

	private fail(reason: string): void {
		this._lastError = reason;
		this.log("warn", reason);
		if (this.started) this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		this.clearReconnect();
		if (!this.started) return;
		this.setState("offline");
		const { reconnectDelaysMs, trickleAfterAttempts, trickleDelayMs } = this.timing;
		const delay =
			this.attempt >= trickleAfterAttempts
				? trickleDelayMs
				: reconnectDelaysMs[Math.min(this.attempt, reconnectDelaysMs.length - 1)]!;
		this.attempt++;
		this.log("info", `Reconnecting in ${delay} ms`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.openSocket();
		}, delay);
	}

	private clearReconnect(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}

	private teardownSession(): void {
		this.clearLiveness();
		const session = this.session;
		this.session = null;
		if (!session) return;
		this.clearTimers(session);
		session.socket.removeAllListeners("message");
		session.socket.on("error", () => {});
		try {
			if (session.socket.readyState === WebSocket.CONNECTING) session.socket.terminate();
			else session.socket.close(1000);
		} catch {
			// already closed
		}
	}

	private armTimer(session: Session, ms: number, fn: () => void): void {
		const timer = setTimeout(() => {
			session.timers.delete(timer);
			fn();
		}, ms);
		session.timers.add(timer);
	}

	private clearTimers(session: Session): void {
		for (const timer of session.timers) clearTimeout(timer);
		session.timers.clear();
	}

	// ---- requests ----

	private sendRequest(
		method: string,
		params: unknown,
		executionHost: string | undefined,
		timeoutMs: number,
		allowBeforeConnected = false
	): Promise<unknown> {
		const session = this.session;
		if (!session || session.phase !== "ready" || (!allowBeforeConnected && this._state !== "connected")) {
			return Promise.reject(new OrcaRpcError("not_connected", `Not connected to Orca (${this._state})`));
		}
		const id = this.newId();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new OrcaRpcError("timeout", `Orca did not answer ${method} within ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer, method });
			if (!this.sendFrame(session, this.buildRequest(id, method, params, executionHost))) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new OrcaRpcError("not_connected", "Could not send to Orca"));
			}
		});
	}

	private buildRequest(id: string, method: string, params: unknown, executionHost?: string): Record<string, unknown> {
		// Wire key order matches Orca's mobile client; the token is injected here and never logged.
		return {
			id,
			deviceToken: this.offer.deviceToken,
			method,
			params: params ?? {},
			...(executionHost ? { executionHost } : {})
		};
	}

	private sendFrame(session: Session, request: Record<string, unknown>): boolean {
		if (session.socket.readyState !== WebSocket.OPEN) return false;
		try {
			session.socket.send(session.handshake.channel.sealText(JSON.stringify(request)));
			return true;
		} catch (error) {
			this.dropSession(session, `Send failed: ${errMessage(error)}`);
			return false;
		}
	}

	private newId(): string {
		return `od-${this.nextId++}`;
	}

	private handleRpcText(plaintext: string): void {
		let msg: unknown;
		try {
			msg = JSON.parse(plaintext);
		} catch {
			return;
		}
		if (!isRecord(msg) || typeof msg.id !== "string") return;
		const id = msg.id;
		const streaming = msg.streaming === true;
		const stream = this.streamsById.get(id);

		if (stream) {
			if (msg.ok === false) {
				const err = toRpcError(msg);
				this.log("warn", `Subscription ${stream.method} rejected: ${err.code}`);
				this.removeStream(stream);
				stream.onError?.(err);
				return;
			}
			if (msg.ok !== true) return;
			const result = (msg as { result?: unknown }).result;
			if (isRecord(result) && result.type === "ready" && typeof result.subscriptionId === "string") {
				stream.subscriptionId = result.subscriptionId;
				if (!stream.onFrame) {
					// Closed before the host named it: release it now.
					this.releaseStream(stream);
					return;
				}
			}
			const ended = isRecord(result) && result.type === "end";
			stream.onFrame?.(result);
			// A non-streaming reply is the host's final answer for this id.
			if (ended || !streaming) this.removeStream(stream);
			return;
		}

		const pending = this.pending.get(id);
		if (!pending) return;
		if (streaming) return; // a stream we no longer track; ignore.
		clearTimeout(pending.timer);
		this.pending.delete(id);
		if (msg.ok === true) pending.resolve((msg as { result?: unknown }).result);
		else pending.reject(toRpcError(msg));
	}

	private failAllPending(code: string, message: string): void {
		const entries = [...this.pending.values()];
		this.pending.clear();
		for (const p of entries) {
			clearTimeout(p.timer);
			p.reject(new OrcaRpcError(code, message));
		}
	}

	private waitForConnected(timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			if (this._state !== "connecting") return resolve();
			const off = this.onState((s) => {
				if (s !== "connecting") {
					clearTimeout(timer);
					off();
					resolve();
				}
			});
			const timer = setTimeout(() => {
				off();
				resolve();
			}, timeoutMs);
		});
	}

	// ---- streams ----

	private flushStreams(): void {
		const session = this.session;
		if (!session || session.phase !== "ready" || this._state !== "connected") return;
		for (const stream of this.streams) {
			if (stream.sent || !stream.onFrame) continue;
			const id = this.newId();
			stream.id = id;
			if (this.sendFrame(session, this.buildRequest(id, stream.method, stream.params, stream.executionHost))) {
				stream.sent = true;
				this.streamsById.set(id, stream);
			} else {
				return;
			}
		}
	}

	private markStreamUnsent(stream: Stream): void {
		if (stream.id) this.streamsById.delete(stream.id);
		stream.id = null;
		stream.sent = false;
		stream.subscriptionId = undefined;
		// A closed stream whose host-side registration died with the socket needs nothing more.
		if (!stream.onFrame) this.streams.delete(stream);
	}

	private removeStream(stream: Stream): void {
		this.streams.delete(stream);
		if (stream.id) this.streamsById.delete(stream.id);
	}

	/** Stop delivering; release the host-side registration when we can name it, else keep the entry until it is named. */
	private releaseStream(stream: Stream): void {
		const release = READY_STREAM_RELEASE.get(stream.method);
		const session = this.session;
		if (!stream.sent || !release) {
			this.removeStream(stream);
			return;
		}
		if (stream.subscriptionId) {
			if (session && session.phase === "ready") {
				this.sendFrame(
					session,
					this.buildRequest(this.newId(), release, { subscriptionId: stream.subscriptionId }, stream.executionHost)
				);
			}
			this.removeStream(stream);
		}
		// else: kept (onFrame is null) until its ready frame arrives, or the socket drops.
	}

	// ---- liveness ----

	private onInbound(): void {
		this.missedProbes = 0;
		if (this._state === "connected" && !this.probing) this.armLiveness();
	}

	private armLiveness(): void {
		this.clearLiveness();
		const session = this.session;
		if (!session) return;
		this.livenessTimer = setTimeout(() => {
			this.livenessTimer = null;
			void this.probe(session);
		}, this.timing.livenessIdleMs);
	}

	private clearLiveness(): void {
		if (this.livenessTimer) clearTimeout(this.livenessTimer);
		this.livenessTimer = null;
		this.probing = false;
	}

	private async probe(session: Session): Promise<void> {
		if (this.session !== session || session.phase !== "ready") return;
		this.probing = true;
		try {
			await this.sendRequest("status.get", { probe: true }, undefined, this.timing.livenessProbeTimeoutMs);
			if (this.session !== session) return;
			this.probing = false;
			this.missedProbes = 0;
			this.armLiveness();
		} catch (error) {
			if (this.session !== session) return;
			// Any ok:false reply still proves the host is alive; only a timeout counts as a miss.
			if (error instanceof OrcaRpcError && error.code !== "timeout" && error.code !== "not_connected") {
				this.probing = false;
				this.missedProbes = 0;
				this.armLiveness();
				return;
			}
			this.missedProbes++;
			this.log("warn", `Liveness probe missed (${this.missedProbes}/${this.timing.livenessMissedLimit})`);
			if (this.missedProbes >= this.timing.livenessMissedLimit) {
				this.dropSession(session, "Orca stopped responding");
			} else {
				void this.probe(session);
			}
		}
	}

	// ---- misc ----

	private setState(next: ConnectionState): void {
		if (this._state === next) return;
		this._state = next;
		this.log("debug", `State: ${next}`);
		for (const cb of [...this.stateListeners]) {
			try {
				cb(next);
			} catch (error) {
				this.log("error", `State listener threw: ${errMessage(error)}`);
			}
		}
		this.emit("state", next);
	}

	private log(level: LogLevel, msg: string): void {
		try {
			this.logFn(level, msg);
		} catch {
			// logging must never break the connection
		}
	}
}

function toRpcError(msg: Record<string, unknown>): OrcaRpcError {
	const e = isRecord(msg.error) ? msg.error : {};
	return new OrcaRpcError(
		typeof e.code === "string" ? e.code : "unknown",
		typeof e.message === "string" ? e.message : "Orca returned an error",
		e.data
	);
}

function errMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function rawToString(data: WebSocket.RawData): string {
	if (typeof data === "string") return data;
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
	return Buffer.from(data as ArrayBuffer).toString("utf-8");
}

function toBytes(data: WebSocket.RawData): Uint8Array {
	if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return new Uint8Array(data as Buffer);
}
