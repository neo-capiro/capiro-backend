# Phase 4 signed reservation recovery endpoint — local qualification

Date: 2026-09-26

Branch: `integration/meri-provisional-346-20260925`

## Outcome

The pinned worker now has a separate, default-off private endpoint for unknown-worker-ID reconciliation. It verifies a signed reservation command before native scope derivation or SQLite access, then returns a signed exact-byte receipt only for an existing reservation or an atomically installed absence tombstone.

This package does not register an API caller or reconciler and does not activate the endpoint. No deployment or production request occurred.

## Security contract

- The route is exactly `POST /v1/meri/phase4/reservations/lookup-or-seal`, with no query and an empty body.
- Native `Authorization` and exactly one `X-Meri-Dispatch-Reservation-Command` are required. A malformed, duplicate, expired, route-mutated, body-mutated or wrong-key command is rejected before store lookup.
- The command has a cryptographic domain/prefix distinct from status/Stop recovery and binds tenant/run/request identity, worker audience/ingress/generation/credential, idempotency key, delivery cutoff, reconciliation/retention horizons, operation ID, nonce, exact native target, key ID and an exclusive window of at most 60 seconds.
- The worker derives the native scope from the authenticated native request; the API never supplies an arbitrary scope.
- Only `reserved` and `sealed_absent` can receive a receipt. `too_early`, conflict, store error, receipt failure and every plain miss remain unsigned/unknown.
- A reserved receipt binds the exact worker run ID and normalized status. An absence receipt exists only after the native tombstone was installed and binds its seal time plus exact command retention horizon.
- Receipts use the separate recovery receipt secret plus a reservation-specific domain, bind the exact command token and exact response bytes, and require observation inside both command and key windows.
- Worker startup rejects reservation recovery unless claim and recovery v1 are also enabled. The main Phase 4 middleware admits only the exact private path, and the handler itself returns 404 while the feature flag is off.

## Evidence

- Python claim/tool-view/known-recovery/reservation-recovery plus pinned archive: 42/42 passed.
- Reservation protocol: 5/5 passed, including exact target/body/header checks, exclusive windows, wrong identity/key, exact response binding, same-secret rejection, and the rule that a plain miss cannot become a signed absence.
- Exact pinned archive overlay: 1/1 passed; authorization precedes `lookup_or_seal_absent`, which precedes receipt signing.
- Fresh local image: `meri-hermes-worker@sha256:247f1ba5b8b04fa5d79157a8c26cfc44d34485dc51a640a1a433167a26a8d260`.
- The exact 16-entry image manifest passed `sha256sum -c`.
- A disposable internal Docker network with no host port or external egress exercised the real listener and owned volume. Exact signed absence replay and exact signed reservation replay were byte-stable; the reservation returned `worker-run-reserved-proof`; a corrupted command returned 401 with no receipt. The container, network and volume were removed.
- `git diff --check` and entrypoint shell syntax passed.

## Remaining gates

The follow-up [API reservation recovery peer](meri-phase4-reservation-recovery-api-source-20260926.md) now supplies the byte-compatible contract, bounded transport, immutable snapshots, authority-fenced late-ID/absence commit, append-only receipts, and migrated claim/revoke/seal race qualification. It remains dormant and unregistered. No API path may accept an unsigned response or plain 404 as absence.

The local worker SQLite file is not production cross-host durability proof. Reconciler ownership/scheduling, broker-effect receipts, the production PUBLIC-routine baseline, credential custody/rotation, all-ingress/private-topology qualification, rollback rehearsal, Phase 5, Phase 6, deployed QA and explicit user GO remain open.
