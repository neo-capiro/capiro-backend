# Signed capture receipt persistence qualification

Candidate API source: `4aad73b881c2f33ebb0bc41ddf61514a34010ad7` (PR1929).
Immutable image: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:046691b41f6578df41a5cac1bb1e2dee561517463c68ce391cd9450e82489496`.
Qualification: **PASS**. Post-repair live smoke: **NOT RUN** at qualification time.
Full original File01 acceptance: **NOT RUN**; this is a repair release prerequisite.

## Reproduced defect and repair

The preceding reply-format fix, source `bae902c734eea220b4c6299423119e7bdaac2f6b`,
is deployed as orchestrator task definition89. Its new T1 browser smoke completed
one provider call but failed with `meri_capture_receipt_readback_mismatch` in the
API. T2 was not attempted. The ordinary T1 session was revoked and the failed
attempt and execution lock were retained. The error was a product failure, not
an authorization success or a passing exact-reply test.

An actual Prisma model-write probe on an owned loopback PostgreSQL database
reproduced `0.27222999999999997` becoming `0.27223` in JSON metadata; 487 of3003
samples differed. A separate JSON-text-to-JSONB probe preserved the numbers.
The model-write conversion invalidated the signed cost receipt during exact
readback. Both probes used random, rolled-back local schemas and verified cleanup.

The API now parameterizes JSON text for exactly the two signed metadata fields
and atomically merges those fields into the existing metadata object. It retains
tenant/user/conversation/client/message/assistant predicates, requires one updated
row, and retains exact readback equality, HMAC verification and current authority
checks. Unrelated metadata survives. No schema, provider, routing or permission
change is included. Ordinary captures use the same validation and signature rules.

## Actual qualification evidence

- API Jest:4 suites,56 tests passed, exit0.
- Actual PostgreSQL/Prisma integration:2 tests passed,0 skipped, exit0. Tests
  reproduce old-path signature corruption, verify repaired exact readback under
  generic and client scopes, preserve unrelated metadata, deny foreign actor
  access and deny revoked membership.
- Full API typecheck:exit0.
- Deterministic Promptfoo:26/26; custom verifier exit0, no model tokens.
  The runner reused previously qualified unchanged shared/core build output.
- Actual independent Hermes/Bedrock Kimi review:exit0, PASS. Its explanation
  incorrectly describes PostgreSQL JSONB as IEEE754 storage and `||` as a deep
  nested merge. Those descriptions are rejected: the reproduced loss is on the
  Prisma model JSON input path; the SQL operator performs the intended shallow
  top-level merge of two fields. Actual tests support the code verdict.
- First Jest attempt exhausted its default4GB heap; the unchanged suite passed
  at12GB. Initial local integration-harness DDL setup errors were corrected before
  the two actual passing tests. These were local setup failures, not skipped gates.

See `assertion-summary.json`, exact command exit receipts, offline report/summary,
Kimi review and `artifact-index.json` for original and archived hashes.

## Image and release compatibility

GitHub Actions run36967762919 failed at startup with no jobs for this exact source.
The authorized AWS fallback used the canonical GitHub source and native ARM64
build. Its first attempt failed before Docker: text-mode ECR pagination returned
multiple zero-count lines. The second recipe changes only that guard's output
mode to JSON; no source, test or tag-protection check was removed.

Build `capiro-build-web-dev:a3c11764-78a5-4c32-bfa7-08950c5415b6` succeeded.
Independent readback verifies resolved source, exact recipe hash, immutable ECR
digest and executed runtime import/repository-digest markers. The reviewed recipe
checks Node22.23.3, native architecture, OCI source label, packaged Prisma and
runtime imports. All449 packaged migration hashes match source. No migration
was applied and no ledger was changed. Automated tests above are local evidence;
the image build does not claim to rerun them.

The fix is compatible with the currently deployed schema and preserves the
existing capture contract. The forward schema remains in place for rollback;
the release operator must pin the previous API image and preserve every current
non-image setting, including the exact two approved synthetic tenants. Original
whole-dump fingerprint uncertainty remains the owner's accepted limitation.

## Bounded live follow-up

V8 permits one strict no-tool browser turn per approved ordinary synthetic tenant
at `https://os.capiro.ai`, with current API/orchestrator/Web build readback and
freshness rechecked immediately before Send. Its operator has independent static
review. The script source hash is verified against original bytes because this
archive normalizes line endings. Its source-only approval is not live success.
Sessions must be revoked and actual command exits and saved/UI replies inspected.
Remaining original75 cases and associated variants require separate qualified
fixtures, provider accounting, server authority joins and immutable capture storage.

Shared policy: `39590a3bfc57ce03b0411ff7912a7c8d99deb70c`;
machine-map revision:2026-09-30 00:21:48UTC. Integration order is C-drive local main,
GitHub main, then qualified AWS promotion. No customer records were used in the
diagnostic probes and no production database migration is part of this repair.
