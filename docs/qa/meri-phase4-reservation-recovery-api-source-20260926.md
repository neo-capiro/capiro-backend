# Phase 4 API reservation recovery peer — local qualification

Date: 2026-09-26

Branch: `integration/meri-provisional-346-20260925`

## Outcome

The API now has a dormant, byte-compatible peer for the worker's signed unknown-worker-ID reservation endpoint. It can mint one exact lookup-or-seal command, send it to the already-authorized native worker origin, verify the exact signed response, and atomically commit either a stable late worker ID or authenticated absence under the shared Phase 4 authority fence.

Nothing registers this boundary as a Nest provider, controller, scheduler, reconciler, or runtime caller. No feature flag was enabled, no production credential was read, and no deployment or production request occurred.

## Wire and verification boundary

- The contract uses the worker's exact `mhrqc1`/`mhrqr1` canonical JSON, HMAC domains, native path, empty-body digest, route/generation/credential binding, operation ID, nonce, delivery cutoff, reconciliation horizon, retention horizon, and exclusive command/key windows.
- Command and receipt secrets must be distinct. Identity, claims, tokens, and key material are copied into immutable snapshots before the first await.
- Transport is one manual-redirect `POST` to the exact already-resolved HTTPS origin and path. It sends only `Authorization` and the reservation command header, sends an empty body, never retries, and treats redirects, aborts, network uncertainty, duplicate/missing receipt headers, unexpected status, and bodies over 64 KiB as unknown/failure.
- The boundary accepts only exact signed `reserved` or `sealed_absent` responses and verifies the native response digest against the raw bounded bytes. A plain miss, 404, unsigned response, or parseable-but-noncanonical body is never absence evidence.

## Atomic database boundary

- Persistence runs only in a separately provisioned privileged transaction that can `SET LOCAL ROLE meri_phase4_authority_owner`; `capiro_app` is rejected and receives no new write or execute path.
- Lock order is authority fence, exact source rows, intent row, then database clock. The exact source lock is a fixed tenant/run-bound `SECURITY DEFINER` routine executable only by the NOLOGIN recovery owner, avoiding mutation grants on scope, conversation, or message rows.
- An exact append-only operation anchor is inserted before either transition. The intent trigger permits a late `claimed` worker or early `sealed_absent` only for that owner, that exact anchor, after delivery expiry and before reconciliation/retention expiry. Ordinary application claim/seal rules are unchanged.
- `reserved` atomically binds the same worker ID to the API run and dispatch intent. `sealed_absent` stores the SHA-256 of the exact signed receipt token as the absence proof. Exact replay is idempotent; an ordinary claimed/sealed row without this operation provenance cannot be reinterpreted as recovery.
- Operations and receipts are append-only, forced-RLS tables with exact intent/operation foreign keys and unique receipt-digest, nonce, and signature fences. Raw command/receipt tokens, source text, bearer values, and key bytes are not persisted.

## Evidence

- Full API recovery command: 11 suites / 74 tests passed, followed by strict targeted TypeScript compilation.
- Reservation-specific unit/static coverage: contract 5/5, transport 6/6, boundary 6/6, repository 4/4, migration 7/7.
- Cross-language worker coverage: claim 11/11, tool view 14/14, known recovery 11/11, and reservation recovery 6/6, for 42/42 selected Python tests.
- Prisma schema validation and client generation passed.
- A fresh disposable PostgreSQL 16 + pgvector database exercised the reviewed PUBLIC-routine negative control, then applied all 440 migrations. The post-migration invariant was zero owner-role members, no owner schema-create privilege, and zero non-extension PUBLIC routines.
- Four live database tests passed: claim-first versus signed seal, exclusive revocation-fence-first versus seal, late reservation bind plus exact replay, and signed absence plus exact receipt-digest persistence.
- The checked-in rehearsal destroys its disposable container in `finally`; the shared development PostgreSQL was not modified.
- `git diff --check` passed.

## Remaining activation gates

This completes the dormant API source peer, not Phase 4 activation. A separately reviewed caller/reconciler still needs ownership, scheduling, module registration, credential custody/rotation, all-ingress/private-topology routing, and crash-safe operational monitoring. The production PUBLIC privilege baseline must be reconciled before migration.

`claimed` and `sealed_absent` remain admission facts, not proof about provider, broker, database, or external effects. Broker-effect idempotency and signed outcome receipts, known-worker Stop/status completion, production single-writer/durability/backup/rollback proof, image/deployed canaries, Phase 5 representative adjudication, Phase 6 live turns, and explicit deployment GO remain mandatory. This package authorizes none of them.
