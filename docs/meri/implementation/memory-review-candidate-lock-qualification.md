# Memory review candidate transaction qualification

Candidate source: 2bf7bb18581733e68f5ab9743103f7a9ca1885bf.

The memory review list passed an earlier candidate descriptor to workflow creation without locking the candidate. A concurrent terminal disposition or deletion could therefore leave a new pending review pointing at a candidate that was no longer pending or no longer existed. The regression on parent 68bb98b57 resolved successfully for a missing candidate instead of rejecting: one failing and eight passing workflow tests, exit 1. This is actual service behavior with mocked storage, not a live production observation.

The workflow now locks the pending candidate in the caller's transaction before creating or reading its review. The review list uses createdAt/id ordering for consistent candidate lock order. A candidate that disappears or becomes terminal after the initial scan is skipped; other storage errors still surface. Approval eligibility, assignments, tenant policy and routes are unchanged. This does not add a physical deletion or fixture-reset capability.

PASS: 23 focused workflow, review-list and assignment tests in three suites, the API production build, and all three owned local PostgreSQL checks on the exact candidate, each exit 0. The PostgreSQL tests have no skips and include explicit zero-review/zero-audit assertions and schema cleanup output. Scoped formatting, test syntax and diff whitespace checks also pass.

The PostgreSQL test invokes the actual built MemoryReviewWorkflowService and PrismaService. It proves that another connection cannot acquire the candidate lock until review and audit commit, and observes actual PostgreSQL lock waits when withdrawal/deletion holds the row first. After the winning terminal change commits, the application rejects the stale descriptor and creates no review or assignment audit. It uses a UUID-owned schema on 127.0.0.1:55433/postgres and removes that schema afterward. Its minimal schema and explicitly allowed authorization stub qualify transaction behavior only; they do not qualify RLS, deployment migrations or current user permissions. No shared database or AWS environment was accessed by this qualification.

Independent Hermes/Bedrock Kimi review returned SCOPED PASS, exit 0. The reviewer checkout was detached at the exact candidate; prior untracked review artifacts were preserved and excluded. The review was static, using the candidate diff and complete workflow source. Lead qualification accepts consistent list lock ordering, not a general claim that every possible database deadlock is prevented.

Evidence under C:/dev/cap-meri-foundation-evidence:

- memory-review-candidate-lock-before.log and its exit receipt.
- memory-review-candidate-lock-unit-final.log and its exit receipt.
- memory-review-candidate-lock-final-build.log and its exit receipt.
- memory-review-candidate-lock-final-postgres.log and its exit receipt.
- review-memory-candidate-lock.jsonl and its exit receipt.

Remaining: canonical synthetic fixture reset/reseed must still fence ownership, content, lifecycle, holds, lineage and dependencies under concurrent mutations. The previously rejected adapter-level DELETE is not included. Full original File01 and Workstream A served acceptance, hosted CI, database recovery clearance, both-main integration and release remain separate requirements. No live or full-goal PASS is claimed.
