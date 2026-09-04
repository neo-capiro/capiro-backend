# Independent review (§6.2) — Band B: lifecycle + event processing

**Verdict: `FUNDING_OPPORTUNITIES_BAND_B_INDEPENDENTLY_APPROVED`**

**Date:** 2026-08-13
**Reviewer:** independent agent — did **not** implement, deploy, or previously review any
phase in this program.
**Pinned commit:** `d800dcfde5` (`feat(x-feed): configurable X Intelligence dashboard feed (#948)`).
All source read via `git show d800dcfde5:<path>`; `C:\dev\capirov2`'s working tree was
never touched (it carries unrelated uncommitted work).
**Scope:** P03, P04 (producer keyset walks and lifecycle), P35 (pursuit pipeline
stages / Kanban), P36 (outcome capture), P47 (dry-run-first webhook alert
reconciler), P48 (event fan-out, materiality, quiet alerts).
**Nothing was fixed.** Findings are recorded below as a queue only. No file outside
this document was modified; nothing was staged, committed, or pushed.

Verdict vocabulary follows `docs/runbooks/phase-2-independent-live-validation.md`
§8 (exactly one of two strings). Note the completion matrix's own §6.2 column uses a
three-value vocabulary (`PASS` / `PASS WITH NON-BLOCKING NOTES` / `FAIL`); in that
vocabulary this review is **`PASS WITH NON-BLOCKING NOTES`**. No finding below blocks
the band.

---

## Method — what "verified" means in this document

The program's own history contains three merged defects of one class: **raw SQL that
had never actually executed once**, because unit tests in this codebase drive services
against in-memory port doubles. The instruction for this review was to hunt the fourth
instance. Reading SQL cannot find that class, so nothing here was verified by reading
alone.

A disposable Postgres was stood up and the **real** schema built by replaying migration
history — not by asserting schema objects exist:

| Step | Result |
|---|---|
| Container | `pgvector/pgvector:pg16` (PostgreSQL 16.14). `vector`, `citext`, `pg_trgm`, `uuid-ossp` all required by migration 0001 |
| Database name | must be `capiro` — `20260502020000_capiro_app_role` does `GRANT CONNECT ON DATABASE capiro`, which fails on any other name |
| `apps/api/prisma/migrations` | **263 applied, 0 failed** |
| `apps/intel-api/prisma/migrations` | **26 applied, 0 failed** |
| Connection role | **`capiro_app`, a NON-superuser**, over TCP, with `FORCE ROW LEVEL SECURITY` in effect |

Both migration sets are required and this is itself worth recording: `intel_feature_flag`
— the table **every** phase in this band gates on — is owned by **intel-api**, not
`apps/api`. Replaying only `apps/api/prisma/migrations` produces a database in which
every statement in P03, P04 and the flag guard fails with `relation "intel_feature_flag"
does not exist`. That is an artifact of an incomplete replay, **not** a defect, and it is
flagged here because it is the exact shape of a false positive a future reviewer will hit.

The non-superuser detail is load-bearing and is the lesson P48's own migration rehearsal
learned the hard way: `postgres` bypasses RLS even under `FORCE`, so a check run as
superuser proves nothing about the policy path. Every statement below ran as `capiro_app`
with the same GUC contract `PrismaService` uses (`app.current_tenant` / `app.current_user`
/ `app.bypass_rls`, all `is_local = true` inside a transaction — verified against
`apps/api/src/prisma/prisma.service.ts:157,192-193,248`).

---

## 1. Every raw SQL statement in scope, executed

**Result: no fourth instance of the never-executed-SQL class exists in P03, P04, P35,
P36 or P47.** Every raw SQL statement in the band executes cleanly against the current
schema. The full inventory:

