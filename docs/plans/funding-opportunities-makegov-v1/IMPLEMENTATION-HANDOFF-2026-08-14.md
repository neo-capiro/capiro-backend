# Implementation handoff — Funding Opportunities + MakeGov/Tango remediation

**Scope of this document: every remaining workstream except UI validation.** That means: no
browser/visual QA steps, no P49 human canary walk. Everything else — code fixes, migrations,
tests (real-DB/integration, not browser), infra sequencing, and documentation — is covered here
in implementation-step detail.

**Read `HANDOFF-2026-08-13-ga-review.md` first if you haven't** — it has the full narrative of
how this program got here. This document picks up from its current state (all 6 decisions
answered, PassRole fixed, `:13` registered, 7 `fo-dev-*` EventBridge rules created disabled) and
goes deep on what's left.

**Every fix below has its own full-detail plan file** (exact line numbers, before/after code,
complete test breakdowns) in `independent-review/FIX-PLAN-*.md`. This document is the index,
priority order, and executive summary — read the individual files before actually writing code.

All five fix plans were independently re-verified against **current `origin/main`
(`3e2a691baa2a94802047ded1c3fe7a5dfd4e366c`, fetched 2026-08-14)** — zero drift from the original
review's `d800dcfde5` pin on any relevant file, confirmed via `git log` between the two SHAs.
Re-verify again before implementing if more time has passed — this repo moves fast.

---

## Priority order and dependencies

```
1. P46 webhook fix ──────────────┐
2. P08 idempotency fix           │  independent of each other,
3. DIBBS scoring fix             │  can all proceed in parallel
4. SBIR scoring fix              │
5. Meri forecast-flag bypass fix ┘

6. SBIR write-failure diagnostic (needs a manual image build+push — CI is broken)
   └─→ SBIR write-failure permanent fix (depends on 6's result)

7. Canary runbook doc fixes (independent, can happen anytime)
8. completion-matrix.md real update (independent, can happen anytime)

9. EventBridge rule enablement ← depends on 1, 3, 4, 5 being done or consciously accepted
10. Ingestion resumption ← independent, ongoing regardless of the above
11. Continue independent review into the 9 uncovered phases ← independent, ongoing
```

Nothing here blocks anything else except item 9 (enablement), which genuinely needs 1/3/4/5 done
first — enabling `fo-dev-process-tango-events` against a still-broken P46 would drain a webhook
queue that's been silently losing events, and enabling the DIBBS/SBIR candidate generators before
their scoring bugs are fixed would either flood clients with wrong recommendations (DIBBS) or
silently produce nothing forever (SBIR).

---

## 1. P46 — webhook receiver: two proven bugs, one fix

**Full plan:** `independent-review/FIX-PLAN-p46-webhooks.md`

**No migration needed.** The `tango_webhook_deliveries` table already computes and stores a
SHA-256 hash of the raw request body in a `payload_sha256` column, for an unrelated purpose. The
fix repoints identity at that same value instead of the currently-broken chain.

**Code change**, `apps/api/src/webhooks/tango-webhook.service.ts`, `readEnvelope`:
- Keep checking `body.delivery_id` / `body.deliveryId` / `body.id` first, in that order (harmless,
  forward-compatible if the provider ever adds one).
- If none present: **stop returning `missing_delivery_id` (400)**. Instead, use the existing
  `payloadDigest(rawBody)` computation (already present in this file for `payload_sha256`) as the
  delivery identity.
