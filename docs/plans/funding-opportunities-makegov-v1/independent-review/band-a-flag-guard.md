# Band A — the feature-flag guard as a trust boundary

**Review type:** independent §6.2 review, per the convention in
`docs/runbooks/phase-2-independent-live-validation.md` — a different reviewer than the
implementer, read-only verification, a verdict that is exactly one of two strings, and a
dated approval record.

**Reviewer:** an independent agent. Not involved in implementing any phase of the
Funding Opportunities + MakeGov/Tango program, and not the author of
`flag-ui-reconciliation.md` in this directory.

**Commit under review:** `d800dcfde51f6cf21a4b54b511006b9001fd6d2b`
(`feat(x-feed): configurable X Intelligence dashboard feed (#948)`, 2026-08-13).
Every citation below is against that SHA, read via `git show` from `C:\dev\capirov2` or
directly from the clean checkout at `C:\dev\capiro-fo-ga-review-wt`.

**Read-only.** No AWS call, no database read, no mutation, no deploy, no commit. The
only command run that was not a read was `jest` over two existing spec files
(§5). Claims that would need runtime state — actual `intel_feature_flag` rows, the
deployed bundle SHA, live row counts — are marked **unverified** and are not load-bearing
for any finding.

**Relationship to `flag-ui-reconciliation.md`:** that document is a narrower, parallel
investigation of the same area from the same day. This review independently re-derived its
two central claims (the inbox API applies no rail gating; `funding_opportunities_dibbs`
does not exist) and **confirms both**. It then goes further in four directions that
document does not cover: the complete per-flag route table (§2), the **write side** —
which materially changes the blast radius and contradicts that document's stated
mitigation (§3.3), the introduced-when question (§4), and the negative-test question
(§5). Where the two disagree, §3.3 is the disagreement and it is noted explicitly.

---

## Verdict

```
FO_GA_BAND_A_FLAG_GUARD_REJECTED
```

The two permitted strings for this review are
`FO_GA_BAND_A_FLAG_GUARD_INDEPENDENTLY_APPROVED` and
`FO_GA_BAND_A_FLAG_GUARD_REJECTED`.

**Why rejected.** The guard itself is genuinely well built — every fail-closed path in
§1 passes as specified, including the one the program most cares about (no implicit
internal-tenant fallback). But the program's own invariant, D-07, is *"Every tenant-visible
capability is separately flag-gated and dark by default."* At this commit two
tenant-visible rails do not meet it: the DLA bid board has **no flag at any layer of the
stack**, and SBIR/STTR's only enforcement is JavaScript running in the reader's browser.
Approval requires the invariant to hold at the API boundary, not to hold for one
well-behaved client. It does not hold. This is a REJECT on the invariant, not on the
guard's implementation.

The rejection is **not** an assertion that data is leaking today. It is not. See §3.2 for
the precise, honest statement of what is and is not true right now.

---

## 1. The guard implementation: verified, and it passes

`apps/api/src/funding-opportunities/funding-opportunities-flag.guard.ts`

The base class `FundingOpportunitiesFlagGuard` (`:186-226`) plus nine subclasses, each
overriding a single `feature()` method. Every fail-closed path lives in the base, so a
subclass cannot drift into failing open. Verified directly:

