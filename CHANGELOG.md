# Changelog

## 0.2.0

- security: owner-only access is now the default; explicit allowlist and open modes are visible and auditable.
- security: bounded WebSocket parser, max payload enforcement, CSPRNG device/DH entropy, and ACK-after-validation.
- reliability: connection readiness waits for CONNACK, disconnect drains, and fatal registration failures trigger re-registration.
- reliability: final reply close semantics await in-flight sends; per-conversation queue backpressure prevents unbounded work.
- privacy: outbound logs no longer include message text; internal startup failures are redacted before chat delivery.
- quality: added parser/presenter regression tests and hermetic npm check scripts.

## 0.1.0

- Initial text-only Octo IM channel release.
