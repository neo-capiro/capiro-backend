# Funding Opportunities + MakeGov/Tango — frozen baseline (P00)

| | |
|---|---|
| Program | Funding Opportunities → client-first federal-capture operating system |
| Plan | `funding-opportunities-makegov-shippable-microphase-plan.md` v1.0 (P00–P51) |
| Base SHA | `cf2934faa07c0d2e7c704e1aacd9ebccd066e45e` (`main`, 2026-08-06) |
| Provider name in code | `tango` |
| Product-facing name | MakeGov/Tango enrichment |
| Feature flag | `intel_feature_flag.feature = 'funding_opportunities'` |
| Dedicated gate | `.github/workflows/funding-opportunities-ci.yml` |
| Rollout runbook | `docs/runbooks/funding-opportunities-rollout.md` |

**This document records what existed BEFORE the program started.** It is not a design
doc and not a plan. Its only job is to make later drift detectable: when P22 adds
vehicles or P28 adds notice history, the question "was that always like that?" has a
written answer instead of a `git log` archaeology session.

Machine-checked companion: [`apps/api/src/funding-opportunities/__fixtures__/baseline-contract-v1.json`](../../../apps/api/src/funding-opportunities/__fixtures__/baseline-contract-v1.json),
enforced by `funding-opportunities.baseline-contract.spec.ts`. Where this prose and
that fixture disagree, **the fixture wins** — it is the one a test reads.

---

## 1. What shipped, and how dark it is

Every route lives on `FundingOpportunitiesController` (`@Controller('intelligence')`),
guarded by `RolesGuard` then `FundingOpportunitiesFlagGuard`:

| Method | Route |
|---|---|
| `list` | `GET /api/intelligence/opportunities` |
| `getOne` | `GET /api/intelligence/opportunities/:source/:id` |
| `listForClient` | `GET /api/intelligence/clients/:clientId/opportunities` |
| `summaryForClient` | `GET /api/intelligence/clients/:clientId/opportunities/summary` |
| `save` / `patch` / `dismiss` / `restore` | workflow writes |

Web surfaces: `/intelligence/opportunities` (`FundingOpportunitiesPage`),
`FundingOpportunitiesSection` embedded in the client Intelligence tab, and
`/settings/intelligence-mappings`.

**As of the freeze, nothing has been enabled.** The runbook's own words: *"Nothing in
this runbook has been executed."* No migration applied by that work, no image
deployed, no flag row written, no producer run, no schedule enabled. All four
Funding-Opportunities schedule entries in `infra/cdk/lib/ingestion-schedule.ts`
(`SyncSamOpportunitiesAllFederal`, `GenerateFundingGrantCandidates`,
`GenerateSamOpportunityCandidates`, `ProcessFundingOpportunityLifecycle`) are
`enabled: false`.

> Two neighbouring grant jobs — `SyncGrantsReconcile` and `EnrichGrantDetails` — are
> `enabled: false` in CDK but their live EventBridge rules were hand-created on
> 2026-07-27 and **are enabled**. That drift is documented in the CDK file itself and
> is not ours to fix. It matters here only because a reader who trusts `enabled: false`
> globally will be wrong about those two.

`capiro-dev` is the live production environment, and the tracked `Capiro-dev-Compute`
stack is drifted. Do not deploy it — including during a rollback.

---

## 2. The invariants this program may not break

These are the properties the current code already has. Each is machine-enforced;
the "enforced by" column is where a violation goes red.

| # | Invariant | Enforced by |
|---|---|---|
| 1 | No blended money. No `totalAmount`, no `*Amount` key. `grantFunding` is null on a SAM row; `contractValue` is null on a grant row. | `baseline-contract.spec.ts`, `boundaries.spec.ts`, `service.spec.ts` |
| 2 | Null money is not zero. Every money field is `number \| null`; nothing coerces to `0`. | `baseline-contract.spec.ts`, `service.spec.ts` |
| 3 | Relevance is not eligibility. Separate keys, separate functions, eligibility always carries a reason. | `baseline-contract.spec.ts` |
| 4 | Explicit flag, no internal fallback. Missing row, missing tenant context, and a *failing* flag read all 404. | `boundaries.spec.ts` |
| 5 | Portal users get nothing. `client_portal_user` ranks below `standard_user` → 403 on all 8 handlers. | `boundaries.spec.ts` |
| 6 | Failure is not empty. A failing catalog read propagates; `EmptyReason` has no "it broke" member. | `baseline-contract.spec.ts`, `service.spec.ts` |
| 7 | Closed and informational notices cannot be pursued. `saved` stays available. | `service.spec.ts` |
| 8 | The producer never overwrites a human decision. | `producer-decision.spec.ts`, producer specs |
| 9 | Workflow writes are tenant-scoped and audited; the service never touches the workflow model outside `withTenant`. | `boundaries.spec.ts` |
| 10 | An opportunity never contributes to a District Nexus score. | `boundaries.spec.ts` |

