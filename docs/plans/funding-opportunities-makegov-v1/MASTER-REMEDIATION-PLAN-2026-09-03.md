# Master remediation plan — Funding Opportunities + MakeGov/Tango

**Date:** 2026-09-03
**Supersedes:** `IMPLEMENTATION-HANDOFF-2026-08-14.md` and `HANDOFF-2026-08-19-closeout.md`.
Both of those are now **historically accurate but operationally stale** — most of what they list
as open has since shipped, and several things they do not mention at all are the most urgent items
in this program today. Read them only for narrative background; treat *this* document as the
current state.

**Verified against:**
- `origin/main` @ **`28b1414bcc947164261f921e2aed1df3d61dc90a`** (fetched 2026-09-03)
- Live AWS account **967807252336**, profile `capiro-dev`, region `us-east-1`, checked 2026-09-03 ~21:15 EDT
- Live `capiro-dev` Aurora Postgres, queried directly via `capiro-dev-api-diag:8` Fargate tasks
- Live `os.capiro.ai`, signed in as Neo Martinez

**Deployed revisions at time of writing** (all confirmed live, not assumed):

| Service / family | Revision | Image identity | Status |
|---|---|---|---|
| `capiro-dev-api` (service) | `:278` | commit `7028c845ef89ea382efeb40bf119fb29ce1f7153` | 2/2 running |
| `capiro-dev-api-sync-jobs` | `:21` | digest `sha256:847e3d46b66a2c4c887e3aea748177492b2182f8346e0511f0eb934991a62020` | ACTIVE in ECR, registered today |
| `capiro-dev-web-vnext` (service) | `:225` | ECR tag `28b1414bcc947164261f921e2aed1df3d61dc90a` | matches `origin/main` exactly |
| `capiro-dev-api-diag` | `:8` | same digest as sync-jobs `:21` | fixed today, proven with a real query |
| `capiro-dev-api-migrate` | `:95` | tag `45a8c6db78005ee89dca38ad63751b3f29056834` | **BROKEN — image pruned from ECR** |

**Method note:** this document is a plan. Nothing in it has been implemented except where a section
explicitly says "FIXED TODAY" and names the command that did it. No git branch here was committed,
pushed, or merged as part of writing it — same convention as every other document in this folder.

---

## 1. Executive summary

