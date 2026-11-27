// Parses an Orca mobile pairing code (orca://pair?code=<base64url JSON>, or the bare code).
// Mirrors stablyai/orca src/shared/pairing.ts + mobile-relay-pairing-offer.ts @ 8538b07f9a4 (MIT),
// with the zod schema replaced by hand-written validation and friendlier error messages.
import { normalizePairingBase64 } from './vendor/mobile-pairing-base64'
import {
	PAIRING_DEVICE_TOKEN_MAX_CHARACTERS,
	PAIRING_ENDPOINT_MAX_CHARACTERS,
	PAIRING_INPUT_MAX_CHARACTERS,
	PAIRING_PUBLIC_KEY_MAX_CHARACTERS
} from './vendor/mobile-pairing-protocol-limits'

export const PAIRING_OFFER_VERSION = 2

export type PairingOffer = {
	v: 2;
	/** Desktop WebSocket endpoint, e.g. ws://192.168.1.5:6768 */
	endpoint: string;
	/** Secret bearer token. Never log it. */
	deviceToken: string;
	/** Desktop Curve25519 public key (base64, 32 bytes). Pinned: the handshake must present this key. */
	publicKeyB64: string;
	pairedDeviceId?: string;
	scope?: "mobile" | "runtime";
	/** Relay details are parsed but unused: only direct endpoints are supported. */
	relay?: Record<string, unknown>;
	hostDescriptor?: { installationId: string; machineBinding?: string };
};

const HOST_ID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const MACHINE_BINDING = /^[A-Za-z0-9_-]{43}$/;

export class PairingCodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PairingCodeError";
	}
}

function bad(message: string): never {
	throw new PairingCodeError(message);
}

/** Accepts `orca://pair?code=...`, `orca://pair#...`, or the bare base64/base64url code. Throws PairingCodeError. */
export function parsePairingCode(input: string): PairingOffer {
	if (typeof input !== "string") bad("Paste the pairing code from Orca (Settings > Mobile).");
	if (input.length > PAIRING_INPUT_MAX_CHARACTERS) bad("That pairing code is far too long to be real.");
	const trimmed = input.trim();
	if (!trimmed) bad("Paste the pairing code from Orca (Settings > Mobile).");

	let code: string;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
		code = extractCode(trimmed);
	} else {
		code = trimmed;
	}

	let json: string;
	try {
		json = Buffer.from(normalizePairingBase64(code), "base64").toString("utf-8");
	} catch {
		bad("That doesn't look like an Orca pairing code (it isn't valid base64).");
	}
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		bad("That doesn't look like an Orca pairing code (the contents aren't readable).");
	}
	return validateOffer(raw);
}

function extractCode(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		bad("That link isn't a valid Orca pairing link.");
	}
	// Exact host prevents prefixes such as orca://pairing from being accepted.
	if (parsed.protocol !== "orca:" || parsed.hostname !== "pair") {
		bad("That link isn't an Orca pairing link (it should start with orca://pair).");
	}
	if (parsed.pathname !== "" && parsed.pathname !== "/") {
		bad("That link isn't an Orca pairing link (it should start with orca://pair).");
	}
	const code = parsed.searchParams.get("code") || (parsed.hash ? parsed.hash.slice(1) : "");
	if (!code) bad("That Orca pairing link has no code in it.");
	return code;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string, max: number, label: string): string {
	const v = obj[key];
	if (typeof v !== "string" || v.length === 0) bad(`The pairing code is missing its ${label}.`);
	if (v.length > max) bad(`The pairing code's ${label} is too long.`);
	return v;
}

function validateOffer(raw: unknown): PairingOffer {
	if (!isRecord(raw)) bad("That doesn't look like an Orca pairing code.");
	if (raw.v !== PAIRING_OFFER_VERSION) {
		bad(
			`This pairing code is version ${String(raw.v)}, but Orca Deck needs version ${PAIRING_OFFER_VERSION}. Update Orca and generate a fresh code.`
		);
	}
	const endpoint = requireString(raw, "endpoint", PAIRING_ENDPOINT_MAX_CHARACTERS, "address");
	const deviceToken = requireString(raw, "deviceToken", PAIRING_DEVICE_TOKEN_MAX_CHARACTERS, "device token");
	const publicKeyB64 = requireString(raw, "publicKeyB64", PAIRING_PUBLIC_KEY_MAX_CHARACTERS, "security key");

	let key: Buffer;
	try {
		key = Buffer.from(publicKeyB64, "base64");
	} catch {
		key = Buffer.alloc(0);
	}
	if (publicKeyB64.length > 44 || key.length !== 32) bad("The pairing code's security key is malformed.");

	try {
		const u = new URL(endpoint);
		if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new Error("scheme");
	} catch {
		bad("The pairing code's address isn't a ws:// or wss:// URL.");
	}

	const offer: PairingOffer = { v: 2, endpoint, deviceToken, publicKeyB64 };

	if (raw.pairedDeviceId !== undefined) {
		if (typeof raw.pairedDeviceId !== "string" || !raw.pairedDeviceId || raw.pairedDeviceId.length > 128) {
			bad("The pairing code's device id is malformed.");
		}
		offer.pairedDeviceId = raw.pairedDeviceId;
	}
	if (raw.scope !== undefined) {
		if (raw.scope !== "mobile" && raw.scope !== "runtime") bad("The pairing code has an unknown scope.");
		offer.scope = raw.scope;
	}
	if (raw.relay !== undefined) {
		if (!isRecord(raw.relay)) bad("The pairing code's relay details are malformed.");
		if (raw.scope === "runtime") bad("The pairing code mixes relay and runtime scope.");
		offer.relay = raw.relay;
	}
	// A descriptor this build can't read is dropped, never a reason to refuse pairing (same as Orca).
	const hd = raw.hostDescriptor;
	if (isRecord(hd) && typeof hd.installationId === "string" && HOST_ID.test(hd.installationId)) {
		if (hd.machineBinding === undefined) offer.hostDescriptor = { installationId: hd.installationId };
		else if (typeof hd.machineBinding === "string" && MACHINE_BINDING.test(hd.machineBinding)) {
			offer.hostDescriptor = { installationId: hd.installationId, machineBinding: hd.machineBinding };
		}
	}
	return offer;
}

/** Test/tooling helper: encodes an offer as orca://pair?code=<base64url>. */
export function encodePairingOffer(offer: PairingOffer): string {
	const b64 = Buffer.from(JSON.stringify(offer), "utf-8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return `orca://pair?code=${b64}`;
}
