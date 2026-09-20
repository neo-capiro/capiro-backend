# apps/api migrations — how to name a new directory

**Read this before creating a migration here.** The rule is not "use today's date".

## The rule

A new migration directory is named `YYYYMMDDHHMMSS_snake_case_description`, where the
timestamp must:

1. **Sort strictly after every existing directory in this tree.** Directory order *is*
   the order migrations replay onto a fresh database. A name that sorts earlier than an
   already-applied migration changes fresh-replay order relative to authoring order.
2. **Be a real timestamp** — hour < 24, minute < 60, second < 60. Do not produce the next
   name by adding `1000` to the previous one: that yields `…016000`, i.e. "minute 60".
   Six directories in this tree already have this defect and cannot be renamed.
3. **Equal today's real date plus the `yearOffset` for this tree** in
   [`scripts/migration-timestamp-offsets.json`](../../../../scripts/migration-timestamp-offsets.json),
   within its tolerance.

`scripts/check-migration-timestamps.mjs` enforces all three on every PR, for newly added
directories only.

## Why apps/api has a `yearOffset` of 2

These names are hand-written, not produced by `prisma migrate dev`. The convention has
always been "pick something that sorts after the latest migration on `origin/main`" — a
ratchet. With many parallel worktrees each advancing the frontier by a day or more, the
frontier outran real time: between `bc0f501e` (2026-07-19) and `e3fc86544` (2026-09-05),
`apps/api` names drifted **+730 days**. Two commits did most of it — `edefa9da8` jumped
+373 days to a `20271231*` "end of year" sentinel block, which forced the next workstream
into 2028, and `e3fc86544` jumped a further +201 days.

The year is now a stuck carry: current names use the **real month and day** with the year
forced to 2028. `yearOffset: 2` makes that explicit and **freezes** the drift instead of
letting it keep growing. It does not fix it.

None of this happened in the other five Prisma trees, which are all on real dates — commit
`1d44dfd60` wrote 2028-dated names here and 2026-dated names into `apps/intel-api` in the
same commit, same second. It was never a clock.

## Do not rename existing directories

Many of these are applied to production and to the shared local fixture DB, recorded in
`_prisma_migrations` under their original names. Renaming one causes Prisma drift errors,
and on a deployed database it is effectively irreversible. Renaming a *subset* is worse: it
moves those migrations backwards past dozens of others and silently changes apply order on
fresh databases.

The offset is retired to `0` at the next migration baseline/squash, which is the only point
at which these names can be rewritten safely.

## If the guard blocks you

It prints the name it expected. Use that. If you genuinely need to move the frontier
further than the tolerance allows, raise `yearOffset` for this tree in the same PR — that
edit is the review gate, and it is meant to be noticed.
