# Synthetic document fixture readback and reset qualification

Source base: `d77ab91dfcb117b935c2280f10798badeb9556a7`, with the described changes currently uncommitted on `codex/meri-foundation-20260928`.

The canonical Engagement document owner now has source-byte readback, fixture-guarded deletion and reset reconciliation. The readback uses the existing `EngagementService.extractAttachmentText(..., { contextSourceOnly: true })` path, then checks the same document row, active tenant membership, client access wall and row version again. The receipt identifies the observed canonical row version, bucket/object key, actor, byte hash and size. It is a canonical source-readback receipt; it does not claim an AWS storage-provider receipt.

Reset accepts only the matching complete seed receipt, verifies every available and unavailable manifest record, binds each deletion to the original row version, fixture marker and bucket, and applies only a complete unique operation list. A claimed delete remains resumable with its original version after storage failure or a lost response. Completion requires the canonical row to be absent, indexed chunks to be absent, and an S3 `HeadObject` result of `NotFound` or `NoSuchKey`; permission errors, missing buckets, timeouts, remaining index chunks and row recreation fail closed. Reconciliation rechecks the row after the storage probe. The fixture owner is wired through a one-shot adapter that avoids AppModule/EngagementModule bootstrap and exposes only the document owner, exact approved tenant identities and attachment read/write actions.

## Evidence

PASS, actual exit 0:

- API production build: `pnpm --filter @capiro/api build`.
- Engagement runtime boundary: one Jest suite, 24 tests passed. The earlier attempt using a nonexistent direct Jest wrapper and a root-relative config path was a setup failure; the corrected package script passed.
- Current Node provisioning suite: 26 tests passed through `pnpm run test:fixture-provisioning`; the three document-runtime checks also pass, for 29 checks across the two exact commands. Coverage includes exact tenant/namespace/owner/bucket requirements, frozen asset path, complete seed/plan coverage, tamper-resistant unavailable coverage, unknown outcomes, and refusal to complete after storage/index reappearance.
- Formatter, Node syntax checks and `git diff --check` pass.
- Earlier owned local PostgreSQL plus in-process object-storage run: 21 tests passed with exit 0, including real canonical create/read/reset, object/index absence checks, failure/retry reconciliation, bucket drift and authority changes. Evidence: `C:/dev/cap-meri-foundation-evidence/document-reset-reconciliation-postgres-covered.log` and `document-reset-reconciliation-postgres-covered-exit.json`.
- Earlier canonical source-read regression suite: 20 tests passed with exit 0. Evidence: `C:/dev/cap-meri-foundation-evidence/document-reset-source-read-regressions.log` and `document-reset-source-read-regressions-exit.json`.

NOT RUN in this current shell: the PostgreSQL suite and the new runtime adapter against a database or AWS. This process has no `DATABASE_URL`; the database test suite skips without it. The recorded 21-test PostgreSQL run exercises the real application owner methods against an owned minimal schema and sandbox storage, but does not exercise the new one-shot runtime adapter, production migration/RLS stack or AWS. No shared database, AWS object, tenant flag, allowlist, API route or deployment was changed.

An independent Bedrock Kimi review read the full current patch and exited 0 with no static blockers. It called out that generic row-version validation allowed an empty string; the adapter now rejects that value, covered by a new direct regression. The final focused report is `C:/dev/cap-meri-foundation-evidence/document-reset-runtime-concurrent-review-report.md`; process exit and usage receipts are `document-reset-runtime-concurrent-review-20260929-exit.json` and `...-usage.json`. The review was static and did not qualify live DB/AWS behavior. Two earlier review attempts exited 1 and are retained; they are not counted as green review evidence.

## Remaining scope

This qualifies only the bounded client-document fixture lifecycle. It does not qualify other fixture owners, read/write sinks beyond this owner, full CLI execution against Capiro Dev, parser/extraction receipts, trusted source/effect/build collection, restart/replay/trace acceptance, or the original 75 cases plus CD, coworker and applicable memory suites. Workstream A's 17 cases plus CD-05 still lack a complete served pass. GitHub Actions currently fails at startup before jobs run; database release clearance, owner acceptance, GitHub-main integration and the approved Capiro Dev deployment remain open. Do not use this document as a full File01 completion or release claim.