| Phase | File | Raw SQL callsites | Executed | Result |
|---|---|---|---|---|
| P03 | `apps/api/scripts/generate-funding-grant-candidates.ts` | 2 | 2 | pass |
| P04 | `apps/api/scripts/generate-sam-opportunity-candidates.ts` | 4 (2 are interface *declarations*, not callsites) | 2 | pass |
| P03/P04 | `apps/api/src/funding-opportunities/producer-pagination.ts` | 0 | — | pure logic, no I/O |
| P03/P04 | `apps/api/src/funding-opportunities/client-opportunity-profile.repository.ts` | 5 | 5 | pass |
| P03/P04 | `apps/api/scripts/process-funding-opportunity-lifecycle.ts` | 2 | 2 | pass |
| all | `apps/api/src/funding-opportunities/funding-opportunities-flag.guard.ts` | 1 | 1 | pass |
| P35 | `apps/api/src/funding-opportunities/funding-opportunity-pipeline.ts` | **0** | equivalent executed | pass — Prisma model calls only |
| P36 | `apps/api/src/funding-opportunities/funding-opportunity-outcome.service.ts` | 2 | 2 | pass |
| P47 | `apps/api/scripts/reconcile-tango-webhook-alerts.ts` | **0** | n/a | touches no database at all |
| P48 | `apps/api/scripts/process-tango-events.ts` | 11 | 11 | pass |

Two structural notes that matter for anyone repeating this:

- **P35 and P47 carry no raw SQL.** P35 writes exclusively through Prisma model calls
  (`updateMany`, `create`, `groupBy`, `findMany`), which are checked against
  `schema.prisma` at generate/compile time — they cannot ship referencing a column that
  does not exist, so they are not exposed to this bug class. P47 makes provider HTTP
  calls only. For these two the class is *structurally* absent, not merely unobserved.
- **P48's SQL is not in P48's service file.** `tango-event-processor.service.ts` defines
  `insertAlertIfNew` as a **port interface method** (line 268); the real SQL lives in the
  adapter `buildPort()` in `apps/api/scripts/process-tango-events.ts`. Grepping the
  service file for `$queryRaw` returns nothing and would wrongly suggest there is nothing
  to execute. This service/adapter split *is* the mechanism that let the original
  `ON CONFLICT ON CONSTRAINT` defect reach main.

### P48 — all 11 statements, executed verbatim

Fixtures: one delivery, one notice, one `client_funding_opportunity` row, two tenants.

| # | Statement | Result |
|---|---|---|
| 1 | `enqueuePendingDeliveries` SELECT (delivery LEFT JOIN outbox) | 1 row |
| 2 | enqueue `INSERT … SELECT FROM unnest(5 arrays)` + `ON CONFLICT (delivery_id, event_index) DO NOTHING` | `INSERT 0 3` |
| 2b | **same statement re-run** | `INSERT 0 0` — idempotent, replay-safe |
| 3 | `claimBatch` dry-run SELECT | 3 rows |
| 4 | `claimBatch` commit CTE `FOR UPDATE SKIP LOCKED` → UPDATE … RETURNING | `UPDATE 3` |
| 5 | `findAffectedClients` cross-tenant SELECT under bypass | 1 row |
| 6 | `insertAlertIfNew` dry-run `count(*)` | `n = 0` |
| 7 | `insertAlertIfNew` commit INSERT + `ON CONFLICT (4 cols) DO NOTHING` | `INSERT 0 1` |
| 7b | re-run with **same fingerprint, different `delivery_id`** | `INSERT 0 0` |
| 8 | `markDone` | `UPDATE 1` → `done`, `completed_at` set, lease cleared |
| 9 | `markFailed` | `UPDATE 1` → `pending`, `attempts=1`, lease cleared |
| 10 | `markQuarantined` | `UPDATE 1` → `quarantined`, `completed_at` set |

Statement 7 is the one that previously threw on every real call. It now runs. The
`ON CONFLICT` column list `(tenant_id, client_id, source_record_key, change_fingerprint)`
matches `tango_event_alert_dedupe_uniq` exactly — and because the code names the **column
list** rather than `ON CONFLICT ON CONSTRAINT`, it correctly infers against a unique
**INDEX**. Confirmed by execution, not by reading `\d`.

Statement 7b is a genuinely useful proof and is worth calling out: an identical insert
carrying a **different `delivery_id`** is still a no-op. That demonstrates the dedupe
fingerprint **excludes** the delivery id, which is precisely the property the completion
matrix claims makes replay and out-of-order delivery converge to one result. It was
verified here rather than assumed.

The three `mark*` statements were checked against
`tango_event_outbox_completed_chk`, which couples `status` to `completed_at`. All three
transitions from a `processing` row satisfy it.

