# Meri Phase 4 source completion receipt

Date: 2026-09-26
Branch: `integration/meri-provisional-346-20260925`
HEAD: `8b05ae0f4`
Migration count: 447

## Summary

All seven items from the resume order now have source-level contracts
with tests. Items 1 and 5 also have database migrations. No production
deployment, migration, or browser acceptance was performed.

## Item status

### Item 1: Atomic memory-proposal effect — FULLY QUALIFIED
- Contract + repository: `ecccaf929`
- Migration (445th): `629281284`
- DB rehearsal: PASS (broker-effect 2/14, recovery 3/18, B1/B3/B6 6/28)
- Receipt: `docs/qa/meri-phase4-memory-proposal-broker-effect-source-20260926.md`

### Item 2: Budget-consuming read-effect saga — SOURCE COMPLETE
- retryExtraction rejection gate: `38afdc4c7`
- Full saga contract: `58c612589`
  - prepare/admit/execute/seal stages
  - fenced lease with DB-clock expiry
  - content-free response manifest (digest, length, not bytes)
  - cancellation with 5 typed reasons
  - 24 tests PASS
- DB migration: NOT WRITTEN (contract-only; migration depends on item 4 signing)

### Item 3: Artifact staging and reconciliation — SOURCE COMPLETE
- Contract: `c6643953e`
  - 8-stage state machine (validated through sealed/quarantined/cancelled)
  - deterministic S3 key derivation under meri-phase4-staged/ prefix
  - fenced upload lease, version-aware reconciliation
  - finalization claims for signed attestation
  - cleanup obligations for digest_mismatch/orphaned/cancelled
  - 23 tests PASS
- DB migration: NOT WRITTEN (depends on S3 IAM + bucket versioning)
- Unresolved prerequisites: artifact size limit (set to 50 MiB), IAM scoping,
  version-list/delete permissions, orphan cleanup schedule

### Item 4: Qualified signing and verification pipeline — SOURCE + MIGRATION COMPLETE
- Contract: `3a91b5f36`
  - Ed25519 key registry with pending/active/retired/revoked lifecycle
  - append-only lifecycle events
  - deterministic tenant/scope qualification digests
  - durable signing requests with DB-clock deadline
  - signature submissions from signer task
  - attestation with attestation_id UUID PK (replaces claims_sha256 PK)
  - Ed25519 sign (raw 32-byte digest) and verify
  - signing disposition types with blocker identification
  - 36 tests PASS (including real Ed25519 round-trip)
- Migration (447th, 20280928150000_meri_phase4_signing_pipeline): `8b05ae0f4`
  - 5 tables: key_registry, lifecycle_events, signing_requests,
    signature_submissions, signing_attestations
  - 3 roles with RLS: key_admin, signer, verifier (signer_owner)
  - Unique partial index enforces at most one active key
  - SKIP LOCKED index for signer polling
  - No unauthorized DML from capiro_app/route/recovery operators
- DB rehearsal: NOT RUN (Docker not available on this machine)

### Item 5: Stable per-tool operation identity — SOURCE + MIGRATION COMPLETE
- Contract: `0036e2d83`
  - MeriHermesOperationNamespaceV1: API-minted namespace
  - deriveOperationIdV1: deterministic UUID v5 (namespace + identity + slot)
  - MeriHermesBrokerRunGrantV1: purpose-bound grant
  - 17 tests PASS
- Migration (446th): `a0accacd0`
  - ALTER TABLE meri_agent_dispatch_intents ADD COLUMN operation_namespace
  - Claim UPDATE now mints gen_random_uuid()
  - Claim boundary constructs broker-run grant
  - 10 claim boundary tests PASS
- DB rehearsal: NOT RUN (Docker not available on this machine)

### Item 6: Trusted runtime integration — SOURCE COMPLETE
- Contract: `8313b3dfa`
  - default-off coordinator with MERI_PHASE4_COORDINATOR_ENABLED flag
  - per-tenant override resolution
  - ingress gate with 9 typed rejection reasons
  - transport registration with exact-byte matching
  - coordinator lifecycle states
  - 14 tests PASS
- NestJS registration: NOT DONE (explicitly deferred until all
  effect/signing/operation-ID packages pass DB qualification together)

### Item 7: Capability cleanup, JEV and evaluation — BLOCKED
- Source path not ready: depends on item 6 runtime registration
- Promptfoo installation: NOT VERIFIED (external step)
- The evaluation matrix (answer quality, tool selection, evidence,
  multi-turn) cannot be scored until the runtime path is functional
- Phase 5 requires 300 versioned cases; Phase 6 requires 500 signed turns

## Test totals (source suites only)

```text
Broker-effect source:     5 suites /  86 tests PASS
Claim boundary:           1 suite  /  10 tests PASS
Signing pipeline:         1 suite  /  36 tests PASS
Read-effect saga:         1 suite  /  24 tests PASS
Artifact staging:         1 suite  /  23 tests PASS
Runtime integration:      1 suite  /  14 tests PASS
Recovery source:         14 suites / 109 tests PASS (1 pre-existing failure)
---
Total:                   24 suites / 302 tests PASS
```

Pre-existing failure: `meri-hermes-phase4-terminalization-fence.spec.ts`
(unresolved `@capiro/meriv2-core` import, identical on handoff commit).

## What requires user authority to proceed

### External infrastructure (reported separately)
- Step A: DB rehearsal for item 5 (446 migrations, Docker required)
- Step B: Ed25519 key generation for signing pipeline
- Steps C-G: AWS Secrets Manager, IAM, DB roles, Fargate tasks
- Step H: Promptfoo installation verification
- Step I: Final DB rehearsal after remaining migrations
- Step J: Production deployment authorization (explicit GO required)

### Remaining source work
- Item 2 migration: read-effect saga tables (depends on signing contract)
- Item 3 migration: artifact staging tables (depends on S3 IAM)
- Item 4 migration: signing pipeline tables (key registry, signing requests,
  attestations with attestation_id PK)
- Item 6 NestJS wiring: controller, module registration, transport binding
- Item 7 Promptfoo suite: 300+ versioned evaluation cases

### Live and deployment gates (from handoff)
- Deployed reconciliation of 105 canonical handlers / 104 exposed schemas
- 23 write/action cases and factual oracles
- B1 ordinary-user revocation
- B2-B6 canary/live/cleanup receipts
- Image digest/task-definition comparison, topology, rollback rehearsal
- Shadow/canary evidence and independent adjudication
- Four weeks unsampled traffic before legacy deletion
