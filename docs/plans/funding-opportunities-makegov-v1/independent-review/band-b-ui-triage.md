# Band B — the UI / triage surface cluster (P10–P12, P26, P32–P34)

**Review type:** independent §6.2 review, per the convention in
`docs/runbooks/phase-2-independent-live-validation.md` — a different reviewer than the
implementer, read-only verification, a verdict that is exactly one of two strings, and a
dated approval record.

**Reviewer:** an independent agent. Not involved in implementing any phase of the Funding
Opportunities + MakeGov/Tango program, and not the author of `flag-ui-reconciliation.md`
or `band-a-flag-guard.md` in this directory.

**Commit under review:** `d800dcfde51f6cf21a4b54b511006b9001fd6d2b`
(`feat(x-feed): configurable X Intelligence dashboard feed (#948)`, 2026-08-13). Every
citation below is against that SHA, read via `git show` from `C:\dev\capirov2`. Tests were
run from the clean checkout at `C:\dev\capiro-fo-ga-review-wt`, which is at the same SHA.

**Read-only.** No AWS call, no database read, no mutation, no deploy, no commit, and no
edit to any source file. The only command run that was not a read was
`pnpm --filter @capiro/web exec vitest run src/pages/intelligence/opportunities`.

**Scope boundary.** Whether the three newest rails are *correctly flag-gated* — the live
observation that the Triage Inbox source dropdown lists all 5 rails with zero rows for 3
of them — is the subject of `flag-ui-reconciliation.md` and `band-a-flag-guard.md`, not
this review. This review asks the different question: **assuming flags and data eventually
work correctly, does the UI itself handle each rail once real data exists?** Where the two
questions touch (finding **B-1**), the overlap is stated explicitly.

---

## Verdict

```
BAND_B_UI_TRIAGE_REJECTED
```

The two permitted strings for this review are
`BAND_B_UI_TRIAGE_INDEPENDENTLY_APPROVED` and `BAND_B_UI_TRIAGE_REJECTED`.

**Rejected on question 4 (empty / error / stale states) and partly on question 5 (test
coverage).** Questions 1, 2 and 3 pass cleanly and are, on the evidence, better than the
brief's hypotheses assumed — the D-67 dispatch fix held, the newest rail did *not* get a
shortcut version of the established pattern, and `fpds` is safely illegal.

The rejection rests on four things, one of which (**B-1**) is the UI half of the exact
symptom seen live today, and one of which (**B-2**) is a reachable navigational dead-end:

| # | Severity | One line |
|---|----------|----------|
| **B-1** | **P1** | Source-rail staleness is **structurally unrepresentable** for 3 of the 5 rails — the freshness type is narrowed to the 2 catalog rails — and the source-filter empty state still speaks P11's two-rail sentence, so "the DIBBS rail has never synced" renders as "there is nothing on the DLA bid board for you". |
| **B-2** | **P2** | When a whole page of results is withheld by a capability flag, the pager is not rendered at all, so every later page of that queue becomes unreachable. |
| **B-3** | **P2** | The drawer's forecast branch has no forecast-flag check, so the same deep link that the full page answers with a named "capability is off" gets an ambiguous three-way "No such agency forecast" in the drawer. |
| **B-4** | **P2** | DIBBS and SBIR rows have **no path to the source record** from the inbox: no detail body, and the source-document links are nested inside an action row the inbox structurally never renders. |
| **B-5** | **P3** | The inbox *list* dispatch keeps the negative-fallback polarity that D-67 removed from the *drawer* dispatch — the catalog card is the unnamed default branch. |
| **B-6** | **P3** | The web's `INBOX_SOURCES` mirror is hand-copied from the API's and is pinned by no test on either side. |
| **B-7** | **P3** | No inbox test ever renders a `grants_gov` row. The uncovered rail is the *oldest* one, not the newest. |
| **B-8** | **P4** | Minor: withheld counts are per-page but worded as if per-queue; the unnamed-rail drawer fallback has zero test coverage; the drawer title falls back to "Opportunity detail" for a rail whose body says there is no view for it. |

**Test health at this SHA:** `vitest run src/pages/intelligence/opportunities` —
**17 files, 445 tests, 445 passed, 0 failed, 0 skipped** (101.6 s). Nothing below is a
failing test. Every finding is a gap in what the tests assert, or in behaviour no test
exercises.

---

## Question 1 — is every rail explicitly NAMED in the detail dispatch? **PASS**

