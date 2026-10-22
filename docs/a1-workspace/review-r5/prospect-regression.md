# A1 R5: prospect PATCH and restore regression

Brief: [Fable's bounded correction](https://github.com/neo-capiro/capiro-backend/pull/105#issuecomment-6342196826). Requested base: `efd03f1997ef61b99bee315706f39dc1fa341f54`. These changes follow the local rebase at `a1615c5a51592f6c36946f47f882a46aa9516734`; the PR body records the resulting published head.

## Root cause and correction

The production Workspace `PrismaService.withSystem` API is present at the requested base and in this candidate, with the identical Git blob `f11ecf87c93fbf1526f16d62dda3602e933df5a4`. The review's API-change diagnosis was not reproduced. The prospect fixture lacks that method, and the added ordinary-client association lookup was being invoked on prospect PATCH and restore even when their client binding was null.

Those prospect paths now use their existing transaction-native `withProspectDraft` / `requireProspectDraftInTx` admission. That authority retains current active tenant and membership checks, draft roles, linked-client wall checks, parent locks and copied-source validation. Ordinary drafts and non-null bindings still use `requireDraftClient`; its membership and wall checks are unchanged. Prospect PATCH also preserves legacy config without adding an unrelated `clientId: null` key.

No identity stub or permissive fallback was added. The existing 20-case prospect test source is byte-preserved after removing the new test block. Eight added PATCH/restore cases revoke membership, prospect entitlement, linked-client access or copied-source availability and require a 404 with unchanged drafts, documents, versions and write counts.

## Final focused evidence

Three sequential processes used the repository's unchanged `apps/workspace/jest.config.cjs`:

| Suite | Passed | Failed / skipped / runtime errors | Exit |
|---|---:|---|---:|
| `src/documents/prospect-brief-copy.spec.ts` | 28 | 0 / 0 / 0 | 0 |
| `src/drafts/legacy-client-recovery.spec.ts` | 16 | 0 / 0 / 0 | 0 |
| `test/ws03-version-admission-order.spec.ts` | 22 | 0 / 0 / 0 | 0 |

The sum is **66/66 across three separate processes**. Both specifically reported failing prospect names pass, with their original assertions retained. The ordinary-client suite preserves held-owner recovery and membership/wall refusals; the version suite preserves admission ordering and owner/editor positives.

Run each suite from the repository root using its full `apps/workspace/…` path:

```sh
NODE_PATH=/workspace/scratch/7cdb10b10884/workspace-backend/node_modules \
NODE_OPTIONS=--max-old-space-size=1536 \
node node_modules/jest/bin/jest.js \
  --config apps/workspace/jest.config.cjs --runInBand \
  --runTestsByPath <testPath> \
  --cacheDirectory=/dev/shm/a1-r5-identity/jest-cache \
  --json --outputFile=<receipt.json>
```

This used reused dependencies: Node `24.19.0`, Jest `29.7.0`, ts-jest `29.2.5`, TypeScript `5.5.4`, and the existing generated Workspace client matching its unchanged schema. It is **not** the pinned clean-install qualification. Exact per-run JSON hashes, source hashes and local raw-output paths are in `prospect-regression.json`.

An initial combined three-suite attempt at a 4096 MiB heap exited **137** during shared memory pressure. It printed a prospect-suite pass but produced no final JSON or aggregate receipt. That attempt is retained and excluded from the final aggregate. The sequential runs above completed normally; no assertions, Jest diagnostics, test timeouts or dependencies were changed to obtain them.

## Remaining qualification

Full current Workspace/API base-versus-head failing-name comparison, clean-install typecheck/build, native PostgreSQL/RLS, HTTP/JWT and image gates remain **Fable-run**. This focused receipt does not establish those gates. In particular, the earlier 17-diagnostic cached comparison is historical, not an R5 typecheck result. Report improved base failures separately from new regressions when performing the full comparison.

These tests use synthetic database and identity fixtures. No live database, SQL, migration, merge or deployment was executed. Frontend #117/#118 remain held until the corrected backend is live.
