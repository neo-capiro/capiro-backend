# Synthetic fixture provisioner report

Status: PASS for scoped local implementation and native PostgreSQL qualification; NOT_RUN for shared release, providers, browser/live acceptance, and full repository gates.

## Source

- Repository: `neo-capiro/capirov2`
- Branch: `codex/meri-synthetic-fixture-provisioner`
- Required clean base: `3111e053d43960d8ca44ab589d120ceafb105bd3`
- Runtime used: native Node `v22.23.3`
- Target contract: `capiro-dev`, but no shared target was contacted or changed.
- Approved enablement proposal was read from `C:/Users/Administrator/Documents/Codex/2026-09-28/goal-execute-the-entire-file-untill/outputs/synthetic-meri-enablement.json`. Its status remains `APPROVED_NOT_APPLIED`.

The prior identity/client bootstrap evidence and fixture-binding correction reports were read. This change does not reuse the destructive fixed-ID Phase 19 seed and does not create users, tenants, or clients.

## Delivered

- `docs/meri/implementation/synthetic-fixture-contract.md`
  - freezes the v1 source-map, plan, seed, verify, reset-plan, and reset-receipt content-address contract;
  - documents the server capture-worker handoff and release commands;
  - preserves explicit unavailable/unknown states and rejects fixture-completeness or acceptance claims.
- `evals/meri/live-v1/fixture-provisioning/contract.mjs`
  - exact tenant/namespace/confirmation constants, deterministic IDs, ownership markers, receipt hashing, and typed errors.
- `evals/meri/live-v1/fixture-provisioning/manifest.mjs`
  - maps every frozen logical source plus required CD/CW additions to named canonical owner families;
  - verifies all committed binary hashes before planning;
  - validates exact tenant/client references and records concrete source/adapter availability.
- `evals/meri/live-v1/fixture-provisioning/provisioner.mjs`
  - dry-run plan, guarded apply, authoritative verify, reset dry run, and manifest-limited owned reset;
  - exact tenant, physical ID, owner marker, payload hash, and expected-row-version checks on every mutation;
  - post-write canonical readback and explicit `unknown_outcome` receipts.
- `evals/meri/live-v1/fixture-provisioning/canonical-owner-adapter.mjs`
  - canonical owner-service port with no generic fixture table/fallback;
  - deterministic binding to the existing `ClientDocumentWriterService` upload identity and immutable bytes.
- `evals/meri/live-v1/fixture-provisioning/cli.mjs`
  - native Node dry-run-first CLI;
  - absolute receipt paths, exact target/config checks, secret-key rejection, exact apply/reset confirmations;
  - offline plans are marked `offline_unverified` and cannot be applied.
- `evals/meri/live-v1/fixture-provisioning/config.example.json`
  - non-secret placeholder configuration for later owner review.
- Two focused test files and package scripts.

The frozen inputs remain unchanged:

- `evals/meri/live-v1/fixture.mjs`
- `evals/meri/live-v1/source/appendix-f.md`
- `evals/meri/live-v1/contract-lock.json`
- `evals/meri/live-v1/source-binaries/asset-manifest.json`

No evaluator, authority gate, human-adjudication path, production route/model/flag, schema, migration, deployment, or provider implementation changed.

## Source-map availability result

A controlled offline plan using exact authorized tenant IDs, synthetic test client/user UUIDs, and only the canonical memory-item owner mapped:

- total records: 112;
- available/planned canonical memory records: 10;
- explicitly unavailable records: 102.

Unavailable records include attachment upload until a reviewed storage-owner runtime is injected; canonical memory candidates; meetings/debriefs/tasks/actions; research/BD/facility owners; global bill and budget evidence; Monday/mail/action sinks; public acquisition; and CW fault adapters. The plan records each unavailable owner/reason. It does not invent data or treat absence as complete coverage.

The CLI negative control produced an offline dry-run plan, then rejected apply with `CANONICAL_PLAN_REQUIRED`; no seed receipt or write was produced.

## Verification

Focused native Node test command:

    node --test evals/meri/live-v1/tests/fixture-provisioning.test.mjs evals/meri/live-v1/tests/fixture-provisioning.postgres.test.mjs

Result: exit 0; 12 tests passed, 0 failed, 0 skipped, 0 cancelled. Node collected both named test paths. Coverage includes:

- namespace/tenant/marker mismatch denial;
- cross-client reference rejection;
- repeated apply with stable physical IDs and zero duplicate creates;
- changed-version reset fencing and manifest-only deletion;
- unknown partial-write receipt;
- immutable source-byte hash mismatch;
- subset availability honesty;
- actual canonical readback mismatch failure;
- canonical uploader identity derivation;
- native local PostgreSQL apply/reapply/reset-version behavior.

The PostgreSQL test read only `C:/dev/cap-meri-foundation-evidence/private/local-postgres.json`, validated loopback `127.0.0.1:55433` and the configured user, created a random owned schema, exercised canonical `clients` and `memory_items` field/owner shapes with authoritative joins, then dropped the schema and closed its pool. It did not use the shared database.

Frozen contract validation:

    node evals/meri/live-v1/validate-contract.mjs

Result: exit 0; valid true, 75 cases, 0 errors; contract source SHA-256 `acd2a1cf766ad6e988025c4c43235213164926e7036cc8361986916d59963b66`; fixture SHA-256 `2a8159d45d512f325539eb700907700ecc16cbc2d6536277adf85d8f49368e61`.

Formatting:

- Existing repository Prettier from read-only donor `C:/dev/cap-meri-foundation/node_modules/.bin/prettier` was run with `--write` only on changed supported source/test/JSON files.
- The same exact changed-file list passed `prettier --check`, exit 0.
- `git diff --check` exited 0.

ESLint executable discovery was performed once. Neither this checkout nor the read-only donor had an ESLint executable, so ESLint is `NOT_RUN`; no wrapper was retried and no package was installed.

Root `pnpm run test`, `lint`, `typecheck`, and `build` are `NOT_RUN`: this checkout intentionally has no installed dependencies, and the task forbade install/relink/build mutation of the donor. The focused native Node contract and PostgreSQL tests are the applicable local gate, not a fabricated global green result.

## Release proposal and remaining work

Shared apply remains blocked and was not attempted. A later release owner must:

1. fill exact existing actor/client IDs from protected creation evidence without copying credentials;
2. inject a separately reviewed adapter assembled from existing API canonical owner services;
3. make each owner available only after its exact tenant/marker/version atomic guard and authoritative readback are proven;
4. use `ClientDocumentWriterService` for assets and preserve scan/storage/index/erasure ownership;
5. configure controlled Monday/mail/bill/action/CW adapters without real provider effects;
6. produce a canonical-readback dry-run plan and review all unavailable records;
7. apply only with the exact confirmation, immediately verify current owner state, and retain source-map/plan/seed/verify hashes;
8. use only the seed-bound reset plan if cleanup is authorized.

No AWS, Clerk, S3, shared PostgreSQL, Monday, mail, bill provider, model provider, GitHub, main, push, deployment, or live acceptance action occurred. Original 75, CD-01–07, CW-01–08, browser flows, and human rubric remain `NOT_RUN`; no human adjudication or PASS was manufactured.