### 2.1 Two invariants that are narrower than they sound

Worth stating precisely, because both have an obvious wrong reading that later
phases would encode:

**"Failure is not empty" is not uniform.** The *catalog* reads
(`fetchSourceRows` / `fetchGrantRows` / `fetchSamRows`) have no try/catch and
propagate. But two ancillary reads deliberately fail soft, each with a code comment
saying why:

- `readAwardHistory` catches and returns empty history — award-history relevance
  signals silently stop firing, the request still succeeds.
- `readFreshness` catches and returns `countsUnavailable: true` with null timestamps.
  It keeps `neverSynced: false`, because "we do not know" must not be reported as
  "it has never synced". Opportunities still render.

**`staleAt` does not mean "the source closed".** Two different mechanisms exist:

- `staleAt` (both candidate producers) means *still open, but no longer clears the
  relevance floor for this client*. It can only fire for rows the producer's own
  query still returns, i.e. still active.
- `workflowStatus = 'expired'` (`process-funding-opportunity-lifecycle`) is the
  actual source-closed mechanism, and only for rows that are `suggested` and not
  `userCreated`. It is silent to the user but always audit-logged.

---

## 3. Frozen response contract

Full key lists live in the fixture. The shape, in brief:

- `FundingOpportunity` — 41 keys. Money is two mutually exclusive blocks:
  `grantFunding` (`estimatedProgramFunding`, `awardFloor`, `awardCeiling`,
  `expectedAwardCount`, `costSharingRequired`) and `contractValue`
  (`estimatedValue`, `basis`).
- `ContractValue.estimatedValue` is **always null today**, with
  `basis: 'not_stated_by_source'`. That is a fact about SAM's `opportunities/v2`
  payload, not an unfinished TODO: the only dollar figure it carries is
  `award.amount` on an award notice, which is money already obligated to someone
  else.
- `relevanceScore: number` and `eligibility: { state, reason }` are siblings.
- `FundingOpportunityListResponse.total` / `totalIsCapped` are row counts, not money.
  They are the only allowlisted `total*` keys in the contract.

### 3.1 Vocabularies

| Vocabulary | Values |
|---|---|
| `OPPORTUNITY_SOURCES` | `grants_gov`, `sam_gov` |
| `OPPORTUNITY_WORKFLOW_STATUSES` | `suggested`, `saved`, `pursuing`, `dismissed`, `won`, `lost`, `expired` |
| `HUMAN_DECISION_STATUSES` | `saved`, `pursuing`, `dismissed`, `won`, `lost` |
| `ELIGIBILITY_STATES` | `eligible`, `ineligible`, `needs_review`, `unknown` |
| `NON_PURSUABLE_KINDS` | `award_notice`, `special_notice` |
| `OPPORTUNITY_KINDS` | 10 values, `other` as the honest bucket |
| `EmptyReason` | 6 values, none meaning "the request failed" |
| Write DTOs accept | `saved`, `pursuing`, `won`, `lost` only |

Notes a later phase will otherwise get wrong:

- The plan's §4.5 table names `reviewing`, `qualified`, `submitted`, `monitor` and
  `pass`. **None of those exist in this codebase today.** P07 (human decision) and
  P35 (pipeline stages) are the phases that introduce that vocabulary; until then,
  the seven statuses above are the whole world.
- `expired` is never written by anything in `apps/api/src/funding-opportunities/` —
  only by the lifecycle script.
- `won` / `lost` / `expired` render in the UI but no button sets them. The only
  user-driven transitions are save / pursue / dismiss / restore.
- `HUMAN_DECISION_STATUSES` is **declared twice** — in `funding-opportunities.types.ts`
  and again in `producer-decision.ts`. Both currently agree. They can drift.

---

## 4. Producers and coverage limits

| Script | Coverage bound | Behavior at the bound |
|---|---|---|
| `generate-funding-grant-candidates.ts` | `OPPORTUNITY_SCAN_CAP = 4000`, `CLIENT_CAP = 500` (hardcoded) | `capped = true` → `counts.errors += 1` → run is **not** a clean success, prints `⚠️ CAPPED` |
| `generate-sam-opportunity-candidates.ts` | same names, env-overridable via `SAM_OPPORTUNITY_SCAN_CAP` / `SAM_CANDIDATE_CLIENT_CAP`, default 4000 / 500 | same |
| `process-funding-opportunity-lifecycle.ts` | none — true keyset walk, `PAGE_SIZE = 500` | walks to exhaustion |

Both producers are **single-shot `take: N`**, not paginated: anything past the cap is
never read that run. The SAM script documents the real bite — measured on `capiro-dev`
2026-07-29 there were 17,915 active in-deadline notices, so a 4,000 cap evaluates 22%
of them. This is what **P03 and P04** replace. The honest part of today's behavior is
that a capped run self-reports as containing an error rather than as complete.