The brief's hypothesis was that after D-67 (dispatch keyed on `catalogRef == null ?
Forecast : Catalog`, which broke silently when `dibbs` became a third `null`-returning
ref), one of the five rails might still share an implicit fallback. It does not, in either
detail frame.

### 1.1 The drawer

`apps/web/src/pages/intelligence/opportunities/FundingOpportunityDrawer.tsx`, dispatch at
lines 119–152:

| Order | Test | Body |
|-------|------|------|
| 1 | `refValue == null` | nothing (closed) |
| 2 | `catalogRef != null` (line 119) | `FundingOpportunityDetail` |
| 3 | `refValue.source === FORECAST_SOURCE` (121) | `ForecastOpportunityDetail` |
| 4 | `isDibbs` (126) | `fo-drawer-dibbs-no-detail` alert |
| 5 | `refValue.source === SBIR_SOURCE` (134) | `fo-drawer-sbir-no-detail` alert |
| 6 | else (143) | `fo-drawer-no-detail` — "There is no detail view for this rail yet" |

Branch 2 looks like it could be the old negative test, and it is not. `asCatalogRef`
(`funding-opportunities-api.ts:1582`) delegates to `isOpportunitySource`, which is a
**positive whitelist of two literal strings**:

```ts
export function isOpportunitySource(value: string): value is OpportunitySource {
  return value === 'grants_gov' || value === 'sam_gov';
}
```

So `catalogRef != null` names `grants_gov` and `sam_gov` as surely as branch 3 names
`agency_forecast`. All five rails are named; the sixth branch is a stated absence, not a
body. Line 60's own comment records the D-67 history and the rule ("Test the source, never
the absence"), and `asCatalogRef`'s doc at 1574–1580 carries the same warning at the
helper rather than only at the call site — which is where it needed to be.

`drawerTitle` (bottom of the same file) is a *second* dispatch over the same five values,
which is the usual place two ternaries drift. Here it is a `function` with three explicit
`if`s and a default, and the file comments say exactly why it is not a nested ternary in
the JSX. Titles and bodies agree for all five rails. (One nit — **B-8** — the default title
is `'Opportunity detail'`, so a hypothetical sixth rail would be titled as an opportunity
above a body saying there is no view for it. Unreachable today.)

### 1.2 The full page

`FundingOpportunityDetail.tsx:538–680` (`FundingOpportunityDetailPage`) dispatches in a
different order but with the same property — every rail named, catalog reached through the
same positive whitelist:

- `source === FORECAST_SOURCE` → flag check, then `ForecastOpportunityDetail` (581)
- `source === DIBBS_SOURCE` → `fo-dibbs-no-detail` (617)
- `source === SBIR_SOURCE` → `fo-sbir-no-detail` (634)
- `!isOpportunitySource(source) || !sourceRecordId` → `fo-detail-bad-ref` (650)
- otherwise → `FundingOpportunityDetail` (668)

The bad-ref copy names all five accepted rails verbatim, and a web test
(`FundingOpportunityDetail.test.tsx:528`) pins that sentence. The comments at 603–616 and
631–633 state the specific harm each branch prevents — telling a reader that `dibbs` "is
not a source Capiro holds" is false about Capiro's own data, and sends them looking for a
broken import rather than back to the queue.

**Assessment: the D-67 fix held, and it generalised correctly to the fifth rail.** No rail
shares an implicit fallback in either detail frame. There is one place the same polarity
was *not* applied — the inbox list — see **B-5** below.

---

## Question 2 — are the per-rail fact/withheld distinctions real, or did SBIR get a shortcut? **PASS**

SBIR, the newest rail, is the *most* carefully handled of the three, not the least.

### 2.1 The three-state distinction is genuinely implemented

`SbirOpportunityCard.tsx:119–133` exports `describeSbirCycle`, which returns three
different sentences:

```ts
if (facts.solicitationNumber == null || facts.solicitationNumber === '')
  return 'The source states no solicitation cycle for this topic';   // a SOURCE fact
if (cycle == null)
  return `${facts.solicitationNumber} — Capiro does not hold this cycle`; // a CAPIRO fact
