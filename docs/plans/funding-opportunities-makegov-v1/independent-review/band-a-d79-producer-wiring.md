# Band A — Independent §6.2 Review: D-79 / PR #943 producer wiring

**Scope:** commit `22316cc2` (merge of `aebec3b32`, PR #943) — the two new
matching producers (`generate-dibbs-opportunity-candidates.ts`,
`generate-sbir-opportunity-candidates.ts`) and the deletion of the stale
`FundingOpportunitiesV2Page` / `FundingOpportunitiesV2Gate` (9 files).

**Pinned at:** `d800dcfde5`. All source read via `git show d800dcfde5:<path>`
from `C:\dev\capirov2`; nothing in that working tree was touched.

**Reviewer:** an independent agent. Not the agent that implemented, tested or
merged D-79. Per `docs/runbooks/phase-2-independent-live-validation.md`, this is
a different-reviewer, read-only review with a dated approval record and a verdict
that is exactly one of two strings.

**Date:** 2026-08-13.

---

## Verdict

```
D79_PRODUCER_WIRING_INDEPENDENTLY_APPROVED
```

(The alternative string is `D79_PRODUCER_WIRING_REJECTED`.)

**Approval is of the code as merged, in its shipped-disabled posture.** The
producers are correct: I ran them against a real, freshly-migrated Postgres and
both created rows that satisfy every live constraint and resolve back through
the inbox's own join. Nothing in the change is deployed, no schedule is enabled,
and no flag is flipped.

**Approval is NOT a statement that this code is ready for its schedules to be
enabled.** F1 and F2 below should be closed before
`GenerateDibbsOpportunityCandidates` / `GenerateSbirOpportunityCandidates` are
turned on, because in their current state a broken run and a healthy run are
indistinguishable from the outside.

Nothing was fixed. Every finding below is queued, not applied.

---

## What I actually ran (the load-bearing evidence)

Everything below was executed, not inferred.

| Step | Result |
| --- | --- |
| `prisma migrate deploy` (264 migrations) onto a disposable `pgvector/pgvector:pg16` container | All applied clean |
| Real `generateDibbsCandidates(prisma, {commit:true})` against it | **1 row created** |
| Real `generateSbirCandidates(prisma, {commit:true})` against it | **1 row created** |
| Inbox join resolution via the real `readSourceRecordId` + the real `tangoDibbsId`/`tangoSbirId` lookups | **Both keys resolved** |
| Existing 56-test suite (both new spec files) | 2 suites / 56 tests passed |

Fixture: one tenant, one client with a populated profile (UEI, CAGE, NAICS, PSC,
applicant types, one capability), one confirmed `contracting`
`client_intel_mapping` resolving to a `federal_contractor.uei`, one
`federal_award` on that UEI, one open DIBBS RFQ, one prior `tango_dibbs_award` on
the client's own CAGE, one SBIR cycle + open topic on the same agency.

Rows written (verbatim from the database):

```
source     source_record_type   source_record_key  workflow_status  relevance_score  grant_opportunity_id  sam_opportunity_id
dibbs      dibbs_solicitation   DIBBS-SOL-1        suggested        60               null                  null
sbir_sttr  sbir_topic           SBIR-TOPIC-1       suggested        60               null                  null
```

`match_signals_jsonb` carried `{"reasonCodes":["prior_cage_award_history"],
"dibbsPartProfileGap":"no_client_parts_recorded"}` and
`{"program":"SBIR","cycleName":"DoD 26.1","reasonCodes":["prior_agency_history",
"capability_topic_match"],"sbirPhaseGap":"phase_not_published_by_source"}`
respectively. SBIR's `eligibility_state` is `needs_review` with the scorer's real
reason; DIBBS's is null, not fabricated. Both are what the code claims.

Three further scenarios, same fixture, one variable changed each time:

- **S2** — remove the prior CAGE award and the federal award history:
  `evaluated=1 created=0 skipped=1 errors=0 coverage=COMPLETE`, zero rows.
- **S3** — restore a capability keyword that *does* substring-match the
  solicitation's nomenclature, still no CAGE award:
  `evaluated=1 created=0`, zero rows. Capability text alone can never mint a
  DIBBS row.
- **S4** — two tenants, the second empty: the run reports `coverage=COMPLETE`
  from the *last* tenant's walk outcome (see F4).

The probe harness was written from scratch for this review, run, and deleted. It
was not committed.

---

## The specific bug shape I was asked to hunt: NOT PRESENT

The prior risk note for exactly this code reads: a `sourceRecordKey` / join-key
mismatch that *"passes every DB constraint while making every row silently
invisible."* D-79's own decision-log entry claims it was deliberately avoided.

**I verified the claim rather than accepting it, and it holds.**

- Both producers persist `sourceRecordKey` as the provider's own id —
  `tangoDibbsId` / `tangoSbirId` — via `sourceRecordIdentityColumns`, **not** the
  business-key fields (`solicitation`, `topicNumber`), which are non-unique and
  are not what the inbox joins on.
- `funding-opportunity-inbox.service.ts`'s `titlesFor` resolves DIBBS rows via
  `tangoDibbsSolicitation.findMany({ where: { tangoDibbsId: { in: … } } })` and
  SBIR rows via `tangoSbirTopic.findMany({ where: { tangoSbirId: { in: … } } })`,
  keyed through `readSourceRecordId`. I executed that exact resolution against
  the rows the producers created: `DIBBS-SOL-1` → the solicitation,
  `SBIR-TOPIC-1` → the topic. Both hit.
- The read-back inside each producer (`clientFundingOpportunity.findMany({
  sourceRecordKey: { in: page.map(…) } })`) uses the same field it writes, so
  idempotency and human-decision protection key correctly.
- `'dibbs'` and `'sbir_sttr'` are both in `INBOX_SOURCES`
  (`[...OPPORTUNITY_SOURCES, 'agency_forecast', 'dibbs', 'sbir_sttr']`), so the
  rows are requestable, not merely storable.

Every other join between candidate rows and existing schema also checks out:

- `tenant_id` / `client_id` are `uuid` on both sides; the in-memory dedupe map is
  keyed `${clientId}:${sourceRecordKey}` identically on the read and write paths.
- The rows satisfy the real `client_funding_opportunity_one_source_chk` generic
  branch (`source NOT IN ('grants_gov','sam_gov')` AND both legacy pointers NULL
  AND both generic columns NOT NULL) and the real partial unique index
  `client_funding_opportunity_generic_uniq` — confirmed by successful insert
  against the migrated schema, not by reading the migration.
- `hasPriorCageAward`'s raw SQL names `awardee_cage` and `awardee_cage_code`,
  which are the actual `tango_dibbs_award` column names. Executed successfully.
- RLS: `rls_bypass()` is `current_setting('app.bypass_rls', true) = 'on'`, which
  is exactly what `withBypass` sets. Verified against the live policy definitions
  on `clients`, `client_intel_mapping` and `client_funding_opportunity`.

**Conclusion: no join-key or key-type mismatch. The rows are visible.**

---

## Findings

### F1 — HIGH — Neither producer has a single test that touches a real database

Both spec files build `makeFake`: a plain object of `jest.fn()` delegates plus a
hand-written `matchesWhere` interpreter that re-implements a subset of Prisma's
`where` semantics in ~15 lines. 56 tests, all green, none of which can observe:

- the `client_funding_opportunity_one_source_chk` CHECK constraint;
- the `client_funding_opportunity_generic_uniq` partial unique index;
- RLS, `rls_bypass()`, or whether `withBypass` actually bypasses anything;
- the real column names in the two raw SQL statements
  (`tango_dibbs_award.awardee_cage` / `.awardee_cage_code`, `intel_feature_flag`);
- `VarChar(16)` / `VarChar(48)` / `VarChar(64)` truncation;
- Prisma `select` semantics — the fake ignores `select` entirely and returns
  whatever the fixture literal holds, so a missing field in
  `CLIENT_PROFILE_SELECT` or `SOLICITATION_SELECT` would be invisible.

This is precisely the P48 category: a mocked-repository suite at 100% green while
the real SQL is unexercised. **The distinction that matters here is that I closed
the gap manually and the code passed** — so this is an assurance gap, not a
latent defect. But the next change to these two files has no safety net at all,
and the program has already been bitten by this exact pattern once.

*Queued remedy:* one integration test per producer against a disposable Postgres
(`prisma migrate deploy` + minimal fixture + `--commit` + assert one row exists
and resolves through `readSourceRecordId`). The harness I wrote for this review
is about 120 lines and took one iteration to get right.

### F2 — HIGH — A zero-row run is indistinguishable from a healthy run, from a misconfigured run, and from a broken one

There is **no intermediate instrumentation**. Concretely:

- The only counters are `evaluated / created / refreshed / markedStale /
  humanDecisionsPreserved / errors`, plus `clientsRead` and `opportunitiesRead`.
  Nothing reports *why* a pair was rejected.
- `counts.skipped` aggregates three distinct outcomes — `skip_below_floor`,
  `noop`, and `skip_human_decision` — into one number, and then **that number is
  discarded twice over**: the console summary in `main()` does not print
  `skipped`, and `sync_run` has no skipped column (`rows_inserted`,
  `rows_updated`, `error_count` only). The single most diagnostic figure a
  producer computes never reaches an operator.
- Neither rail counts its own sole live gate (see F3): no count of clients with a
  `cageCode`, clients with a prior CAGE award, clients whose
  `identityBasis.contract === 'exact_uei'`, or topic-agency matches.
- No reason-code histogram, though `scored.reasonCodes` is already in hand on
  every iteration.
- `counts.complete` is left `undefined` on a clean run, and
  `runWithSyncRun` records `complete: counts.complete !== false` → `true`. A run
  that evaluated nothing therefore lands as **`status: 'success'`,
  `rows_inserted: 0`, `error_count: 0`** — the exact "zero rows, complete:true"
  signature, with nothing anywhere to distinguish it from a correct pass.
- `resolveTenantIds` returning `[]` produces one `console.warn` and then a
  fully "successful" all-zero SyncRun.

Demonstrated live: scenario S2 above emitted exactly two lines —
`[dibbs-candidates] 1 active rfq/rfp rows scanned` and the summary — for a run
whose real answer was "the one client has no prior DLA award on its CAGE."

*Queued remedy:* count and log, per run, at minimum: pairs rejected by the floor,
pairs rejected as `noop`, clients with the live gate satisfied, and a reason-code
histogram. Persist `skipped` (add the column, or fold it into `error_message` on
a zero-insert run).

### F3 — MEDIUM — Each rail has exactly one live gate, and it is documented nowhere the operator will look

**DIBBS.** `clearsSuggestionFloor` is set true only in Rule 4, on
`exactNsnMatch || exactPartNumberMatch || priorCageAwardHistory`. The producer
hardcodes the first two to `false` (correctly — no client part store exists). So
**`priorCageAwardHistory` is the sole live gate**: a DIBBS candidate can only ever
be created for a client that has a `cageCode` recorded *and* a matching row in
`tango_dibbs_award`. Proven by execution (S3): a capability keyword that matches
the nomenclature produces zero rows.

The consequence, which no code comment, test, log line or the D-79 decision-log
entry states: **while DIBBS *award* ingestion has not run, this producer is
structurally guaranteed to create zero rows for every client, regardless of how
many solicitations are synced.** D-79 correctly records that the sync→producer
chain is dormant end-to-end; it does not record that the producer's output is
gated on the *award* half of that ingestion specifically, which is a sharper and
more actionable statement.

**SBIR.** Rule 4 is entirely unreachable — both
`programElementLinkedSourceBacked` and `priorSbirHistorySourceBacked` are
hardcoded `false`. The sole live path is Rule 5 with `historyIsIdentifierBacked`,
requiring **both** a UEI-backed contractor identity (own `uei`, or a confirmed
`contracting` mapping resolving through `federal_contractor.uei`) **and** a
`federal_award` whose `awarding_agency`/`awarding_sub_tier` matches the topic's
`agency`. A name-derived history explicitly does not clear the floor.

This is defensible design — it is the "a dormant signal passed `false` is honest"
posture the scorers argue for at length, and I agree with it. The finding is that
the *operational narrowness* is invisible: an operator enabling these schedules
has no way to know that a full, clean, `COMPLETE` run producing zero rows is the
expected outcome for most of the client base.

*Queued remedy:* state the single live gate in each producer's docblock and in the
decision log, and emit it as a counter per F2.

### F4 — MEDIUM — Multi-tenant coverage and the resume cursor are both wrong across tenants

In both producers:

```ts
for (const tenantId of options.tenantIds) {
  clientWalkOutcome = await walkKeyset<ClientProfileFacts>({
    startCursor: options.resumeClientCursor ?? null,
    …
  });
}
```

Two defects fall out:

1. `clientWalkOutcome` is **reassigned** each iteration and only the final value
   feeds the coverage decision. An `INCOMPLETE` client walk on tenant A is erased
   by a `COMPLETE` walk on tenant B, so the run reports `COMPLETE` /
   `complete: true` while tenant A was partially evaluated — which lets
   `lastSuccessfulWatermark` advance over an unevaluated tail.
2. `startCursor: options.resumeClientCursor` is applied to **every** tenant's
   walk, not just the tenant the cursor came from. A resumed multi-tenant run
   silently skips the head of every other tenant's client list.

Mitigations, stated honestly: the *inner* (solicitation/topic) walk's
incompleteness is tracked in a separate `solicitationWalkIncomplete` /
`topicWalkIncomplete` flag that is checked independently, so the reachable half
of the problem is already handled; and the client-page runaway guard needs
>200,000 clients in one tenant to trip. Defect (2) is the more reachable of the
two, since an inner-walk `INCOMPLETE` legitimately prompts an operator to resume.

**Inherited, not introduced.** `generate-sam-opportunity-candidates.ts` has the
identical shape at its lines 370–377 and 608–612. D-79 duplicated a pre-existing
family defect into two more scripts rather than creating one.

### F5 — LOW — Full cross product, corpus re-walked per client page, one transaction per written row

The source-corpus walk is nested *inside* the client walk's `onPage`, so the
entire DIBBS/SBIR corpus is re-read once per 500-client page. `evaluated` is
clients × solicitations, and every pair invokes the scorer. Each committed
create/update opens its **own** `withBypass` transaction — one interactive
transaction per written row. At a realistic corpus (measured elsewhere in this
program: ~17,900 active SAM notices) with a few hundred clients this is millions
of scorer calls and a full corpus re-read per page. Also inherited from the SAM
producer's shape.

### F6 — LOW — "N rows scanned" reports 0 when the *client* walk found nobody

`solicitationCorpus` (DIBBS) and `topicCorpus`/`openCorpus` (SBIR) are only ever
assigned inside the client walk's `onPage`. With zero clients the inner walk never
runs and the log reads `[dibbs-candidates] 0 active rfq/rfp rows scanned` — a
false statement about the source corpus. The summary's `clients=0` disambiguates,
so this is cosmetic, but it is the first line an operator reads.

### F7 — LOW — Producers scheduled 5 minutes after their source syncs

`SyncTangoDibbs` 13:10 → `GenerateDibbsOpportunityCandidates` 13:15;
`SyncTangoSbir` 13:30 → `GenerateSbirOpportunityCandidates` 13:35. If a sync runs
longer than five minutes the producer scores a partially-synced corpus and marks
the not-yet-synced remainder as having no candidate. Both entries ship
`enabled: false`, so this is forward-looking only.

### F8 — LOW — `intel_feature_flag` is invisible to this repo's schema, migrations and CI

`resolveTenantIds` reads `intel_feature_flag`, a table owned by **intel-api**. It
appears in none of this repo's 264 migrations and not in `schema.prisma`, so
`prisma migrate deploy` against a fresh database does not create it and
`resolveTenantIds` cannot be executed in any local or CI environment — I had to
create the table by hand to run this review. Its `tenant_id` is TEXT while every
consumer feeds the result into a `@db.Uuid` Prisma filter; that contract is
recorded only in a comment inside the unrelated `district-nexus-flag.guard.ts`,
which documents a real six-week outage caused by getting it wrong.

**The bypass idiom itself is correct** — I checked this specifically rather than
assuming. `withBypass` sets `app.bypass_rls`, which is exactly what
`PrismaService.withSystem` does, and `withSystem` is the established, documented
way apps/api reads intel-api-owned tables (`intelOwnedTenantIds()` in
`tracker-change-detector.service.ts` reads this same table the same way). This is
a testability/visibility finding, not a correctness one.

---

## Verified clean (negative results worth recording)

- **The V2 deletion is complete.** `apps/web/src/pages/intelligence/opportunities/v2/`
  is gone; the `lazy()` import and the `FundingOpportunitiesV2Gate` function are
  both removed; the route now renders `<FundingOpportunitiesPage />` directly;
  `useMe` is still used elsewhere in `App.tsx` (lines 495, 501) so no unused
  import is left; a repo-wide search for `FoV2`, `fo-v2`, `FundingOpportunitiesV2`
  and `opportunities/v2` across `apps/`, `packages/` and `infra/` returns only
  unrelated SAM.gov API URLs and two deliberate explanatory comments in the new
  regression test. **No dangling route or import.** A regression test pins a
  `capiro-internal` tenant to the real page.
- **The confidence→relevanceScore bridge invariant is real.** I re-derived it from
  both scorers' rule chains independently: `clearsSuggestionFloor: true` never
  co-occurs with `recommendationConfidence: 'low'` in either function, so the
  boolean floor is the operative gate and the numeric mapping only matters above
  `--min-relevance=60`. Both specs pin it.
- **Awards structurally cannot become DIBBS candidates.** Enforced by type
  (`DibbsPursuableDocumentType = 'rfq' | 'rfp'`) and by table separation, not by a
  filter. Confirmed.
- **Dry-run is genuinely the default and genuinely reads.** Reads always execute;
  only create/update is gated on `commit`, so a dry run reports real counts.
  Confirmed in S2/S3.
- **Entrypoint, tsconfig and schedule wiring are consistent** — both verbs added
  to the dispatcher case statement *and* to the unknown-command usage string,
  both script+spec pairs added to `tsconfig.funding-opportunities.json`, both
  schedule entries `enabled: false`.

---

## The mandatory question

> Is there ANY assertion anywhere that would fail if this producer silently
> created zero candidates against data that should have produced at least one?

**Yes — but only against an in-memory double whose fixture is hand-tuned so the
single live signal fires.**

`expect(r.created).toBe(1)` appears in both specs (DIBBS lines 268, 330; SBIR
line 313), and those assertions would indeed fail on a zero result. But they run
against `makeFake`, whose default is:

```ts
const cagesWithAwards = new Set((opts.cagesWithAwards ?? ['1ABC2']).map(c => c.toUpperCase()));
```

— i.e. the fake's default prior-CAGE-award set is hardcoded to the default
client fixture's own CAGE, with a comment acknowledging that a "happy path"
fixture needs one because it is the only signal that can clear the floor.

So: **there is no assertion, anywhere, that would fail if these producers created
zero rows against a real database.** There is likewise no runtime guard, no
alarm, and no SyncRun status that distinguishes "zero because nothing qualified"
from "zero because of a defect" — a zero run is recorded as `status: 'success'`,
`rows_inserted: 0`, `error_count: 0`.

That is the headline. It is also why I ran the code against real Postgres rather
than reporting the gap alone: with the gap closed by hand, **the producers work.**

---

## Approval record

**Verdict: `D79_PRODUCER_WIRING_INDEPENDENTLY_APPROVED`** — 2026-08-13, by an
independent agent that did not implement, test or merge D-79.

The change as merged is correct and contained. The specific failure mode this
program feared for this code — a `sourceRecordKey` mismatch that passes every
constraint while making every row invisible — was verified absent by execution
against a real migrated database, not by reading the code that claims to avoid
it. The V2 deletion is complete with no dangling references.

Eight findings are queued above, none fixed. F1 (no real-database test) and F2
(a zero-row run is indistinguishable from a broken one) should be closed before
`GenerateDibbsOpportunityCandidates` or `GenerateSbirOpportunityCandidates` is
enabled, because until then the first real run has no way to tell anyone whether
it worked.
