// The server half of these tests uses Orca's own desktop-side E2EE v2 session
// (src/main/runtime/rpc/mobile-e2ee-v2-desktop-session.ts) imported by absolute path from the Orca checkout.
// If that checkout is missing, the suite is skipped. The WebSocket server loop, auth check and RPC
// dispatch around it are reimplemented here (Orca's E2EEChannel needs the Electron-side runtime).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import nacl from "tweetnacl";
import { WebSocketServer, type WebSocket } from "ws";
import { OrcaConnection, OrcaRpcError, type ConnectionState } from "../src/orca/connection";
import type { PairingOffer } from "../src/orca/pairing";

// Set ORCA_SRC to a checkout of github.com/stablyai/orca to run these against Orca's own desktop-side code.
const ORCA = process.env.ORCA_SRC ?? "";
const SESSION_PATH = `${ORCA}/src/main/runtime/rpc/mobile-e2ee-v2-desktop-session.ts`;
const haveOrca = existsSync(SESSION_PATH);
const skip = haveOrca ? false : `Orca checkout not found at ${ORCA}; skipping desktop-side handshake tests`;

type Req = { id: string; deviceToken: string; method: string; params: any; executionHost?: string };
type Conn = { ws: WebSocket; reply: (msg: unknown) => void; requests: Req[] };
type Behavior = {
	token: string;
	authMode: "ok" | "revoked" | "close4001";
	onRequest: (req: Req, c: Conn) => void;
};

async function startServer(behavior: Behavior, serverKeys = nacl.box.keyPair()) {
	const { DesktopMobileE2EEV2Session } = (await import(SESSION_PATH)) as { DesktopMobileE2EEV2Session: any };
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise((r) => wss.once("listening", r));
	const port = (wss.address() as { port: number }).port;
	const conns: Conn[] = [];
	const received: Req[] = [];
	let authAttempts = 0;
	let unauthorizedSeen = 0;

	wss.on("connection", (ws) => {
		let session: InstanceType<typeof DesktopMobileE2EEV2Session> | null = null;
		let authed = false;
		const conn: Conn = {
			ws,
			requests: [],
			reply: (msg) => ws.send(session!.sealText(JSON.stringify(msg)))
		};
		conns.push(conn);
		ws.on("message", (data, isBinary) => {
			if (!session) {
				session = DesktopMobileE2EEV2Session.create({
					hello: JSON.parse(data.toString()),
					serverSecretKey: serverKeys.secretKey,
					expectedContext: { transport: "direct" }
				});
				if (!session) return ws.close(4001, "Invalid e2ee_hello v2");
				ws.send(JSON.stringify(session.ready));
				return;
			}
			assert.equal(isBinary, false);
			const text = session.openText(data.toString());
			assert.ok(text !== null, "server could not open a client frame");
			const msg = JSON.parse(text!);
			if (!authed) {
				authAttempts++;
				assert.deepEqual(Object.keys(msg).sort(), ["deviceToken", "transcriptHashB64", "type", "v"]);
				assert.equal(msg.transcriptHashB64, session.transcriptHashB64);
				if (behavior.authMode === "close4001") {
					unauthorizedSeen++;
					return ws.close(4001, "Unauthorized");
				}
				if (behavior.authMode === "revoked" || msg.deviceToken !== behavior.token) {
					unauthorizedSeen++;
					ws.send(session.sealText(JSON.stringify({ type: "e2ee_error", error: { code: "device_revoked" } })));
					return ws.close(4001, "Unauthorized");
				}
				authed = true;
				ws.send(
					session.sealText(
						JSON.stringify({ type: "e2ee_authenticated", v: 2, transcriptHashB64: session.transcriptHashB64 })
					)
				);
				return;
			}
			assert.equal(msg.deviceToken, behavior.token);
			conn.requests.push(msg);
			received.push(msg);
			behavior.onRequest(msg, conn);
		});
	});
	return {
		port,
		conns,
		received,
		get authAttempts() {
			return authAttempts;
		},
		get unauthorizedSeen() {
			return unauthorizedSeen;
		},
		publicKeyB64: Buffer.from(serverKeys.publicKey).toString("base64"),
		close: () =>
			new Promise<void>((resolve) => {
				for (const c of wss.clients) c.terminate();
				wss.close(() => resolve());
			})
	};
}