return name ? `${cycle.solicitationNumber} · ${name}` : cycle.solicitationNumber; // held and named
```

It is `export`ed specifically so the test asserts the same function the card renders rather
than a re-implementation of the rule (comment at 116–118). The type mirror keeps the two
absences distinguishable end to end: `InboxSbirFacts.solicitationNumber` documents "Null
means the source named none" and `InboxSbirFacts.cycle` documents "Null means NOT HELD — a
fact about Capiro's sync" (`funding-opportunities-api.ts:579–596`).

The harder, rail-specific half is also right: `sbirProgramLabel` returns `null` rather than
guessing, because `program` lives on the parent cycle and STTR is the variant requiring a
research partner — so labelling an orphan topic "SBIR" would assert the *absence* of a
requirement. The card renders a `Program not stated` tag instead, and a test covers it
(`FundingOpportunityInbox.test.tsx:1080`, "an ORPHAN topic — cycle not held — says so
instead of guessing a program").

### 2.2 Withheld-row counts are per-rail, not pooled

`FundingOpportunityInbox.tsx:266–277`:

```ts
const withheldForecasts = forecastsEnabled ? 0 : allRows.filter(isForecastRow).length;
const withheldSbir      = sbirEnabled      ? 0 : allRows.filter(isSbirRow).length;
```

Two separate notices (`WithheldForecastNotice` 504, `WithheldSbirNotice` 524) with the
stated reason for not pooling them — two flagged rails can be off at once and a reader
needs to know *which* capability to ask for. A test pins the both-off case
(`FundingOpportunityInbox.test.tsx:1129`, "forecasts and topics withheld together are
counted separately"). Both notices render in *both* the empty and non-empty branches
(lines 357–358 and 371–372), so a page whose every row is withheld still says so.

DIBBS has no withheld notice because it has no capability flag. That is documented rather
than accidental (`FundingOpportunityInbox.tsx:66–71`: "neither the API nor the web defines
one … inventing a flag here would not gate anything"). Whether that *should* be true is the
flag reconciliation's question, not this one.

### 2.3 The degradation paths were factored, not copy-pasted

`SourceFactsMissingCard` (678) is parameterised on label and test-id, with a comment saying
it was DIBBS-only until P43 needed the identical thing for topics "and a copy would have
been free to drift". It stays on the row's own rail rather than falling back to the generic
opportunity card, and a test asserts an SBIR fallback card is never mislabelled "DLA bid
board" (`:1167`). The DIBBS path additionally narrows `documentType` through
`asPursuableDibbsFacts` rather than casting, so an unrecognised third document type
degrades to a stated absence instead of being coerced into an RFQ with a quote button
(tested at `:1003`).

**Assessment: no shortcut. If anything, P43 tightened the pattern P41 established.**

---

## Question 3 — is `fpds` still safely illegal? **PASS, with one advisory**

Yes, on every vocabulary that matters, and the guard test that would catch a future move is
present and correct.

**The three vocabularies at this SHA:**

| Vocabulary | Value | Contains `fpds`? |
|---|---|---|
| `OPPORTUNITY_SOURCES` (catalog) | `['grants_gov','sam_gov']` | no |
| `PLANNED_OPPORTUNITY_SOURCES` | `['agency_forecast','dibbs','sbir_sttr']` | no |
| `STORABLE_OPPORTUNITY_SOURCES` | spread of the two above (5) | no |
| `INBOX_SOURCES` (api) | `[...OPPORTUNITY_SOURCES,'agency_forecast','dibbs','sbir_sttr']` | no |

The test's own self-guard is the load-bearing part and it is present
(`funding-opportunity-identity.spec.ts` / `funding-opportunity-inbox.spec.ts:1020–1035`):

```ts
const NEVER_A_RAIL = 'fpds';
test('the example used here is in no vocabulary, so it cannot become legal', () => {
  expect(INBOX_SOURCES as readonly string[]).not.toContain(NEVER_A_RAIL);
  expect(STORABLE_OPPORTUNITY_SOURCES as readonly string[]).not.toContain(NEVER_A_RAIL);
});
```

**Why it is durable this time and was not the previous two times:** `dibbs` and
`sbir_sttr` were both in `PLANNED_OPPORTUNITY_SOURCES` when they were chosen as the
"illegal" example — each existed precisely because a phase intended to make it legal.
`PLANNED_OPPORTUNITY_SOURCES` is now **exhausted**: all three of its members are live inbox
rails, so there is no planned source left that could quietly promote. The spec's own
comment says this and draws the right conclusion ("A PLANNED SOURCE IS NEVER A DURABLE
EXAMPLE OF AN ILLEGAL ONE").

The source-scanning tripwire is also intact and stronger than a name list. It pins the
*spread*, not the members:

```ts
expect(inboxSource).toMatch(
  /export const INBOX_SOURCES = \[\.\.\.OPPORTUNITY_SOURCES, 'agency_forecast', 'dibbs', 'sbir_sttr'\] as const;/,
);
```

The comment records that this assertion "has now failed-on-purpose three times, once per
rail" — which is the tripwire working as intended, not churn.

**Advisory (not a finding).** The spec describes `fpds` as "a real federal system this
program has never proposed ingesting". True for *this* program; not true of the repository.
`docs/plans/2026-06-29-meri-consolidated-command-architecture-plan.md:459` and
`docs/plans/2026-06-30-meriv2-technical-implementation-plan.md:420` both schedule a
`sync-fpds` verb under the **MeriV2** program. That does not make `fpds` legal here — FPDS
is retrospective *award* data, not an opportunity rail, so it has no path into
`INBOX_SOURCES` — and the `not.toContain` guard above fails loudly if it ever does. But the
comment's claim is about the whole codebase and is narrower than it reads. If a future
phase wants a bulletproof example, a string in no plan at all (`hhs_tagsys`, `nasa_sewp`)
would be stronger than one that appears in another program's ingestion schedule.

---

## Question 4 — does every rail have a real, distinct empty / error / stale state? **FAIL**

This is where the cluster does not meet its own P11 acceptance, and it fails in the exact
place today's live observation lands.

### B-1 (P1) — source-rail staleness is unrepresentable for 3 of the 5 rails

P11's acceptance is that an empty queue explains *whether no rows exist, profile data is
thin, source data is stale, or filters exclude results*. The "source data is stale" half is
delegated to `OpportunityFreshnessStrip`, which the inbox renders at line 281 from
`GET /api/intelligence/opportunities?pageSize=1&activeState=active`. That endpoint's
freshness array is built by `FundingOpportunitiesService.readFreshness()`
(`apps/api/src/funding-opportunities/funding-opportunities.service.ts:2071–2078`):

```ts
const rails: Array<{ source: OpportunitySource; verb: string; label: string }> = [
  { source: 'grants_gov', verb: 'sync-grants', label: 'Grants.gov opportunities' },
  { source: 'sam_gov', verb: 'sync-sam-opportunities-all-federal', label: '…' },
];
```

Two rails. `agency_forecast` (`sync-tango-forecasts`), `dibbs` (`sync-tango-dibbs`) and
`sbir_sttr` (`sync-tango-sbir`) are absent — and not merely omitted from a list, but
**excluded by the type**: `OpportunitySourceFreshness.source` is declared
`OpportunitySource` (`funding-opportunities.types.ts:221–222`), which is exactly
`'grants_gov' | 'sam_gov'`. Adding a third rail to the strip is a type change, not a list
edit. `neverSynced`, `lastRunStatus`, `lastFailureAt` and `hoursSinceLastSuccess` — the
whole "this rail is dead right now" vocabulary — therefore cannot be expressed for the
three newest rails.

The freshness *component* is not at fault: `OpportunityFreshnessStrip.tsx` maps whatever it
is handed and its colour rule is correct (an outright failed last run is red even when older
data exists). It renders three fewer tags because it is given three fewer facts.

Now compose that with the second half of the finding. `InboxEmptyState`'s source branch
(`FundingOpportunityInbox.tsx:925–933`) is unchanged P11-era copy:

```ts
} else if (source) {
  heading = `Nothing in ${INBOX_FILTER_LABELS[filter].toLowerCase()} on this source`;
  detail  = 'The source filter narrows this queue to one rail. The other rail is not counted here.';
```

Three problems in two sentences, all of which bite hardest on the three newest rails:

1. **"The other rail" is singular.** There were two rails when this was written; there are
   five now. P26, P41 and P43 each added a rail to the filter and none updated this
   sentence.
2. **It never names the filtered rail.** "this source" is as specific as it gets, so the
   message is byte-identical for Grants.gov, SAM.gov, DIBBS, forecasts and SBIR.
3. **It attributes the emptiness to the filter.** The branch fires *before* the
   `totalHere === 0` branch (946), and the API narrows the tab counts to the selected rail
   too (`funding-opportunity-inbox.spec.ts`, "the forecast narrowing applies to the tab
   counts too"). So a rail that has genuinely never been ingested produces "Nothing in
   needs review on this source / The source filter narrows this queue to one rail" plus a
   **Show all sources** button — which reads as *there is nothing on the DLA bid board for
   you*, a claim about the data, when the truth is *Capiro has never ingested the DLA bid
   board*. The one control that could correct the impression — the freshness strip — is
   structurally unable to mention that rail (above).

That composite is the UI half of the live symptom: a dropdown offering five rails, three of
which return nothing, and no surface anywhere on the page that can distinguish "empty" from
"never synced" for those three.

Two further gaps in the same acceptance line, both real but lower-severity because the
completion matrix's own P11 row already claims only the narrower four causes:

- **"profile data is thin" has no inbox branch at all.** The catalog response carries
  `emptyReason`, `emptyExplanation` and `missingProfileFields`
  (`funding-opportunities.service.ts:209–214, 265–266`); `InboxResponse`
  (`funding-opportunities-api.ts:631–656`) carries none of the three. The Explore view can
  say "your profile is too thin to match"; the inbox — the *default* surface — cannot.
- The `totalHere === 0` branch (950–952) says "the source rails **above** have not synced",
  pointing the reader at a strip that reports two of five rails. The sentence is true of
  what it can see and misleading about what it cannot.

**Not a finding:** the error and loading states are correct and well separated on every
surface. `fo-inbox-error` ("This is a request failure, not an empty inbox"),
`fo-inbox-loading`, the `countsUnavailableReason` warning, and the 404-vs-transport split
in both `FundingOpportunityDetail` and `ForecastOpportunityDetail` (only the transport case
offers Retry) are all present, distinct, and tested.

### B-2 (P2) — a fully-withheld page hides the pager, stranding every later page

`FundingOpportunityInbox.tsx` filters rows client-side at 267–269, then branches on
`visibleRows.length === 0` at 355. The `fo-pager` block — First page / Previous / **Next**
— lives only in the `else` branch at 447–481. So when a page of API results is *entirely*
forecast or SBIR rows and the corresponding flag is off:

- `visibleRows.length === 0` → the empty-state branch renders,
- the withheld notice correctly says "N rows not shown",
- and **there is no Next button**, even though `data.nextCursor` is non-null.

The remaining pages of that queue are unreachable through the UI. The reader is told the
queue is empty (or that another queue has work) while the server is holding a cursor to
rows that would render fine.

This is not hypothetical for a keyset walk: the API pages by `(sort, id)` without regard to
rail, so any tenant with a run of consecutive forecast or SBIR rows hits it. The existing
test for this shape (`FundingOpportunityInbox.test.tsx:761`, "with the flag OFF and ONLY
forecast rows, the withheld notice appears beside the empty state") asserts the notice and
the empty state and says nothing about the pager, so it passes over the defect.

### B-4 (P2) — DIBBS and SBIR rows have no path to the source record

Both cards define source links, and in both cards the links are nested *inside* the action
row, which the inbox structurally never renders:

- `DibbsOpportunityCard.tsx:282–300` — `documentUrl` ("Solicitation document") and
  `techDocsUrl` ("Technical documents") sit inside `{onPursue ? (…) : null}`.
  `DibbsInboxRow` deliberately does not pass `onPursue` (documented at
  `FundingOpportunityInbox.tsx:612–615`: no pursuit mutation is wired, and an absent handler
  removes the control rather than disabling it).
- `SbirOpportunityCard.tsx:298–324` — `topicUrl` ("Topic on the source") and
  `officialSolicitationUrl` ("Official solicitation") sit inside
  `{actions.length > 0 && onAction ? (…) : null}`. `SbirInboxRow` passes neither.

Combined with the (correct) fact that neither rail has a detail body — the drawer and the
full page both say "do not have a detail page yet" — a reader looking at a DIBBS line item
or an SBIR topic in the triage inbox **cannot reach the underlying record at all**. The
data to do so is on the wire (`InboxDibbsFacts.documentUrl`, `InboxSbirFacts.topicUrl`) and
is simply not rendered.

The two design rules being applied are each individually right ("an absent handler removes
the control", "a rail with no body says so rather than borrowing another's"). Their
composition produces a dead end that neither rule intends. The forecast rail avoids it only
because it *has* a body, whose Source-record card shows provenance and the agency's own id.

No test covers this: the card tests exercise the links only via `renderCard({ onPursue:
vi.fn() })` / `actions: […], onAction: vi.fn()`, i.e. only in a configuration the inbox
never produces.

### B-3 (P2) — the drawer's forecast branch skips the flag check the full page requires

`FundingOpportunityDetailPage` reads `FUNDING_OPPORTUNITIES_FORECASTS_FEATURE` and renders
a named `fo-forecast-not-enabled` state before touching the API, with an explicit rationale
at `FundingOpportunityDetail.tsx:540–548`:

> "Saying so up front is the difference between 'this workspace does not have agency
> forecasts' and 'that forecast does not exist'."

`FundingOpportunityDrawer.tsx` imports no flag hook at all. Its forecast branch (121)
renders `ForecastOpportunityDetail` unconditionally.

That branch is reachable with the flag off. `openRef` is decoded from `?detail=` at
`FundingOpportunityInbox.tsx:186` with no capability filtering — only *rows* are withheld
(267–269), not refs — and `decodeOpportunityRef` accepts any `INBOX_SOURCES` member. So a
shared link `…?detail=agency_forecast%3AFCST-1%3Aclient-1` opens the drawer for a tenant
without the flag, fires the forecast read, receives the API guard's 404, and renders:

> "Capiro holds no forecast with this id. The link may be stale, the agency may have
> removed the record, **or agency forecasts may not be enabled for this workspace**."

A three-way hedge, in the frame the reader is most likely to arrive in from a colleague's
link — precisely the presentation the full page's comment rejects. The full page has a test
for the flag-off case (`FundingOpportunityDetail.test.tsx:506`); the drawer has none.

Note the asymmetry is forecast-only: a `dibbs` or `sbir_sttr` ref in the drawer renders the
"no detail page yet" alert regardless of any flag, which is honest either way.

---

## Question 5 — does a component test render each of the 5 rails with realistic fixtures? **PARTIAL PASS**

The brief's hypothesis was that tests cover the 2 original rails and leave the newer 3
implicitly "should also work". **The opposite is true.** Four rails are rendered from
realistic fixtures with content assertions; the uncovered one is `grants_gov`, the oldest.

| Rail | Rendered as an inbox row from a fixture? | Where |
|---|---|---|
| `sam_gov` | yes | `FundingOpportunityInbox.test.tsx` — default `inboxRow()` fixture, ~15 tests |
| `grants_gov` | **no** | see **B-7** |
| `agency_forecast` | yes | `:703–873`, 11 tests + `ForecastOpportunityCard.test.tsx` |
| `dibbs` | yes | `:875–1055`, 12 tests + `DibbsOpportunityCard.test.tsx` |
| `sbir_sttr` | yes | `:1057–1178`, 11 tests + `SbirOpportunityCard.test.tsx` |

The assertions are specific and correct, not smoke tests: the forecast card is asserted to
state no deadline and no eligibility (`:820`); the DIBBS card is asserted to say no
part-level match was *attempted* rather than that the parts did not match (`:901`); the SBIR
card is asserted never to contain the word "eligible" and never to label an orphan topic
"SBIR". Each of the three non-catalog rails also has a drawer test proving it is not
rendered as one of the others (`:969`, `:1153`).

The full-page route is covered for all five (`FundingOpportunityDetail.test.tsx:491–560`),
including that a `dibbs`/`sbir_sttr` link says the *detail page* is missing and never that
the *source* is unknown, with `expect(apiGetMock).not.toHaveBeenCalled()` on both.

### B-7 (P3) — `grants_gov` is never rendered as an inbox row

The three `grants_gov` occurrences in `FundingOpportunityInbox.test.tsx` are: a freshness
fixture (`:180`), and a `?source=grants_gov` URL used by the source-filter empty-state test
(`:474–475`). No test ever puts `source: 'grants_gov'` on an `InboxRow`.

`InboxRowCard` has exactly one grants-specific behaviour —
`<Tag color={row.source === 'grants_gov' ? 'purple' : 'cyan'}>{INBOX_SOURCE_SHORT_LABELS[row.source]}</Tag>`
(`FundingOpportunityInbox.tsx:771–773`) — and it is unexercised. Low impact (a tag colour
and a label lookup that cannot fail, since `INBOX_SOURCE_SHORT_LABELS` is a total `Record`
over `InboxSource`), but it means the "2 original rails are well covered" assumption is
half wrong.

### B-6 (P3) — the web's `INBOX_SOURCES` mirror is pinned by nothing

`funding-opportunities-api.ts:373–379` declares the web's copy as a **flat literal**:

```ts
export const INBOX_SOURCES = ['grants_gov','sam_gov','agency_forecast','dibbs','sbir_sttr'] as const;
```

with the comment "Mirrors INBOX_SOURCES in apps/api's funding-opportunity-inbox.service.ts."
The API's is a **spread** — `[...OPPORTUNITY_SOURCES, 'agency_forecast', 'dibbs',
'sbir_sttr']` — and the API spec pins that spread by regex specifically because a
hand-kept copy "could drift from it".

A repository-wide `git grep` for `INBOX_SOURCES` at this SHA returns no hit in any file
under `apps/web/src/**/*.test.tsx`. The web mirror is exactly the hand-kept copy the API's
own guard exists to prevent, and it guards the value that
`decodeOpportunityRef`/`isInboxSource` use to decide which `?detail=` refs are legal.
Drift here would silently make a rail's deep links undecodable (drawer stays closed) with
no failing test anywhere.

### B-5 (P3) — the inbox list keeps the negative-fallback polarity D-67 removed

The row dispatch at `FundingOpportunityInbox.tsx:392–445` is the mirror image of the drawer's:

```ts
if (isForecastRow(row)) return <ForecastOpportunityCard … />;   // 392
if (isDibbsRow(row))    return <DibbsInboxRow … />;             // 411
if (isSbirRow(row))     return <SbirInboxRow … />;              // 427
return <InboxRowCard … />;                                      // 438 — the catalog card
```

The catalog card is the **unnamed default**, not a named branch. This is precisely the
shape D-67 identified and removed from the drawer: *a boolean whose meaning silently
changes while its value stays "correct"*. A sixth rail added to `INBOX_SOURCES` would fall
through to `InboxRowCard` and be rendered with a Deadline row, an Eligibility row
("Not evaluated") and a Relevance row — the same class of mis-render as showing a DIBBS
line item as an agency forecast, and with no compiler error, because `InboxRowCard` takes
`InboxRow` (whose `source` is the *wide* `InboxSource`) rather than a narrowed type.

Two mitigations keep this at P3 rather than higher: `sbir_sttr` is documented as "the LAST
planned source" and `PLANNED_OPPORTUNITY_SOURCES` is exhausted, so no sixth rail is in
flight; and the API-side tripwire guarantees that adding one requires a visible edit to the
file guarding the catalog boundary. But the fix's own stated principle — "every rail must be
NAMED to get a body; an unnamed one renders 'no view for this rail'" — was applied to the
drawer and the full page and **not** to the list, which is the surface a reader actually
spends their time on. `InboxRowCard`'s own comment at 765–770 shows the author was aware the
row type "admits three rails now" and chose a safe *label lookup* rather than a safe
*dispatch*.

The cheap version of the fix (not applied here, per instructions) is the same one the
detail frames use: take `CatalogOpportunityRef`/a narrowed row in `InboxRowCard`, and end
the chain with a named `SourceFactsMissingCard`-style "no card for this rail" branch. The
drawer's own `fo-drawer-no-detail` fallback is the template — though note (**B-8**) that
that fallback has zero test coverage; nothing renders it because all five rails are named,
which is correct but means the safety net itself is unverified.

---

## What was checked and found sound (not findings)

Recorded so a later reader does not re-derive them:

- **URL as the source of truth.** Filter, source, cursor, client and `?detail=` all live in
  the URL; the drawer is rendered outside the row branch (`:490`) so a refetch returning no
  rows cannot slam shut a record somebody is reading. Back closes the drawer.
- **Stale flagged deep links degrade widest-first.** `?source=agency_forecast` /
  `?source=sbir_sttr` with the flag off fall back to *all sources* rather than to an empty
  list, via `readEnum` over a flag-conditional accepted set (`:170–179`). Tested both ways
  for both rails.
- **`?view=inbox` with the inbox flag off falls back to Explore** rather than 404
  (`FundingOpportunitiesPage.tsx:70–72`), so no bookmark breaks on rollback.
- **The ref carries the ROW's client, not the page filter** (`:378–383`), which is the
  correct identity for a cross-client queue; tested at `:634`.
- **Counts of `-1` render as `?`, never `0`** (`formatInboxCount`), and the empty state
  refuses to claim there is no work when counts are unreadable (`:913–916`).
- **P33 / P34 are catalog-scoped by construction, honestly.** `GovernmentLandscapePanel`,
  `OpportunityActionPlan`, `OpportunityAssessmentPanel` and `MeriOpportunityAssessment` are
  mounted only inside `FundingOpportunityDetail`, which takes `CatalogOpportunityRef` — so
  the compiler, not a convention, keeps them off the other three rails. `GovernmentLandscapePanel`
  narrows further to `sam_gov` with a stated sentence for the grant case, separates
  `not_wired` from `empty` ("Nothing here says none exist" vs "Capiro looked and found
  nothing"), and separates a request failure from an absence of context. The forecast rail's
  own body has its own five sections rather than borrowing these — correct, since a forecast
  has no acquisition position or requirements to compose against.
- **Untrusted source text is rendered as prose, never interpreted**, with an explicit
  comment to that effect in both detail bodies.
- **Date handling.** `formatSourceDate` is used for every date-only column on every rail
  (`closesDate`, `closeDate`, `openDate`, `anticipatedAwardDate`), so a bid closing on the
  30th is the 30th west of Greenwich. No `new Date()` on a `YYYY-MM-DD` value in any card.

---

## What would move this to `BAND_B_UI_TRIAGE_INDEPENDENTLY_APPROVED`

In severity order. None of these were applied — this review is read-only.

1. **B-1.** Widen `OpportunitySourceFreshness.source` beyond `OpportunitySource` and add the
   three Tango verbs (`sync-tango-forecasts`, `sync-tango-dibbs`, `sync-tango-sbir`) to
   `readFreshness()`'s rail list, so `neverSynced` is expressible for all five rails. Then
   rewrite `InboxEmptyState`'s source branch to name the filtered rail
   (`INBOX_SOURCE_SHORT_LABELS[source]`), drop the singular "the other rail", and — when the
   strip reports that rail as `neverSynced` — say *that* instead of blaming the filter. Add a
   test per non-catalog rail, mirroring the existing `?source=grants_gov` one.
2. **B-2.** Render `fo-pager` whenever `data.nextCursor` is non-null, including in the
   `visibleRows.length === 0` branch. Extend the `:761` test to assert Next is present and
   enabled when a fully-withheld page has a next cursor.
3. **B-3.** Give `FundingOpportunityDrawer` the same `FUNDING_OPPORTUNITIES_FORECASTS_FEATURE`
   check the full page has, rendering the named not-enabled alert before
   `ForecastOpportunityDetail` mounts. Add the drawer twin of
   `FundingOpportunityDetail.test.tsx:506`.
4. **B-4.** Surface `documentUrl` / `techDocsUrl` / `topicUrl` / `officialSolicitationUrl`
   outside the action-row conditional in both cards (or add them to the two `*_NO_DETAIL_*`
   alerts), so a rail with no detail body still reaches its source record. Assert them in the
   inbox tests, not only in the card tests' `onPursue`/`onAction` configurations.
5. **B-5.** End the inbox row dispatch with a named branch rather than the catalog card, and
   narrow `InboxRowCard`'s prop so the compiler enforces it — the same move `asCatalogRef`
   made for the detail frames.
6. **B-6.** Add a web-side test pinning `INBOX_SOURCES` (and ideally deriving it from a
   spread of the web's catalog vocabulary, as the API does), so the mirror cannot drift
   unobserved.
7. **B-7 / B-8.** Add a `grants_gov` inbox row fixture; add a test for the drawer's
   unnamed-rail fallback; make `drawerTitle`'s default consistent with a body that says
   there is no view for the rail.

---

## Approval record

**Verdict: `BAND_B_UI_TRIAGE_REJECTED`** — 2026-08-13, by an independent agent who did not
implement or deploy any phase of this program, reviewing commit `d800dcfde5` read-only.

Questions 1, 2 and 3 pass: the D-67 dispatch fix held and generalised to all five rails in
both detail frames; SBIR received the full three-state / per-rail-withheld treatment rather
than a shortcut; `fpds` is illegal on every vocabulary and the self-guard that keeps it that
way is present and correct.

Question 4 fails on **B-1** (rail staleness is unrepresentable for `agency_forecast`,
`dibbs` and `sbir_sttr` because `OpportunitySourceFreshness.source` is typed to the two
catalog rails, compounded by a source-filter empty state that still speaks P11's two-rail
sentence, never names the rail, and attributes a never-synced rail's emptiness to the
filter) and on **B-2** (a fully-withheld page suppresses the pager, stranding later pages),
with **B-3** and **B-4** as further P2s. Question 5 passes for four of five rails and fails
for `grants_gov` (**B-7**), alongside an unpinned web `INBOX_SOURCES` mirror (**B-6**) and
the list dispatch's retained negative fallback (**B-5**).

All 445 tests under `apps/web/src/pages/intelligence/opportunities` pass at this SHA. Every
finding above is a gap in what is asserted or in behaviour no test exercises — none is a
failing test.
