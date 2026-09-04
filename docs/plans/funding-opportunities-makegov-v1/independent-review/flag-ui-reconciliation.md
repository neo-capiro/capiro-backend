# Flag/UI reconciliation — the 5-rail source dropdown vs. "dark by default"

**Scope:** independent code review, read-only. All citations are against commit
`d800dcfde51f6cf21a4b54b511006b9001fd6d2b` (`feat(x-feed): configurable X Intelligence dashboard feed (#948)`,
2026-08-13). No AWS calls, no DB reads, no mutations were made. Where a claim needs runtime state
(a flag row, a deployed bundle SHA) that is called out explicitly as unverified.

**The reported contradiction:** a live check of `os.capiro.ai` → Funding Opportunities → Triage Inbox,
logged in as an internal user, showed the source-filter dropdown listing all 5 rails (Grants.gov,
SAM.gov, DLA bid board, Agency forecast, SBIR/STTR), while decision-log D-79 states that
`funding_opportunities_sbir` is web-only with no API-side guard and has never been enabled for any
tenant, and the plan's invariant is "every tenant-visible capability is separately flag-gated and
dark by default."

---

## Verdict, up front

The observation and the invariant are **both** partly right, and the framing in the brief points at
the wrong artifact.

1. **The dropdown is NOT the bug.** It is correctly and strictly flag-gated for the two flagged
   rails. There is no code path at this commit by which "Agency forecast" and "SBIR/STTR" render as
   options with their flags off. The dropdown is, in effect, a faithful *readout* of the flag map —
   so seeing all 5 rails is **evidence that both flags are ON for the tenant that was viewed**, not
   evidence of an ungated UI.

2. **There IS a genuine gap, and it is one layer down.** Rail gating on the *data path* is
   **presentation-layer only**. The inbox API returns forecast, DIBBS and SBIR rows to any tenant
   that passes the two inbox flags; the browser is the only thing that withholds them. And DIBBS has
   **no flag at all, at any layer, anywhere in the repo** — its darkness today rests purely on there
   being no data, which is an accident of the blocked ingestion, not a gate.

So: **(a) a genuine gap**, but not the gap the dropdown suggested. Detail below.

---

## 1. The dropdown: correctly gated (not a bug)

There is exactly **one** Triage Inbox source dropdown in the web app. A repo-wide search for the
`'All sources'` option label returns three files, only one of which is this surface
(`TrackerFeedPanel.tsx` and vNext `legiwatch/feed/FeedTab.tsx` are unrelated surfaces):

- `C:\dev\capiro-fo-ga-review-wt\apps\web\src\pages\intelligence\opportunities\FundingOpportunityInbox.tsx`

The option list is built in two pieces:

- **`BASE_SOURCE_OPTIONS`** — `FundingOpportunityInbox.tsx:72-77`. Four entries, unconditional:
  All sources, Grants.gov, SAM.gov, DLA bid board (`DIBBS_SOURCE`).
- **`sourceOptions(forecastsEnabled, sbirEnabled)`** — `FundingOpportunityInbox.tsx:87-96`. Appends
  the agency-forecast option **only if** `forecastsEnabled`, and the SBIR/STTR option **only if**
  `sbirEnabled`.

The render site consumes exactly that function — `FundingOpportunityInbox.tsx:305-311`, with
`options={sourceOptions(forecastsEnabled, sbirEnabled)}` at `:309`. There is no second array, no
`INBOX_SOURCES.map(...)`, and no fallback branch. The two booleans come from
`FundingOpportunityInbox.tsx:157-161`:

```
const forecasts = useIntelFeature(FUNDING_OPPORTUNITIES_FORECASTS_FEATURE);
const forecastsEnabled = forecasts.ready && forecasts.enabled;
const sbir = useIntelFeature(FUNDING_OPPORTUNITIES_SBIR_FEATURE);
const sbirEnabled = sbir.ready && sbir.enabled;
```

