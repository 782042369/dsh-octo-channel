# Changelog

## 0.3.1

- docs: the README is Chinese-first now, rebuilt from repository facts with a centered header, verified badges, highlights, quick install / quick start paths, a full configuration table, and troubleshooting notes.
- docs: added an icon under `assets/` (shipped in the npm package as well).
- docs: fixed the stale 0.2.0 install examples.

## 0.3.0

- performance: the WuKongIM session crypto now uses node:crypto (X25519 + AES-128-CBC + MD5), dropping the crypto-js, curve25519-js and md5-typescript runtime dependencies; the derived key/IV are pinned against the previous implementation by a test vector.
- performance: the frame parser accumulates bytes in one Uint8Array copy per chunk instead of a per-byte number array, cutting the memory ceiling of the 4 MiB buffer roughly 8x.
- reliability: long answers are chunked (`maxReplyChars`, default 3500) so a big reply cannot be rejected by the server.
- reliability: a turn whose host events stop arriving is finalized after `turnIdleTimeoutMs` (default 30 min), and the typing keep-alive stops after 10 min instead of pinging a chat forever.
- reliability: sendMessage/registerBot retry once more on transient network errors and 5xx answers (client_msg_no keeps retries idempotent); fatal re-registration backs off exponentially so two clients sharing one token cannot kick each other in a hot loop.
- reliability: the inbound handler can no longer reject into the host event loop, where an unhandled rejection would terminate the whole DSH process.
- quality: removed write-only conversation-binding state and dead socket helpers; the plugin version is read from package.json instead of being hard-coded.
- quality: added a crypto/framing regression suite (`scripts/crypto-test.mjs`).

## 0.2.0

- security: owner-only access is now the default; explicit allowlist and open modes are visible and auditable.
- security: bounded WebSocket parser, max payload enforcement, CSPRNG device/DH entropy, and ACK-after-validation.
- reliability: connection readiness waits for CONNACK, disconnect drains, and fatal registration failures trigger re-registration.
- reliability: final reply close semantics await in-flight sends; per-conversation queue backpressure prevents unbounded work.
- privacy: outbound logs no longer include message text; internal startup failures are redacted before chat delivery.
- quality: added parser/presenter regression tests and hermetic npm check scripts.

## 0.1.0

- Initial text-only Octo IM channel release.
