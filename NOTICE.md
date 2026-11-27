# Third-party notices

Orca Deck vendors a small part of the Orca source code (pairing-code parsing and the
end-to-end-encrypted v2 client handshake and framing) under `src/orca/vendor/`, so that it can
talk to the Orca desktop app the same way Orca's mobile companion does.

Source: https://github.com/stablyai/orca at commit 8538b07f9a4.

Vendored files (all from `src/shared/` in that repository; each carries a header comment
listing any local changes):

- `mobile-pairing-protocol-limits.ts`
- `mobile-pairing-base64.ts`
- `e2ee-crypto.ts`
- `mobile-e2ee-v2-contract.ts`
- `mobile-e2ee-v2-framing.ts`
- `mobile-e2ee-v2-node-key-schedule.ts`
- `paired-e2ee-primitives.ts`
- `paired-e2ee-node-primitives.ts`
- `paired-e2ee-client-handshake.ts` (device-key credential path removed)
- `paired-e2ee-v2-client-session.ts`
- `paired-e2ee-handshake-deadline.ts`
- `structured-agent-session-fingerprint.ts` (from `src/shared/agent-session/lifecycle/structured-agent-session-mutation.ts`; only the payload fingerprint and operation id helpers, sha256 via node:crypto)

`src/orca/pairing.ts` re-implements the pairing-offer validation of `pairing.ts` and
`mobile-relay-pairing-offer.ts` by hand (no zod) and `src/orca/connection.ts` re-implements the
client behaviour of Orca's `mobile/src/transport/rpc-client*.ts`.

## Orca license (MIT)

MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
