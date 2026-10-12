# Independent review of immutable Objective revision SELECT repair

Accepted for source scope: head `3f5a879efc06174f77231706244c1ba5e33810fa`,
tree `1f94bbde87da5f996b17ec074b849c97452a769e`. Combined selected checks passed
**130/130 tests across 11 synthetic suites**, including 10 new independent repair
cases, 39 retained independent destination cases, and 81 author selected cases.
`repair-combined-final.json` and `.log` retain the exact suite paths/results.
The targeted first run also passed 11/11 across two suites. Neither run executed
PostgreSQL, PGlite, RLS, migrations, providers, AWS or customer operations.

The review used a new worktree `/workspace/objective-revision-repair-review` and
branch `codex/objective-revision-repair-independent-review-20261012`. Published
head `30fa58467238542ff2b98137844ea02a3225e545`, the original review branch and
evidence commit `1ab782519bc48ecf0b9b977876c334d165822552` remain preserved.
`RECEIPT.json` records the four repair delta path hashes and six unchanged critical
path hashes. The exact published-to-repair patch is in `repair-source.diff`.

The P1 privilege finding is valid. PostgreSQL requires UPDATE privilege on at least
one column of every table selected with a row-locking clause. [SELECT documentation](https://www.postgresql.org/docs/current/sql-select.html)
The preserved Objective migration explicitly revokes revision UPDATE/DELETE and
grants only SELECT/INSERT. The earlier 119-test review missed this incompatibility;
its acceptance did not establish native permission correctness. This review
supersedes that privilege conclusion without rewriting earlier evidence.

The only production change removes `FOR SHARE` from the immutable revision query.
An independent test reconstructs the exact new service source by removing that
one line from the published source and checks equality. The existing migration
is byte-identical to both the published candidate and original Objective PR2362.
No privilege grant, schema, migration or authorization predicate changes.
The tagged SQL test rejects any locking revision SELECT, then runs the real helper
and verifies the exact canonical tenant/client/Objective/version values.

Current mutable authority remains protected. The helper locks the matched current
tenant, member, user and client rows with `FOR SHARE OF t,m,u,c`; it locks the actual
ethical-wall grant when required; and it locks the exact nondeleted Objective
before testing its requested version. The Outreach caller's owned-session
`FOR UPDATE` and single-client sponsor/content checks are unchanged. The test suite
checks that the revision is never read before the parent lock resolves, and that
missing authority/grant/Objective/revision or a changed current version fails closed.

Source inference for cascade safety: the unchanged revision FK references the
exact tenant/client/Objective parent with `ON DELETE CASCADE`. Removing that parent
requires deleting the locked Objective; client/tenant ancestor cascades also pass
through locked authority rows. FOR SHARE conflicts with UPDATE and DELETE on those
rows through transaction end. [Locking documentation](https://www.postgresql.org/docs/current/explicit-locking.html)
An Objective update records its new version and revision in the same existing
transaction, so a waiting parent lock cannot treat an in-flight intermediate
version as current committed authority. The ordinary revision SELECT still filters
all canonical scope fields and fails 404 if the revision is unavailable.

This argument assumes the intended original application privilege configuration:
direct revision UPDATE/DELETE is unavailable. Effective grants, inherited roles,
table ownership, FK/RLS behavior, native MVCC, real cascade concurrency and deadlock
behavior remain unrun release gates. Synthetic SQL-boundary sequencing and source
FK inspection do not establish those native properties. The source role migration
and wall/objective migration grants were inspected and retained in
`mutable-lock-grant-source.txt`; no permissions were changed.

The first short base name `30fa` was ambiguous among Git objects; the full published
commit was resolved without changing refs. No repair-review test failed. The
author's original privilege red test and incompletely applied repair run remain
separate author evidence and are not erased by these passing reviewer receipts.
No full Core TSC was rerun concurrently with the author's check, and no native
Prisma download/generation was attempted by this review.

Acceptance covers this append-only repair of the existing Outreach resolver only.
It enables no generic destination authority, durable link, Objective creation,
frontend activation, content generation or send. Draft publication stays with the
owner; native qualification stays a coordinated release prerequisite.