The lifecycle script already has the pattern P03/P04 should follow: `id > cursor`,
`orderBy: { id: 'asc' }`, backed by `client_funding_opportunity_tenant_cursor_idx`.

Idempotency is enforced by two **partial** unique indexes
(`client_funding_opportunity_grant_uniq`, `..._sam_uniq`, each `WHERE <col> IS NOT NULL`)
plus find-then-branch in app code. Nothing may use `upsert` against those keys —
Postgres treats NULLs as distinct, so a single unique index across the nullable source
pair would admit unlimited duplicates for the other source.

Entrypoint verbs (`apps/api/scripts/entrypoint-dispatcher.inc`):
`generate-funding-grant-candidates`, `generate-sam-opportunity-candidates`,
`process-funding-opportunity-lifecycle`.

---

## 5. Schema and migrations

| Model | Scope | Table |
|---|---|---|
| `ClientFundingOpportunity` | **tenant-scoped, RLS ENABLE + FORCE, 4 policies** | `client_funding_opportunity` |
| `FederalGrant` | global, no tenant_id, no RLS | `federal_grant` |
| `SamOpportunity` | global, no tenant_id, no RLS | `sam_opportunity` |
| `SamOpportunityMatch` | global, review-gated PE link | `sam_opportunity_match` |
| `ClientIntelMapping` | tenant-scoped | `client_intel_mapping` |

`intel_feature_flag` has **no Prisma model**. It is owned by `intel-api` and read only
via raw SQL through `prisma.withSystem(...)`. Its `tenant_id` is **TEXT** — casting it
to `uuid` throws 42883, hits the guard's catch, and 404s a tenant whose flag is
genuinely on. That is a real prior incident, and there is a test pinning the absence
of the cast.

Migrations at freeze (three):

```
20260810010000_funding_opportunities
20260810020000_funding_opportunities_closeout
20260810040000_funding_opportunities_lifecycle_truth
```

No migration in the repo mentions `tango`. Source-freshness snapshot columns
(`source_fingerprint`, `source_active_snapshot`) are **nullable on purpose**: null
means "no baseline yet", which the lifecycle pass treats as a silent first
observation. A NOT NULL default would make every legacy row look already-observed and
the first run would alert on the entire corpus.

`sourceFingerprint` hashes **source-published fields only** — never
`SamOpportunity.updatedAt`, `FederalGrant.syncedAt` or `detailSyncedAt`, because those
move on every ordinary re-sync and hashing them produced an amendment alert per night.

---

## 6. The gate

`.github/workflows/funding-opportunities-ci.yml` — absolute inside scope: zero
failures, zero skips, plus suite/test floors so it cannot shrink quietly. It scopes
**inside** the job rather than with a workflow-level `paths:` filter, because a
path-filtered workflow skips the whole workflow and a required check on it blocks
every out-of-scope PR forever.

Measured at freeze, after `prisma generate`:

| App | Suites | Tests | Skipped | Floor set by P00 |
|---|---|---|---|---|
| `apps/api` | 20 (files) | 584 | 0 | **20 / 575** (was 19 / 500) |
| `apps/web` | 26 (describe blocks) | 79 | 0 | 25 / 75 (unchanged) |

Jest counts *files* in `numTotalTestSuites`; vitest counts *describe blocks*. The api
suite floor moved with the file count deliberately: without it, someone could delete
`funding-opportunities.baseline-contract.spec.ts` and stay green.

`apps/api/tsconfig.json` **excludes `scripts`**, so `apps/api/tsconfig.funding-opportunities.json`
is the only thing that typechecks the producers. Its `include` is an explicit list of
22 literal file paths with no globs — **a new script not added to that list is
typechecked by nothing.** New files under `src/` are covered by the ordinary
`apps/api` typecheck and by the gate's `src/funding-opportunities/` test glob.

### 6.1 Local reproduction

`prisma generate` is not optional. Without it, 8 of the 20 api suites fail on
`reviewStatus does not exist in type ClientIntelMappingWhereInput` — the generated
client is stale relative to the closeout migration, and the failure looks like broken
code rather than a stale artifact.

```bash
pnpm install --frozen-lockfile
pnpm --filter "./packages/*" build
pnpm --filter @capiro/api exec prisma generate
pnpm --filter @capiro/api exec jest --ci --runInBand src/funding-opportunities/
```

---

## 7. Where the program goes next

`completion-matrix.md` tracks per-phase evidence. `decision-log.md` records the locked
architectural decisions and any amendment to them.

P00 changes no production code. The first phase that changes behavior is P01
(one shared client-opportunity profile builder), and the first that changes a
persisted score is P02 (UEI-first award-history identity).