### P03 / P04 — producer walk statements

`resolveTenantIds` (identical text in the grant producer, the SAM producer and the
lifecycle script) and the flag guard's `SELECT 1 AS ok` both execute and return correctly.
`intel_feature_flag.tenant_id` is **`text`**, not `uuid`, and the guard deliberately does
**not** cast — consistent with its own docblock about the District Nexus `::uuid`
incident. Executed both with a matching flag row (returns `ok=1`) and against the
`funding_opportunities_pipeline_v2` feature with no row (returns 0 rows, i.e. correctly
disabled).

The five statements in `client-opportunity-profile.repository.ts` — `resolveContractorUeis`,
and the exact-UEI and reviewed-name-fallback variants for both the assistance and contract
rails — all parse and resolve: every table (`federal_contractor`, `federal_assistance_award`,
`federal_award`) and every column referenced exists, and the `= ANY(…::uuid[])` /
`= ANY(…::text[])` casts are type-compatible with their columns.

The keyset walk itself is not raw SQL — it is a Prisma `findMany` with
`id: { gt: cursor }` and `orderBy: { id: 'asc' }`, the correct keyset form. The
equivalent SQL was executed directly.

---

## 2. P35 / P36 against the **current** schema (not as-written)

This was checked against the schema as it exists at `d800dcfde5` after a full replay, not
against the migration as authored.

### P36 — append-only reopen and the widened `pursuit_won` kind

`outcome_event` today carries `outcome_event_kind_chk` admitting `pursuit_won`,
`pursuit_lost`, `pursuit_passed`, and `outcome_event_source_type_chk` admitting
`funding_opportunity`. Critically, **there is no unique constraint or unique index on
`(tenant_id, client_id, source_type, source_id)`** — nothing in the current schema
prevents a second row for the same source key. Four checks, all by actual insert as
`capiro_app`:

1. `recordOutcome`'s INSERT … RETURNING, verbatim, `kind='pursuit_lost'` → row returned.
2. **Reopen**: a second INSERT, **same `source_id`**, widened `kind='pursuit_won'` → accepted.
3. `getOutcomeHistory`'s SELECT, verbatim → **2 rows, newest first**, and the first row's
   `notes` (`FIRST ROW notes`) and distinct `evidence_jsonb` are **untouched**.
4. `pursuit_passed` accepted by the current CHECK.

**Append-only reopen semantics hold, and the widened kinds are live in the current
schema.** There is no update path anywhere in the file, so the property is structural
rather than conventional.

### P35 — stage transitions

Three checks, by execution:

1. `commitTransition`'s update with the optimistic-concurrency version predicate →
   `UPDATE 1`, and the audit row inserted in the **same transaction** → `INSERT 0 1`.
2. **Replaying the same stale `expectedVersion`** → `UPDATE 0`. The concurrency loser
   really does affect zero rows; the code maps that to `false` and the caller raises
   `ConflictException` (`funding-opportunity-pipeline.ts:471-475`).
3. A terminal-stage transition (`to_stage='won'`) with a **null reason** → **refused** by
   `funding_opportunity_stage_transition_reason_chk`. The database, not just the service,
   enforces "a terminal move must state why."

Two additional current-schema invariants confirmed while building fixtures, both
correct and both stricter than the service layer alone:
`client_funding_opportunity_pipeline_stage_at_chk` (a non-null `pipeline_stage` requires a
non-null `pipeline_stage_at`) and `client_funding_opportunity_one_source_chk` (a `sam_gov`
row must carry `source_record_type='sam_notice'`).

---

## 3. P47 — is "dry-run by default" enforced in code, not just help text?

**Yes. Structurally, in three independent places.** No code path was found in which a
missing or misparsed flag commits.

- **Parsing is exact-match.** `commit: argv.includes('--commit')`
  (`reconcile-tango-webhook-alerts.ts:88`). `--commit=true`, `--Commit`, `-commit` and
  any typo all evaluate to `false`. Every misparse fails **toward** dry run, which is the
  correct direction.
- **The dry-run branch returns before the commit path.** `if (!args.commit) { … return }`
  at line 220. Everything above it is reads only — `listWebhookEndpoints()`,
  `listWebhookAlerts()` — plus `diffWebhookAlerts`, which the file states performs no I/O.
  There is no fallthrough.