const defaultBehavior = (over: Partial<Behavior> = {}): Behavior => ({
	token: "secret-token-xyz",
	authMode: "ok",
	onRequest: (req, c) => {
		if (req.method === "runtime.clientCapabilities.update") c.reply({ id: req.id, ok: true, result: {} });
		else if (req.method === "status.get") c.reply({ id: req.id, ok: true, result: { ok: true } });
	},
	...over
});

function waitFor(cond: () => boolean, ms = 3000, what = "condition"): Promise<void> {
	return new Promise((resolve, reject) => {
		const t0 = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - t0 > ms) return reject(new Error(`timed out waiting for ${what}`));
			setTimeout(tick, 10);
		};
		tick();
	});
}

const FAST = { reconnectDelaysMs: [20, 20, 20], livenessIdleMs: 60_000 };

describe("OrcaConnection against Orca's desktop-side E2EE v2 session", { skip }, () => {
	const cleanups: (() => void | Promise<void>)[] = [];
	afterEach(async () => {
		for (const c of cleanups.splice(0).reverse()) await c();
	});

	async function setup(over: Partial<Behavior> = {}, opts: { offerKey?: string; endpointOverride?: boolean } = {}) {
		const behavior = defaultBehavior(over);
		const server = await startServer(behavior);
		cleanups.push(() => server.close());
		const offer: PairingOffer = {
			v: 2,
			// A bogus offer endpoint proves the override is used.
			endpoint: opts.endpointOverride === false ? `ws://127.0.0.1:${server.port}` : "ws://203.0.113.9:1",
			deviceToken: behavior.token,
			publicKeyB64: opts.offerKey ?? server.publicKeyB64
		};
		const logs: string[] = [];
		const conn = new OrcaConnection({
			offer,
			endpoint: opts.endpointOverride === false ? undefined : `ws://127.0.0.1:${server.port}`,
			capabilities: ["test.capability.v1"],
			log: (l, m) => logs.push(`${l}: ${m}`),
			timing: FAST
		});
		cleanups.push(() => conn.stop());
		return { server, conn, logs, behavior };
	}

	it("handshakes, sends capabilities, then answers an encrypted call", async () => {
		const { server, conn, logs } = await setup({
			onRequest: (req, c) => {
				if (req.method === "echo") c.reply({ id: req.id, ok: true, result: { got: req.params, host: req.executionHost ?? null }, _meta: { runtimeId: "r1" } });
				else defaultBehavior().onRequest(req, c);
			}
		});
		const states: ConnectionState[] = [];
		conn.onState((s) => states.push(s));
		let connectedEvents = 0;
		conn.on("connected", () => connectedEvents++);
		conn.start();
		await waitFor(() => conn.state === "connected", 3000, "connected");
		assert.equal(connectedEvents, 1);
		assert.ok(states.includes("connected"));
		// capabilities arrive before 'connected' and as the first request
		const first = server.received[0]!;
		assert.equal(first.method, "runtime.clientCapabilities.update");
		assert.deepEqual(first.params, { clientCapabilities: ["test.capability.v1"] });

		const res = await conn.call<{ got: unknown; host: string | null }>("echo", { a: 1 });
		assert.deepEqual(res, { got: { a: 1 }, host: null });
		const hosted = await conn.call<{ host: string }>("echo", {}, { executionHost: "runtime:env1" });
		assert.equal(hosted.host, "runtime:env1");
		// the token never reaches the logs
		assert.ok(!logs.join("\n").includes("secret-token-xyz"));
	});

	it("uses the endpoint from the offer when no override is given", async () => {
		const { conn } = await setup({}, { endpointOverride: false });
		conn.start();
		await waitFor(() => conn.state === "connected");
	});

	it("rejects ok:false replies with OrcaRpcError and times out silent calls", async () => {
		const { conn } = await setup({
			onRequest: (req, c) => {
				if (req.method === "boom") c.reply({ id: req.id, ok: false, error: { code: "not_found", message: "no such thing", data: { x: 1 } } });
				else if (req.method === "silent") return;
				else defaultBehavior().onRequest(req, c);
			}
		});
		conn.start();
		await waitFor(() => conn.state === "connected");
		await assert.rejects(conn.call("boom"), (e: unknown) => {
			assert.ok(e instanceof OrcaRpcError);
			assert.equal(e.code, "not_found");
			assert.equal(e.message, "no such thing");
			assert.deepEqual(e.data, { x: 1 });
			return true;
		});
		await assert.rejects(conn.call("silent", {}, { timeoutMs: 50 }), (e: unknown) => e instanceof OrcaRpcError && e.code === "timeout");
	});

	it("delivers streaming frames to subscribe() and stops after close()", async () => {
		const { conn, server } = await setup({
			onRequest: (req, c) => {
				if (req.method === "things.subscribe") {
					c.reply({ id: req.id, ok: true, streaming: true, result: { type: "ready", subscriptionId: "sub-1" } });
					c.reply({ id: req.id, ok: true, streaming: true, result: { type: "snapshot", items: [1, 2] } });
				} else defaultBehavior().onRequest(req, c);
			}
		});
		conn.start();
		await waitFor(() => conn.state === "connected");
		const frames: any[] = [];
		const sub = conn.subscribe("things.subscribe", {}, (f) => frames.push(f));
		await waitFor(() => frames.length === 2, 3000, "two frames");
		assert.equal(frames[0].type, "ready");
		assert.deepEqual(frames[1], { type: "snapshot", items: [1, 2] });
		const id = server.received.find((r) => r.method === "things.subscribe")!.id;
		server.conns[0]!.reply({ id, ok: true, streaming: true, result: { type: "updated", n: 1 } });
		await waitFor(() => frames.length === 3);
		sub.close();
		server.conns[0]!.reply({ id, ok: true, streaming: true, result: { type: "updated", n: 2 } });
		await new Promise((r) => setTimeout(r, 80));
		assert.equal(frames.length, 3);
	});

	it("sends the matching unsubscribe for ready-id streams on close()", async () => {
		const { conn, server } = await setup({
			onRequest: (req, c) => {
				if (req.method === "notifications.subscribe") c.reply({ id: req.id, ok: true, streaming: true, result: { type: "ready", subscriptionId: "n-9" } });
				else defaultBehavior().onRequest(req, c);
			}
		});
		conn.start();
		await waitFor(() => conn.state === "connected");
		const frames: unknown[] = [];
		const sub = conn.subscribe("notifications.subscribe", {}, (f) => frames.push(f));
		await waitFor(() => frames.length === 1);
		sub.close();
		await waitFor(() => server.received.some((r) => r.method === "notifications.unsubscribe"));
		assert.deepEqual(server.received.find((r) => r.method === "notifications.unsubscribe")!.params, { subscriptionId: "n-9" });
	});

	it("refuses a host whose key is not the pinned one", async () => {
		const other = Buffer.from(nacl.box.keyPair().publicKey).toString("base64");
		const { conn, server } = await setup({}, { offerKey: other });
		conn.start();
		await waitFor(() => /security key/.test(conn.lastError), 3000, "refusal");
		assert.notEqual(conn.state, "connected");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(server.authAttempts, 0, "must never send the token to an unpinned host");
		assert.notEqual(conn.state, "connected");
	});

	it("treats a 4001 close after the handshake as unauthorized and does not retry", async () => {
		const { conn, server } = await setup({ authMode: "revoked" });
		const states: ConnectionState[] = [];
		conn.onState((s) => states.push(s));
		conn.start();
		await waitFor(() => conn.state === "unauthorized", 3000, "unauthorized");
		assert.match(conn.lastError, /pair again/i);
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(server.authAttempts, 1, "no reconnect after 4001");
		assert.equal(conn.state, "unauthorized");
		await assert.rejects(conn.call("x"), (e: unknown) => e instanceof OrcaRpcError && e.code === "not_connected");
	});

	it("also goes unauthorized on a bare 4001 close (no sealed error)", async () => {
		const { conn, server } = await setup({ authMode: "close4001" });
		conn.start();
		await waitFor(() => conn.state === "unauthorized");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(server.authAttempts, 1);
	});

	it("reconnects after the server drops, fails in-flight calls, and re-subscribes", async () => {
		const { conn, server } = await setup({
			onRequest: (req, c) => {
				if (req.method === "things.subscribe") {
					c.reply({ id: req.id, ok: true, streaming: true, result: { type: "ready", subscriptionId: `s${c.requests.length}` } });
					c.reply({ id: req.id, ok: true, streaming: true, result: { type: "snapshot", gen: server.conns.indexOf(c) } });
				} else if (req.method === "silent") return;
				else defaultBehavior().onRequest(req, c);
			}
		});
		conn.start();
		await waitFor(() => conn.state === "connected");
		const frames: any[] = [];
		conn.subscribe("things.subscribe", { q: 1 }, (f) => frames.push(f));
		await waitFor(() => frames.some((f) => f.type === "snapshot" && f.gen === 0));
		const inflight = conn.call("silent", {}, { timeoutMs: 5000 });
		await waitFor(() => server.received.some((r) => r.method === "silent"));
		const downStates: ConnectionState[] = [];
		conn.onState((s) => downStates.push(s));
		server.conns[0]!.ws.terminate();
		await assert.rejects(inflight, (e: unknown) => e instanceof OrcaRpcError && e.code === "disconnected");
		await waitFor(() => frames.some((f) => f.type === "snapshot" && f.gen === 1), 3000, "snapshot on 2nd connection");
		assert.equal(conn.state, "connected");
		assert.ok(downStates.includes("offline"));
		const resub = server.conns[1]!.requests.find((r) => r.method === "things.subscribe")!;
		assert.deepEqual(resub.params, { q: 1 });
		// calls work again
		assert.deepEqual(await conn.call("status.get"), { ok: true });
	});

	it("drops the connection when the host stops answering liveness probes", async () => {
		const behavior = defaultBehavior({ onRequest: (req, c) => { if (req.method !== "status.get") defaultBehavior().onRequest(req, c); } });
		const server = await startServer(behavior);
		cleanups.push(() => server.close());
		const conn = new OrcaConnection({
			offer: { v: 2, endpoint: `ws://127.0.0.1:${server.port}`, deviceToken: behavior.token, publicKeyB64: server.publicKeyB64 },
			capabilities: [],
			timing: { reconnectDelaysMs: [20], livenessIdleMs: 40, livenessProbeTimeoutMs: 40, livenessMissedLimit: 2 }
		});
		cleanups.push(() => conn.stop());
		// Read the reason as the connection drops: a fast reconnect clears it again.
		const dropReasons: string[] = [];
		conn.onState((s) => { if (s === "offline") dropReasons.push(conn.lastError); });
		conn.start();
		await waitFor(() => conn.state === "connected");
		await waitFor(() => server.conns.length >= 2, 3000, "reconnect after dead probes");
		assert.ok(dropReasons.some((r) => /stopped responding/.test(r)), `drop reasons: ${JSON.stringify(dropReasons)}`);
	});
});

if (!haveOrca) console.log(skip);
