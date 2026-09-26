# Meri capability cleanup and JEV routing handoff

Date: 2026-09-26 (America/New_York)

## Repository and exact stop point

- Repository: `neo-capiro/capirov2`
- GitHub: `https://github.com/neo-capiro/capirov2`
- Branch: `integration/meri-provisional-346-20260925`
- Latest implementation commit: `ea644b15f66f16f9c1c8be2ae7192633fc3384aa`
- The remote branch tip containing this document is the authoritative resume point.

Clone or fetch the repository, check out the branch, verify local `HEAD` equals the remote branch,
and require a clean worktree before continuing. Do not transfer test claims to a different commit.

The implementation plan is not complete. Work stopped at a safe package boundary after the
dormant `meri_request_clarification` effect authority passed source, database, recovery and
B1/B3/B6 regressions. No production deployment, production migration, Meri prompt, provider run,
browser acceptance or live traffic was performed.

Deployment still requires a new, explicit user deployment **GO**. There is one production
environment and no staging environment. Do not infer deployment authority from this handoff.

## What is complete at this checkpoint

The branch already contains the earlier capability inventory and B1-B6 local repair packages,
Phase 4 exact dispatch identity/authority/tool-view foundations, worker claim and route binding,
durable recovery obligations, verified recovery-outcome application, and the dormant
`meri_record_turn` effect authority.

The newest package adds dormant `meri_request_clarification` authority and also corrects the
record-turn routine. Read
`docs/qa/meri-phase4-clarification-broker-effect-source-20260926.md` for the exact behavior and
qualification receipt.

Important current facts:

- The Prisma migration count is 444.
- Clarification and record-turn share one global operation-ID namespace.
- Both are run-local and valid on `readOnly:true` runs.
- Exact historical replay occurs before current authority checks.
- Replay identity excludes caller disposition. Attempt-first can be recovered by a later unknown
  query; unknown-first remains an unsigned tombstone and cannot execute later.
- Attempted effects rederive current authority under the tenant fence and serialize on the run.
- `maxToolCalls` is bounded to 40.
- Clarification commits budget, waiting status, interaction, event, operation and receipt in one
  PostgreSQL transaction.
- There is no runtime/Nest registration, caller credential, signer writer or scheduler.

Final qualification on the implementation commit:

- broker-effect source: 4 suites / 43 tests plus focused TypeScript;
- broker-effect database: 444 migrations, 2 suites / 14 tests;
- recovery source: 15 suites / 116 tests;
- recovery database: 3 suites / 18 tests;
- B1/B3/B6: 444 API migrations, 61 intel migrations, 6 suites / 28 tests;
- Prisma validation and whitespace checks passed.

The first broker-effect database run exposed a missing migration parenthesis. It was fixed, then
the complete disposable rehearsal passed from a fresh database. There are no retained rehearsal
containers.

## Hermes constraint and audit record

The user required every Hermes session to remain below 50% usage. Earlier package audits stayed
below the conservative 45% proxy. The final clarification audit did not: despite an explicit stop
before 70,000 aggregate/cache/reasoning tokens, Hermes reported 161,700 over 5 model calls, costing
an estimated USD 0.01943546. Aggregate per-call tokens are not a valid measure of peak context
occupancy, but the enforceable audit budget was missed. Do not run another Hermes session as part
of this stopped work cycle. A future agent must use a genuinely enforceable provider/tool-call
budget, not prompt text plus a post-run usage file.

Hermes made no edits or external actions. Its claimed unmatched-`END IF` blocker was false and is
disproved by the successful PostgreSQL migration/test gate. The remaining observations were
already covered by the separate database suite or were non-blocking comments about test-command
separation.

## Resume order

Continue in small, dormant, reviewable packages. Do not wire the live broker until all effect
families, signing, stable operation identity and recovery are qualified together.

### 1. Atomic memory-proposal effect

Use the next free migration timestamp after `20280928120000`.

Current behavior that must be preserved:

- Hermes always proposes with `sourceKind = model_extraction`.
- That source kind always yields `WARN` and a pending candidate, including `user_private`.
- A committed effect creates exactly one pending `memory_candidate`.
- Firm/client scope also creates one deterministic unassigned `review_request`.
- No `clio_memory`, `memory_items`, `memory_cleanup_outbox`, embedding, projection or review
  notification is created. Notifications begin only after reviewer assignment.

