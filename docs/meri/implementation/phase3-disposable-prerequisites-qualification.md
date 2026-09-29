# Phase 3 disposable migration prerequisites

The hosted disposable rehearsal failed in job `109217536296` at migration `20260502020000_capiro_app_role` because its fixed `GRANT CONNECT ON DATABASE capiro` target did not exist. The workflow initialized only `postgres`. A clean service also needs the canonical least-privilege `capiro_worker` role, and each independently created rehearsal database needs the canonical append-only trigger function before the full ledger runs.

## Scope and behavior

Base: `a17c570326daa5ebb3fb8cfe969b516436e47058`. This repair initializes the owned service with `capiro`, invokes the existing guarded prerequisite bootstrap, and applies the unchanged canonical append-only SQL separately to each newly created fresh/upgrade database. No SQL or migration file is modified. Existing fresh/upgrade migration commands and database assertions remain in place.

The full destructive rehearsal now explicitly requires GitHub Actions, Linux, `CI=true`, `CI_DISPOSABLE_POSTGRES=1`, and `postgres@127.0.0.1:5432`. It rejects target/service/options overrides before any subprocess, pins and sanitizes libpq and Prisma environment routing, verifies the actual server identity and baseline prerequisites before mutations, and uses unique database/probe role names. A failed CREATE collision is never recorded as owned, terminated, or dropped. Cleanup acts only on successful creations; cleanup failure fails the gate.

**Local compatibility change:** direct local full rehearsal is unsupported and exits early with a diagnostic. The previous Windows path could point psql at a fixed Docker container while Prisma used a different configurable target. There is no local bypass flag. Pure guard tests and separately owned local PostgreSQL prerequisite probes remain supported. Full fresh plus ordered-upgrade migration acceptance requires the real hosted pgvector service and is still a release gate.

## Qualification

- PASS: `node --test scripts/verify-outreach-v3-phase3-db.test.mjs` — 27 tests, 27 pass, zero skipped, actual exit 0. Covers invocation routing/platform refusal, a real rejected CLI invocation, sanitized environment, read-only identity/prerequisite failure, resource ownership, collisions, per-database canonical SQL ordering, failed bootstrap cleanup, cleanup errors, and identifier injection/truncation.
- PASS: actual native PostgreSQL 16 prerequisite probes against the already owned local test cluster at `127.0.0.1:55433`, exit 0. Two unique databases were created and dropped. Each proved canonical function installation and idempotence, update/delete rejection, unchanged row state, and rejection without replacement of an incompatible preexisting function. No global roles were changed and no AWS database was contacted.
- PASS: strict YAML semantic comparison with unique-key validation, exit 0. Exact allowed changes are service baseline/health database, disposable marker, guard test step, and canonical bootstrap step. All preexisting triggers, permissions, image, environment, gates, timeouts, commands, and step order are preserved.
- PASS: Node syntax, targeted Prettier, and `git diff --check`, exit 0.
- NOT RUN: local full migration ledger; this invocation is deliberately unsupported, and the owned native test cluster lacks pgvector. Hosted full-ledger acceptance remains required. These prerequisite results are not product acceptance or a green hosted rehearsal claim.
- PASS: independent Hermes/Kimi source review `review-phase3-disposable-prerequisites`, actual exit 0, SCOPED PASS. The review explicitly leaves hosted full-ledger acceptance unverified. Source SHA-256 inputs are retained in `phase3-disposable-review-source-sha256.json`.

Hermes/Qwen first produced a bounded static plan with actual exit 0 (`phase3-disposable-prerequisite-qwen-plan`). Its fixture directory and admin identity assumptions required correction. Codex implemented the bounded repair under the explicit direct-repair authorization; independent Kimi review was performed separately.

Reviewer prose corrections: `POSTGRES_DB=capiro` initializes the service baseline database; the canonical bootstrap does not create that database, and no health-check fallback is relied on. A missing canonical SQL file fails closed with `ENOENT`. Hosted ledger PASS is required for release; publishing a qualified topic to obtain that CI result follows local-main-first integration. These corrections do not change the reviewed implementation.

An additional structural AST comparison confirms the existing migration helpers, seed functions, and database assertion function are unchanged apart from formatting (`phase3-disposable-assertion-preservation.json`, exit 0).

Evidence under `C:\dev\cap-meri-foundation-evidence`: `ci-7823-109217536296.log`, `phase3-owned-resources-tests.log`, `phase3-owned-resources-tests-exit.json`, `phase3-owned-prerequisite-pg.json`, and `phase3-disposable-workflow-semantic.json`. No push, main integration, deployment, live canary, or production model/routing change is part of this qualification.
