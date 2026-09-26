# Phase 6 authenticated append boundary — source-only checkpoint

Date: 2026-09-25

This source slice moves the dormant Phase 6 event producer toward a trustworthy delivery boundary without enabling traffic. `capability-shadow-append-boundary.ts` composes the existing signed-event preparation helper with an injected append-only sink contract. It is exported as a library primitive but has no API provider, controller, worker, environment lookup, HTTP client, deployment setting, or runtime caller.

## Source guarantees

- `mode: "off"` returns before reading producer, registry, signer, trusted-time, or sink properties.
- `append_only` exact-byte pins and preflights a separate public sink-receipt registry before protected producer signing.
- The existing producer registry, event signature, pseudonym derivation, locked membership, and content-free event schema remain authoritative.
- Only final lifecycle observations may be appended. `attempted` and `dispatched` snapshots are refused, avoiding an immutable partial record under the one-event-per-turn identifier.
- The append authorization uses a separate fixed domain over the strict, canonical request payload. The authenticated request binds producer and sink registry digests, signed event, event-payload digest, audience, endpoint, and deterministic event-ID/idempotency key. An exported sink-side verifier rejects a UTF-8 BOM, malformed UTF-8, duplicate raw keys, noncanonical request JSON, registry-generation drift, event tampering, digest drift, invalid append authorization, expired producer authorization at trusted verification time, and event time beyond the bounded future skew before transactional storage.
- The injected sink is invoked once with a copy of a private canonical request snapshot. Callback mutation or later retention cannot change returned request bytes or their digest. A later caller may resubmit the same deterministic request after an ambiguous transport result; the sink contract must return the original ledger entry as `replayed` rather than append a duplicate.
- A bounded exact-byte receipt rejects a UTF-8 BOM, decodes as fatal UTF-8, and rejects duplicate raw JSON keys before strict-schema parsing. It is accepted only under the exact pinned audience/endpoint/key/fingerprint/window. It binds the request to an immutable positive safe-integer ledger sequence capped at `2^53 - 1`, predecessor digest, append time, event ID, idempotency key, and payload digest. The ledger-entry digest and receipt signature are recomputed locally. Receipt and append times are checked against injected trusted verification time plus at most five minutes of caller-selected future skew; the receipt key must also be valid at that trusted time.
- Neither requests nor results add prompt, answer, source, raw tenant, raw evaluation-unit, client, or tool-result content. No live-evidence or qualification field is emitted.

## Authored verification (not run under the RAM hold)

The focused spec covers a hostile-getter zero-touch off mode, an authenticated append, a true two-call deterministic replay with identical request bytes/digest/original ledger entry, sink registry pin/fingerprint rejection before producer signing, refusal of an in-flight lifecycle before authorization/delivery, raw-identifier absence, duplicate/noncanonical/BOM request rejection, the `2^53` ledger-sequence boundary, callback mutation/retention isolation, trusted-time expiry and future-skew rejection, exact request binding, and bad receipt authentication. Jest, typecheck, build, runtime, database, and live tests were not run in this checkpoint per the active low-memory instruction.

## Still required before live evidence

The injected callback is a contract, not a production sink. Acceptance still requires a reviewed transactional store that uniquely indexes `(audience, endpoint, idempotencyKey)`, rejects a different request digest for an existing key, durably chains entries, and returns the original entry on replay. It also requires approved key custody and rotation, authenticated private transport, source-of-truth observation and receipt clocks, bounded retry/lookup plus gap reconciliation, operational monitoring, runtime default-off wiring, exact-candidate tests, deployment, independently reviewed organic sampling, and the full 500-turn evidence set. The existing report continues to hold `liveEvidenceVerified:false` and `qualified:false`.
