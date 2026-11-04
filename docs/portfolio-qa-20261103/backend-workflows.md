# Portfolio QA: prospect and file workflows

Implementation: `362cc7965702ea51a80b3db193e0c14305630130`; mounted text-read checks: `53d0b9c7f884979a517bbc6b55ce4335355ad2fa`. Base: `471e3451b48674d881b395b354ea5b1292b698ca`. Scope is F01, F03, F11 and F12; no deployment, live data writes, Fill with Meri or Objectives changes.

## Behavior and ownership

- F01: Business Development now admits an explicit user-selected change from a previous stage. Existing activity and audit owners retain the exact before/after stage. There is no automatic stage mapping, row rewrite, conversion or billing triggered by a stage change.
- F03: `GET /api/engagement/attachments/:id/extract-text` uses the existing authorized, bounded document reader with server-bound `readOnly: true` and `allowPaidExtraction: false`. It neither invokes paid transcription/vision nor changes extraction metadata. Repeat reads are safe; an empty text layer remains an explicit failure. Existing POST processing is unchanged. An indexed/searchable label does not prove that the backing file can currently be read.
- F11: A canonical match or already-linked conversion cannot report an archived client as successfully linked/recovered. The response directs the caller to restore the client. The selected client is rechecked after its row lock to cover concurrent archiving. Existing active conversion, replay, tenant and canonical-identity regressions remain covered. This source defect is not established as the cause of the reported synthetic fixture's failures.
- F12: Empty client file folders are durable and idempotent by tenant/client/name. The folder list merges these names with counts of current files the caller can see. Existing canonical client membership, archive and ethical-wall checks protect reads and creation. Folder names do not grant file permissions. Upload confirmation accepts a trimmed optional folder name, persists it on the attachment, and rejects a replay with a changed folder instead of moving or duplicating the file.

## Migration and generated files

`20281104010000_portfolio_prospect_stages` promotes the reserved stage CHECK source byte-for-byte (SHA256 `fc3aeb539b0e75f2c1024346eb9b745ee185474e5ba4ed8ea3ff9a02da932f78`). The reserved README records its removal and promotion. The reserved inventory reports absence from the previously inspected finished migration ledger; no current live CHECK or target ledger was read here. Reconcile those at deployment time before executing this migration. The migration preserves all rows and the existing database default.

`20281104020000_client_file_folders` adds only the empty-folder table, composite tenant/client foreign key, name constraint, tenant RLS policy and application read/insert grants. IDs follow the existing migration ordering, whose latest base entry is dated `20281103120000`. Neither migration was applied to live or clone databases.

Prisma 5.22.0 generation succeeds. `refresh-source-bindings.cjs --write` regenerates both image-local schema pins. Its JSON contract is byte-identical because its input map includes manifests and lockfile, not the Prisma schema; no package or lockfile changed. The source-binding verifier passes.

The route manifest comes from the route generator's candidate-minus-generated-base delta, retaining the new GET and changed controller line locations. Full base regeneration also adds an unrelated existing outreach-metrics route, so that inherited topology drift is not included. Generated dependency manifests are identical for base and candidate; their large inherited drift is left unchanged. No manifest entry was invented manually.

## Verification

Runtime: Node 24.22.1, pinned pnpm 9.12.0, Prisma 5.22.0. Commands below use `pnpm` to mean the pinned executable invoked through Node. Package dependencies and shared/auth builds were prepared by the root agent in the primary checkout; worktrees borrow those dependencies.

| Command | Result |
|---|---|
| `pnpm --filter @capiro/api run test --runInBand --runTestsByPath src/business-development/prospect-stages.spec.ts src/business-development/business-development.service.spec.ts src/clients/client-file-folders.spec.ts src/engagement/engagement-document-read.spec.ts src/engagement/meeting-client-reassignment.spec.ts` | 5 suites, 123 tests pass |
| `pnpm --filter @capiro/api run test --runInBand --runTestsByPath src/engagement/attachments/client-file-history.http.spec.ts` | 7 tests pass, including new repeatable GET and invalid-ID/role cases |
| `pnpm --filter @capiro/api run test --runInBand --runTestsByPath src/engagement/runtime/engagement-runtime.guard.spec.ts src/engagement/runtime/engagement-runtime-route-coverage.spec.ts src/clients/client-file-access.http.spec.ts src/engagement/attachments/client-file-history.spec.ts` | 67 tests pass, 1 inherited route-coverage failure |
| `node apps/api/scripts/qualification/refresh-source-bindings.cjs` | Pass |
| `node --test apps/api/scripts/qualification/alpine-amd64-qualification.test.cjs apps/api/scripts/qualification/runtime-closure-contract.test.cjs` | 22 pass, 2 inherited failures reproduced on untouched base |
| `pnpm --filter @capiro/api exec eslint <changed TypeScript paths>` | Could not start: the backend's installed dependency set does not provide `eslint` |
| `pnpm --filter @capiro/api typecheck` | Both default 2 GB and `NODE_OPTIONS=--max-old-space-size=4096` runs exhausted the heap in initial `tsc`, exit 134, before diagnostics. Integrated larger-heap typecheck/build are owned by root. |

The route-coverage failure is `EngagementController.resumeDebriefJob` decorated but absent from the exact registry. A detached checkout of exact base `471e3451` reproduces the same single failure (12/13 route-coverage tests pass). The two qualification failures are the ARM candidate gate-copy assertion (expected 2, observed 0), and the frozen PptxGenJS removal probe resolving `image-size` outside its synthetic image. The schema-pin assertions pass on the candidate. No assertion was weakened.

The folder test executes the actual new migration in disposable in-memory PGlite and exercises service access, duplicate creation, empty listing, visible counts, other-client/tenant exclusions, archiving, walls, membership revocation and composite foreign-key/name constraints. PGlite runs as its owner, so this does **not** qualify nonowner RLS enforcement, production Prisma transaction behavior or PostgreSQL 16 deployment.

## Remaining acceptance

No live file read, provider-health probe, synthetic fixture repair, deployed stage transition or fresh real database conversion/carry-over was performed. PostgreSQL 16 and image/runtime gates, migration reconciliation, and browser end-to-end persistence remain release checks. A local passing test does not establish deployed behavior or repair the report's existing synthetic data.