- **`--commit` cannot stand alone.** `validateArgs` rejects `--commit` without
  `--endpoint-id` **and** `--confirm-callback` (exit 2), and the commit path additionally
  refuses unless `args.confirmCallback === endpoint.callbackUrl` as the **provider**
  reports it.

Two adversarial cases specifically checked, both safe: `--endpoint-id abc`
(space-separated rather than `=`) parses to `null` because `get()` only matches
`--name=`, so `--commit` is rejected with exit 2; and `--confirm-callback=` (empty value)
yields `''`, which is falsy, and is likewise rejected.

The value-parser slice arithmetic is also correct: the prefix `--${name}=` is
`name.length + 3` characters, which is exactly what `hit.slice(name.length + 3)` drops.

The spec backs this at the strongest available level — `reconcile-tango-webhook-alerts.spec.ts:206`
asserts the **complete** call list for a dry run
(`expect(fake.calls).toEqual(['listWebhookEndpoints','listWebhookAlerts'])`), which
proves read-only positively rather than asserting the absence of one method.

One divergence, non-blocking and noted only for consistency: P03/P04's lifecycle script
accepts **both** `--name=value` and `--name value` (`process-funding-opportunity-lifecycle.ts:230-235`),
while P47 accepts only `--name=value`. P47's stricter form is the safer one; the
inconsistency is a usability wart, not a defect.

---

## 4. P03 / P04 keyset-completeness tests — real fixtures or toy cases?

**Real. These are not 3-row cases.**

| Test | Fixture |
|---|---|
| `generate-funding-grant-candidates.spec.ts:350` | **4,001 grants × 501 clients** — asserts `completion='COMPLETE'`, `clientsRead=501`, `opportunitiesRead=4001`, `evaluated=2,004,501`, `errors=0`, `resumeClientCursor=null` |
| `generate-sam-opportunity-candidates.spec.ts:629` | **4,001 notices × 501 clients**, same assertions plus `pursuableRead=4001` |
| both specs | exact-`PAGE_SIZE` corpus, `PAGE_SIZE+5`, `PAGE_SIZE+10`, `PAGE_SIZE+20`, empty corpus |
| `generate-sam-opportunity-candidates.spec.ts:541` | 1,200 non-pursuable notices → `COMPLETE` with nothing evaluated |
| `producer-pagination.spec.ts:59` | `test.each([0, 1, 2, 9, 10, 11, 99, 100, 101, 1000])` — off-by-one on both sides of the page boundary |

Both dimensions sit exactly **one past** the old caps (4,000 grants / 500 clients), which
is the correct boundary choice: it fails if the walk stops at the old bound.

Critically, **the fake honours keyset semantics** rather than short-circuiting them. Its
`page()` helper (`generate-funding-grant-candidates.spec.ts:115-126`) sorts by id, applies
`id > cursor`, and slices to `take`. A fake that ignored the cursor would loop forever
rather than pass, so these tests could not be green by accident. The walk logic in
`walkKeyset` is also correct on inspection: a short page ends `COMPLETE` and is checked
**after** `onPage`, so the final partial page is evaluated rather than dropped.

Two honest limits on what this proves, recorded as findings F-3 and F-4 below: the
4,001×501 tests run with `commit: false`, and the fake is an in-memory double, so these
prove the **walk** is exhaustive — not that the underlying Prisma query pages correctly
against Postgres. The latter was covered separately by executing the equivalent SQL (§1).

---

## 5. Mandatory question — would a silent zero-write no-op be caught?

Per phase, if the core write silently no-op'd in production:

