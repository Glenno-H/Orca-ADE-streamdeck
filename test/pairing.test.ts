import assert from "node:assert/strict";
import { describe, it } from "node:test";
import nacl from "tweetnacl";
import { encodePairingOffer, parsePairingCode, type PairingOffer } from "../src/orca/pairing";

const key = Buffer.from(nacl.box.keyPair().publicKey).toString("base64");
const offer: PairingOffer = {
	v: 2,
	endpoint: "ws://192.168.1.20:6768",
	deviceToken: "tok-abc_123",
	publicKeyB64: key,
	pairedDeviceId: "dev-1",
	scope: "mobile"
};
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("parsePairingCode", () => {
	it("round-trips orca://pair?code=", () => {
		const url = encodePairingOffer(offer);
		assert.ok(url.startsWith("orca://pair?code="));
		assert.deepEqual(parsePairingCode(url), offer);
		assert.deepEqual(parsePairingCode(`  ${url}\n`), offer);
	});

	it("accepts a bare base64url code without padding and a bare padded base64 code", () => {
		const code = b64url(offer);
		assert.ok(!code.includes("="));
		assert.deepEqual(parsePairingCode(code), offer);
		assert.deepEqual(parsePairingCode(Buffer.from(JSON.stringify(offer)).toString("base64")), offer);
	});

	it("accepts a #fragment code and keeps relay data without using it", () => {
		const withRelay = { ...offer, relay: { v: 1, whatever: true } };
		const parsed = parsePairingCode(`orca://pair#${b64url(withRelay)}`);
		assert.equal(parsed.endpoint, offer.endpoint);
		assert.deepEqual(parsed.relay, withRelay.relay);
	});

	it("drops an unreadable hostDescriptor instead of failing", () => {
		const parsed = parsePairingCode(b64url({ ...offer, hostDescriptor: { installationId: "nope" } }));
		assert.equal(parsed.hostDescriptor, undefined);
	});

	it("gives clear errors for junk", () => {
		assert.throws(() => parsePairingCode(""), /Paste the pairing code/);
		assert.throws(() => parsePairingCode("this is not a code!!"), /isn't valid base64|doesn't look like/);
		assert.throws(() => parsePairingCode(Buffer.from("hello").toString("base64url")), /aren't readable/);
		assert.throws(() => parsePairingCode("orca://pairing?code=abc"), /isn't an Orca pairing link/);
		assert.throws(() => parsePairingCode("orca://pair"), /no code/);
		assert.throws(() => parsePairingCode(b64url([1, 2])), /doesn't look like an Orca pairing code/);
	});

	it("rejects the wrong version", () => {
		assert.throws(() => parsePairingCode(b64url({ ...offer, v: 1 })), /version 1.*needs version 2/);
	});

	it("rejects a missing or malformed key / token / endpoint", () => {
		const { publicKeyB64: _k, ...noKey } = offer;
		assert.throws(() => parsePairingCode(b64url(noKey)), /missing its security key/);
		assert.throws(() => parsePairingCode(b64url({ ...offer, publicKeyB64: "AAAA" })), /security key is malformed/);
		const { deviceToken: _t, ...noToken } = offer;
		assert.throws(() => parsePairingCode(b64url(noToken)), /missing its device token/);
		assert.throws(() => parsePairingCode(b64url({ ...offer, endpoint: "http://x" })), /ws:\/\/ or wss:\/\//);
		assert.throws(() => parsePairingCode(b64url({ ...offer, scope: "admin" })), /unknown scope/);
	});
});
