# Phase 4 native reservation/absence authority — local source qualification

Date: 2026-09-26

Branch: `integration/meri-provisional-346-20260925`

## Outcome

The pinned worker's native idempotency store now contains the atomic primitive needed by unknown-worker-ID recovery. A reservation and an absence seal use the same SQLite `BEGIN IMMEDIATE` authority and the same native authenticated scope plus idempotency key. Exactly one can win. This is a dormant source/image foundation, not an activation or proof that network-filesystem SQLite is safe across production hosts.

This foundation commit itself exposed no endpoint. The follow-up [signed worker endpoint](meri-phase4-reservation-recovery-endpoint-source-20260926.md) now exposes it only behind a second default-off flag, but the API still cannot consume an absence seal, no reconciler is registered, and no deployment occurred.

## Contract

- Every guarded reservation persists the API-authenticated `requestSha256`; raw prompts, request bodies, dispatch bearers and native API keys are not copied into the store.
- `lookup_or_seal_absent` accepts only a 64-character lowercase SHA-256 digest, a passed delivery cutoff, and a future retention horizon.
- Before the cutoff an absent key returns `too_early` and changes nothing.
- At or after the cutoff, the worker takes `BEGIN IMMEDIATE`, samples its clock while holding the write authority, and either returns the exact existing reservation or inserts one durable absence tombstone.
- An exact tombstone replay returns the same seal. A different request digest conflicts.
- Future guarded lookups and reservations consult the tombstone first, so a delayed POST cannot create a run after absence was sealed.
- Existing/migrated guarded reservations without the authenticated request digest conflict rather than being treated as a match.
- The native POST handler passes the verified dispatch-bearer digest into both lookup sites and the reservation. A sealed dispatch fails with `phase4_dispatch_sealed_absent` before agent/provider launch.
- Tombstones are deliberately not pruned in this package. That is conservative; a separately reviewed purge may remove them only after the full late-delivery horizon and every ingress path share a proven authority.

## Evidence

- Exact pinned-archive overlay: 1/1 passed, including reopen persistence, exact/conflicting seal replay, delayed POST denial, no delayed reservation row, and reservation-versus-seal two-connection races.
- The race test passed in ten consecutive isolated pinned-image runs. Every run produced exactly one authority row: either `(reservation created, lookup reused)` or `(seal installed, POST sealed_absent)`.
- Worker claim, recovery, tool-view, and pinned-archive selection: 37/37 passed.
- Fresh local image: `meri-hermes-worker@sha256:534ae5714696831a65b4f891c388cfd4587c6f9d2035ea24caff22088200e540`.
- The image's exact 15-entry overlay manifest passed `sha256sum -c`.
- `git diff --check` passed.

## Remaining safety gates

The signed native reservation query/receipt endpoint binds immutable dispatch identity, route/generation/credential, native scope inputs, operation/nonce, cutoff and retention horizon. The follow-up [API peer](meri-phase4-reservation-recovery-api-source-20260926.md) now accepts only that signed observation, serializes absence under the claim authority fence, durably binds a discovered late worker ID, and qualifies claim/revoke/seal database races. It remains dormant and unregistered; all-ingress routing still needs production qualification.

Broker-effect idempotency receipts, reconciler ownership/scheduling, production credential custody, the hardened PUBLIC-routine baseline, single-writer/topology/durability/rollback proof, Phase 5 adjudication, Phase 6 representative live evidence, deployed QA and explicit user GO remain open. This package authorizes none of them.