- Keep `x-tango-delivery-id` in the stored row for observability only — never as the uniqueness
  key. It is not covered by the HMAC (confirmed: the SDK's `signing.js` hashes raw body only), so
  it must never be trusted for dedup.

**Why this is safe**: the hash is a pure function of exactly the bytes the signature already
verified. An attacker can't produce a "different" delivery identity for a replayed valid body
without also forging a body that passes signature verification — which defeats the whole point of
replaying.

**Tests** (per the full plan, exact line numbers there): 5 existing tests change expected
behavior (a body with no id field now succeeds instead of 400ing), ~12 need mechanical fixture
updates, 1 controller test case gets deleted (it was asserting the now-wrong behavior), and 2 new
tests are needed: a real-shaped delivery with no body-level id (must succeed), and a replayed
valid body under a different forged header (must be caught as a duplicate via the hash, not the
header).

**One more file to touch**: `diag-tango-webhook-contract.ts` has one string that needs updating
for consistency (named in the full plan).

---

## 2. P08 — task-creation race condition

**Full plan:** `independent-review/FIX-PLAN-p08-idempotency.md` (994 lines, exact code)

**Migration needed**, new file
`apps/api/prisma/migrations/20261120050000_engagement_task_action_source_uniq/migration.sql`:

```sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "engagement_tasks"
    WHERE "source_type" IS NOT NULL AND "source_id" IS NOT NULL
    GROUP BY "tenant_id", "source_type", "source_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'engagement_tasks has duplicate (tenant_id, source_type, source_id) rows; resolve before this index can apply';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "engagement_tasks_tenant_source_uniq"
    ON "engagement_tasks" ("tenant_id", "source_type", "source_id")
    WHERE "source_type" IS NOT NULL AND "source_id" IS NOT NULL;
```

The pre-flight duplicate check follows an exact existing precedent in this repo
(`20260728230000_add_tenant_scoped_pe_watch_key`) — **run the same duplicate-check query against
real `capiro-dev` data before writing this migration** (exact read-only SQL is in the full plan);
this was not done during planning, only specified.

**Code change**, `FundingOpportunityActionsService.act()`
(`apps/api/src/funding-opportunities/funding-opportunity-actions.service.ts`): wrap the existing
transaction in a try/catch mirroring the EXACT shape already used correctly elsewhere in this same
file (`decide()`/`setWorkflowStatus()`/`patchWorkflow()` in `funding-opportunities.service.ts`) —
on a caught Prisma `P2002`, re-`findFirst` the winning row and return it with `reused: true`
instead of erroring. **The migration and code fix must ship together** — confirmed via
`prisma-exception.filter.ts` that `P2002` is currently unmapped and falls through to a raw 500, so
shipping the migration alone would turn "silently creates a duplicate" into "the race loser gets
an unhandled 500."

**Test**: the existing spec is 100% hand-mocked and structurally cannot catch this class of bug.
Add a new script, `apps/api/scripts/test-funding-opportunity-action-concurrency.ts` (matches this
repo's existing tsx-script convention), that fires 8 genuinely concurrent `act()` calls against the
disposable `pgvector/pgvector:pg16` container `funding-opportunities-ci.yml` already provisions,
and asserts exactly 1 row exists afterward in both `engagement_tasks` and
`client_funding_opportunity`. Wire it into CI per the full plan's exact steps.

**Confirmed safe**: RLS on `engagement_tasks` is already correct and untouched by this change;
the migration is additive/forward-only.

**Flagged, not fixed, out of scope for this pass**: the reuse path has a separate, smaller bug
(a reused task keeps its original due-date/owner while the caller's fresh values are silently
discarded — the exact "task vs. inbox drift" this phase's acceptance criteria say it prevents),
plus a related cross-intent race the investigating agent found but wasn't asked to plan. Both are
named in the full plan for a follow-up.

---

## 3. DIBBS scoring fix — and a consequence you need to know before shipping it

**Full plan:** `independent-review/FIX-PLAN-dibbs-sbir-scoring.md`

**Code change**, `apps/api/src/funding-opportunities/dibbs-relevance.ts`: remove
`priorCageAwardHistory` from `hasStrongMatch` (currently line ~276, alongside the two
part-level signals). Move it into the existing weak-evidence rule next to `capabilityTextMatch` —
it may still boost confidence to `'high'` when it corroborates a real part-level match, but it can
no longer clear the recommendation floor by itself. Fix the display/explanation text from "a prior
award **on this kind of item**" to an honest, broader claim: "this client's CAGE code has DLA
award history."

**The consequence, stated plainly so it isn't mistaken for a regression**: the two part-level
signals (exact NSN, exact part number) are hardcoded `false` everywhere in the producer today,
because no client-parts store exists. Once this fix ships, `clearsSuggestionFloor: true` becomes
**unreachable with current data** — DIBBS will correctly stop creating new suggestions and mark
any existing machine-suggested rows stale. **"GA-ready" for the DIBBS rail, with this fix in
place, means "correctly produces nothing" until a client-parts store exists — not "produces good
matches."** State this explicitly to anyone reviewing the change; a PR that makes a feature go
quiet needs that context or it reads as broken.

**Tests**: full before/after fixture breakdown in the plan; two new real-fixture-driven regression
tests (one proving the floor is now unreachable on the exact 10/10-false-positive scenario that
was measured live, one proving the weak-signal confidence boost still works correctly).

---

## 4. SBIR scoring fix — agency-name normalization, plus a bonus fix

**Full plan:** same file as #3, `FIX-PLAN-dibbs-sbir-scoring.md`

Repo-wide inventory found **three** agency-comparison utilities, not the one previously known:
- The canonical, exported `normAgency` — already correctly imported by SBIR's own producer.
- A private, buggier duplicate in `forecast-opportunity-read.service.ts` (already known from the
  independent review — its own docblock claims parity with the canonical one that it doesn't
  have, a punctuation-collapse ordering bug).
- Two wrong-shape data maps (`AGENCY_SECTOR_MAP`, `ACRONYM_EXPANSIONS`) not fit for identity
  matching — don't reach for these.

**Fix**: extend the canonical `normAgency` with a small, closed abbreviation table. Only add
`dod → department of defense` with confidence — it's proven against the real fixture data (5/5
real SBIR records use `"DOD"`). The other ~10 federal agency abbreviations SBIR might encounter
are flagged in the plan as **unverified — do not guess them in**, add them only as real data
surfaces each one. **In the same change, migrate the forecast rail onto this same canonical
function**, closing its independently-known bug for free and eliminating the third private copy.

**Confirmed additive**: every existing test on both rails uses matching full-name fixtures on both
sides of the comparison, so nothing currently green should regress. SBIR just starts correctly
matching real DoD history it currently cannot see at all.

---

## 5. Meri forecast-flag bypass — new, narrow finding from re-verifying P1-1

**No separate plan file — small enough to specify here directly.**

Context: the broader P1-1 finding ("DIBBS/SBIR/forecast served ungated by the API") is now
**closed** for the HTTP inbox route and for DIBBS/SBIR everywhere, including every Meri tool —
verified path-by-path against current `origin/main`. Given Neo's decision (master-flag-only
gating, no per-capability flags), that's the correct, working design.

But the verification pass found one real, narrower gap while checking: `MeriOpportunityToolsAdapter
.buildOpportunityActionPlan()` (`apps/api/src/funding-opportunities/meri-opportunity-tools.adapter.ts:512-533`)
never calls the `asOpportunitySource` allowlist every other tool in this file uses, and forwards
the caller-supplied `source` straight to `GovernmentLandscapeService.composeActionPlan()`
(`government-landscape.service.ts:382-460`), which explicitly permits `'agency_forecast'` in
addition to `'sam_gov'` with **no flag check anywhere inside it**. Because this adapter is called
as a plain method during a Meri conversation turn, it never passes through the NestJS HTTP guard
pipeline at all — its only gate checks `funding_opportunities_meri_v2`, never the master
`funding_opportunities` flag.

**Net effect**: any tenant with `funding_opportunities_meri_v2` on — regardless of the master flag
or the forecast flag — can have Meri call this tool with `source: 'agency_forecast'` and get back
real forecast facts and a generated pursuit action plan. DIBBS and SBIR remain fully blocked on
this same path (confirmed), so this is forecast-only.

**Fix** (pick one, both are small):
- (a) Add the same `asOpportunitySource`-style allowlist this tool is missing, restricting it to
  `sam_gov` only (drops forecast support from this one tool), or
- (b) Have the adapter's existing `gate()` function also check the master
  `funding_opportunities` flag (and/or `funding_opportunities_forecasts`) before any tool
  proceeds — matching what the HTTP guard stack already does for the equivalent route.

No existing test exercises this tool with `source: 'agency_forecast'` — this reads as an
unnoticed gap, not a deliberately accepted one. Whichever fix is chosen needs a new test proving
a tenant without the relevant flag(s) gets refused.

---

## 6. SBIR write-failure — diagnose, then fix

**Full plan:** `independent-review/FIX-PLAN-sbir-writes-and-canary-runbook.md`

**Important sequencing catch**: CI is still repo-wide broken (`startup_failure`, reconfirmed via
`gh run list`). Any diagnostic code change here needs a **manual build + push + new task-def
revision registration** before a resume run would actually exercise it — the same pattern that's
governed every deploy in this program. Do not expect adding a log line and re-running against the
current `:13` revision to show anything new; `:13`'s image predates the patch.

**Step 1 — diagnostic patch**, `sync-tango-sbir.ts` `walkEndpoint()` catch block (currently bare
`catch {}` around `upsertSolicitation`): log the Prisma error code, `meta`, and the record's own
`start_date`/`end_date` values — enough to confirm or refute the `tango_sbir_solicitation_dates_chk`
hypothesis on sight, without changing behavior otherwise (still catches, still counts as errored).

**Step 2 — build, push, register**: standard manual cycle for this repo (arm64 build, push to
`capiro/dev/api`, register a new `capiro-dev-api-sync-jobs` revision pointing at the new digest —
same procedure just used for `:13`).

**Step 3 — resume with the patched code**:
```bash
aws ecs run-task --cluster capiro-dev --task-definition capiro-dev-api-sync-jobs:<new-revision> \
  --overrides '{"containerOverrides":[{"name":"api-sync-jobs","command":["sync-tango-sbir","--endpoint=solicitation","--commit","--full"]}]}' \
  ...
```
(`--full` is required — 173 rows are already stored; a plain incremental run derives its window
from the newest stored date and would skip back over the previously-failed rows.)

**Step 4 — read the log**, confirm or refute the hypothesis.

**Step 5 — permanent fix, if confirmed**: follow the exact existing precedent already used
elsewhere in this same file/program (`reconcileQuantity` in the DIBBS mapper, `solicitationYear`
in this file) — **null the invalid field, keep the row**, and count it under a new, distinct
counter (`solicitationsWithInvertedDates`) that never merges into the generic `errored` count.
Dropping the whole record isn't this program's convention when only one field is bad.

**Step 6**: remove the temporary diagnostic logging, or convert it to a permanent low-noise
structured log line if that reads as more useful long-term.

---

## 7. Canary runbook — four documentation fixes

**Full plan:** same file as #6. All four have exact before/after text drafted — this is a
straightforward doc PR, not more research.

1. **§5, `funding_opportunities_tango_shadow`**: confirmed dead code (2 hits repo-wide, one a
   migration comment). Remove the step; add an explicit note that this phase has no tenant-level
   flag, rather than leaving a silent gap.
2. **§5/§6, `--client=<id>`**: confirmed silently dropped by both scripts, both genuinely
   all-tenant. **Recommended: implement real scoping**, not just fix the docs — sized as a few
   lines in each script's live-wiring function (not its tested pure core), using two existing
   precedent scripts as templates (named in the full plan). Note `--limit` is still separately
   needed even after this fix, since tenant scoping narrows what's *written*, not what's fetched
   from the provider per page.
3. **§16, quiet-pass tripwire**: confirmed inert (no `--commit`, missing the notice-sync
   prerequisite). Replace with rollout runbook's own §29, which already has the correct form.
   Flagged addition: §16 also invokes the lifecycle processor, which has a second,
   differently-shaped quiet-pass check at rollout §16 that §29 alone doesn't cover — include both.
4. **§14, exit-code claim**: confirmed backwards by reading the actual script — exit 3 on a dry
   run means READ APIs were denied, not WRITE. Replace with rollout §28's full 5-row exit table.

---

## 8. Apply the `completion-matrix.md` update for real

1. `independent-review/completion-matrix-updates.md` is ready to apply close to verbatim.
2. Add the two 2026-08-14 decisions, which aren't in that file yet: "no DIBBS flag — master-flag-only
   gating is a deliberate, recorded exception" and "design-partner acceptance explicitly
   deferred, not resolved" (do not let this read as closed). Ideally also a real decision-log
   entry (next available D-number).
3. Do this as its own docs-only PR, off current `origin/main`, not bundled with any code fix above
   — keeps it mergeable fast and independently of the rest.

---

## 9. EventBridge rule enablement (once §1, §3, §4, §5 are done or consciously accepted)

Per-rule, repeat individually — never batch:
1. `aws events describe-rule --name <rule>` — confirm still `DISABLED`, target still the current
   `capiro-dev-api-sync-jobs` revision (re-check it hasn't moved again).
2. Build the CloudWatch alarm(s) this specific job needs before enabling it (rollout §33 — none of
   the 8 required alarms exist yet; this is its own unscoped design pass, not detailed further
   here).
3. Run the job manually twice via `run-task` with `--commit`, on two different days, per rollout
   §32 — not enabled yet, just proving it.
4. Record this rule's disable command before flipping it on.
5. `aws events enable-rule --name <rule>`.
6. Watch the next scheduled fire in `/capiro/dev/api` (stream prefix `sync-jobs`).
7. Confirm row counts changed **only** for the dataset this job owns.

**Recommended order**, given dependencies: raw ingestion first
(`fo-dev-sync-tango-dibbs`, `fo-dev-sync-tango-sbir`) → candidate generators next, now that
scoring is fixed (`fo-dev-generate-dibbs-opportunity-candidates`,
`fo-dev-generate-sbir-opportunity-candidates` — watch DIBBS specifically produce **nothing**,
correctly, per §3 above) → `fo-dev-process-tango-events` **last**, only once §1 (P46) is fixed and
live-tested → the two `-full` reconcile rules last of all.

---

## 10. Ingestion resumption

Same probe-first, small-endpoints-first procedure already documented in
`HANDOFF-2026-08-11-dibbs-sbir-ingestion-resume.md`, updated for the current task-def revision
(that doc still says `:11`; live is now `:13` — update the doc or at minimum flag it every time
it's referenced).

```bash
export AWS_PROFILE=capiro-dev MSYS_NO_PATHCONV=1
NETCFG='awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}'
aws ecs run-task --region us-east-1 --cluster capiro-dev --task-definition capiro-dev-api-sync-jobs:13 --launch-type FARGATE \
  --overrides '{"containerOverrides":[{"name":"api-sync-jobs","command":["sync-tango-dibbs","--endpoint=rfq","--limit=1"]}]}' \
  --network-configuration "$NETCFG" --started-by "resume-probe"
```

Read the `TANGO_DIBBS_SYNC_DONE` log line for `rateLimited` before doing anything bigger. Firm
rule, unchanged: **zero ingestion runs on any day a canary session is scheduled** — same
account-wide Tango quota.

**Priority target given Neo's GA bar** ("prove correctness for ≥1 client"): **DIBBS Award**
(currently 0%) is the highest-value target — it's the only thing that can produce a real DIBBS
match once §3's fix is live. RFQ progress alone doesn't unblock a real end-to-end proof, since the
floor now requires actual award history.

---

## 11. Continuing independent review into the 9 uncovered phases

P05, P20, P21, P31, P37, P38, P39, P44, P45 — none look like Band-C attestation candidates on
inspection (all have real logic: governance/permissions, enrichment workflows, Meri-facing tool
surfaces, a trust-boundary-adjacent MCP connector). Suggested banding for a smaller follow-up wave
(same convention: fresh current-`main` pin, `phase-2-independent-live-validation.md` template,
different reviewer than implementer):

- **Band A** (one reviewer each): **P39** (research-only Tango MCP connector — a trust boundary
  between an LLM and this data, deserves the same scrutiny P46 got), **P05** (mapping governance
  hardening — admin-only approval permissions, same class of scrutiny P07/P08 got).
- **Band B clusters**: {P20, P21} client-profile-enrichment; {P37, P38} Meri-tools; {P31, P44,
  P45} evidence/context-composition (all three are "assemble a context packet from existing data"
  shaped).

Roughly 5 reviewers instead of the original 15, proportional to 9 phases vs. 43.

---

## What's still not in this document

- The P49 human canary browser walk, and anything downstream of it — excluded per scope.
- Actually running any of the fixes above — everything here is a plan, not applied code.
- The remaining ~104 P1–P4 findings from `MASTER-FINDINGS-QUEUE.md` not called out individually —
  the ones above were the highest-value/most-proven; the rest are mostly narrower documentation
  or cosmetic-with-consequence items, full list with file:line in that document.