Deep links are gated on the same booleans (`:99` `UNFLAGGED_SOURCES` = grants/sam/dibbs only;
`:170-180` builds `readEnum`'s accepted set by appending the flagged rails conditionally), so a stale
`?source=sbir_sttr` degrades to "all sources" rather than to an empty view. Pinned by test at
`FundingOpportunityInbox.test.tsx:1145-1152`.

### Why the flags cannot be silently true

Three independent fail-closed layers, all verified:

- **Web hook fails closed.** `apps/web/src/lib/intel-feature-flags.ts:30-41` — the `/intel-api/feature-flags`
  query has `retry: false` and a `catch { return {}; }` at `:37`. `useIntelFeature` at `:55-57`
  returns `Boolean(data?.[feature])`, so an unreachable or erroring endpoint yields `false` for every
  flag.
- **intel-api's map does NOT carry the internal-tenant short-circuit.** This is the subtle one, and
  it cuts *against* the "it's just internal-tenant bypass" theory.
  `apps/intel-api/src/feature-flags/feature-flag.service.ts:46-47` — `isEnabled()` returns `true` for
  *every* flag when `tenantId === CAPIRO_INTERNAL_TENANT_ID`. But `enabledFor()` at `:57-71` — which
  is what powers the web's `/feature-flags` map — returns only genuinely enabled DB rows, plus
  exactly three hardcoded extras for the internal tenant: `hearing_watch` (`:64`), `bill_360` (`:68`),
  `defense_funding_intel` (`:69`). `funding_opportunities_forecasts` and `funding_opportunities_sbir`
  are **not** in that list. The internal-tenant fallback therefore cannot light up either option.
- **Same table, both readers.** intel-api's `featureFlag` model and apps/api's raw
  `SELECT ... FROM intel_feature_flag` (`funding-opportunities-flag.guard.ts:139-148`) read the same
  rows, so the web map and the API guards cannot disagree about what is enabled.

### Why a stale deployed bundle does not explain it either

A bundle older than this commit can only show **fewer** rails, never more. `git log` on the component
shows the last commit to touch it is `4a1a0331c` (*P43 part 3 — the SBIR/STTR rail, end to end*),
which is the commit that *introduced* the SBIR option — already conditional, in the same
`sourceOptions` shape seen today. Preceding commits (`c93fe2195` P41p3, `adc8d57bc` P26, `cf6a47d67`
P12, `24de45eb9` P11) have no SBIR option at all. There is no later "fix" that made an unconditional
list conditional. So any bundle that can render an "SBIR/STTR" option is at-or-after `4a1a0331c`,
and every such bundle gates it on the flag.

The observed labels corroborate that this is the real component and not the retired mockup: the
strings match `INBOX_SOURCE_SHORT_LABELS` byte-for-byte
(`funding-opportunities-api.ts:1721-1727` — `'Agency forecast'`, `'DLA bid board'`, `'SBIR/STTR'`)
and `SOURCE_LABELS` (`:1668-1671` — `'Grants.gov'`, `'SAM.gov'`). The deleted
`FundingOpportunitiesV2Page` that D-79 removed was hardcoded to three rails
(sam/grants/agency_forecast) and could never have shown DIBBS or SBIR; the
`apps/web/src/pages/intelligence/opportunities/v2/` directory is confirmed absent at this commit.

**Therefore:** the live 5-rail dropdown implies `funding_opportunities_forecasts` **and**
`funding_opportunities_sbir` both have enabled `intel_feature_flag` rows for the tenant that was
viewed, and that a bundle at-or-after `4a1a0331c` is deployed.

**Reconciling with D-79:** this is not actually a contradiction of the decision log. D-79's wording
is *"no evidence **in the repo** of ever being enabled"* — a statement about the source tree, not the
database. D-79 goes on to name the enablement explicitly as an out-of-band action: *"Enabling it is
an OPERATOR step (the `enable-feature` verb on intel-api's task runner), separate from this code
change, and deliberately scoped to `capiro-internal` only."* The most parsimonious reading of the
live observation is that the operator step was performed. Note this also implies a deploy happened,
which is worth reconciling against any handoff note claiming "not deployed."

**Unverified (out of scope for this read-only pass):** the actual `intel_feature_flag` rows and the
deployed web bundle SHA. Confirming those requires a DB read and an ECS/task-def check. That is the
single open item here, and it is a *confirmation* step — no code-level alternative explanation
survives.

---

## 2. The real gap: rail gating is client-side only

### The inbox API applies no rail gating whatsoever

`C:\dev\capiro-fo-ga-review-wt\apps\api\src\funding-opportunities\funding-opportunity-inbox.service.ts`
contains **zero** flag logic. A grep of the entire file for `FEATURE`, `FlagGuard`,
`isFundingOpportunitiesFeatureEnabled`, or `feature` returns nothing.

- `list()` — `:774-830`. The Prisma `where` is built at `:816-822` as tenant + wall-scoped clients +
  `...(source ? { source } : {})` + filter + cursor. No rail predicate, conditional or otherwise.
- `parseSource()` — `:998-1002`. Validates the caller's `?source=` against `INBOX_SOURCES`
  (`:76`, = `[...OPPORTUNITY_SOURCES, 'agency_forecast', 'dibbs', 'sbir_sttr']`) and accepts all five
  with **no flag check**. A caller may pass `?source=sbir_sttr` and the API will honour it.
- The service's own header comment at `:65-68` states the behaviour plainly: the inbox *"has ALWAYS
  returned a forecast-sourced row when one existed — no source predicate excludes what the caller did
  not ask about."*

### The route carries only the two coarse guards

`funding-opportunities.controller.ts`:

- `:491` class-level `@UseGuards(RolesGuard, FundingOpportunitiesFlagGuard)` — the master
  `funding_opportunities` flag.
- `:524-525` `@Get('opportunities/inbox')` + `@UseGuards(FundingOpportunitiesInboxFlagGuard)` — the
  `funding_opportunities_client_inbox` flag.

Nothing rail-specific. Contrast the forecast **detail** route at `:555-556`, which does carry
`FundingOpportunitiesForecastFlagGuard`. That asymmetry is real and observable: with
`funding_opportunities_forecasts` off, a forecast row is still delivered in the inbox JSON, but
opening its detail 404s.

### The suppression happens in the browser

`FundingOpportunityInbox.tsx:266-277`:

```
const allRows = data?.rows ?? [];
const visibleRows = allRows.filter(
  (r) => (forecastsEnabled || !isForecastRow(r)) && (sbirEnabled || !isSbirRow(r)),
);
const withheldForecasts = forecastsEnabled ? 0 : allRows.filter((r) => isForecastRow(r)).length;
const withheldSbir = sbirEnabled ? 0 : allRows.filter((r) => isSbirRow(r)).length;
```

This is well-built *as UI* — it withholds rather than renders, and it states the withheld count per
rail so the numbers do not silently disagree with the tab badges (tested at
`FundingOpportunityInbox.test.tsx:1129-1144`). But it means **"flag off" is enforced by the client**.
Any consumer that is not this React component — a `curl` with a valid session, a future integration,
an internal script — receives forecast and SBIR rows for a tenant whose flags are off.

**One consumer checked and cleared:** Meri's tool adapter is *not* a leak.
`meri-opportunity-tools.adapter.ts:254-255, 276-277, 467-472` narrows every inbound ref through
`asOpportunitySource` (grants_gov / sam_gov only) and returns a typed `unsupported_source` result for
anything else. DIBBS/SBIR/forecast refs cannot be read through Meri.

### Severity

Real but currently latent, and it is a **defense-in-depth** finding rather than an active exposure:
the rows do not exist yet (see §3). It contradicts the plan's stated invariant in letter — a
tenant-visible capability whose only "dark" enforcement is JavaScript in the reader's browser is not
dark by default at the API boundary — while honouring it in practice for the browser surface.

---

## 3. DIBBS: genuinely un-flagged, end to end, by explicit design

A repo-wide search for `funding_opportunities_dibbs` at this commit returns **zero matches** —
including in docs. The brief's framing ("not imported in the funding-opportunities controller's guard
list") understates the situation: **there is no such constant to import.** No API guard, no web
constant, no flag key anywhere.

This is deliberate and documented in the code, at `FundingOpportunityInbox.tsx:60-71`:

> `dibbs` is in the unconditional list because it has NO capability flag — neither the API nor the
> web defines one, and the inbox has returned bid-board rows to every tenant since P41 part 2.
> Inventing a flag here would not gate anything; it would only hide a filter for rows the page is
> already showing.

The reasoning is internally consistent (a UI-only flag over an ungated data path hides a filter, not
data), but the conclusion drawn was "don't add the flag" rather than "add the gate." The net effect
is that the DLA bid-board rail is **the one tenant-visible rail with no gate at any layer**, which is
a literal violation of the plan's invariant.

**Why nobody has noticed:** the rail is dark today by *data accident*, not by design.
`client_funding_opportunity` holds zero `dibbs` rows for every tenant — D-79 gap 2 records that
`dibbs-relevance.ts`/`sbir-relevance.ts` were pure scoring functions nothing called, and that the
matching producers (`apps/api/scripts/generate-dibbs-opportunity-candidates.ts`,
`generate-sbir-opportunity-candidates.ts`) were only just built, are producer-only, and have never
been run with `--commit`. DIBBS ingestion is itself still incomplete and blocked on the MakeGov
account-wide rate limit (D-75 through D-78), and every Funding Opportunities schedule ships
`enabled: false` (`infra/cdk/lib/ingestion-schedule.ts`, e.g. `:620-633` for the forecast job, whose
comment at `:620-623` explicitly notes the flag stays off regardless of the schedule).

**This is exactly the "explainable because there's no data" case the brief offered as option (b) —
and it is the part that should worry you most,** because it expires the moment someone runs the DIBBS
producer with `--commit` for any tenant. At that instant, bid-board rows appear in every user's inbox
on that tenant, with no flag anywhere that could stop them, and no canary step available. The
producer's own CLI (`--commit`/`--tenant`/`--client`) is the only control.

---

## 4. Answers to the four questions as posed

**Q1 — static constant or API-driven?** Neither, exactly. It is a client-side constant list
(`BASE_SOURCE_OPTIONS`, `:72-77`) **conditionally extended** from the tenant's flag map fetched from
`/intel-api/feature-flags` (`:87-96`, `:157-161`). It is not "always rendered regardless of flag":
two of the five rails are strictly conditional. It is also not derived from the inbox response.

**Q2 — does the API gate rows?** No. `funding-opportunity-inbox.service.ts` has no flag logic at all;
`list()` (`:774-830`) applies no rail predicate and `parseSource()` (`:998-1002`) accepts all five
`INBOX_SOURCES` values unconditionally. The filter option's visibility and the data's availability
are indeed gated differently — the option is flag-gated (client), the data is not gated at all
(server).

**Q3 — what does the guard check, and how does absence behave?**
`funding-opportunities-flag.guard.ts` defines a base `FundingOpportunitiesFlagGuard` plus nine
subclasses, each overriding `feature()`:

| Guard | Flag | Line |
|---|---|---|
| `FundingOpportunitiesFlagGuard` (base) | `funding_opportunities` | `:6` |
| `FundingOpportunitiesInboxFlagGuard` | `funding_opportunities_client_inbox` | `:16` |
| `FundingOpportunitiesForecastFlagGuard` | `funding_opportunities_forecasts` | `:45` |
| `FundingOpportunitiesNoticeHistoryFlagGuard` | `funding_opportunities_notice_history` | `:56-57` |
| `FundingOpportunitiesDocumentsFlagGuard` | `funding_opportunities_documents` | `:70` |
| `FundingOpportunitiesLandscapeFlagGuard` | `funding_opportunities_government_landscape` | `:80-81` |
| `FundingOpportunitiesPipelineFlagGuard` | `funding_opportunities_pipeline_v2` | `:94` |
| `FundingOpportunitiesMeriFlagGuard` | `funding_opportunities_meri_v2` | `:114` |
| `FundingOpportunitiesBudgetFlagGuard` | `funding_opportunities_budget_context` | `:316-317` |
| `FundingOpportunitiesRiskFlagGuard` | `funding_opportunities_risk_context` | `:336` |

Plus `FUNDING_OPPORTUNITIES_VEHICLE_FIT_FEATURE` (`:26`), which is deliberately **never** read by a
guard — it is a data-shape check inside the service, because the field it gates lives inside an
already-flagged response.

Behaviour on absence — **404, three ways, all fail-closed** (`canActivate`, `:200-225`):
no tenant context → `NotFoundException`; a throwing flag read → logged at `error` then
`NotFoundException`; a missing/disabled row → `NotFoundException`.
404 rather than 403 is a stated choice (`:158-161`) so the response is indistinguishable from a route
that was never deployed. Two further deliberate details in the shared read
(`isFundingOpportunitiesFeatureEnabled`, `:134-149`): `withSystem` not `withTenant` (`:139`), because
`intel_feature_flag` is RLS-FORCE'd and owned by intel-api (documented `:163-166`); and **no `::uuid`
cast** in the SQL (`:141-146`), documented at `:168-176` as the exact bug that made District Nexus
dark for a tenant whose flag was genuinely on. There is also **no internal-tenant fallback** in this
guard (`:177-185`) — unlike `DistrictNexusFlagGuard` — so every tenant including `capiro-internal`
needs an explicit row.

**Notably absent from that table:** any guard for DIBBS (no flag exists) or for SBIR
(`funding_opportunities_sbir` appears **only** in `apps/web` — `funding-opportunities-api.ts:419` and
test files; zero occurrences under `apps/api` or `apps/intel-api`).

**Q4 — genuine gap or explainable?** Split verdict, stated plainly:

- The **dropdown** is (b)-and-then-some: not merely harmless, but *correct*. It is properly gated,
  and the live observation is best read as a flag-state readout — the flags are on — not as a UI bug.
- The **data path** is (a): a genuine gap. Forecast and SBIR rail gating is enforced only in the
  browser; DIBBS has no gate at any layer, in violation of the plan's stated invariant, and its
  current darkness is a consequence of blocked ingestion and never-run producers rather than of any
  control.

---

## 5. Recommendations

Ordered by what actually reduces risk, not by effort.

1. **Add rail gating to the inbox service, server-side.** In
   `funding-opportunity-inbox.service.ts.list()`, resolve the forecast and SBIR flags via
   `isFundingOpportunitiesFeatureEnabled` (already exported from the guard module for exactly this
   "data-shape check rather than 404" purpose — see its docblock at `:118-133`) and exclude those
   rails from the `where` when off. Have `parseSource()` reject a flagged rail the tenant does not
   have. The web's `visibleRows`/withheld-count logic can stay as belt-and-braces.
2. **Decide DIBBS deliberately, and write it down.** Either introduce
   `funding_opportunities_dibbs` with a real guard + the same web treatment the other two rails get,
   or record an explicit, reviewed exception to the "every capability is separately flag-gated"
   invariant naming DIBBS. What should not persist is an invariant the code silently does not meet.
   Do this **before** either candidate producer is first run with `--commit`.
3. **Confirm the two flag rows and the deployed bundle SHA** to close the one unverified link in this
   analysis. If the flags are on for `capiro-internal` this is expected per D-79's operator step and
   simply needs recording; if they are *not* on, then something in the runtime contradicts the code
   as read here and warrants a fresh look at the served bundle.
4. **Amend D-79.** Its "no evidence in the repo of ever being enabled" is accurate but reads as
   "not enabled anywhere," which the live observation appears to contradict. Distinguishing
   repo-state from database-state in that sentence would have prevented this review.