| Phase | Core write | Would it be caught? |
|---|---|---|
| **P36** | `INSERT INTO outcome_event … RETURNING` | **YES — loudly.** No `ON CONFLICT`; a plain INSERT either writes or throws. If it somehow returned zero rows, `row[0]!.id` dereferences `undefined` and throws a `TypeError`. It cannot fail quietly. |
| **P35** | `updateMany` + audit insert | **YES — explicitly.** `if (updated.count === 0) return false` (line 645) → caller throws `ConflictException` (line 471). Zero rows is a first-class, user-visible outcome. |
| **P47** | provider `createWebhookAlert` | **PARTIALLY.** Test-level: yes (`spec:295` asserts the create call). Production: only the operator instruction *"Re-run without `--commit`; it must report no work"* plus exit code 5 (`EXIT_DRIFT`), which CI can gate on. A provider that accepted the call and did nothing would be caught **only** by a human or CI re-running the dry run. No automated post-state verification. |
| **P48** | `insertAlertIfNew` (`ON CONFLICT DO NOTHING`) | **PARTIALLY.** `inserted > 0` is returned and counted per event, and P49's canary has a two-quiet-passes check. But a run in which *every* alert deduped away is indistinguishable in status terms from a run that wrote nothing because of a defect. |
| **P03** | `clientFundingOpportunity.create` / `update` | **NO production signal.** ← |
| **P04** | `clientFundingOpportunity.create` / `update` | **NO production signal.** ← |

**Named as having no such assertion: P03 and P04.** See finding F-1.

---

## Findings queue (severity-ranked)

### F-1 — Medium — a zero-write producer run is indistinguishable from a healthy one

`statusFromCounts` (`apps/api/src/ingestion/embed-watermark.ts:64`) is the whole of the
status derivation:

```ts
if (counts.complete === false) return 'partial';
return counts.errors > 0 ? 'success_with_errors' : 'success';
```

It reads `complete` and `errors` only. `RunCounts` **does** carry `inserted` and `updated`,
and they are persisted on the `sync_run` row — but **nothing consumes them**: not the
status, not an alarm, not a metric, not a test at the run level. A P03/P04 run that walks
the full corpus, evaluates 2,004,501 pairs, and writes **zero** rows reports
`status='success'`, `complete=true`, `errors=0` — byte-identical in the dashboard to a
run that wrote every row correctly.

This is the same shape as the zero-rows finding that motivated this review, and it is the
one place in this band where the failure would be genuinely invisible. Note the contrast
with P03/P04's *coverage* claim, which is rigorously instrumented (`COMPLETE`/`INCOMPLETE`,
resume cursor, `partial` status blocking the watermark). Coverage is well guarded; **volume
written is not guarded at all.**

Mitigating context, which is why this is Medium and not High: all four schedules ship
`enabled: false` (`infra/cdk/lib/ingestion-schedule.ts:517, 526, 562, 734`), so none of
these jobs runs in production today. The exposure begins the moment a human enables the
chain — which D-79 describes as a deliberate, imminent step.

Suggested (not applied): have the producers emit `inserted`/`updated` as a metric, or
have a run that evaluated a non-zero number of pairs and inserted zero rows land as
`success_with_errors` with an `errorMessage`, reusing the mechanism added after the
`geocode-facilities` incident described in `RunCounts`' own docblock.

### F-2 — Low — duplicated `eventIndex` alias in P48's `claimBatch` RETURNING

`apps/api/scripts/process-tango-events.ts:376`:

```sql
RETURNING o."id", o."delivery_id" AS "deliveryId", o."event_index" AS "eventIndex", "event_index" AS "eventIndex", o."event_type" AS "eventType",
```

`eventIndex` is projected twice — once qualified, once bare. **Executed: Postgres accepts
it** and returns two identically-labelled columns (confirmed in the run above), and
Prisma's row→object mapping collapses them, the second overwriting the first with the same
value. Harmless today.

It is a merge artifact rather than intent, and it is fragile in a specific way: if the two
expressions ever diverge, one silently wins and no error is raised. The bare
`"event_index"` also resolves only because the `claimed` CTE projects `id` alone — widen
that CTE to include `event_index` and the reference becomes ambiguous, turning a
cosmetic duplicate into a hard failure. Worth deleting the redundant projection.

### F-3 — Low — the headline 4,001×501 completeness tests never exercise the write path

Both `generate-funding-grant-candidates.spec.ts:350` and
`generate-sam-opportunity-candidates.spec.ts:629` pass `commit: false`. They prove the
**walk** reaches the last row of both dimensions; they write nothing. The commit-path
assertion is a separate test against the **default one-grant / one-client fixture**
(`spec:240-248`, `expect(created).toHaveLength(1)`).