Use `operationId` as candidate ID and, for firm/client proposals, review-request ID. Validate and
normalize before budget reservation. Bind normalized key/value/scope/effective client/confidence/
source excerpt into the request digest, but keep raw proposal text out of operation and receipt
evidence. Confidence needs exact IEEE-754 bytes (`writeDoubleBE` / PostgreSQL `float8send`), not
locale-sensitive decimal text. Preserve JavaScript UTF-16 slicing for the source excerpt.

The atomic transaction must create the candidate/review request, increment budget once, append one
`memory.proposed` event, and insert operation/receipt. Personal proposals remain pending but have
no eager review row. Unauthorized client input must deny before consuming budget. Test that no
canonical memory or downstream outbox/projection rows appear.

### 2. Budget-consuming read-effect saga

`meri_memory_search` and `meri_fetch_attachment` are not transactionally pure reads.

- Memory search can create/update Context Plane packet metadata and always writes a content-free
  audit row.
- Attachment reads may return about 13.3 MiB of base64 plus extracted text.
- `retryExtraction=true` is a write saga. Its current select is unlocked, OCR may outlive the
  broker deadline, and concurrent operations can both extract.

Implement prepare/admit, execute and seal stages with one durable budget reservation and a fenced
lease. Store response digests and content-free manifests, not query text, excerpts, attachment
bytes or extracted text. Exact replay without encrypted result storage is not guaranteed: a
recomputed response may be released only if its digest matches the sealed receipt. Propagate the
stable operation ID into Context Plane request/audit identity before claiming idempotent retries.

The smallest safe first package rejects `retryExtraction=true` with a signed
`retry_requires_reconciler` result. Full support needs a resource-keyed extraction obligation and
lease, work outside the DB transaction, conditional final persistence, cancellation-aware timeout
handling and reconciliation.

### 3. Artifact staging and reconciliation

The live artifact path currently consumes budget, blind-PUTs to a random S3 key, and later creates
the database artifact and event. A crash can orphan objects or duplicate publication.

Use a protected durable payload spool and a staged state machine:

1. Validate and prepare under current authority; reserve budget once.
2. Claim a fenced upload lease.
3. Upload to a deterministic key with `If-None-Match: *`, checksum and operation metadata.
4. Reconcile exact bytes and S3 version history.
5. Atomically finalize one database artifact/event only for a selected immutable `VersionId`.
6. Seal a signed receipt; quarantine mismatches and create version-specific cleanup obligations.

Add `s3VersionId`, content digest/length and operation identity to new artifact rows. Preserve
latest-by-key behavior only for legacy rows. A committed receipt may prove one Capiro publication
and the selected version's exact bytes; it must never claim exactly one external PUT/version.

Unresolved prerequisites include one canonical artifact size limit, strict one-of text/base64
input, version-list/delete IAM scoped to the new prefix, payload retention, orphan cleanup and
version-specific downloads.

### 4. Qualified signing and verification pipeline

The current attestation table is a test-only dormant boundary. It has no key registry or writer.
Its `claims_sha256` primary key also prevents refreshing the same claims after the five-minute
attestation expires.

After effect schemas stabilize, add one shared signing pipeline:

- immutable qualified Ed25519 public-key registry and append-only activate/retire/revoke events;
- deterministic tenant/scope qualification digests;
- durable signing requests, append-only signature submissions and verifier-produced attestations;
- an `attestation_id` primary key plus deterministic latest-unexpired selection by claims digest;
- separate memberless signing, verification and key-admin capability roles;
- separate restricted signer/verifier login identities and DB credentials;
- signer-only access to one version-pinned Ed25519 PKCS#8 secret;
- verifier with public material only and no secret permission;
- DB-clock bounded leases, `SKIP LOCKED`, fresh fencing tokens, retry/quarantine and attestation
  refresh from an existing valid signature.

The signer signs the raw 32-byte digest, not ASCII hex. Never reuse
`MERI_HERMES_BROKER_SIGNING_KEY`; that is an unrelated HMAC credential. The API and ordinary
broker/recovery/route roles get no signing-table DML. Missing or revoked signing authority must
produce zero budget/domain/event effects. `signature_pending` is distinct from `effect_unknown`.

