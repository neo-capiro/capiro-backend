# Document index cleanup and unknown reset outcomes

Source: `0cf9ac7abef05c0169cf8eae05b5996fbccce6c6` over `7d9270419`. **PASS for guarded canonical index cleanup and reset outcome classification.** Full attachment fixture runtime/reset qualification remains open.

Guarded synthetic deletion now calls the existing ClientKbService document-chunk purge inside the same final transaction that validates ownership/access and deletes the attachment. Chunk deletion and row deletion commit or roll back together. The existing index writer locks and rechecks that attachment before writing; a stale job cannot recreate its chunks after deletion. The exact source and its `:index` chunk prefix are removed, while other tenants, source types and neighboring IDs remain intact. Ordinary user/system deletion retains its existing asynchronous cleanup behavior.

The owned-reset harness also treats an exception after invoking a mutation as `unknown_outcome`, including unannotated lost acknowledgments. A pre-mutation version refusal remains `failed`. Same-plan retry reconciles already-absent records before proceeding, without repeating their deletion.

## Evidence

All logs and exit receipts are under `C:/dev/cap-meri-foundation-evidence`.

| Check                                                  | Evidence                                                                                             | Result                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| API production build                                   | `document-cleanup-atomic-build.log`                                                                  | exit 0                                                        |
| Actual PostgreSQL owner tests                          | `document-cleanup-atomic-postgres-final.log`                                                         | 15 passed, exit 0, no skips                                   |
| Index/readability/access/write-guard regression suites | `document-cleanup-index-regressions.log`                                                             | 29 passed, exit 0                                             |
| Fixture provisioning, CLI and runtime suites           | `document-cleanup-harness-regressions-final.log`                                                     | 29 passed, exit 0                                             |
| Independent Hermes/Bedrock Kimi static review          | `review-document-cleanup-atomic.jsonl`, exit and usage receipts                                      | SCOPED PASS, exit 0, initialized model `moonshotai.kimi-k2.5` |
| Formatting                                             | Changed harness/service files checked; existing KB method formatted in isolation; `git diff --check` | exit 0; unrelated KB formatting debt preserved                |

Three cleanup regressions fail on the previous compiled source in `document-cleanup-atomic-before-corrected.log`: index rows survive, an index-purge fault is not surfaced, and completion depends on an asynchronous hook. The earlier first attempt used `#0` rather than the real `:0` chunk ID; that test setup was corrected before recording the final pre-fix evidence. The lost-acknowledgment regression fails as `failed` instead of `unknown_outcome` in `fixture-reset-unknown-before.log`.

The final PostgreSQL suite invokes actual Prisma, Engagement and ClientKb owner methods against a unique owned local schema. A real PostgreSQL trigger rejects chunk deletion; the transaction retains the attachment intent and chunks even though the sandbox storage object has already been deleted. Retrying the exact original guard succeeds. The test also calls the actual index snapshot lock after deletion and observes refusal. Earlier storage-failure, version/authorization and lock-contention tests remain covered.

An added reset preflight test initially altered the first seed row rather than the first operation in the reverse-order reset plan, so seven earlier operations legitimately completed. That test setup error is retained in `document-cleanup-harness-regressions.log`; the corrected test faults the first reset operation and proves no mutation occurs before refusal.

## Remaining boundaries

The database schema is minimal and isolated; S3 is sandboxed. No shared database, AWS service or provider was mutated. Owned test schemas were removed. The successful API build preceded a formatting-only change to the KB method; its behavior and SQL were unchanged afterward.

This supersedes the asynchronous-KB limitation for the **guarded owner** in `document-guarded-erasure-qualification.md`. It does not establish full external object absence, historical S3 version erasure, all possible projections, complete RLS/migrations or full served acceptance. Object deletion still precedes the final database transaction; a final transaction failure is a partial outcome, and the retained original intent supports retry. Document absence/storage readback, port/runtime registration and complete receipt/reconciliation integration remain required before the attachment fixture owner is enabled. Existing LIVE guards remain closed.

Both-main integration, hosted CI, database release clearance, full original File01/01-1/01-B acceptance and approved deployment remain separate gates. UI remains web-vnext at os.capiro.ai.
