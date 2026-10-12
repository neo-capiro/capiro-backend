# Sender qualification and review receipt

Implementation source `2ed276a27954fa11c851ba950b53bf88b81ec8b1`; exact runtime/test
hashes are in `candidate-paths.json`. The independent-review repair below supersedes this initial source receipt.

- **PASS:** 132/132 tests, 13 suites, zero skipped, on that source. Raw Jest results
  are tracked in `evidence/sender-tests.json`. The 30 new tests include exact B on
  Gmail/Outlook, invalid/unavailable/foreign B, thread A versus B, signature opt-out,
  attachment refusal, ambiguous provider results, post-acceptance receipt failure,
  foreign-connection dedup keys, safe projection, and actual DTO/controller behavior.
- **Expected RED:** the identical 30 new tests against the exact preserved
  pre-implementation service/controller at `fbc0f4230` yield23 failures/7 passes.
  Only new tests and the helper they import were copied into a detached worktree;
  baseline production entry points were not modified. Raw results retained.
- **PASS:** primary API TypeScript (`tsc --noEmit --rootDir .`, 8 GiB heap), Nest
  build, small touched-file Prettier, whitespace checks. This does not claim the
  entire root multi-tsconfig/typecheck script or monorepo test/build gate.
- **BLOCKED TOOLING:** `pnpm run lint` exits1: `eslint: not found`. No config,
  dependencies or rule suppression was introduced to hide it.
- **NOT RUN:** native Prisma/PostgreSQL/RLS contention, actual provider delivery,
  browser/authenticated deployed acceptance. Independent source review is recorded below.

The test configuration is the checked-in `apps/api/jest.config.cjs`, with `rootDir`
made absolute and only `transform['^.+\\.ts$'][1].isolatedModules=true` in an external
scratch file. No assertion, test discovery, resolver or negative control was removed.
Production runtime modules and canonical authorization helpers execute; provider,
storage and persistence boundaries are synthetic. Native provider/RLS behavior is
not inferred from these doubles.

Reproduce from repository root with frozen dependencies, built shared packages and
a generated Prisma client:

```bash
NODE_OPTIONS=--max-old-space-size=4096 apps/api/node_modules/.bin/jest \
  --config /tmp/capiro-sender-jest.cjs --runInBand --runTestsByPath \
  apps/api/src/engagement/mailbox-selection.spec.ts \
  apps/api/src/engagement/mailbox-selection.controller.spec.ts \
  apps/api/src/engagement/engagement-send-authorization.spec.ts \
  apps/api/src/engagement/engagement-send-thread-key.spec.ts \
  apps/api/src/engagement/attachments/outbound-attachment-access.spec.ts \
  apps/api/src/engagement/engagement-document-read.spec.ts \
  apps/api/src/engagement/engagement-mail-threads.spec.ts \
  apps/api/src/engagement/outreach-send-attachment-integrity.spec.ts \
  apps/api/src/engagement/hearing-record-document-access.spec.ts \
  apps/api/src/engagement/mail-sender.service.spec.ts \
  apps/api/src/engagement/google/gmail-send.service.spec.ts \
  apps/api/src/engagement/runtime/engagement-runtime.guard.spec.ts \
  apps/api/src/engagement/runtime/engagement-route-controller-coverage.spec.ts
```

Raw local files, scratch configs, code-generation harness and failed attempts are
preserved under `/workspace/backend-qualification-20261012/` with SHA256 manifests.
Initial setup failures were: Corepack/npm tried unwritable cache locations (task
caches fixed this); Prisma native engine CDN returned403; normal CLI `--no-engine`
still tried downloading an engine; a direct generator needed a resolved executable
path and empty `libqueryEngine` map. Official Prisma5.22 WASM metadata and client
source generation then succeeded without any native engine/database operation.
No hand-written Prisma model shim was used. Initial Jest collection lacked a
successfully generated client; two later full-program ts-jest jobs were killed137
under concurrent memory pressure. Separate primary TypeScript plus isolated Jest
transpilation resolved this without changing repository config. An initial route
metadata test used `roles` instead of the canonical exported `ROLES_KEY`; corrected
assertion now verifies the real `capiro:roles` guard metadata. A fixture-only
formatting failure was corrected; all assertions remain.

The source review found and fixed connection provenance mismatches and post-send
error classification. It retained provider-sync dedup narrow updates, caller-owned
preflight and all attachment negative controls. This is implementer review, not an
independent-author approval. The preserved prerequisite/facility source was reviewed
independently of its original authors. Keep drafts pending responsible-owner review.

## Independent review and repair

Original candidate `8340ac22cdb5c9f4d03e1f36b7f96d30b2af4502` was independently
reviewed by `independent_backend_review`, who did not author production changes.
Two additional regressions demonstrated a same-mailbox/different-thread dedup
collision returning an inconsistent success receipt. Repair source
`14d66227c4898ad3aaa7e46ec054c5b2c325c5fe` checks both persisted connection and
thread identity, retaining sync-owned fields and rolling back into the existing
non-retryable receipt-unavailable outcome. The independent regression was retained.
Two existing success fixtures gained their real threadId; assertions were unchanged.
The initial fixture failures and original two RED cases remain in evidence.

Independent re-review: **168/168 tests, 16 suites, zero skipped**, no blocking source
findings. Implementer replay: **136/136, 14 suites** and primary API tsc passed on
repair source. Native concurrency/provider/deployed acceptance remains unrun.
See `evidence/independent-review/FINAL-RECEIPT.json` and `REVIEW.txt`; the qualification
is source-only and does not qualify Cleanup's separate release gate.
