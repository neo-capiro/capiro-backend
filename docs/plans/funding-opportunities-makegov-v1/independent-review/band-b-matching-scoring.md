# Band B — matching / scoring producer cluster, independent §6.2 review

**Scope:** P01 (shared client-opportunity profile), P02 (UEI-first award-history
identity), P06 (deterministic recommendation contract), P23 (acquisition
position / vehicle fit), P25 (forecast recommendation), P41 (DIBBS relevance),
P43 (SBIR relevance) — with emphasis on the BOUNDARIES between them.

**Reviewer:** independent agent. Not the agent that implemented or deployed any
of P01/P02/P06/P23/P25/P41/P43. Read-only against the repository; the only
writes performed anywhere were into a throwaway Postgres database created for
this review and destroyed after it.

**Commit under review:** `d800dcfde5` (`feat(x-feed): configurable X Intelligence
dashboard feed (#948)`). Every file quoted below was read via
`git show d800dcfde5:<path>`; no working tree was consulted for source of truth.

**Verdict vocabulary** (following `docs/runbooks/phase-2-independent-live-validation.md`
§8, and the sibling Band A review's `FO_GA_…` shape) — exactly one of:

```
FO_GA_BAND_B_MATCHING_SCORING_INDEPENDENTLY_APPROVED
or
FO_GA_BAND_B_MATCHING_SCORING_REJECTED  (list every failing item)
```

---

## Verdict

**`FO_GA_BAND_B_MATCHING_SCORING_REJECTED`**

Two P1 findings, both proven by running the real producers end-to-end against a
real Postgres seeded from the repository's own real capture fixtures — not
inferred from reading:

- **B-1** — P41's only live floor-clearing signal is **not scoped to the item
  being scored**. Every open DIBBS bid-board item in the corpus becomes a
  `pursue`, floor-clearing suggestion for any client whose CAGE has ever won any
  DLA award. Measured: **10 of 10** items (100% of the corpus) for one client.
- **B-2** — P43's only live floor-clearing signal is **structurally unreachable
  with real data**. The real SBIR source publishes agency as the acronym `DOD`;
  `federal_award` stores agency as `Department of Defense` / `DEPT OF THE NAVY`.
  `normAgency` normalizes but does not expand acronyms, so `priorAgencyHistory`
  is permanently `false`. Measured: a realistic UEI-backed client with genuine
  prior DoD contract history produced **zero** rows; an otherwise identical
  client whose award row literally reads `'DOD'` produced 5.

These are opposite failure modes of the same boundary class — a signal that fires
on everything, and a signal that can never fire — and they sit either side of the
same `clearsSuggestionFloor` gate. Neither is caught by the existing tests,
because in both cases the test fixture supplies the signal as a hand-set boolean
(P41/P43 unit specs) or as a value shaped unlike the real source (P43 producer
spec). Approval is not available while either stands.

Nothing in this review requires reverting merged work. Both are contained
corrections inside a producer, and both are currently latent on `capiro-dev`
because the sync→producer schedule chain ships disabled (decision-log D-79).

---

## How the live verification was done

Because both scorers are pure functions over caller-established booleans, reading
them proves almost nothing about whether they ever fire. The interesting code is
the **producers' signal derivation**, so this review ran the real producers.

- Disposable Postgres (`pgvector/pgvector:pg16`, container `fo-review-pg`, port
  55439, database `fo_review`), created for this review and torn down after. The
  shared `capiro-postgres` container was not touched, and no AWS resource was
  touched at all.
- Seeded from the repository's own real capture fixtures at the pinned commit —
  `apps/api/src/external/tango/__fixtures__/real-captures/dibbs-contract-capture-2026-08-09.json`
  (5 RFQs, 5 RFPs, 5 awards) and `…/sbir-contract-capture-2026-08-09.json`
  (5 topics, 5 cycles). Real public federal records, not synthetic ones.
- Three realistic client profiles with NAICS, PSC, capabilities, facilities, a
  verified UEI, and (for one) a real CAGE taken from a real award in the DIBBS
  capture.
- The **real exported** `generateDibbsCandidates` / `generateSbirCandidates` were
  invoked directly, through a `pg`-backed adapter satisfying the duck-typed
  Prisma slices those producers declare. So the real `hasPriorCageAward` SQL, the
  real `readAwardHistoryByBasis` SQL, the real `resolveContractorUeis` join, the
  real `buildAwardHistoryIdentity`, the real `buildClientOpportunityProfile`, the
  real scorers and the real `decideProducerAction` all executed.
- Two passes: one with capture dates verbatim, one with close dates shifted +90
  days so the corpus is open relative to the run clock (the RFQs' real
  `return_by_date` of 2026-08-11 has passed). The shift touches dates only;
  every other field is the captured value.

The harness was deleted after the run and nothing was staged or committed.

Shared-profile state as the producers actually saw it (all three clients):

```
cli-0001-mfg:      basis={"contract":"exact_uei","assistance":"exact_uei"} tooThin=false
   sam.priorAgencies = ["Department of Defense","DEPT OF THE NAVY"]
cli-0002-autonomy: basis={"contract":"exact_uei","assistance":"exact_uei"} tooThin=false
   sam.priorAgencies = ["Department of Defense","DEPT OF THE NAVY"]
cli-0003-dodliteral: basis={"contract":"exact_uei","assistance":"exact_uei"} tooThin=false
   sam.priorAgencies = ["DOD"]
```

`profileIsTooThin` is a six-way conjunction
(`apps/api/src/funding-opportunities/missing-profile-fields.ts`) and correctly
returned `false` for every realistic profile — it is **not** a cause of missing
rows, and that hypothesis can be closed.

---

## Findings, severity-ranked

### B-1 · P1 · P41's prior-CAGE signal is client-level, not item-level — every open DIBBS item becomes a `pursue`

`scoreDibbsRelevance` treats `priorCageAwardHistory` as a Rule 4 **strong**
signal: it alone produces `machineRecommendation: 'pursue'` and
`clearsSuggestionFloor: true`
(`apps/api/src/funding-opportunities/dibbs-relevance.ts:276-289`). Its own
`primaryReason` for that branch reads:

> `"A prior DLA award to this client's own CAGE code on this kind of item."`
> — `dibbs-relevance.ts:284`

The producer establishes that boolean with a query that has **no item predicate
at all** — no NSN, no part number, no nomenclature:

```sql
-- apps/api/scripts/generate-dibbs-opportunity-candidates.ts:284-294
SELECT 1 AS hit
FROM tango_dibbs_award
WHERE upper(trim(awardee_cage)) = $1
   OR upper(trim(awardee_cage_code)) = $1
LIMIT 1
```

and then caches the single boolean **per client**, reusing it for every
solicitation on every page (`priorCageByClient`, lines 389-401, consumed at
445/458). So the value fed into an item-level strong signal is really the
client-level fact *"this CAGE appears somewhere in the DLA award table."*

**Measured, against the real capture.** Client `cli-0001-mfg` carries CAGE
`81873` — taken verbatim from the real award in the fixture, `WOODWARD HRT INC`,
whose single prior award is `SHIPPING COVER, RPA, PLATE` (part `1730LN0035253`).
The producer created a floor-clearing `pursue` row for **all ten** open items:

```
evaluated=30 created=10 errors=0 solicitationsRead=10
  client cli-0001-mfg: 10 rows created
     score=60 item="DISK DRIVE UNIT"                     reasons=["prior_cage_award_history"]
     score=60 item="COUNTER AND CHUTE A"                 reasons=["prior_cage_award_history"]
     score=60 item="PLATE,CLAMP,GEARBOX"                 reasons=["prior_cage_award_history","capability_text_match"]
     score=60 item="ROPE,FIBROUS"                        reasons=["prior_cage_award_history"]
     score=60 item="SHIPPING AND STORAGE"                reasons=["prior_cage_award_history"]
     score=60 item="BATTERY ASSEMBLY"                    reasons=["prior_cage_award_history"]
     score=60 item="BOLT, MACHINE"                       reasons=["prior_cage_award_history"]
     score=60 item="PRODUCTION LOT TESTING (GOVERNMENT)" reasons=["prior_cage_award_history"]
     score=60 item="CONTRACTOR FIRST ARTICLE TEST"       reasons=["prior_cage_award_history"]
     score=60 item="SLING, MULTIPLE LEG"                 reasons=["prior_cage_award_history"]
```

An actuation-systems manufacturer is being told to **price and quote** fibrous
rope, machine bolts and multi-leg slings, with the stated reason that it has a
prior award "on this kind of item." It does not. The real DIBBS bid board carries
tens of thousands of open RFQs; the row count here is bounded only by the corpus
size times the number of clients with a CAGE.

This is the same defect class the program already named and rejected once:
`AwardHistoryFacts.contractOffices`
(`client-opportunity-profile.types.ts`) records an office signal that was fed the
awarding sub-tier "because that field was adjacent and available, which produced a
signal that fired on the wrong fact." `dibbs-relevance.ts`'s own file docblock
repeats that warning. The same mistake has recurred one boundary over — not in the
scorer, which is honest, but in the producer that establishes its input.

The internal inconsistency is worth being precise about, because it explains how
this passed review at each individual phase: `DibbsRelevanceInput`'s field comment
(`dibbs-relevance.ts:127`) describes the item-agnostic reading
("A `tango_dibbs_award` whose `awardeeCage`/`awardeeCageCode` is this client's own
recorded CAGE"), while the branch's own user-facing prose describes the
item-scoped one. The producer implemented the field comment. A single-phase
reviewer reading only P41 sees a consistent scorer; a single-phase reviewer
reading only the producer sees a faithful implementation of the field comment.

**Not a scorer bug.** `scoreDibbsRelevance` is correct given an item-scoped input.
The correction belongs in the producer (scope the award lookup to the
solicitation's NSN / part number, per `(client, item)` or via a batched
CAGE×NSN set) and in reconciling the two contradictory descriptions of what the
input means.

---

### B-2 · P1 · P43 can never clear the suggestion floor with real data — agency acronym vs. agency name

`scoreSbirRelevance` has exactly one live path to `clearsSuggestionFloor: true`:
Rule 5, `priorAgencyHistory && historyIsIdentifierBacked`
(`apps/api/src/funding-opportunities/sbir-relevance.ts`, Rule 5). Rule 4's two
structural signals are documented as dormant, and Rule 6 (capability text) is
weak by rule. The file's own analysis of this — the "five signals reduce to two
live, two dormant, one double-count" reading — is accurate and is the right call.

The producer establishes `priorAgencyHistory` as:

```ts
// apps/api/scripts/generate-sbir-opportunity-candidates.ts:432-453
const priorAgencies = new Set(profile.sam.priorAgencies.map(normAgency).filter(Boolean));
...
priorAgencyHistory: topic.agency != null && priorAgencies.has(normAgency(topic.agency)),
```

`normAgency` (`sam-opportunity-relevance.ts:241-248`) is a small closed set of
rewrites — case, `dept`→`department`, `hq`→`headquarters`, trailing parenthetical
dropped. It does **not** expand acronyms, by explicit design ("a near-miss is not
that evidence"). That design is right for the rail it was written for.

It is the wrong tool at this boundary, because the two sides speak different
vocabularies:

```
real SBIR topic agencies in the capture corpus: ['DOD']

normAgency("DOD")                    = "dod"
normAgency("Department of Defense")  = "department of defense"
normAgency("DEPT OF THE NAVY")       = "department of the navy"
```

`federal_award.awarding_agency` / `awarding_sub_tier` are USAspending-shaped and
never carry the acronym. `AwardHistoryFacts.contractAgencies`' own comment in
`client-opportunity-profile.types.ts` documents the SAM-side calibration
explicitly ("`sam_opportunity.agency` is sub-tier shaped ('DEPT OF THE NAVY')") —
which is exactly why it does not carry `DOD`. The set intersection is empty for
every real client against every real topic.

**Measured, against the real capture.** Two clients identical in every respect
except how their award row spells the agency:

```
--- P43 SBIR producer (real fixtures, real Postgres) ---
evaluated=15 created=5 errors=0 topicsRead=5
  client cli-0003-dodliteral: 5 rows created     <-- award row literally 'DOD'
     score=60 topic="Novel Technologies for CWMD and Related Threats"                reasons=["prior_agency_history"]
     score=60 topic="Dynamically Generated, Articulated 3-Dimensional Training…"     reasons=["prior_agency_history","capability_topic_match"]
     score=60 topic="Intelligent Tools for Naval Aircrew Performance and Readiness"  reasons=["prior_agency_history","capability_topic_match"]
     score=60 topic="High Performance Electrolytic Coating Touch-Up Repairs…"        reasons=["prior_agency_history"]
     score=60 topic="Ultra-Sensitive Quantum Telemetry Receiver"                     reasons=["prior_agency_history"]

  cli-0002-autonomy: 0 rows                      <-- award row 'Department of Defense' / 'DEPT OF THE NAVY'
```

`cli-0002-autonomy` is the realistic case: `identityBasis.contract = 'exact_uei'`,
genuine prior DoD contract history, capability text that matches two of the five
topic titles. It produced nothing, correctly by the scorer's own rules
(capability-only is below the floor) — but the one signal that *should* have
carried it never fired, and never can.

`cli-0003-dodliteral` exists only to isolate the variable, and confirms the
mechanism precisely: change nothing but the literal agency string on the award row
and the same client goes from 0 rows to 5.

**Consequence:** once the DIBBS/SBIR chain is enabled and ingestion has real data,
`client_funding_opportunity` will still hold zero `sbir_sttr` rows for every real
client. This is a direct, mechanical answer for the separate zero-rows
investigation and does not require waiting on the Tango rate-limit resolution
(D-76/D-77) to confirm.

**Why the tests do not catch it.** Every row-creating fixture in
`generate-sbir-opportunity-candidates.spec.ts` gives the topic a full agency
*name* — `agency: 'Defense Health Agency'` (topicRow default), and
`'Defense Health Agency (DHA)'` in the one test explicitly about agency
normalization ("agency names are compared normalized, not verbatim", ~line 363).
Both are shaped like a SAM notice's agency field, not like the SBIR source's. The
test that exists to guard this comparison is built on the one input shape that
cannot expose the problem.

---

### B-3 · P2 · Two different capability-text semantics inside the same signal name

The four scorers nominally share one signal — "the client's capability text
against the opportunity's text." Two incompatible implementations exist:

- **Forecast (P25)** — `containsWholeToken`
  (`forecast-opportunity-read.service.ts:222`): whole-token boundaries, refuses
  needles of ≤2 characters.
- **DIBBS (P41) and SBIR (P43)** — a bare `haystack.includes(needle)` substring
  test, duplicated **byte-for-byte** as a private `capabilityTextMatch` in both
  producers (`generate-dibbs-opportunity-candidates.ts:181` and
  `generate-sbir-opportunity-candidates.ts:181`).

Measured divergence:

```
kw="air"    text="AIRPORT SURVEILLANCE RADAR"     DIBBS/SBIR=true  forecast=false
kw="bolt"   text="BOLTED FLANGE ASSEMBLY"         DIBBS/SBIR=true  forecast=false
kw="rope"   text="EUROPEAN THEATER LOGISTICS"     DIBBS/SBIR=true  forecast=false
kw="plate"  text="TEMPLATE GENERATION SOFTWARE"   DIBBS/SBIR=true  forecast=false
kw="gear"   text="GEARBOX, REDUCTION"             DIBBS/SBIR=true  forecast=false
```

`rope` matching `EUROPEAN`, and `plate` matching `TEMPLATE`, are exactly the
false positives `containsWholeToken`'s docblock was written to prevent
("a client capability of 'air' must not match 'airport', 'repair' or
'millionaire'"). The DIBBS corpus in the real capture literally contains
`ROPE,FIBROUS`. The forecast rail solved this and the two newer producers did not
adopt the fix.

Consequence for cross-source comparison: `capability_text_match` /
`capability_topic_match` on a DIBBS or SBIR row is a materially weaker claim than
`capability_match` on a forecast row, while presenting under the same name and
the same `recommendationConfidence: 'low'` band. Today this only affects a
below-floor `monitor`, so it is P2 rather than P1 — but the duplication is also
the structural risk P01 was created to eliminate. P01's own docblock names the
failure mode precisely: *"`tags()` in the grant producer and `stringTags()` inside
`shapeClientRelevanceProfile` are byte-identical implementations, so the grant
profile matched"* — until one of them changed. There are now three copies of the
capability-text comparison and they have already diverged.

---

### B-4 · P2 · A third `normAgency`, whose own docblock describes behaviour it does not have

`forecast-opportunity-read.service.ts:261` defines a **private** `normAgency`
rather than importing the exported one. Its docblock claims parity:

> "The same closed set of rewrites `normAgency` applies on the SAM rail
> ("dept" → "department", "hq" → "headquarters", **a trailing parenthetical
> dropped**)"

It does not drop the trailing parenthetical. Its local `norm` collapses
`[^a-z0-9]+` to spaces *before* the parenthetical-stripping regex runs, so by the
time `/\s*\([^)]*\)\s*$/` is applied there are no parentheses left and the rule is
a no-op. The exported SAM `normAgency` uses a `norm` that only lowercases and
trims (`sam-opportunity-relevance.ts:220-222`), so its strip does fire.

Measured, against prior agencies `['Defense Health Agency', 'Department of the Navy']`:

```
"DEFENSE HEALTH AGENCY (DHA)"   SAM=true   forecast=false   <-- DIVERGES
"DEPT OF THE NAVY"              SAM=true   forecast=true
"Defense Health Agency"         SAM=true   forecast=true
```

The SAM `normAgency` docblock cites `'DEFENSE HEALTH AGENCY (DHA)'` as a real
observed value from `capiro-dev`, so this is not a hypothetical string. Two rails
consuming the **same** `profile.sam.priorAgencies` from the **same** P01 profile
give different answers to "does this client have prior history with this agency" —
which is the read-time/producer profile drift P01 exists to prevent, reappearing
one layer above the profile.

---

### B-5 · P2 · `relevanceScore` means two different things across sources, in one column

`relevanceScore` on `client_funding_opportunity` is surfaced to the inbox
(`funding-opportunity-inbox.service.ts:932`). It carries:

- **SAM / grants** — a genuine weighted score,
  `Math.round((earned / MAX_SCORE) * 100)` (`sam-opportunity-relevance.ts:446`),
  continuous over 0-100.
- **DIBBS / SBIR** — a three-valued confidence proxy,
  `{high: 90, medium: 60, low: 30}`, identical constants in both producers.

Every row created in both live runs above scored exactly `60`, because the only
reachable floor-clearing branch in each is a `'medium'` one. A reader comparing a
DIBBS `60` against a SAM `60` is comparing a bucket label to a measurement.

Mitigating: the inbox sorts by deadline/`updatedAt`, never by `relevanceScore`
(`funding-opportunity-inbox.service.ts:789-832`), so this does not currently
corrupt ranking — it is a display and `--min-relevance` filtering concern. The
confidence→score bridge itself is well-reasoned and correctly test-pinned in both
producer specs; the gap is that nothing marks the resulting number as
non-comparable across sources.

---

### B-6 · P3 · Latent double-count in P41, and one reason-code-level one that is live

Answering the P43-analogue question directly: **P41 has no live double-count.**
Only one live signal reads text (`capabilityTextMatch` against `nomenclature`), so
there is no live pair that is two sides of one comparison. The `sbir-relevance.ts`
analysis that collapsed "reviewed capabilities" and "topic keywords" into one
signal has no live equivalent here. Two latent ones exist:

1. **`exactNsnMatch` / `exactPartNumberMatch`** — an NSN and a manufacturer part
   number are two identifiers for the *same* line item, and a client part
   catalogue that recorded one would typically record both. This *is* the P43
   shape. The **outcome** logic already handles it correctly: line 279 collapses
   them into a single `partLevel` boolean, so confidence cannot be inflated by
   firing both. But both push separate entries into `reasonCodes` (lines
   247-248), which are persisted verbatim into `matchSignals` as the row's entire
   evidence record — so the evidence display will double-count one part identity
   as two findings. Cosmetic today (both dormant), and worth fixing before a
   client part store lands.

2. **`priorCageAwardHistory` / `buyerHistory`** — both can only ever be derived
   from `tango_dibbs_award`, the one DIBBS table recording who transacted with
   whom, keyed on the same client CAGE. If `buyerHistory` is ever implemented it
   will necessarily read the same rows as the CAGE check, making them two views
   of one comparison — and, worse, the rule chain places one in the **strong**
   bucket (Rule 4) and the other in the **weak** bucket (Rule 5), so a single
   underlying fact would supply evidence at two different strengths. Dormant
   today; flagged so the phase that makes it live starts from this.

---

### B-7 · P3 · The brief's "all four scorers share `recommendationConfidence` + `clearsSuggestionFloor`" premise is false, and two of the four legitimately differ

Recording this as a finding about the *convention*, not about the code, because
the mismatch is easy to read as a defect and mostly is not one:

| module | `machineRecommendation` | `recommendationConfidence` | `clearsSuggestionFloor` |
|---|---|---|---|
| P06 `recommendOpportunity` | yes | yes | **no** |
| P23 `computeAcquisitionPosition` | **no** (returns `state`) | **no** | **no** |
| P25 `scoreForecastRelevance` | yes (+`forecastRecommendation`) | yes | **no** |
| P41 `scoreDibbsRelevance` | yes | yes | yes |
| P43 `scoreSbirRelevance` | yes | yes | yes |

- **P23 is not a relevance scorer** and should not be held to the convention. It
  computes a client's own vehicle-access posture as a six-state truth table, does
  not consume `ClientOpportunityProfileV1` at all, and correctly does not need to
  — it reads P22 vehicle rows, not client profile facts. Its exclusion from P01 is
  right, not drift.
- **P25 has no floor because it writes no rows.** `forecast-opportunity-read.service.ts`
  is a read path only, by its own explicit statement; there is no forecast
  producer. Adding a floor with no producer to consume it would be dead surface.
- **P41 and P43 are genuinely consistent with each other**, and this is worth
  saying plainly since it is the part the brief was most concerned about. Both
  use `high` = two independent strong facts, `medium` = one strong fact, `low` =
  vocabulary-only or unanswerable, and `high` for confident negatives (closed /
  no-evidence). Both keep `clearsSuggestionFloor` as a stated field rather than
  inferring it from the recommendation, for the same documented reason. Both hold
  the invariant "`clearsSuggestionFloor: true` never co-occurs with confidence
  `'low'`", and both pin it with a dedicated producer-spec test. A `'high'` from
  P41 and a `'high'` from P43 are comparably strong claims. **The confidence
  vocabulary is sound; the problem is entirely in what feeds it** (B-1, B-2).

---

## Answers to the five review questions

**1. Does every later scorer consume P01's shared builder?** — **Yes, with one
documented exception whose consequence is undocumented.**
All five call sites route through `buildClientOpportunityProfile` +
`buildAwardHistoryIdentity` + `readAwardHistoryByBasis`: the read service
(`funding-opportunities.service.ts:1092-1105`), the forecast read service
(`forecast-opportunity-read.service.ts:690-703`), and the grant, SAM, DIBBS
(`generate-dibbs-opportunity-candidates.ts:391-395`) and SBIR
(`generate-sbir-opportunity-candidates.ts:359-363`) producers. No scorer
re-derives NAICS, PSC, capabilities, facilities or agency history independently.
P01 held.

The exception is P41's CAGE rail, which reads `client.cageCode` directly and issues
its own raw-SQL award lookup. Decision-log D-79 states this deliberately
("colocated with that producer since it doesn't fit the UEI/name-shaped
`AwardHistoryFacts` type") and that reasoning is sound — P02 has no CAGE rail.
What is not documented is the consequence: **`profile.identityBasis` does not
describe how DIBBS award evidence was obtained.** A surface rendering
"matched on your UEI" from `identityBasis.contract` would be making a false
claim about a `prior_cage_award_history` row. Severity is contained because the
CAGE path is *stricter* than P02 (first-party CAGE only; no mappings, no name
fallback, no fuzzy tier), so it cannot attribute another company's awards. See
also B-4, where the drift P01 prevents at the profile layer has reappeared one
layer above it.

**2. Do all four scorers use the same confidence/floor vocabulary?** — **P41 and
P43 do, and are genuinely cross-comparable. P23 and P25 do not, and for both the
difference is correct rather than drift.** Detail and the full matrix in B-7. The
real cross-source comparability problems are elsewhere: two different
capability-text semantics under one signal name (B-3) and two different meanings
for `relevanceScore` in one column (B-5).

**3. Do P41 and P43 route award-history identity through P02?** — **P43 yes,
P41 partially.**
P43 reads `profile.sam.priorAgencies` (P02-basis-gated, one query per rail, never
an OR) and gates strength on `profile.identityBasis.contract === 'exact_uei'`
(line 435) — a textbook consumption of P02, and its "name-derived history does not
clear the floor" rule is exactly what P02 was built to make expressible. P41 uses
P02 for `profileTooThin`/`completeness` but establishes its actual strong signal
outside it, via the client's own CAGE. That bypass is defensible (see Q1); its
undocumented consequence is the `identityBasis` gap above, and its real problem is
B-1, which is about item scope rather than identity strength.

**4. Does P41 have P43's double-counting mistake?** — **Not live. Two latent
instances, one of which is already correctly collapsed in the outcome logic but
not in the persisted evidence.** Full detail in B-6.

**5. Are there real tests asserting specific confidence/floor outcomes?** —
**Yes for all four at the pure-scorer layer; no for the layer that actually
decides whether rows exist.**

The pure-scorer specs are strong, not "returns without throwing". Concretely:
`dibbs-relevance.spec.ts` asserts `machineRecommendation === 'pursue'` and
`clearsSuggestionFloor === true` for NSN and part-number matches, `'monitor'` /
`false` / `'low'` for capability-text-only, `'medium'` vs `'high'` for the
part-level + CAGE combination, and that `primaryReason` matches `/vocabulary
match/i`. `sbir-relevance.spec.ts` asserts identifier-backed history clears the
floor at `'medium'` while name-derived history does not and is `'low'`, checks
`actions` arrays exactly, and deliberately uses a mid-day `asOf`
(`2026-03-10T14:37:11Z`) after the P41 midnight-fixture date bug.
`forecast-relevance.spec.ts` covers the truth table and order-independence.
`acquisition-position.spec.ts` covers all six states plus precedence.
Both producer specs pin the "`clearsSuggestionFloor: true` never pairs with
`'low'`" bridge invariant with `test.each` over the floor-clearing combinations.

The gap is that **every one of those tests supplies the signals as hand-set
booleans**. Not one test establishes a signal from realistic source data and then
asserts a floor outcome. That is precisely the seam both P1 findings live in:

- B-1 is invisible because no test asserts *how many* rows one prior CAGE award
  produces. The nearest test, "CAGE history is read ONCE per client, never once
  per solicitation", runs three solicitations and asserts `cageQueries` has length
  1 — it asserts the query-count optimization and never looks at `r.created`,
  which would have been 3. The fixture comment even states the mechanism plainly
  ("prior CAGE award history is the ONLY signal that can clear the suggestion
  floor, so a 'happy path' fixture needs one") without anyone noticing that it
  therefore clears the floor for *everything*.
- B-2 is invisible because the producer spec's topic agency is a full agency name
  in every fixture, so the acronym case is never exercised.

**Recommended guard for the queue:** one test per producer that seeds the real
capture fixtures (`__fixtures__/real-captures/`), runs the real
`generate*Candidates`, and asserts a specific `created` count and specific
`reasonCodes` — not a threshold, an exact expectation. Both P1 findings fall out
of such a test on the first run; that is how they were found here.

---

## What was checked and found sound

Recorded so a re-reviewer does not redo it:

- **P01's builder and repository.** Single `CLIENT_PROFILE_SELECT` shared by all
  callers; grant shaping delegated to District Nexus rather than reimplemented;
  fingerprint canonicalized with sorted keys, excluding `completeness` and any
  local clock; `identityBasis` folded into the fingerprint. The transaction
  ownership split (caller owns the tenant transaction; award history read
  separately and outside it) is correct and its rationale documented.
- **P02's identity rules.** Rail-level exclusivity is implemented as specified —
  a verified UEI on either rail suppresses *all* names on that rail, including
  names from sibling mappings with no UEI of their own. `nameIsUsable` rejects
  unrecorded and fuzzy bases and tier ≥ 4. `contractorIdsToResolve` filters
  non-UUIDs before the `::uuid[]` cast, and the stated reason (22P02 aborts the
  whole statement, killing the run for every tenant, not just that client) is
  correct. `readAwardHistoryByBasis` issues exactly one query per rail keyed on
  the selected basis, never an OR. Verified live: all three seeded clients
  resolved to `exact_uei` on both rails and the assistance/contract rails stayed
  separate.
- **P06's rule ordering.** First-match-wins over an eight-rule ordered list, with
  the two hard invariants (closed and informational can never be `pursue`) sitting
  first so nothing later can override them. The P23 override is correctly
  restricted to intercepting only the Rule 7 `pursue` outcome. `asOf` is the
  caller's clock throughout; no `new Date()` in the module.
- **P41/P43 calendar-day arithmetic.** Both use `startOfUtcDay` on both operands,
  correctly fixing the "closed on its final biddable day" bug the P41 docblock
  documents. `isClosed`/`isTopicClosed` check both the provider's stated status and
  a genuinely-past date; `CLOSED_STATUS_WORDS` is a closed set compared exactly,
  not a substring test, so "Closing Soon" is not read as "Closed". Verified live:
  the unshifted pass correctly excluded the five RFQs whose real
  `return_by_date` had passed, keeping the five RFPs.
- **Dormant-signal discipline.** Every dormant input is passed a literal `false`
  by its producer with an inline comment naming why, never a lookalike. This is
  the discipline `AwardHistoryFacts.contractOffices` exists to enforce and it is
  observed everywhere it was checked.
- **`decideProducerAction`.** Human decisions and `userCreated` rows are protected
  before any floor test; `staleAt` marks rather than deletes; `qualifies` requires
  both the boolean floor and the numeric floor.
- **Structural containment of DIBBS awards.** `DibbsPursuableDocumentType` admits
  only `'rfq' | 'rfp'`, so an award is not a value `scoreDibbsRelevance` can be
  called with, and `describeDibbsAwardIntelligence` has no recommendation field for
  a `pursue` to occupy. Enforced by type, not by a filter. Verified live: created
  rows keyed on solicitation uuids only.
- **RLS idiom.** Both producers run every tenant-table read and write inside
  `withBypass` *and* carry an explicit `tenantId` predicate; global Tango and
  federal reference tables are read directly. Consistent across both.
- **`profileIsTooThin`.** A six-way conjunction, correctly forgiving. Returned
  `false` for every realistic profile in the live run. Not a cause of missing rows.

---

## Cleanup performed

- Postgres container `fo-review-pg` and database `fo_review` destroyed.
- Review harness files removed from `C:\dev\capiro-fo-ga-review-wt`.
- Nothing staged, committed, pushed, or deployed. No AWS resource touched. The
  `C:\dev\capirov2` working tree was not modified — all source was read via
  `git show d800dcfde5:<path>`.

---

## Approval record

**Verdict: `FO_GA_BAND_B_MATCHING_SCORING_REJECTED`** — 2026-08-13, by an
independent agent (not the agent that implemented P01/P02/P06/P23/P25/P41/P43 or
wired the DIBBS/SBIR producers).

Rejected on **B-1** and **B-2**, both P1, both demonstrated by executing the real
producers against a real Postgres seeded from the repository's own real capture
fixtures rather than by reading:

- **B-1** — `generate-dibbs-opportunity-candidates.ts`'s `hasPriorCageAward` has no
  item predicate and is cached per client, so P41's only live floor-clearing
  signal fires on 100% of the open corpus for any client with a CAGE that has ever
  won any DLA award. Measured 10/10 items, including fibrous rope and machine
  bolts recommended to an actuation-systems manufacturer with the stated reason
  "prior DLA award … on this kind of item."
- **B-2** — `generate-sbir-opportunity-candidates.ts` compares the SBIR source's
  agency acronym (`DOD`) against USAspending-shaped award agency names
  (`Department of Defense` / `DEPT OF THE NAVY`) through a `normAgency` that
  deliberately does not expand acronyms, so P43's only live floor-clearing signal
  can never fire. Measured: realistic UEI-backed client with genuine prior DoD
  history → 0 rows; identical client whose award row literally reads `'DOD'` → 5
  rows.

Four P2/P3 findings recorded for the queue and not blocking on their own: B-3
(two capability-text semantics under one signal name, with `rope`→`EUROPEAN`-class
false positives on the DIBBS/SBIR side), B-4 (a third private `normAgency` whose
docblock describes a rewrite it does not perform), B-5 (`relevanceScore` carrying
a weighted 0-100 measurement for SAM/grants and a three-valued bucket for
DIBBS/SBIR in the same column), B-6 (two latent double-counts in P41, one already
collapsed in outcome logic but not in persisted evidence).

P01, P02, P06, P23 and P25 are individually sound; every finding above sits on a
boundary between phases rather than inside one. The confidence vocabulary shared
by P41 and P43 is consistent and cross-comparable — the defects are entirely in
what feeds it.

**Note on the brief's own premise:** the framing that all four scorers should
carry `recommendationConfidence` + `clearsSuggestionFloor` does not hold for P23
(a client-posture truth table, not a relevance scorer, correctly outside P01) or
P25 (a read path with no producer, so a floor would be dead surface). Neither is
drift, and neither is counted against the verdict.

**Bearing on the separate zero-rows investigation:** B-2 is a sufficient,
mechanical explanation for zero `sbir_sttr` rows that holds independently of the
Tango rate-limit blockage (D-76/D-77) and of the schedule chain shipping disabled
(D-79). It should be treated as confirmed rather than as a hypothesis awaiting
live data. B-1 predicts the opposite for `dibbs` — not zero rows but a fan-out
across the entire open corpus — the moment that producer is enabled with real
ingested data.