Five parallel discovery agents re-verified this program's entire remediation trail against live
`origin/main`, live AWS, and the live `capiro-dev` database today, and the picture has changed
substantially since 2026-08-19. **Four of the five fix branches the older handoffs list as open are
merged and deployed** — DIBBS+SBIR scoring (PR #1098, merge `9b9ae5083`), P46 webhook delivery-loss
(PR #1099, merge `f3be71ee8`), the Meri forecast-flag bypass (PR #1100, merge `373071239`), and the
SBIR solicitation date-order fix (PR #1101, merge `fdceece66`) are all ancestors of `origin/main` and
of deployed commit `7028c845e`, with content verified by diff and no reverts; the "Requirements
failed to load" UI bug is likewise fixed (PR #1115, merge `96355d3ca`), deployed on web-vnext `:225`,
and confirmed working live on a real Grants.gov opportunity. **Only P08 task-idempotency remains from
the original five** — its fix commit `1d6430365` was never even pushed to `origin`, and the TOCTOU
race it targets is still live in deployed code (`funding-opportunity-actions.service.ts:145-153`:
`findFirst`-then-`create` under READ COMMITTED with no unique index and no `P2002` backstop). What
has replaced those closed items as the program's real risk surface is **three things the older
documents never mention**: (a) two newly-proven, opposite-direction defects in grant matching — a
producer-side relevance floor that structurally refuses good matches (proven live: 164,428 real
(client, grant) pairs evaluated, only 4 candidates created) and a `normalizeListing` regex that
collapses `93.00R`/`93.00E`/etc. into false "exact match" strong signals — neither fixed, both
changing what real clients see, both explicitly awaiting Neo's go-ahead; (b) the **SAM.gov API key
has been returning HTTP 401 for 36 consecutive days** (since 2026-07-30), making every client's
core contract-opportunity data stale to Jul 29 — an external, human-only fix outside AWS; and (c)
the ECR image-pruning failure mode has now recurred for at least the **fifth** time in this
program's history, this round killing *all* grants ingestion silently for 5-6 days while CloudWatch
reported `Invocations=1/day, FailedInvocations=0` the entire time. Two of those infra failures were
repaired today (`sync-jobs:21` + 11 EventBridge rules retargeted and smoke-proven; `api-diag:8`
registered and proven with a real query), but **`capiro-dev-api-migrate:95` is still pointed at a
pruned image and was deliberately left alone** pending Neo's go-ahead given its cross-team blast
radius. Separately, the Tango **agency-forecast capability was rigorously audited for the first
time and is 100% dark**: the flag is genuinely `enabled=true` for capiro-internal plus six real
client tenants, the scoring logic is provably correct, and yet `tango_procurement_forecast` has
**0 rows** and no sync has ever run — seven tenants are looking at a filter that can only ever be
empty. Finally, **none of the four program-closeout items has moved at all**: the real
`completion-matrix.md` and `decision-log.md` on `origin/main` are byte-identical to their
2026-08-13 state (last touching commit `aebec3b32`, zero commits to this directory in 295 commits
of main), no decision past **D-79** exists, the P49 canary has never been run and its four known
runbook defects are unchanged since the file was created on 2026-08-08, and the nine originally
uncovered phases (P05, P20, P21, P31, P37, P38, P39, P44, P45) still have no formal review recorded
anywhere.

---

## 2. Definitive current-status table

Status values: **DONE-VERIFIED** (proven live/by execution today) · **DONE-UNVERIFIED** (code
shipped, effect not yet observed) · **PARTIALLY-DONE** · **NOT-STARTED** · **BLOCKED** (on what).

### 2.1 The five fix branches

| # | Item | Status | Evidence / what remains |
|---|---|---|---|
| F1 | DIBBS + SBIR scoring fix (`hasPriorCageAward` item-scoping; `normAgency` agency normalization) | **DONE-VERIFIED** | Merge `9b9ae508386cc0d42ccb47c0e0b50d5e73bfd81f` (PR #1098) is an ancestor of `origin/main` and of deployed `7028c845e`. Content confirmed by `git diff 3c4efd70d d78df4f9e`: `dibbs-relevance.ts` no longer lets `priorCageAwardHistory` participate in `hasStrongMatch`; `sam-opportunity-relevance.ts` carries `normAgency`. Unreverted, and since extended (`agencyFetchVariants`, `expandClientNaicsCodes`). Original branch tip `48eab5761` is *not* an ancestor — expected, it was rebased before merge; do not read that as "unmerged." |
| F2 | P46 webhook delivery-loss (identity = `payload_sha256`, not a missing `delivery_id`) | **PARTIALLY-DONE** | Code: merge `f3be71ee84b196bb7edbeae8084158a0e8febe29` (PR #1099) is an ancestor of `origin/main` and deployed `7028c845e`. Effect: **never exercised.** Live DB via `api-diag`: table is `tango_webhook_delivery` (**singular** — correction to earlier notes that said `tango_webhook_deliveries`), `{total:0, processed:0, received:0, failed:0, earliest:null, latest:null}`. No real Tango webhook has ever been received in `capiro-dev`. Still needs a real signing secret + a real delivery to prove. |
| F3 | Meri forecast-flag bypass (`buildOpportunityActionPlan` ungated `agency_forecast`) | **DONE-VERIFIED** | Merge `373071239c405ba2d96f2cfd4885675b840c4f07` (PR #1100), ancestor of `origin/main` and deployed `7028c845e`. Exactly one commit has touched `meri-opportunity-tools.adapter.ts` since (`26db4fd66`, the fix itself). Guard present on main today. |
| F4 | SBIR solicitation date-order (inverted `close_date < open_date`) | **DONE-VERIFIED** | Merge `fdceece668d3ff93f00ed69ea40182395bf370be` (PR #1101), ancestor of `origin/main` and of sync-jobs' deployed `7028c845e`. Live DB: `tango_sbir_topic` `total_sbir: 9700`, `inverted: 0`. The historical "66 inverted" figure was a backfill-moment count, not a recurring metric — do not treat its absence as a regression. |
| F5 | P08 task-creation idempotency race | **NOT-STARTED** | Commit `1d643036532ffe6fb769006e33538ad3aaed9693` exists **only in local git objects** — `git ls-remote origin refs/heads/fix/p08-task-idempotency` returns nothing (never pushed, never PR'd). Worktree is at **`C:\c\dev\capiro-p08-fix-wt`** (note: `C:\c\dev\`, *not* `C:\dev\` — the git worktree list renders it as `C:/c/dev/...`; a `ls C:\dev\capiro-p08-fix-wt` will report MISSING and mislead you). The race is still live on `origin/main`: `funding-opportunity-actions.service.ts` has been touched by exactly one commit ever (`0fd4e819d`, 2026-08-06 — the original feature), `act()` does `tx.engagementTask.findFirst` (line 146) then `tx.engagementTask.create` (line 153) inside `prisma.withTenant()` with no isolation override (default READ COMMITTED) and no unique constraint; `EngagementTask`/`engagement_tasks` has only the two non-unique indexes `tenant_client_status` and `tenant_due`. No compensating fix from any other session. Live: `engagement_tasks` has **0 rows** with `source_type='funding_opportunity'` — no duplicates *yet*, because the path has seen no concurrent real traffic, not because it is safe. |

### 2.2 UI bugs and SAM.gov sync

| # | Item | Status | Evidence / what remains |
|---|---|---|---|
| U1 | "Requirements failed to load" on non-SAM.gov opportunities | **DONE-VERIFIED** | Merge `96355d3ca` (PR #1115) is an ancestor of `origin/main`. Both panel trees (`apps/web/src/pages/intelligence/opportunities/OpportunityRequirementsPanel.tsx` and `apps/web/src/vnext/pages/funding-opportunities/OpportunityRequirementsPanel.tsx`) gate on `enabled: flag.ready && flag.enabled && supportsRequirements` where `supportsRequirements = source === 'sam_gov'`, and render `data-testid="fo-requirements-not-supported"` before the query fires. `git log 96355d3c..origin/main` shows zero further commits to either file. Deployed: web-vnext `:225` carries ECR tag `28b1414bcc9…` = current main. Live-confirmed at `https://os.capiro.ai/intelligence/opportunities/grants_gov/360510` — reads the honest not-supported copy, not the error. **No action.** |
| U2 | SAM.gov sync EventBridge rules pointed at a pruned image | **DONE-VERIFIED (fixed today)** | Both `capiro-dev-sync-sam-opportunities` and `capiro-dev-sync-sam-opportunities-all-federal` targeted `capiro-dev-api-migrate:68` (tag `9c302d260…`, garbage-collected from ECR). Live-reproduced `CannotPullContainerError`. Retargeted via `events put-targets` to `capiro-dev-api-sync-jobs:21`, container `api-sync-jobs`. Both proven with real `ecs run-task` smoke tests — log streams `sync-jobs/api-sync-jobs/829830071d0b4edbaa68f2ede1e4b865` and `.../f025b30c427a4280a92f36f974a82599` show real app execution. Silent-failure mode is gone; jobs now log a clear error. |
| U3 | SAM.gov API key returning HTTP 401 for 36 days | **BLOCKED — on external human action (SAM.gov portal account owner)** | Last real success: `sync-sam-opportunities-all-federal` 2026-07-29 12:53:27 (192 rows), DoD variant 2026-07-29 07:51:07 (59 rows). Every run since 2026-07-30 fails in ~1s: `SAM.gov 401: unauthorized (non-JSON body). Check SAM_GOV_API_KEY is present, active, and entitled for opportunities/v2/search.` Secret `capiro/dev/sam-gov-api-key` has `LastChangedDate` 2026-04-29 and has never been rotated — SAM.gov invalidated it externally. This is why the live banner says "current to Jul 29." **Cannot be fixed from AWS.** Highest real-world impact item in this document. |
| U4 | SAM.gov rules: CDK source/live drift | **NOT-STARTED** | Both rules are CDK-managed (`infra/cdk/lib/ingestion-schedule.ts`, job defs `SyncSamOpportunities` / `SyncSamOpportunitiesAllFederal`) — unlike several other out-of-band `fo-dev-*` rules. A future `cdk deploy` of that stack could re-point the targets fixed in U2 straight back at a stale task-def. Separately, CDK source marks `SyncSamOpportunitiesAllFederal` `enabled: false` ("enable only after backfill/canary") while the live rule is `ENABLED`. Neither was touched. |

### 2.3 The two newly-proven grant-matching defects

| # | Item | Status | Evidence / what remains |
|---|---|---|---|
| G1 | Producer re-derives an incomplete relevance floor — structurally refuses good matches | **NOT-STARTED — needs Neo's explicit go-ahead** | `apps/api/scripts/generate-funding-grant-candidates.ts:295-298` inlines `strong≥1 \|\| moderate≥2`, dropping the third arm of the shared `meetsGrantSuggestionFloor` (`apps/api/src/district-nexus/grant-opportunity-relevance.ts:421`), which is *grant-specific*: `capabilityKeyword` (the only moderate signal this rail ever has) **plus** one distinctive weak topical signal (`sector`/`fundingCategory`/`knownPartner`). Compounded by line 46: `export const DEFAULT_MIN_RELEVANCE = MIN_RELEVANCE_ASSISTANCE_LISTING_FLOOR` (~29), where the sibling District Nexus producer was moved to `15` by PR #1146. Proven live: a real DOE grant ("Grid Resilience and Innovation Partnerships") against a real client whose capability is literally "grid resilience" scores 25 with `meetsSuggestionFloor: true` through the on-demand scorer, and is **refused** by the producer that populates the Triage Inbox. Live-reconfirmed after ingestion was restored today: **164,428 (client, grant) pairs across 101 real clients → only 4 new candidates.** 65/101 clients have a sector and 60 have capabilities, but only **2** have applicant-type data — exactly the profile shape the broken floor discards. This bug class was already found and fixed everywhere else by PR #1146 ("stop matching from hiding good fits", 2026-08-21, 14 files including the DN producer) and **missed in this one file**. |
| G2 | `normalizeListing` regex collapses distinct Assistance Listings into false strong signals | **NOT-STARTED — needs Neo's explicit go-ahead** | `grant-opportunity-relevance.ts:193-197`: `(value ?? '').replace(/[^0-9.]/g, '')` strips letter suffixes, so `93.00R`, `93.00E`, `93.00F`, `93.00G`, `93.00J`, `93.00K` — genuinely different real federal assistance listings — all normalize to `93.00` and register as an **exact-match `assistanceListing` strong signal** (the highest-weight signal in `RELEVANCE_WEIGHTS`). Proven against real production data: `93.00R` has 75 real award rows behind it; a false hit there scores 29 with `meetsSuggestionFloor: true`, clearing the recommendation floor entirely on its own. Note this is the **opposite direction** from G1: G1 hides good fits, G2 manufactures bad ones. Both are consumed by the same code path. |

### 2.4 ECR / infrastructure

| # | Item | Status | Evidence / what remains |
|---|---|---|---|
| I1 | `capiro-dev-api-sync-jobs` valid revision + 11 grant/DIBBS/SBIR EventBridge rules retargeted | **DONE-VERIFIED (fixed today)** | `:21` registered today against digest `sha256:847e3d46…` (ECR status ACTIVE, pushed 2026-09-03T17:35:53-04:00, pulled 17:36:52). Reconfirmed unchanged at 21:14. All 11 rules retargeted and **proven by real smoke runs**: `sync-grants` (1,598 opportunities upserted, 87 expired, 0 errors), `enrich-grant-details` (300 enriched, 0 errors), `generate-funding-grant-candidates` (164,428 pairs evaluated, 4 created, 118 refreshed, 0 errors). `fo-dev-generate-dibbs-opportunity-candidates`, `fo-dev-generate-sbir-opportunity-candidates`, `fo-dev-sync-tango-dibbs/sbir`, `fo-dev-reconcile-tango-dibbs/sbir-full` all confirmed targeting `:21`. **This closed a real 5-6 day production outage** — all grants ingestion had been dead since 2026-08-28/29 because `sync-jobs:20`'s image had been pruned. |
| I2 | `capiro-dev-api-migrate:95` points at a pruned image | **NOT-STARTED — deliberately untouched, needs Neo's explicit go-ahead** | `aws ecs describe-task-definition --task-definition capiro-dev-api-migrate` → revision 95, image tag `45a8c6db78005ee89dca38ad63751b3f29056834`; `aws ecr describe-images --image-ids imageTag=45a8c6db78…` → `ImageNotFoundException`. Revision 95 is still the family's active revision. **23 of 27 EventBridge rules across multiple unrelated programs point at this family** — this is not a Funding Opportunities-local fix and must not be done casually as part of FO work. |
| I3 | `capiro-dev-api-diag` broken (pruned image) | **DONE-VERIFIED (fixed today)** | `:7` pointed at tag `da6cff74bf15a074d4a703d40513eac9abd711b0` → `ImageNotFoundException`. Registered `:8` with identical container/env/secrets/role config, repointed to the confirmed-good digest `sha256:847e3d46…`. Proven with a real query, not a placeholder: task `6b5f9b61a4d049369446b3535a38e70e`, exit code 0, log stream `diag/db-inspect/6b5f9b61a4d049369446b3535a38e70e` → `DIAG_OK [{"now":"2026-09-04T01:12:42.111Z","cfo_count":0,"cgn_count":0,"federal_grant_count":83443}]`. In-scope: read-only diagnostic, minimal blast radius. |
| I4 | ECR image-pruning root cause (recurred ≥5 times) | **NOT-STARTED** | The account's `keep last 5 images, any tag` ECR lifecycle policy, combined with heavy concurrent build traffic from many unrelated teams sharing one `capiro/dev/api` repo, garbage-collects images that live task definitions still reference. **The insidious part, which belongs in every future postmortem for this program: CloudWatch showed `Invocations=1/day, FailedInvocations=0` for the entire 5-6 day grants outage.** Every dashboard read healthy while producing nothing, because a container that fails to pull its image never gets far enough to emit a failure signal. This is the sixth independent confirmation of this program's single most-repeated finding: *a no-op run reads identical to a healthy one.* |

### 2.5 District Nexus vs Funding Opportunities

| # | Item | Status | Evidence / what remains |
|---|---|---|---|
| D1 | Two producers resolve client↔UEI identity two different ways | **NOT-STARTED (documented divergence, low priority)** | Funding Opportunities producers (`generate-funding-grant-candidates.ts`, `-dibbs-`, `-sam-`, `-sbir-`) all share `readClientProfileFactsMany` → `ClientProfileFacts.uei`, reading the client's own `Client.uei` column (`apps/api/prisma/schema.prisma:735`, `Client.uei String? @db.VarChar(12)`) — the shared P02 identity path via `award-history-identity.ts` / `client-opportunity-profile.builder.ts`. District Nexus (`generate-grant-opportunity-candidates.ts`) never touches `Client.uei` at all; it pulls UEI-shaped strings out of `clientIntelMapping` rows (`source = 'assistance_recipient'`, field `externalId`), validates with its own local `isUeiShaped()` regex, then joins `federal_assistance_award.recipient_uei` with a name-match fallback. **Not a duplicate-write conflict** — separate tables, separate flags (`district_nexus_v2` vs `funding_opportunities`). It is an accuracy inconsistency: the two features can legitimately show different scores for the same (client, grant) pair. |

### 2.6 Tango agency-forecast capability (newly audited — see §4)

| # | Item | Status | Evidence / what remains |
|---|---|---|---|
| T1 | Forecast sync has never run | **NOT-STARTED** | `infra/cdk/lib/ingestion-schedule.ts` ships `SyncTangoForecasts` with `enabled: false` ("this job populates the table, it surfaces nothing"). `aws events list-rules` on `capiro-dev`/`us-east-1` shows **zero** forecast rules — no drift, it simply doesn't exist. Live DB: `tango_procurement_forecast` = **0 rows**; `tango_sync_checkpoint` for forecast = **0 rows** (no checkpoint = never even attempted). `completion-matrix.md` records a real P24 dev-time proof run that committed 10 rows with `errored: 0` — the script works; that data is gone and it has never been scheduled since. |
| T2 | Flag `funding_opportunities_forecasts` is ON for 7 tenants with no data behind it | **NOT-STARTED — needs a Neo decision** | Verified directly against `intel_feature_flag` (note: a naive read comes back empty and looks like "flag off" — RLS must be bypassed correctly inside one transaction). `enabled=true` for **capiro-internal** (since 2026-08-07) and **six real client tenants** — c2-strategies, dualsight, maven, prospering-solutions, revere, victory-six-advisors (since 2026-08-24). The Triage Inbox forecast filter is guaranteed empty for all seven. |
| T3 | No forecast producer was ever built | **NOT-STARTED** | `client_funding_opportunity` WHERE `source='agency_forecast'` = **0 rows**. Decision-log D-47/D-79 cite forecast as the *precedent* DIBBS/SBIR followed for the producer-only pattern — but forecast itself never got even the producer half those two later received. The live-scoring detail route (`GET /opportunities/forecasts/:id`) and the market-wide Federal Spending / District Nexus "Forecasts" tabs are genuinely wired and have nothing to read. |
| T4 | Forecast scoring logic correctness | **DONE-VERIFIED (by execution)** | 79 existing tests plus 7 new ad hoc tests run against a worktree confirmed byte-identical to `origin/main` HEAD. The historical bug was real and is fixed: the pre-fix duplicate normalizer provably never matched `'DEFENSE HEALTH AGENCY (DHA)'` to `'Defense Health Agency'` (punctuation-collapse-then-strip-parenthetical ordering). Commit `d78df4f9e` (2026-08-14) deleted the duplicate, imported canonical `normAgency`, added a `DOD→'department of defense'` entry. Both cases now resolve end-to-end through the real pipeline, including a bare-`'DOD'` forecast reaching `shape_now`/`high`. All 1,536 input combinations swept: `machineRecommendation` never leaks `'pursue'`. The G1 floor-function bug class **cannot occur here** — `forecast-relevance.ts` has no numeric score or floor at all, it is a purely categorical rule table. **Honest caveat: none of this has ever run against a real forecast record, because none exist.** |
| T5 | Forecast→solicitation lifecycle governance | **NOT-STARTED** | `linkedOpportunity` is hardcoded `null` by design, deferred to "P27." The crosswalk table exists as schema only — `git grep` finds zero application code anywhere reading or writing it. The one enabled, live lifecycle job (`process-funding-opportunity-lifecycle.ts`) has zero mentions of "forecast." |

### 2.7 Program closeout items

| # | Item | Status | Evidence / what remains |
|---|---|---|---|
| C1 | Apply `independent-review/completion-matrix-updates.md` to the real `completion-matrix.md` | **NOT-STARTED** | The updates file states plainly it is a proposal ("Nothing in the real `completion-matrix.md` was modified"), pinned to `d800dcfde5`. `git diff d800dcfde5 origin/main -- docs/plans/funding-opportunities-makegov-v1/completion-matrix.md` → **empty**; same for `decision-log.md` → **empty**. Last commit to either file on `origin/main` is `aebec3b32` (2026-08-13, D-79). The real matrix still reads `*pending*` / `*self-verified only*` everywhere the proposal wanted them replaced. |
| C2 | Record the outstanding decisions in `decision-log.md` | **NOT-STARTED** | Last entry is **D-79 · 2026-08-13**. No D-80 or later exists. Grepping the real log for `master-flag`, `design-partner`, `permanently`, `entity_exclusion`, `budget_vendor_flow`, `procurement_protest` → zero relevant hits. All three previously-identified decisions ((a) no DIBBS flag / master-flag-only gating as a deliberate recorded exception, (b) design-partner acceptance deferred not resolved, (c) P44/P45 code-complete but permanently data-blocked) are unrecorded. This round adds two more (see §3, step 8). |
| C3 | P49 canary (human browser walk) | **BLOCKED — on Neo personally, plus a live MakeGov key and flag enablement** | Real `completion-matrix.md` P49 row still reads `**merged; canary run still blocked**`. P51 (GA) is blocked behind P49. |
| C4 | The four known P49 runbook defects | **NOT-STARTED** | `docs/runbooks/funding-opportunities-makegov-canary.md` has **exactly one commit in its entire history** (`4f8017091`, 2026-08-08) — never touched since. All four verified still present today: (i) `funding_opportunities_tango_shadow` gates nothing — the migration's own comment (`20260821010000_tango_source_substrate/migration.sql`) says it "is not read by anything this migration touches, and stays off"; repo-wide grep finds only that comment and the runbook reference. (ii) `--client=<id>` scoping is fictional — `sync-tango-entities.ts`'s `parseArgs` recognizes only `--limit` and `--commit`; the script header says it runs "For every client with a UEI — across ALL tenants"; an unrecognized `--client=<id>` is silently ignored, so runbook steps 5/6 hit every tenant. (iii) the §16 quiet-pass tripwire is unchanged inert text. (iv) the §14 exit-3 claim ("Exit 3 means the tier refuses webhook writes") still describes a *read*-tier probe result as answering the *write*-tier question §4 poses. `band-a-p49-canary.md`'s `FAIL` verdict remains fully live. |
| C5 | Formal independent review of the 9 uncovered phases (P05, P20, P21, P31, P37, P38, P39, P44, P45) | **NOT-STARTED** | `git log origin/main -- docs/plans/funding-opportunities-makegov-v1/` → last commit is still `aebec3b32` (2026-08-13). **Zero commits to this directory on `origin/main` since then**, across 295 commits of main. P38 and P44/P45 have only the informal, uncommitted chat-style check documented in `HANDOFF-2026-08-19-closeout.md` §2 — which that document itself flags as not meeting the `phase-2-independent-live-validation.md` verdict convention. P05, P20, P21, P31, P37, P39 have had no review of any kind, formal or informal, recorded anywhere. |

---

## 3. Prioritized, dependency-ordered remediation plan

Ordering rationale: (a) production is live and serving real clients, so anything that changes or
corrupts what a real client sees ranks above anything internal; (b) the SAM.gov key outage is the
single largest real-world impact but is blocked on a human outside this system, so it goes first as
an *escalation*, not as work; (c) structural failure modes that have already recurred five times
rank above one-off correctness fixes because they will silently undo the fixes; (d) documentation
closeout is cheap and safe and is what actually unblocks GA, so it should run in parallel rather
than last.

```
STEP 1  SAM.gov key escalation ────────────── BLOCKED on human; escalate NOW, in parallel with all below
STEP 2  G1 + G2 grant-matching fixes ──────── NEEDS NEO GO-AHEAD; ship together as one PR
STEP 3  ECR pruning root-cause hardening ──── safe; protects steps 2/5 and everything already fixed today
STEP 4  migrate:95 ───────────────────────── NEEDS NEO GO-AHEAD (cross-team blast radius)
STEP 5  P08 idempotency (F5) ──────────────── safe; migration + code must ship together
STEP 6  Forecast decision ─────────────────── NEEDS NEO DECISION (turn flags off, or build the producer)
STEP 7  P46 live proof (F2) ───────────────── BLOCKED on a real Tango signing secret
STEP 8  Docs closeout: C1 + C2 ────────────── safe, cheap, independent — start immediately
STEP 9  C4 runbook defects (+ real --client scoping) ── safe; BLOCKS step 10
STEP 10 P49 canary (C3) ───────────────────── Neo only; depends on step 9
STEP 11 C5 formal reviews of 9 phases ─────── independent, ongoing
STEP 12 D1 District Nexus UEI divergence ──── document only, no code
STEP 13 U4 CDK drift check ────────────────── do before ANY cdk deploy of ingestion-schedule
```

Steps 1, 3, 8, 9, 11, 12 can all proceed immediately and in parallel. Steps 2, 4, 6 are gated on Neo.
Steps 5 and 7 are gated only on sequencing/secrets, not on a decision.

---

### STEP 1 — Escalate the SAM.gov API key (U3) — **highest real-world impact, human-only**

**Why first:** every client's core contract-opportunity data has been frozen at 2026-07-29 for 36
days. This is not a Funding Opportunities-rail issue; it affects the original, already-GA'd SAM.gov
rail that every client uses.

**What is already true:** U2 is fixed — the jobs now *run* and log the real error instead of silently
failing to start. Nothing further can be done from AWS.

**Steps:**
1. Identify who owns the SAM.gov portal account for Capiro. Generate a new API key from
   `sam.gov` → Account Details → API Key. **This is a credential-issuing action outside AWS; it must
   be performed by the account owner, not by an agent.**
2. Update Secrets Manager secret `capiro/dev/sam-gov-api-key` with the new value.
3. Prove it with a real run, not a redeploy:
   ```bash
   export AWS_PROFILE=capiro-dev MSYS_NO_PATHCONV=1
   NETCFG='awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}'
   aws ecs run-task --region us-east-1 --cluster capiro-dev \
     --task-definition capiro-dev-api-sync-jobs:21 --launch-type FARGATE \
     --overrides '{"containerOverrides":[{"name":"api-sync-jobs","command":["sync-sam-opportunities","--commit"]}]}' \
     --network-configuration "$NETCFG" --started-by "sam-key-rotation-proof"
   ```
4. **What proves it worked:** the `/capiro/dev/api` log stream (prefix `sync-jobs`) shows a non-zero
   `rows_inserted`, not a 401. Then confirm the live `os.capiro.ai` banner advances past "current to
   Jul 29." Do **not** accept "the task exited 0" as proof — per I4, a no-op exits 0 too.
5. Set a rotation reminder. The secret's `LastChangedDate` was 2026-04-29 and SAM.gov invalidated it
   silently at ~90 days; assume that cadence recurs.

---

### STEP 2 — Fix the two grant-matching defects (G1 + G2) — **NEEDS NEO'S EXPLICIT GO-AHEAD**

**Why this needs a human decision, stated plainly:** these two changes alter what recommendations
real clients see in the Triage Inbox, in *both* directions. G1's fix will cause a large increase in
generated candidates (the current live number is 4 out of 164,428 evaluated pairs). G2's fix will
cause some existing high-confidence matches to correctly lose their strong signal and drop below the
floor — that is a feature going *quieter*, which reads as a regression without this context. Neo has
been informed and asked to confirm before this proceeds. **Do not ship either half on your own
judgment.**

**Ship both together in one PR.** They touch the same scoring path and the same clients; splitting
them means shipping one direction of change without its counterweight.

#### G1 — route the producer through the shared floor

Two edits, and it is proven that **neither alone suffices**:

1. `apps/api/scripts/generate-funding-grant-candidates.ts`, **lines 295-298** — delete the inlined
   floor and import the shared one:
   ```ts
   // BEFORE (drops the grant-specific third arm entirely):
   const meetsSuggestionFloor =
     scored.matchedSignals.some((signal) => signal.strength === 'strong') ||
     scored.matchedSignals.filter((signal) => signal.strength === 'moderate').length >= 2;

   // AFTER:
   const meetsSuggestionFloor = meetsGrantSuggestionFloor(scored.matchedSignals);
   ```
   Add `meetsGrantSuggestionFloor` to the existing import block from
   `'../src/district-nexus/grant-opportunity-relevance.js'` (lines 14-19, which already imports
   `computeEligibility`, `scoreOpportunityRelevance`, `MIN_RELEVANCE_ASSISTANCE_LISTING_FLOOR`).
   Better still, prefer `scored.meetsSuggestionFloor` — `scoreOpportunityRelevance` already returns
   it (`grant-opportunity-relevance.ts:404`), so the producer should never compute a floor at all.

2. Same file, **line 46**:
   ```ts
   // BEFORE:
   export const DEFAULT_MIN_RELEVANCE = MIN_RELEVANCE_ASSISTANCE_LISTING_FLOOR;  // ~29
   // AFTER:
   export const DEFAULT_MIN_RELEVANCE = 15;
   ```
   Copy the sibling producer's docblock rationale verbatim from
   `generate-grant-opportunity-candidates.ts:73-85` — it already explains exactly this reasoning
   ("Keeping the numeric default at the listing floor would silently drop every keyword+sector grant
   (~18) that the read path surfaces"). Remove the now-unused
   `MIN_RELEVANCE_ASSISTANCE_LISTING_FLOOR` import if nothing else in the file uses it.

**Why both:** the shared floor can return `true` for a keyword+sector match scoring ~18, but
`decideProducerAction` then rejects it against a `minRelevance` of 29. Fixing only the floor changes
nothing; fixing only the threshold lets through pairs the floor should still refuse.

**Test:** add a case to `apps/api/src/district-nexus/grant-opportunity-relevance.spec.ts` (or a new
producer-level spec) that reproduces the proven live scenario — the DOE "Grid Resilience and
Innovation Partnerships" grant against a client whose capability is "grid resilience" — and asserts
the producer's decision is `create`, not `skip_below_floor`. Pin the invariant that the producer and
`scoreOpportunityRelevance` never disagree about `meetsSuggestionFloor` for the same inputs; that is
the actual bug class, and a test on the specific grant will not catch the next instance of it.

**What proves it worked, live:** re-run `generate-funding-grant-candidates` **without** `--commit`
first, and compare `created` against today's baseline of **4 out of 164,428 pairs / 101 clients**.
A dry run that still produces ~4 means the fix did not take. Only commit after reviewing a sample of
the newly-qualifying pairs by hand.

#### G2 — stop `normalizeListing` collapsing distinct listings

`apps/api/src/district-nexus/grant-opportunity-relevance.ts`, **lines 193-197**:

```ts
// BEFORE — strips letter suffixes, so 93.00R === 93.00E === 93.00:
function normalizeListing(value: string | null | undefined): string {
  return (value ?? '').replace(/[^0-9.]/g, '');
}
```

The fix must preserve the two things the current regex correctly handles (trailing whitespace, a
`CFDA ` prefix) while keeping a trailing alpha suffix as part of the identity. Extract the listing
with an anchored pattern rather than deleting characters — match `NN.NNN` optionally followed by
letters, uppercase it, and return `''` when nothing matches, so a garbage string cannot normalize
into a spurious equality. Update the docblock: the current comment asserts "Assistance Listings are
`NN.NNN`", which is the false premise the bug rests on.

**Test:** `93.00R` must not equal `93.00E`, `93.00`, or `93.00F`; `'CFDA 93.778'`, `'93.778 '` and
`'93.778'` must still all compare equal; an empty/garbage input must return `''` and must not match
another empty input as a signal. Add a regression test asserting that a client whose
`priorAssistanceListings` contains only `93.00E` does **not** earn an `assistanceListing` strong
signal against an opportunity listing `93.00R`.

**What proves it worked, live:** `93.00R` has 75 real award rows behind it. After the fix, dry-run
the producer and confirm the count of pairs earning an `assistanceListing` signal drops, and that
the specific `93.00R`/`93.00E` cross-matches are gone.

---

### STEP 3 — Harden against ECR image pruning (I4) — safe, do immediately

**Why this ranks above the remaining correctness fixes:** it has silently undone deployed work five
times, it caused a 5-6 day total grants outage that ended only 6 hours ago, and it will silently
undo Step 2's fix the same way. Every hour spent on scoring correctness is wasted if the job that
runs it cannot pull its image.

1. **Stop referencing images by mutable tag where a digest works.** `sync-jobs:21` and `api-diag:8`
   both now pin by **digest** (`sha256:847e3d46…`), which is the correct pattern; `migrate:95` pins
   by **tag** (`45a8c6db78…`), which is what got pruned. Digest-pinning does not by itself prevent
   GC, but it removes the class of failure where a tag is reassigned underneath a task-def.
2. **Fix the actual lifecycle policy.** The current policy is `keep last 5 images, any tag` on a
   `capiro/dev/api` repo shared by many unrelated teams. Propose (do not apply unilaterally — this is
   a shared repo): a tag-prefix rule that retains any image currently referenced by an ACTIVE task
   definition, plus a far larger untagged-image count. **This is an account-wide change affecting
   other teams; treat it as needing the same go-ahead as I2.**
3. **Build the alarm the outage proved is missing.** The failure signature is
   `CannotPullContainerError` in the ECS task `stoppedReason` — it never reaches application logs and
   never increments `FailedInvocations`. Add a CloudWatch alarm on ECS task stop reasons matching
   `CannotPullContainerError` across the `capiro-dev` cluster. This is the single highest-value
   observability gap this program has found, and it is cheap.
4. **Add a liveness assertion to every ingestion job's success path.** The deeper lesson (six
   independent confirmations now) is that *absence of errors is not evidence of work*. Any job whose
   `rows_inserted`/`evaluated` is 0 for N consecutive runs should alarm, not pass quietly. Rollout
   §33 already scopes 8 required alarms, none of which exist; this is the one to build first.

**What proves it worked:** deliberately register a throwaway task-def pointing at a known-pruned tag,
`run-task` it, and confirm the alarm fires. Do not accept the alarm's existence as proof.

---

### STEP 4 — `capiro-dev-api-migrate:95` (I2) — **NEEDS NEO'S EXPLICIT GO-AHEAD**

**Why this needs a human decision, stated plainly:** **23 of 27 EventBridge rules across multiple
unrelated programs target this task-definition family.** Registering a new revision here is not a
Funding Opportunities change; it changes the code that every one of those 23 rules executes,
including migrations. A wrong image here can run the wrong schema migration against `capiro-dev`.
The discovery agent correctly left it alone for exactly this reason.

**When Neo approves, the shape of the fix (do not run this unapproved):**
1. Enumerate every rule targeting the family first — `aws events list-rules` then
   `list-targets-by-rule` for each — and write down which programs own them. You are changing all 23
   at once whether you intend to or not.
2. Confirm which commit those rules *should* be running. `45a8c6db78…` is the pruned tag; it is also
   the tip of the `C:\dev\cap-p9-disp` worktree, so it is a real commit, not a typo. Decide
   deliberately whether the correct target is that commit rebuilt, or current `origin/main`.
3. Build ARM64 — **mandatory.** A plain `docker build` on this machine produces amd64 and ECS
   refuses it. Use `buildx` with an explicit `--platform linux/arm64`.
4. Register a new revision pinned by **digest**, not tag.
5. Prove with a single `run-task` using a read-only command (`migration-status` — note the exact
   spelling, *not* `migrate-status`) before letting any scheduled rule fire against it.

---

### STEP 5 — Ship the P08 idempotency fix (F5) — safe, no decision needed

**The work already exists** at commit `1d643036532ffe6fb769006e33538ad3aaed9693` in worktree
**`C:\c\dev\capiro-p08-fix-wt`** on branch `fix/p08-task-idempotency`. It has never been pushed. The
full plan is `independent-review/FIX-PLAN-p08-idempotency.md` (994 lines, exact code) — read it
before touching anything; the summary below is the index, not the spec.

1. **Rebase onto current `origin/main` (`28b1414bc`) and re-verify.** The branch was written against
   `3e2a691ba` (2026-08-14). The good news: `funding-opportunity-actions.service.ts` has been touched
   by exactly one commit *ever* (`0fd4e819d`, 2026-08-06), so there is no drift on the file being
   fixed — but re-confirm `prisma-exception.filter.ts` and `schema.prisma` before trusting the plan's
   claims about them.
2. **Run the pre-flight duplicate check against real `capiro-dev` data first.** The plan specifies
   this but records that it was never actually run. Use `capiro-dev-api-diag:8` (now working):
   check for existing `(tenant_id, source_type, source_id)` duplicates in `engagement_tasks` where
   both source columns are non-null. Today's live read says `source_type='funding_opportunity'` is at
   **0 rows**, so this should come back clean — but other `source_type` values exist and the index is
   not source-scoped.
3. **Ship the migration and the code change together.** The migration adds a partial unique index
   `engagement_tasks_tenant_source_uniq ON engagement_tasks (tenant_id, source_type, source_id) WHERE source_type IS NOT NULL AND source_id IS NOT NULL`,
   guarded by a `RAISE EXCEPTION` pre-flight (precedent: `20260728230000_add_tenant_scoped_pe_watch_key`).
   The code change wraps `act()`'s transaction in a `try`/`catch` that, on Prisma `P2002`, re-reads
   the winning row and returns it with `reused: true`. **Shipping the migration alone converts
   "silently creates a duplicate" into "the race loser gets an unhandled 500"** — confirmed, because
   `PrismaClientExceptionFilter` does not special-case `P2002`.
4. **Test with real concurrency, not mocks.** The existing spec is 100% hand-mocked and structurally
   cannot catch this class of bug. Add
   `apps/api/scripts/test-funding-opportunity-action-concurrency.ts` (matches this repo's tsx-script
   convention), firing 8 genuinely concurrent `act()` calls against the disposable
   `pgvector/pgvector:pg16` container `funding-opportunities-ci.yml` already provisions, asserting
   exactly 1 row in both `engagement_tasks` and `client_funding_opportunity`.
5. **Known follow-ups, deliberately out of scope** (named in the full plan, do not silently fix):
   the reuse path discards the caller's fresh due-date/owner while keeping the original — the exact
   "task vs. inbox drift" this phase's acceptance criteria claim to prevent — plus a cross-intent
   race in `applyActionDecision`.

**What proves it worked:** the 8-way concurrency script passing against real Postgres. Not the unit
spec, which passed against the broken code too.

---

### STEP 6 — Decide what to do about the dark forecast capability — **NEEDS A NEO DECISION**

See §4 for the full treatment. The decision itself is binary and belongs to Neo, not to an agent:
either turn the flag off for the six client tenants who can currently see a permanently empty
filter, or fund the two pieces of work (enable the sync, build the producer) that would give it
data. Doing nothing is also a choice, but it should be a *recorded* one.

---

### STEP 7 — Prove the P46 webhook fix against a real delivery (F2)

**Blocked on:** a real Tango webhook signing secret and a real delivery. Not on code.

The fix is merged and deployed; `tango_webhook_delivery` (**singular**) has 0 rows total, so nothing
has ever exercised it. The specific property that needs proving is the one the fix introduced: a
replayed valid body under a *different* forged `x-tango-delivery-id` header must be caught as a
duplicate via `payload_sha256`, not via the header. Until a real delivery lands, this stays
DONE-UNVERIFIED — and `fo-dev-process-tango-events` is draining a queue that has never received
anything.

---

### STEP 8 — Program documentation closeout (C1 + C2) — safe, cheap, do in parallel with everything

**Do this as its own docs-only PR off current `origin/main`, not bundled with any code fix.** It is
the cheapest item on this list and it is what the GA gate actually depends on.

1. Apply `independent-review/completion-matrix-updates.md` to the real
   `docs/plans/funding-opportunities-makegov-v1/completion-matrix.md`. It is ready close to verbatim.
   Re-verify each proposed edit against today's state first — several rows the proposal marks
   `*pending*` are now genuinely DONE-VERIFIED per §2 of this document, and the proposal predates
   that.
2. Add decision-log entries starting at **D-80**. Five now, not three:
   - **D-80** — No DIBBS tenant flag: master-flag-only gating is a deliberate, recorded exception.
   - **D-81** — Design-partner acceptance explicitly *deferred*, not resolved. Do not let this read
     as closed.
   - **D-82** — P44/P45 budget/risk context: code-complete, tested, wired, and **permanently
     data-blocked** — `tango_budget_account`, `tango_budget_vendor_flow`,
     `tango_procurement_protest`, `tango_entity_exclusion` are all at 0 rows with no ingestion path
     anywhere in the codebase. Do not enable the flags; a permanently empty panel in front of an
     analyst is worse than not shipping.
   - **D-83 (new this round)** — Agency forecast: flag enabled for 7 tenants against a table that has
     never received a row; sync ships `enabled: false` by design; no producer exists. Record whichever
     way Step 6 is decided.
   - **D-84 (new this round)** — District Nexus and Funding Opportunities resolve client↔UEI identity
     by two different paths and may legitimately disagree on the same (client, grant) pair. Accepted
     as a documented divergence, not a defect (see D1 / Step 12).
3. Update the P49 row and the SAM.gov rows in the matrix to reflect §2 of this document rather than
   their 2026-08-13 text.

---

### STEP 9 — Fix the four P49 runbook defects, and implement real `--client` scoping (C4)

All four have exact before/after text already drafted in
`independent-review/FIX-PLAN-sbir-writes-and-canary-runbook.md`. This is a doc PR plus a few lines of
script code, not more research. **It blocks Step 10** — running the canary against a runbook with a
fictional scoping flag means running the canary against every tenant.

1. **§5, `funding_opportunities_tango_shadow`** — confirmed dead (2 repo-wide hits, one a migration
   comment). Remove the step; add an explicit note that this phase has no tenant-level flag, rather
   than leaving a silent gap.
2. **§5/§6, `--client=<id>`** — **implement the real scoping**, do not just fix the docs.
   `sync-tango-entities.ts`'s `parseArgs` recognizes only `--limit` and `--commit`; an unrecognized
   `--client=<id>` is silently swallowed. Sized as a few lines in each script's live-wiring function
   (not its tested pure core), using the two existing precedent scripts named in the full plan. Note
   `--limit` is still separately required after this — tenant scoping narrows what is *written*, not
   what is fetched per provider page.
3. **§16, quiet-pass tripwire** — confirmed inert (no `--commit`, missing the notice-sync
   prerequisite). Replace with rollout runbook §29, which has the correct form; §16 also invokes the
   lifecycle processor, which has a second, differently-shaped quiet-pass check at rollout §16 —
   include both.
4. **§14, exit-code claim** — confirmed backwards by reading the script: exit 3 on a dry run means
   READ APIs were denied, not WRITE. Replace with rollout §28's full 5-row exit table.

---

### STEP 10 — Run the P49 canary (C3) — Neo only

Depends on Step 9. Also needs a live MakeGov key and flag enablement. This is the one piece of
validation in this entire program that genuinely cannot be delegated to an agent. P51 (GA) is blocked
behind it.

Standing rule, unchanged: **zero ingestion runs on any day a canary session is scheduled** — same
account-wide Tango quota.

---

### STEP 11 — Formal independent review of the 9 uncovered phases (C5)

P05, P20, P21, P31, P37, P38, P39, P44, P45. None are Band-C attestation candidates — all have real
logic. Use the program's existing convention: fresh current-`main` pin, the
`phase-2-independent-live-validation.md` verdict template, and a different reviewer than implementer.

- **Band A** (one reviewer each): **P39** (research-only Tango MCP connector — a trust boundary
  between an LLM and this data, deserves the scrutiny P46 got) and **P05** (mapping governance
  hardening — admin-only approval permissions, same class as P07/P08).
- **Band B clusters**: {P20, P21} client-profile enrichment; {P37, P38} Meri tools; {P31, P44, P45}
  evidence/context composition.

P38 and P44/P45 have an informal check recorded in `HANDOFF-2026-08-19-closeout.md` §2 — **redo them
formally** so the matrix can carry a real verdict rather than a chat report. Roughly 5 reviewers, not
the original 15, proportional to 9 phases vs 43.

---

### STEP 12 — District Nexus / Funding Opportunities UEI divergence (D1) — document only

No code change recommended now. Add the D-84 entry from Step 8 and a backlog note. If and when
someone touches `generate-grant-opportunity-candidates.ts` for another reason, migrate it onto the
shared `Client.uei` / `award-history-identity.ts` path — the shared module already exists, so the
migration is mechanical. Until then this is an accuracy inconsistency across two features with
separate tables and separate flags, not data corruption.

---

### STEP 13 — Check CDK synthesis before any `cdk deploy` of the ingestion stack (U4)

`capiro-dev-sync-sam-opportunities` and `capiro-dev-sync-sam-opportunities-all-federal` are
**CDK-managed** (`infra/cdk/lib/ingestion-schedule.ts`), unlike several other `fo-dev-*` rules that
were created out of band. The targets fixed today in U2 can be silently reverted by the next `cdk
deploy` of that stack. Before any such deploy: run `cdk diff`, read what task-def revision it
synthesizes for those two job defs, and confirm it is not a stale one. Note also the existing
source/live drift — CDK marks `SyncSamOpportunitiesAllFederal` `enabled: false` while the live rule
is `ENABLED`; a deploy will turn it off. **Reminder: `cdk diff` compares against the last
CloudFormation state, not against live** — a rule changed out of band by `put-targets` will not show
in the diff at all.

---

## 4. The Tango agency-forecast capability — dedicated treatment

This was rigorously audited for the first time this round. It had never been checked at this depth,
and the result is worth stating precisely because it is unlike anything else in this program:
**everything that was built works, and none of it can do anything.**

### 4.1 Is it usable today? No.

The capability is **configured ON but functionally 100% dark**. The flag is genuinely enabled, the
UI is genuinely wired, the scoring logic is provably correct — and there has never been a single row
of forecast data in this environment.

- **Flag state (verified directly against `intel_feature_flag`):** `funding_opportunities_forecasts`
  is `enabled=true` for **capiro-internal** (since 2026-08-07) and **six real client tenants** —
  c2-strategies, dualsight, maven, prospering-solutions, revere, victory-six-advisors (since
  2026-08-24). **Verification gotcha worth recording:** a naive read of this table comes back empty
  and looks exactly like "the flag is off." RLS must be bypassed correctly inside a single
  transaction to see the real rows. Anyone re-checking this and concluding "flag is off" has
  probably hit that trap.
- **Data state:** `tango_procurement_forecast` = **0 rows**. `tango_sync_checkpoint` for forecast =
  **0 rows** — no checkpoint at all, meaning the sync has never even been *attempted*, let alone
  failed. `client_funding_opportunity` WHERE `source='agency_forecast'` = **0 rows**.
- **Net effect on real users:** seven tenants see a "Forecasts" filter in the Triage Inbox that is
  guaranteed empty, and two market-wide surfaces (Federal Spending, District Nexus "Forecasts" tabs)
  that are correctly wired to a table with nothing in it.

### 4.2 What is broken, exactly

Three distinct gaps, none of which is a bug in the sense of "wrong code":

1. **The sync has never run — by design, and there is no drift.**
   `infra/cdk/lib/ingestion-schedule.ts` ships `SyncTangoForecasts` with `enabled: false` and the
   comment "this job populates the table, it surfaces nothing." Live AWS confirms the source is
   honest: `aws events list-rules` on `capiro-dev`/`us-east-1` returns **zero** forecast rules — only
   `fo-dev-sync-tango-dibbs` and `fo-dev-sync-tango-sbir` exist and are ENABLED. `completion-matrix.md`
   records a real P24 dev-time proof run that committed 10 rows with `errored: 0`, so the script
   itself demonstrably works; that data is gone and it has never been scheduled since.
2. **No producer was ever built.** This is the substantive gap. Decision-log **D-47** (2026-08-07)
   and **D-79** (2026-08-13) cite forecast as the architectural *precedent* that DIBBS and SBIR
   followed for the producer-only pattern — but forecast itself never received even the producer half
   that those two later got. There is no `generate-forecast-opportunity-candidates` equivalent. The
   Triage Inbox filter therefore cannot populate even if the sync ran tomorrow.
3. **Lifecycle governance (forecast→solicitation) is not implemented.** `linkedOpportunity` is
   hardcoded `null` by design, deferred to "P27." The crosswalk table exists as schema only —
   `git grep` finds zero application code anywhere reading or writing it. The one enabled, live
   lifecycle job (`process-funding-opportunity-lifecycle.ts`) contains zero mentions of "forecast."

### 4.3 What is NOT broken — proven by execution, not by reading

This matters because it changes the cost of the decision below: the expensive part is already done
and correct.

- The 79 existing tests plus 7 new ad hoc tests were run against a worktree confirmed byte-identical
  to `origin/main` HEAD.
- The historical normalization bug was **real** and is **fixed**: the pre-fix duplicate normalizer
  provably never matched `'DEFENSE HEALTH AGENCY (DHA)'` against `'Defense Health Agency'`
  (punctuation-collapse-then-strip-parenthetical ordering). Commit `d78df4f9e` (2026-08-14) deleted
  the duplicate, imported the canonical `normAgency`, and added a `DOD→'department of defense'`
  entry. Both cases now resolve correctly end-to-end through the real pipeline, including a realistic
  bare-`'DOD'` forecast reaching `shape_now`/`high`.
- All **1,536** input combinations were swept: `machineRecommendation` never leaks `'pursue'`.
- **The G1 floor-function bug class cannot occur here.** `forecast-relevance.ts` has no numeric score
  and no floor at all — it is a purely categorical rule table. Do not go looking for the shared-floor
  bug on this rail.
- **Honest caveat, stated because this program's convention demands it:** none of the above has ever
  run against a real forecast record, because none exist. This is verified-correct logic, not
  verified-correct behavior.

### 4.4 Exact fix steps, if Neo chooses to light it up

**Option A — turn the flag off (cheapest, honest, reversible).**
Disable `funding_opportunities_forecasts` for the six client tenants (leave capiro-internal on for
development). Record as D-83. Rationale, matching the D-82/P44/P45 precedent already established by
this program: a permanently empty panel in front of an analyst is worse than not shipping. **This is
the recommended default if the producer work is not being funded now.**

**Option B — give it data.** Two pieces of work, in order:
1. **Enable the sync.** Flip `SyncTangoForecasts` to `enabled: true` in
   `infra/cdk/lib/ingestion-schedule.ts` — but do **not** reach for `cdk deploy` (see §5). Follow this
   program's established per-rule enablement procedure instead: build the CloudWatch alarm this job
   needs first, run the job manually twice via `run-task` with `--commit` on two different days,
   record the disable command, then enable. Prove with a real row count on
   `tango_procurement_forecast` — the P24 proof run's 10 committed rows is the known-good shape.
2. **Build the producer.** Model it on `generate-funding-grant-candidates.ts` / the DIBBS and SBIR
   producers — same `readClientProfileFactsMany` → `ClientProfileFacts.uei` identity path (per D1,
   this is the shared, correct one), same `decideProducerAction` gate, same dual-write identity
   columns via `sourceRecordIdentityColumns`. Because `forecast-relevance.ts` is categorical rather
   than numeric, the producer must gate on the rule table's own verdict, **not** on a `minRelevance`
   number — do not copy G1's mistake of re-deriving a threshold in the producer.
3. **Then, and only then,** consider P27 lifecycle crosswalk work. It is meaningless with 0 forecast
   rows.

**What proves either option worked:** Option A — sign in to `os.capiro.ai` as one of the six affected
tenants and confirm the Forecasts filter is gone, not empty. Option B — a non-zero row count in
`tango_procurement_forecast` *and* a non-zero count in `client_funding_opportunity` WHERE
`source='agency_forecast'`, *and* a real forecast record visible in the Triage Inbox. Per I4, do not
accept an exit-0 sync run as proof of either.

---

## 5. What NOT to do without explicit confirmation first

These are standing cautions. The first three are carried forward from this program's history and have
each already caused a real incident or near-miss; the rest are new this round.

**Carried forward:**

1. **Never run `cdk deploy Capiro-dev-Compute`.** Confirmed to have caused a real production
   incident on 2026-07-25. Still true. This is never revisited without a much bigger, separate
   conversation — not as a step inside any Funding Opportunities task.
2. **Never casually register a new `capiro-dev-api-migrate` revision.** 23 of 27 EventBridge rules
   across multiple unrelated programs target that family. It is broken right now (I2) and it was
   deliberately left broken rather than fixed opportunistically. See Step 4 for the approved shape,
   and get Neo's go-ahead first.
3. **Never treat silence as safety.** This program's single most-repeated finding — now confirmed
   independently **six** times, most recently by a 5-6 day grants outage during which CloudWatch
   showed `Invocations=1/day, FailedInvocations=0` — is that **a no-op run reads identical to a
   healthy one**. Verify with real row counts and real log content, never with the absence of errors
   or an exit code of 0.
4. **Zero ingestion runs on any day a P49 canary session is scheduled** — the account-wide Tango
   quota is shared.
5. **Do not enable any further flags** (`funding_opportunities_tango_shadow`, P44 budget context,
   P45 risk context) — the first gates nothing at all, and the latter two sit in front of
   permanently empty tables with no ingestion path anywhere in the codebase.

**New this round:**

6. **Do not ship the G1/G2 grant-matching fixes without Neo's explicit go-ahead.** They change what
   recommendations real clients see, in both directions simultaneously — G1's fix makes the system
   much louder, G2's makes some existing confident matches correctly disappear. Neo has been informed
   and asked to confirm. Shipping half of G1 (either the floor or the threshold, not both) is worse
   than shipping neither: it is proven that neither edit alone changes the outcome.
7. **Do not run `cdk deploy` on the ingestion-schedule stack without checking synthesis first.** The
   two SAM.gov rule targets fixed today are CDK-managed and will be silently reverted. And remember
   `cdk diff` compares against the last CloudFormation state, **not** against live — an out-of-band
   `put-targets` change will not appear in the diff at all.
8. **Do not change the shared `capiro/dev/api` ECR lifecycle policy unilaterally.** Many unrelated
   teams share that repository; a retention change affects all of them. Propose, get agreement, then
   apply.
9. **Do not enable the forecast sync by flipping the CDK flag and deploying.** Use the per-rule
   `run-task`-first enablement procedure (Step 6 / §4.4 Option B), same as every other rule in this
   program.
10. **Do not ship the P08 migration without the code change.** Confirmed: `P2002` is unmapped in
    `prisma-exception.filter.ts`, so the migration alone converts a silent duplicate into an
    unhandled 500 for the loser of the race.
11. **Do not trust `ls C:\dev\capiro-p08-fix-wt`** — the P08 worktree is at **`C:\c\dev\capiro-p08-fix-wt`**
    (git renders it as `C:/c/dev/...`). A check against the wrong path reports MISSING and will lead
    you to conclude the work was lost. It was not.
12. **Do not build container images with a plain `docker build` on this machine.** It produces amd64
    and ECS refuses it. **ARM64 buildx is mandatory** for every image in this account.
13. **Do not query `tango_webhook_deliveries`.** The Prisma model maps to **`tango_webhook_delivery`**
    (singular). Querying the plural name errors or returns nothing and reads as "no data," which is
    coincidentally also the true answer right now — a genuinely misleading combination.
14. **Do not conclude `funding_opportunities_forecasts` is off from a naive read of
    `intel_feature_flag`.** RLS makes a straightforward read return empty. It is on, for seven
    tenants. Bypass RLS correctly inside one transaction.
15. **Do not read a missing branch tip as an unmerged fix.** `48eab5761` (DIBBS/SBIR) is not an
    ancestor of `origin/main` because it was rebased before merge; the fix shipped as `9b9ae5083`.
    Check for the merge commit, not the branch tip, before reopening anything in §2.1.