| Claim | Where | Result |
|---|---|---|
| No tenant context → 404 | `:206` | PASS |
| Disabled/missing flag row → 404 (not 403) | `:223` | PASS |
| A **throwing** flag read → logged, then 404 | `:216-222` | PASS |
| `withSystem`, not `withTenant` (RLS-FORCE'd table) | `:139` | PASS |
| No `::uuid` cast on `tenant_id` (the District Nexus incident) | `:141-147` | PASS |
| **No implicit internal-tenant fallback** | whole file | PASS |

The last row is the one the brief calls out, and it holds. There is no `capiro-internal`
string, no `CAPIRO_INTERNAL_TENANT_ID`, and no `FROM tenants` in the file; the only
tenant-membership test in the code is the flag row itself. This is a real and deliberate
improvement over `DistrictNexusFlagGuard`, which does carry that fallback, and it is
pinned by a test (`funding-opportunities.boundaries.spec.ts:149-165`) that strips comments
first so the docblock's legitimate mention of District Nexus does not false-positive.

**Nothing in this review disputes the guard.** Every finding below is about flags that
never reach it.

---

## 2. The complete flag table

All seventeen flags named in the brief. "Absent" means the requesting tenant has no
enabled `intel_feature_flag` row for that flag.

| # | Flag | Enforced where | Route(s) actually gated | Behaviour when absent |
|---|---|---|---|---|
| 1 | `funding_opportunities` | `FundingOpportunitiesFlagGuard`, **class-level** — controller `:491` | Every route on `FundingOpportunitiesController` (all 20) | **404** on all of them |
| 2 | `..._client_inbox` | `FundingOpportunitiesInboxFlagGuard` — `:525` | `GET /intelligence/opportunities/inbox` | **404** |
| 3 | `..._tango_shadow` | **nowhere in code** | none | **No effect.** 2 occurrences repo-wide, both prose: a migration comment and the canary runbook |
| 4 | `..._tango_entities` | **nowhere** | none | **No effect. Zero occurrences repo-wide**, including docs |
| 5 | `..._vehicle_fit` | Plain boolean in `funding-opportunities.service.ts` via `isFundingOpportunitiesFeatureEnabled` | none — by design | `acquisitionPosition: null` inside the already-flagged response. **Correct**, and documented at guard `:18-27` |
| 6 | `..._forecasts` | `FundingOpportunitiesForecastFlagGuard` — `:556` | `GET /intelligence/opportunities/forecasts/:forecastId` | **404** on the detail route — but forecast **rows are still returned by the inbox**. See §3.4 |
| 7 | `..._notice_history` | `FundingOpportunitiesNoticeHistoryFlagGuard` — `:592` | `GET /intelligence/opportunities/:source/:id/timeline` | **404** |
| 8 | `..._documents` | `FundingOpportunitiesDocumentsFlagGuard` — `:609` | `GET /intelligence/opportunities/:source/:id/requirements` | **404**. Attachments and extracted text have no HTTP route at all |
| 9 | `..._government_landscape` | `FundingOpportunitiesLandscapeFlagGuard` — `:633`, `:655` | `GET .../landscape` **and** `GET .../action-plan` | **404** on both |
| 10 | `..._pipeline_v2` | `FundingOpportunitiesPipelineFlagGuard` — `:757`, `:775`, `:810`, `:836` | `GET clients/:id/pipeline`, `POST .../pipeline/:rowId/stage`, `POST` + `GET .../outcome` | **404** on all four |
| 11 | `..._meri_v2` | `FundingOpportunitiesMeriFlagGuard` — `:689`, **and** a boolean in the tools adapter | `POST /intelligence/opportunities/:source/:id/assessment` | **404** on the route; a typed `disabled` result inside Meri's tools. Both go through one helper, so they cannot disagree |
| 12 | `..._tango_mcp` | `requiresFeature` on the MCP catalog entry, enforced in `meri-mcp.service.ts:159,163,251` | Not a route — the MakeGov/Tango MCP connector | Entry **hidden** from the catalog; connect attempt **refused**. Real server-side enforcement |
| 13 | `..._dibbs` | **DOES NOT EXIST** | none | **No effect — there is no such flag to enable.** Zero occurrences repo-wide. See §3 |
| 14 | `..._sbir` | **Web only** — `funding-opportunities-api.ts:419`. Zero occurrences under `apps/api` or `apps/intel-api` | none, server-side | API returns full SBIR rows; **the browser filters them out**. See §3 |
| 15 | `..._budget_context` | `FundingOpportunitiesBudgetFlagGuard` — `:718` | `GET /intelligence/clients/:clientId/budget-context` | **404** |
| 16 | `..._risk_context` | `FundingOpportunitiesRiskFlagGuard` — `:739` | `GET /intelligence/clients/:clientId/risk-context` | **404** |
| 17 | `..._tango_webhooks` | **nowhere** | none | **No effect. Zero occurrences repo-wide**, including docs |

Eleven of seventeen are properly enforced server-side (1, 2, 5, 6\*, 7–12, 15, 16 — 6 with
the caveat in §3.4). Six are not: three gate nothing because nothing reads them (3, 4, 17),
two gate nothing because they are browser-only or absent (13, 14), and 5 is a deliberate,
correct non-route design.

---

## 3. Lead finding — the cross-capability exposure

### 3.1 What was verified

**The inbox service contains no flag logic of any kind.**
`apps/api/src/funding-opportunities/funding-opportunity-inbox.service.ts` — a grep of the
entire 1362-line file for `intel_feature_flag`, `isFundingOpportunitiesFeatureEnabled`,
`withSystem`, `FEATURE` or `FlagGuard` returns **nothing**.

- `list()` `:774-975`. The Prisma `where` is assembled at `:816-822`:
  tenant + wall-scoped client ids + `...(source ? { source } : {})` + filter + cursor.
  The rail predicate is present **only when the caller supplies `?source=`** — it is a
  narrowing filter the caller opts into, never a restriction the server imposes.
- `parseSource()` `:998-1002` validates against `INBOX_SOURCES` (`:76`), which is
  `[...OPPORTUNITY_SOURCES, 'agency_forecast', 'dibbs', 'sbir_sttr']`, and accepts all five
  **with no flag check**. `?source=dibbs` and `?source=sbir_sttr` are honoured.
- Rows are shaped at `:876-940` with their full per-rail facts blocks — `dibbs:` at `:910`
  and `sbir:` at `:916` — gated only on the row's own `source` column, never on a flag.

**The route carries only the two coarse guards:** class-level
`funding_opportunities` (`:491`) and `funding_opportunities_client_inbox` (`:525`).
Nothing rail-specific.

**The suppression is in the browser.** `FundingOpportunityInbox.tsx:266-277`:

```
const visibleRows = allRows.filter(
  (r) => (forecastsEnabled || !isForecastRow(r)) && (sbirEnabled || !isSbirRow(r)),
);
```

**And DIBBS is not even filtered there** — it is in `BASE_SOURCE_OPTIONS` (`:72-77`),
unconditionally. The component's own comment (`:67-70`) states the situation without
euphemism:

> `dibbs` is in the unconditional list because it has NO capability flag — neither the API
> nor the web defines one, and the inbox has returned bid-board rows to every tenant since
> P41 part 2.

`funding_opportunities_dibbs` returns **zero matches repo-wide**, docs included. The
brief's framing — "not imported in the controller's guard list" — understates it: there is
no constant to import, at any layer.

**No other API surface serves DIBBS/SBIR.** No controller in `apps/api/src` mentions
either source. Meri's tool adapter is clear: it narrows every inbound ref through
`asOpportunitySource` (grants/sam only) and returns a typed `unsupported_source`
otherwise. The inbox is the **sole** exposure path — which is why fixing it is tractable.

### 3.2 The concrete answer to the exposure question

**Would a tenant without the flag retrieve real DIBBS/SBIR data by hitting the API
directly, provided such data exists? Yes — unambiguously.**

The full chain, with nothing hand-waved:

1. Tenant T has `funding_opportunities` and `funding_opportunities_client_inbox` enabled.
   Nothing else. No `_sbir` row, and no `_dibbs` row is even possible.
2. `GET /api/intelligence/opportunities/inbox` passes both guards.
3. `list()` applies no rail predicate. Rows with `source = 'dibbs'` or `'sbir_sttr'`
   belonging to T's visible clients are selected.
4. The response carries each row's full facts block — for SBIR: topic title, agency,
   parent solicitation cycle, close date, relevance score; for DIBBS: nomenclature,
   solicitation number, quantity, unit of issue, closing date, relevance score.
5. A `curl` with a valid session, or any non-React consumer, receives all of it. The React
   app would have dropped it and rendered "N withheld" — but that is a courtesy of one
   client, not a control.

**The honest severity qualification, stated plainly:**

- **This is not cross-*tenant* exposure. Tenant isolation is fully intact.** `list()` runs
  inside `prisma.withTenant(tenantId, …)` (`:791`), the `where` pins `tenantId` (`:817`),
  and `clientId: { in: scopedClientIds }` (`:818`) is intersected with the ethical wall as
  a positive allow-list (`:796-814`). No tenant can see another tenant's rows. The
  program's §4.6 RLS posture holds.
- **It is cross-*capability* exposure**: a tenant sees a capability it was never granted,
  over its own data. That is a real trust-boundary failure — the boundary this program
  defined is "which tenants can access which capability" — but it is a materially smaller
  blast radius than a cross-customer leak, and this review will not inflate it.
- **It is latent today, not active.** `client_funding_opportunity` holds zero `dibbs` and
  zero `sbir_sttr` rows (per the separate, already-being-investigated zero-rows bug; DB
  state **unverified** by this read-only pass and taken as given). With no rows, step 3
  selects nothing and the gap is undetectable from outside.

**Does it become a real exposure the moment the zero-rows bug is fixed? Yes — and this is
the finding.** Nothing else has to change. No flag has to be flipped, because no flag
exists for DIBBS and the SBIR flag is not consulted server-side. No deploy is needed. The
gap converts from latent to live at the instant the first candidate row is written, and it
does so **silently** — there is no error, no log line, and no alarm that fires when an
ungated rail starts returning data. That is the precise property that makes a latent gap
worth a REJECT rather than a footnote: its transition to live is invisible.

### 3.3 The write side — where this review's blast-radius assessment differs

`flag-ui-reconciliation.md` §3 concludes that the producer's CLI
(`--commit`/`--tenant`/`--client`) "is the only control." **That is not correct, and the
real behaviour is worse.**

`resolveTenantIds()` in `apps/api/scripts/generate-dibbs-opportunity-candidates.ts:258-269`
(identical in the SBIR producer, `:257-268`):

```sql
SELECT DISTINCT tenant_id FROM intel_feature_flag
WHERE feature = ${FUNDING_OPPORTUNITIES_FEATURE} AND enabled = true
```

`--tenant` is an **optional narrowing**. With it omitted, the producer fans out to **every
tenant with the MASTER `funding_opportunities` flag enabled** — not to tenants with a
DIBBS or SBIR entitlement, because no such entitlement exists to key on.

And the scheduled invocation omits it. `infra/cdk/lib/ingestion-schedule.ts:543-550`:

```
id: 'GenerateDibbsOpportunityCandidates',
command: ['generate-dibbs-opportunity-candidates', '--commit'],
enabled: false,
```

No `--tenant`. So the moment that schedule is flipped to `enabled: true` — a routine
rollout step, not a security decision, and one whose runbook entry says nothing about
capability scope — the nightly job writes DIBBS candidate rows for **every master-flag
tenant's clients**, and every one of those tenants with the inbox flag begins receiving
them over the API immediately. There is no per-tenant canary available, because the
producer has no per-rail flag to canary on.

The containment today is real but thin, and all of it is upstream of the gap rather than at
it: schedules ship `enabled: false`, ingestion is blocked on the MakeGov rate limit
(D-75–D-78), and the producers have never been run with `--commit`. Three accidents of
sequencing, no gate.

### 3.4 The forecast rail has the same shape — since P26

This is not solely a DIBBS/SBIR issue. `funding_opportunities_forecasts` guards the
forecast **detail** route (`:556`, 404 when off) but does **not** filter forecast rows out
of the inbox — the same `list()` with no flag logic serves them, and
`FundingOpportunityInbox.tsx:268` filters them in the browser exactly as it does SBIR. The
service's own header comment (`:65-68`) says the inbox *"has ALWAYS returned a
forecast-sourced row when one existed."*

So the in-program precedent is real but **partial**: "inbox rows are not server-side
flag-filtered" has been true for every flagged rail since P26. What is unprecedented is
having *no* server-side enforcement anywhere — forecasts at least gate their dedicated
route. DIBBS and SBIR have no dedicated route, so there is nothing else for a flag to
protect, and the browser is the entire control surface.

---

## 4. Is this new? No — and the timeline matters

Answering the brief's question 3 directly.

| Event | Commit | Date |
|---|---|---|
| DIBBS inbox rail lands (`DIBBS_INBOX_SOURCE`) | `c2f828ac2` P41 part 2 | 2026-08-08 |
| SBIR inbox rail lands (`SBIR_INBOX_SOURCE`) | `4a1a0331c` P43 part 3 | 2026-08-08 |
| Flag guard file last touched | `34cddb7c3` P45 | 2026-08-07 |
| DIBBS/SBIR matching producers wired (#943, D-79) | `aebec3b32` | **2026-08-13** |

**The read-side gap was introduced on 2026-08-08 by P41 part 2 and P43 part 3, five days
before D-79/#943 — not by today's change.** The guard file has not been touched since P45,
before either rail existed; no one removed a guard, and there was never a guard to remove.

**But #943 is what makes the gap consequential.** Before it, no code path existed that
could create a `dibbs` or `sbir_sttr` candidate row at all — D-79 records that
`dibbs-relevance.ts`/`sbir-relevance.ts` were pure scoring functions nothing called.
#943 built the producers that populate the exact rows the ungated read path serves. So:
today's change did not introduce the hole, it built the pipe that will fill it.

**Is there a precedent for "UI-only gated during rollout, real guard added in a follow-up
phase"? No. I looked for one specifically, and every other capability flag in this
repository has real server-side enforcement:**

| Flag | Server-side guard |
|---|---|
| `district_nexus_v2` | `apps/api/src/district-nexus/district-nexus-flag.guard.ts` |
| `hearing_watch` | `apps/intel-api/src/feature-flags/hearing-watch-feature.guard.ts` |
| `bill_360` | `apps/intel-api/src/bill-dossier/bill-360.guard.ts` |
| `tracker_v2` | `apps/intel-api/src/feed/tracker-v2.guard.ts` |
| every FO flag except `_dibbs`/`_sbir` | a `FundingOpportunitiesFlagGuard` subclass |

`funding_opportunities_sbir` is the **only** tenant-visible capability flag in the entire
repository whose sole enforcement is client-side, and `funding_opportunities_dibbs` is the
only tenant-visible rail with no flag at all. So the charitable reading the brief offered —
"a known, temporary rollout state by established convention" — **is not available**. There
is no such convention here; these two are outliers against a consistent codebase-wide
pattern. That said, this is an outlier in *scope*, not sloppiness in *intent*: the
reasoning in `FundingOpportunityInbox.tsx:58-71` is internally coherent (a UI-only flag
over an ungated data path hides a filter, not data). The conclusion drawn was "don't add
the flag" where it should have been "add the gate."

---

## 5. The mandatory question: is there a negative test? No.

**There is no test anywhere in the repository asserting that a tenant without
`_dibbs`/`_sbir` enabled cannot retrieve DIBBS/SBIR data via the API.** Verified by
reading every relevant spec, not by grep alone.

`funding-opportunities.boundaries.spec.ts:114-179` — the `FundingOpportunitiesFlagGuard
fails closed` block — has six tests, all of which pass and all of which exercise the
**base** guard in isolation: no tenant context, no row, an enabled row, a throwing read, no
internal-tenant fallback, no `::uuid` cast. Not one of them concerns a rail.

`funding-opportunity-inbox.spec.ts` has extensive rail coverage — `?source=dibbs` narrows
and echoes (`:968`), a DIBBS row carries its facts block (`:841`), a grant carries none
(`:931`), `?source=sbir_sttr` narrows (`:1328`), an unknown source is a 400 (`:1022`). Its
one gating test (`:1233`) asserts only that the **inbox** flag is separate from the master
flag. Every rail test asserts rows **are** returned; none asserts any row is **withheld**
for a tenant lacking a capability — because no such behaviour exists to test.

I ran both suites to confirm the code I read is the code that runs:

```
apps/api $ ./node_modules/.bin/jest --testPathPattern="(funding-opportunity-inbox|funding-opportunities.boundaries)"
Test Suites: 2 passed, 2 total
Tests:       175 passed, 175 total
```

**175 tests pass, and none of them is the negative test.** Per the brief, that absence is
itself a finding, and it is the sharpest one in this review — because a negative test is
exactly the control that would have caught this at authoring time. The program's own §4.6
posture requires cross-tenant negative tests for every tenant-scoped new table, and that
requirement was met: RLS and tenant scoping are genuinely solid (§3.2). The gap is that
the same discipline was never extended from *tenant* scope to *capability* scope. The
existing web tests (`FundingOpportunityInbox.test.tsx:1129-1152`) do assert the withheld
behaviour — but they assert it of the browser, which is the layer that cannot enforce it.

---

## 6. Findings queue, severity-ranked

Not fixed — recorded, per instruction. No file outside this document was modified.

### F-1 · HIGH (latent) · Cross-capability exposure: DIBBS/SBIR data is served by the inbox API with no server-side gate

**Where:** `funding-opportunity-inbox.service.ts:774-975` (no flag logic);
`funding-opportunities.controller.ts:524-525` (only the two coarse guards).
**Impact:** any tenant with `funding_opportunities` + `_client_inbox` receives DIBBS and
SBIR rows with full facts blocks over the API, without either capability being granted.
Tenant isolation is intact; this is capability scope, not tenant scope.
**Latency:** zero rows exist today, so it is currently undetectable. It becomes live —
silently, with no flag flip and no deploy — the moment the zero-rows bug is fixed.
**Aggravator (F-1a):** the producers select tenants by the **master** flag
(`generate-dibbs-opportunity-candidates.ts:258-269`) and the scheduled command passes no
`--tenant` (`ingestion-schedule.ts:543-550`), so enabling that schedule fans rows out to
every master-flag tenant at once. No per-rail canary is possible.
**Fix direction:** resolve the rail flags in `list()` via the already-exported
`isFundingOpportunitiesFeatureEnabled`, exclude ungranted rails from the `where`, and have
`parseSource()` refuse a rail the tenant lacks. Do this **before** any producer is first
run with `--commit`.

### F-2 · HIGH · `funding_opportunities_dibbs` does not exist at any layer — a literal violation of D-07

**Where:** zero occurrences repo-wide; acknowledged in
`FundingOpportunityInbox.tsx:67-70`.
**Impact:** the DLA bid board is a tenant-visible rail that cannot be turned off, because
there is nothing to turn off. D-07 states every tenant-visible capability is separately
flag-gated and dark by default; this rail is neither.
**Fix direction:** either introduce the flag with a real server-side gate and the same web
treatment the other rails get, or record a reviewed, explicit exception to D-07 naming
DIBBS. What must not persist is an invariant the code silently does not meet.

### F-3 · HIGH · No negative test for either rail

**Where:** `funding-opportunities.boundaries.spec.ts:114-179`;
`funding-opportunity-inbox.spec.ts` throughout. 175 passing tests, none of them this one.
**Impact:** the one control that would have caught F-1 and F-2 at authoring time is
missing, and its absence is why they shipped. The §4.6 discipline was applied to tenant
scope and never extended to capability scope.
**Fix direction:** an API-level test asserting a tenant with master+inbox but no `_sbir`
receives zero `sbir_sttr` rows — added **with** the F-1 fix, so it fails first.

### F-4 · MEDIUM · `funding_opportunities_sbir` is enforced only in the browser

**Where:** `funding-opportunities-api.ts:419` (web only); `FundingOpportunityInbox.tsx:268`.
**Impact:** the only tenant-visible capability flag in the repository whose sole
enforcement is client-side. Well-built as UI — it withholds rather than renders and states
the withheld count per rail — but it is not a gate.
**Note:** subsumed by the F-1 fix.

### F-5 · MEDIUM · The forecast rail has the same inbox gap, and has since P26

**Where:** `funding-opportunity-inbox.service.ts` (no rail filtering);
`funding-opportunities.controller.ts:556` (detail route guarded).
**Impact:** with `_forecasts` off, the detail route correctly 404s but forecast rows are
still delivered in the inbox JSON. Lower severity than F-1 only because forecasts have a
real guard on their dedicated route — the capability is not wholly ungated.
**Fix direction:** same change as F-1; treat all three rails uniformly.

### F-6 · LOW-MEDIUM · Three canary flags gate nothing; two do not exist

**Where:** `_tango_shadow` — 2 occurrences, both prose (a migration comment and
`funding-opportunities-makegov-canary.md:79`). `_tango_entities` and `_tango_webhooks` —
**zero occurrences repo-wide.**
**Impact:** the canary runbook instructs an operator to advance rollout by enabling flags
that no code reads. Following it produces no change in behaviour while creating a false
record that a capability was gated. Low severity today because the capabilities they
nominally cover are shadow-mode and have no tenant-visible surface — but the runbook does
not say that.
**Fix direction:** either wire them or strike them from the runbook and name them as
reserved.

### F-7 · INFO · No precedent exists for UI-only gating in this codebase

`district_nexus_v2`, `hearing_watch`, `bill_360` and `tracker_v2` all have real
server-side guards (§4). Recorded so that F-1/F-2 are not later mistaken for an accepted
house convention, and so a future reviewer does not have to re-derive the search.

---

## 7. What this review did not cover

- **Runtime state.** Actual `intel_feature_flag` rows, live row counts in
  `client_funding_opportunity`, the deployed bundle SHA and task-def revision. All
  read-only-out-of-scope here and all **unverified**. The zero-rows premise is taken as
  given from the separate investigation; note that F-1 is *more* severe, not less, if that
  premise turns out to be wrong.
- **The dropdown question**, fully covered by `flag-ui-reconciliation.md` §1, whose
  conclusion (the dropdown is correctly gated and its 5-rail appearance is a flag-state
  readout) this review has no basis to dispute and did not re-derive.
- **Non-flag authorization.** The role matrix and ethical wall were read closely enough to
  confirm tenant isolation for §3.2 and both look sound, but they were not the assigned
  scope and are not certified here.

---

## Approval record

**Verdict: `FO_GA_BAND_A_FLAG_GUARD_REJECTED`** — 2026-08-13, by an independent agent (not
the implementer of any phase of this program, and not the author of
`flag-ui-reconciliation.md`).

Section 1 passes in full: the guard is well built, fails closed on all three paths, and
genuinely carries no implicit internal-tenant fallback. The rejection rests on the
invariant, not the implementation — D-07's *"every tenant-visible capability is separately
flag-gated and dark by default"* does not hold at the API boundary for two rails, one of
which (DIBBS) has no flag at any layer and one of which (SBIR) is enforced only by
JavaScript in the reader's browser.

The gap predates today's change by five days (P41p2/P43p3, 2026-08-08) and is not a
regression introduced by D-79/#943 — but #943 built the producers that will populate the
rows the ungated path serves, and the scheduled producer command fans out to every
master-flag tenant. No negative test exists that would have caught any of this.

Re-review should be requested once F-1, F-2 and F-3 are closed. F-1's fix is small and
well-supported by existing code: `isFundingOpportunitiesFeatureEnabled` was exported from
the guard module for precisely this "data-shape check rather than 404" purpose, and its
docblock says so.
