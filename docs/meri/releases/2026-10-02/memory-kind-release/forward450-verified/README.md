# Verified forward450 migration

The normal packaged Prisma forward migration succeeded at source42988dae5fb7bc2fff3af582ca15a0836a4477c5 and API digestf792a39e889c7572811dd1335b6f12501d3878701caef3888ae7f120bd6e6f25. The actual ECS task exited0. Independent ECS/task-definition/override/digest/CloudWatch readback confirmed the executed runner and all source-owned database receipts.

Shared history contained606 rows, not the449 rows of a fresh API database. The first preflight incorrectly required the fresh shape and stopped before Prisma. Read-only reconciliation confirmed the same61 accepted historical checksum differences and57 other active history entries. V2 preserved every existing row, including100 rolledback rows, and added exactly one new migration:607 total,507 active finished, API source coverage450. Both new CHECK definitions and all four fixture claim hashes were verified.

[Compatibility addendum](compatibility-addendum.json) supersedes only the shared-history count assumption in the preserved historical bridge. Existing rehearsal evidence remains valid for its original owned-database scope. This is not a full File01 acceptance result.

The archive preserves source/input/proof/plan/execution/test/review bytes and the earlier failure. Source files have a `.txt` suffix to prevent accidental execution or test discovery. These consumed operators and plans are historical evidence, not reusable recovery instructions. Do not replay them, remove their original locks, or edit shared history. Original local files remain unchanged. The index records every original filename/hash; no private configuration, credentials, browser sessions, raw Prisma output, or customer messages are included.

Local validation:4 Node tests (including owned606→607 PostgreSQL preservation and microsecond-timestamp tamper rejection) and13 Python tests passed with exit0. Independent source review was PASS; the peer did not claim to run those tests. Actual migration runtime proof is separately recorded in the execution and independent readback receipts. Root owns service promotion and further case01 capture.