So there is no test anywhere that a large multi-page corpus produces a proportionate
number of writes — which is the same blind spot as F-1, one layer up. Nothing asserts
that `created` scales with `evaluated`.

### F-4 — Informational — the contract award rail is never exercised in the grant producer's spec

`makeFake`'s `$queryRaw` double (`generate-funding-grant-candidates.spec.ts:92-105`)
returns a row for `federal_assistance_award` but falls through to `return []` for
everything else — including `federal_award`. Every contract-rail award-history read in
that spec therefore returns empty, so the contract branch of
`readAwardHistoryByBasis` and the `contractAgencies` / `awarding_sub_tier` handling are
uncovered by that file. Both statements were executed here (§1) and are structurally
valid; this is a coverage gap, not a defect.

### F-5 — Informational — replaying only `apps/api` migrations produces a false positive

Recorded so the next reviewer does not lose time to it. `intel_feature_flag` is created by
`apps/intel-api/prisma/migrations`, and both apps share one database. A review that
replays only `apps/api/prisma/migrations` will find that **every** statement in P03, P04
and the flag guard fails with `relation "intel_feature_flag" does not exist`, which looks
exactly like a fourth instance of the never-executed-SQL bug and is not one. The database
must also be named `capiro`.

---

## What this review did **not** cover

Stated plainly so the gate is not read as wider than it is:

- **No live `capiro-dev` verification.** Entirely local, against a disposable container.
  Whether these code paths behave against the real cluster is untested here — and since
  all four schedules are `enabled: false`, none of them currently runs there.
- **P48's fan-out, materiality and quiet-alert *policy*** — severity classification,
  change-dimension selection, quiet-hours logic — was not re-derived. This review
  covered its persistence layer.
- **No provider calls.** P47's gateway was never exercised against MakeGov/Tango;
  its argument and control flow were reviewed statically and its spec's assertions read.
- **Statement-level execution, not workload-level.** Each SQL statement was proven to run
  and to do the right thing on representative rows. Concurrency behaviour under real load
  (`FOR UPDATE SKIP LOCKED` across competing processors) was not load-tested.
- **P36's `MemoryCandidateService` side path** was not followed beyond confirming the
  outcome write commits before it and that its failure is caught, never rethrown.

---

## Approval record

**Verdict: `FUNDING_OPPORTUNITIES_BAND_B_INDEPENDENTLY_APPROVED`** — 2026-08-13, by an
independent agent that did not implement, deploy, or previously review any phase in this
program.

The band's central claim survives independent execution. Specifically:

- **The fourth instance of the never-executed-SQL class was searched for and does not
  exist in this band.** All 23 raw SQL callsites across P03, P04, P35, P36, P47 and P48
  were executed verbatim against a real, fully-migrated Postgres as a non-superuser under
  forced RLS. Every one runs. P35 and P47 are structurally immune (Prisma model calls and
  HTTP respectively).
- **P36's append-only reopen holds against the current schema**, proven by insert: a
  second row for the same `source_id` is accepted, the widened `pursuit_won` kind is live,
  and the prior row's notes and evidence are provably untouched.
- **P35's optimistic concurrency holds against the current schema**, proven by execution:
  a stale version affects zero rows, and the database itself refuses a terminal transition
  with no stated reason.
- **P47's dry-run default is enforced in code, in three independent places**, and every
  misparse of `--commit` fails toward dry run. The help text is not doing the work.
- **P03/P04's completeness tests use realistic multi-page fixtures** (4,001 × 501, plus
  page-boundary and 0/1/2/9/10/11/99/100/101/1000 cases), and the test double honours
  keyset semantics rather than short-circuiting them.

Five findings are recorded above, none blocking. **F-1 is the one that deserves an
owner**: P03 and P04 have no production assertion — test, log, or metric — that would
catch their core write silently no-op'ing, because `statusFromCounts` ignores rows
written. It is Medium rather than High only because those schedules ship disabled; that
mitigation expires the moment the ingestion chain is enabled.

Environment for reproduction: `pgvector/pgvector:pg16`, database `capiro`, 263 `apps/api`
migrations + 26 `apps/intel-api` migrations, connected as `capiro_app` over TCP.