Keep signer and verifier as separate one-shot, immutable-image, private-subnet tasks whose
schedules synthesize disabled unless exact activation flags are supplied.

### 5. Stable per-tool operation identity

The current worker plugin receives a `task_id` only as an optional handler argument, discards it,
and has no vendored contract proving generation, persistence or retry stability. Prefetch and
sync-turn receive no such identifier. Do not treat it as authoritative.

Mint and persist an API-owned operation namespace in the successful Phase 4 run-claim transaction.
Return it in a purpose-bound broker-run grant. The worker overlay may allocate a per-run monotonic
slot, but the API derives the final operation UUID deterministically from the persisted namespace,
exact claimed dispatch identity and slot. Retries reuse the same slot; two intentional identical
calls get different slots. The worker must never choose or submit an arbitrary operation UUID.
PostgreSQL, not EFS SQLite, is the shared authority.

### 6. Trusted runtime integration

Only after the effect/signing/operation-ID packages pass together:

- register a default-off coordinator and exact-byte transport;
- add the private claim controller and deterministic dispatch bearer;
- use the source-qualified V2 route resolver and current tool view;
- enforce all ingress before provider, broker or memory effects, including MCP and background
  refresh paths;
- preserve Stop/unknown/recovery ordering and restart/crash/retention semantics;
- keep private keys and signer scheduling outside the general API process.

No shared worker-profile mutation is acceptable for request-local tool exposure.

### 7. Capability cleanup, JEV and evaluation

Complete Phase 2 result envelopes/observers and authoritative per-tool/per-skill eligibility before
making JEV choices executable. Offered names or schema fingerprints are not authorization. The JEV
path must preserve off-mode zero provider calls, deterministic fallback, strict registered choices,
cancellation and task-specific budgets. Keep live selection disabled.

Use the locally available Promptfoo installation for the requested Meri regressions once the source
path is ready. The matrix must independently score:

- answer support and exact factual fields;
- tool/skill selection and acceptable alternatives;
- retrieved evidence, provenance, coverage and continuation;
- multi-turn corrections, clarification and missing-context behavior;
- permission, unavailable-source, partial-result and action-governance cases.

Promptfoo is adequate as the regression runner/assertion harness, but it is not an authority or
ground-truth source. Server receipts, source-qualified fixtures and independent adjudication remain
required. Do not promote from synthetic labels alone.

Phase 5 still needs at least 300 versioned cases and 50 per promoted family with development,
calibration and locked-holdout splits. Phase 6 still needs at least 500 distinct representative
signed actual turns plus sink/key/clock/recovery/anti-fork integrity. Claim-support evaluation and
capability routing remain separate scorecards.

## Live and deployment gates still open

Do not fake or silently waive these:

- deployed reconciliation of 105 canonical handlers and 104 exposed schemas;
- 23 write/action cases and factual oracles;
- B1 ordinary-user revocation with a separately authorized non-admin identity;
- B2 egress canary, B3 live source controls, B4 displayed evidence chain, B5 private hop and B6
  attachment/entity/coverage cleanup receipts;
- exact target image digest/task-definition comparison, current topology and rollback rehearsal;
- representative shadow/canary evidence and independent adjudication;
- four weeks of unsampled traffic/consumer evidence before legacy runtime or alias deletion.

When source work reaches this boundary, report what requires user authority. Do not deploy or run
production browser/Meri acceptance without an explicit GO.

## First commands for the next agent

```text
git fetch origin
git checkout integration/meri-provisional-346-20260925
git pull --ff-only
git status --short
git rev-parse HEAD
pnpm --filter @capiro/api run verify:meri-phase4-broker-effects
```

Then read the newest exact package receipts under `docs/qa/`, starting with:

1. `meri-phase4-clarification-broker-effect-source-20260926.md`
2. `meri-phase4-record-turn-broker-effect-source-20260926.md`
3. `meri-phase4-recovery-outcome-application-source-20260926.md`
4. `meri-phase4-recovery-obligation-database-source-20260926.md`
5. `meri-b1-b6-exact-head-requalification-20260926.md`

All of these files are committed in the repository; this handoff depends on no machine-local
document or path.
