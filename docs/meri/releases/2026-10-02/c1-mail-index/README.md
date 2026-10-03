# C1 mailbox index qualification

Source `e1d045d4abe4a7835cb9284508cd287cf1d34d3b` adds one partial btree on active mail messages by tenant and connection. It preserves search SQL, permissions, RLS, timeouts and result semantics. Status: merged and qualified; the immutable migration image is verified. Explicit release approval, forward migration and served mailbox verification remain pending. [Release review](RELEASE-REVIEW.md), [image readback](api-build-readback.json) and [operator review](operator-review.json).

[Qualification](qualification.json) records 11 real PostgreSQL checks, known and zero results, pagination, Unicode and literal search, tenant/owner separation, removed rows, large bodies, and actual lock refusal with no leftover index. The new path reduced the warm local count-plan buffers from 4,014 to 143; this does not establish production latency or repair the live503 by itself.

Both the complete fresh452 replay and the451-to452 upgrade passed using normal Prisma migrations. Every prior ledger row remained unchanged. Both index definitions, memory constraints and retired-table absence were checked. Earlier fixture failures are retained: a missing historical database prerequisite and a PostgreSQL WAL failure on the Windows bind mount. The final replay used an isolated, task-owned Linux Docker volume with durability settings retained.

The API runtime source is unchanged from served API515. An API image is needed to carry the exact452 migration bytes into the existing forward-only migration process; an API service rollout is not needed for this index. Retain the additive index if the orchestrator is rolled back. A failed or uncertain migration requires reconciliation, never blind retry or ledger edits.
