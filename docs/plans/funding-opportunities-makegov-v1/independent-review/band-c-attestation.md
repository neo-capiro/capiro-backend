# Band C — attestation-only pass: P00 and P09

**Reviewed:** 2026-08-13, by an independent reviewer not involved in implementing,
reviewing, or deploying any phase of this program.

**Pinned to:** `d800dcfde51f6cf21a4b54b511006b9001fd6d2b` (`main`, 2026-08-13 16:40
-0400, "feat(x-feed): configurable X Intelligence dashboard feed (#948)"). Every
citation below is `git show d800dcfde5:<path>` or a diff between commits reachable
from that SHA — no working-tree read, no AWS call, no DB read, no mutation.
Repo: `C:\dev\capirov2` (its working tree carries unrelated uncommitted work from
another task and was not touched). Output written to the separate worktree
`C:\dev\capiro-fo-ga-review-wt`, not committed.

**Scope and bar, stated per the assignment:** this is Band C, not §6.2. One question
per phase — *does this phase's diff change any runtime behavior at all, or is it
genuinely inert?* — not a correctness review of what the phase does. Precedent for
the verdict-string/approval-record convention: `docs/runbooks/phase-2-independent-live-validation.md`
§8, and this program's own `band-a-p51-ga-closeout.md` in this same directory.

---

## Verdicts

```
P00_BAND_C_ATTESTATION_CONFIRMED_INERT
P09_BAND_C_ATTESTATION_CONFIRMED_PRESENTATION_ONLY
```

Both phases are genuinely inert/presentation-only as claimed. No finding requires
escalating either to a real (Band A/B-style) review.

| Phase | Verdict | One-line reason |
|---|---|---|
| P00 | **Genuinely inert** | Zero production code files in the diff; only docs, one fixture, one spec, and a CI floor-bump comment. |
| P09 | **Genuinely presentation-only** | New label/sort modules operate only on already-computed `strength`/`matchedOn` fields; the API module has zero callers; the scorer, recommendation, and eligibility files are absent from the diff entirely. |

---

## Method note: isolating each phase's actual diff

The completion matrix lists the same merge SHA (`21d267db`, PR #769) for P00 through
P10 — that PR bundled eleven phases' commits into one merge. The individual
per-phase commits survive on the merged-in side of history, so each phase's own
diff is isolable directly, not just inferable from the combined PR:

```
$ git log --oneline 86f78beecbca310570a7645761c577a3a342648d..1774c9ad54160b5c0665cc0deaf603668334b3b6
1774c9ad5 feat(funding-opportunities): P10 — cross-client triage API
8c432a54b feat(funding-opportunities): P09 — human-readable match explanations
0fd4e819d feat(funding-opportunities): P08 — atomic review/pursuit task action
...
0e4a73726 chore(funding-opportunities): P00 — freeze the baseline and the release gate
```

P00 = commit `0e4a737267cb350850470fe0fb9548f6d87d898b`.
P09 = commit `8c432a54b33c59effbe0845c6061466ac7c4426e`.
All evidence below is `git show <that exact commit>`, not the combined PR diff.

---

## P00 — freeze the baseline and release gate

**Full file list (`git show 0e4a73726 --stat`), six files, zero omitted:**

```
.github/workflows/funding-opportunities-ci.yml               |  11 +-
apps/api/.../__fixtures__/baseline-contract-v1.json          | 234 +++++++++
apps/api/.../funding-opportunities.baseline-contract.spec.ts | 571 +++++++++++++++++++++
docs/plans/funding-opportunities-makegov-v1/README.md        | 264 ++++++++++
docs/plans/funding-opportunities-makegov-v1/completion-matrix.md | 97 ++++
docs/plans/funding-opportunities-makegov-v1/decision-log.md   | 179 +++++++
```

Three docs, one fixture, one spec — exactly the "docs/tests/fixtures" claim. The
sixth file, the CI workflow, is the one worth checking rather than taking on faith:
its diff is a comment rewrite plus a floor bump,

```diff
-      # Floors: jest counts FILES in numTotalTestSuites. Measured 19 files / 509 tests
+      # Floors: jest counts FILES in numTotalTestSuites. Measured 20 files / 584 tests
...
-        run: node scripts/assert-test-summary.mjs "$GITHUB_WORKSPACE/api-summary.json" apps/api 19 500
+        run: node scripts/assert-test-summary.mjs "$GITHUB_WORKSPACE/api-summary.json" apps/api 20 575
```

— a CI gate threshold, not application code; it cannot change what the deployed app
does at runtime, only what the test gate requires to pass. No `apps/api/src` file
outside `__fixtures__` and the new spec is touched; no `apps/web` file is touched at
all. **Confirmed: zero production code changes.** The commit's own claim ("No
production code is touched") holds under direct inspection, not just by trusting
the message.

---

## P09 — human-readable match explanations

**Full file list (`git show 8c432a54b --name-status`), ten files, zero omitted:**

```
M	.github/workflows/funding-opportunities-ci.yml
M	apps/api/src/funding-opportunities/__fixtures__/baseline-contract-v1.json
A	apps/api/src/funding-opportunities/opportunity-explanation.spec.ts
A	apps/api/src/funding-opportunities/opportunity-explanation.ts
M	apps/web/src/pages/intelligence/opportunities/FundingOpportunitiesPage.test.tsx
A	apps/web/src/pages/intelligence/opportunities/OpportunityCard.test.tsx
M	apps/web/src/pages/intelligence/opportunities/OpportunityCard.tsx
M	apps/web/src/pages/intelligence/opportunities/funding-opportunities-api.ts
A	apps/web/src/pages/intelligence/opportunities/opportunity-explanations.ts
M	docs/plans/funding-opportunities-makegov-v1/completion-matrix.md
```

Four production files: two new pure-label modules, one card component, one type
file. No scorer file (`sam-opportunity-relevance.ts` or equivalent), no
`opportunity-recommendation.ts`, no eligibility-computing file anywhere in this
list — the diff cannot touch scoring/eligibility logic it does not include.

**1. The new API module (`opportunity-explanation.ts`) takes already-scored input
and only labels it.** Its exported `explainOpportunity()` accepts
`{ signal, strength, matchedOn }[]` — `strength` is imported as a *type*
(`SignalStrength`) from the scorer file, not computed here — and returns labels,
a sentence template, and a `fitBand` **derived from the existing `strength` field**
(`STRENGTH_ORDER` re-sorts by a value the scorer already assigned; it invents no
new value). `weakOnly` is a boolean re-statement of an existing floor rule ("one
strong, or two moderate" — the same floor P06/producers already use), not a new
threshold.

**2. The module is verifiably unused — this is not an inference:**

```
$ git grep -n "explainOpportunity\|OpportunityExplanation" 8c432a54b -- apps/api/src
  (zero hits outside opportunity-explanation.ts and opportunity-explanation.spec.ts themselves)
```

Matches the completion matrix's own Deploy note for this row: *"Web may deploy
after API — the API change is a new pure module nothing else calls yet."* A module
with no caller cannot change the API's runtime behavior.

**3. The web mirror (`opportunity-explanations.ts`) is the identical pattern
client-side** — `explainSignals()` labels and sorts, again over pre-existing
`strength`/`matchedOn` fields; no network call, no new field requested from the
API.

**4. `OpportunityCard.tsx`'s diff is a rendering swap, not a data change.** The
`Text>{o.relevanceScore}</Text>` line becomes a `Tag` showing `FIT_BAND_LABELS`;
the flat list of raw-key tags becomes a "strongest reason" tag plus a collapsible
evidence panel. `o.relevanceScore` and `o.matchedSignals` are read exactly as
before — the number is not deleted, it moves into the evidence disclosure
(`Evidence ({o.matchedSignals.length}) · relevance {o.relevanceScore}`). No
eligibility or recommendation JSX in this diff at all.

**5. `funding-opportunities-api.ts`'s 22-line addition is type-only** —
`HUMAN_DECISIONS`, `HumanDecision`, `OpportunityDecision`, and a `decision` field
added to the `FundingOpportunity` interface. This is the commit's documented "ALSO
FIXES A P07 OMISSION": the API already returned `decision` since P07, the web
type mirror had simply never been updated to know about it. Adding a TS interface
field is not new runtime logic.

**6. The two rewritten test assertions are reworded, not weakened** — confirmed by
reading the diff, not the commit message: `FundingOpportunitiesPage.test.tsx`'s
`'matched signals are listed with the value that matched'` used to assert the
literal string `assistanceListing: 81.086` (the raw key — asserting the defect);
it now asserts `Prior award under this Assistance Listing: 81.086` **and** that
`assistanceListing:` is absent. The relevance-number assertion is not deleted,
just moved: `expect(card).toHaveTextContent(/relevance 54/)` still runs, alongside
new assertions for `'Fit'` / `'Strong fit'` / `'Eligibility'` / `'Eligible'`
staying on the same card. Nothing about eligibility computation changed; the test
still reads eligibility off the card exactly as before.

**7. A full-diff grep for anything that *sets* an eligibility/recommendation
value** (as opposed to a comment mentioning one, or a test fixture literal) turned
up nothing — every hit is either prose ("eligible applicant types" as a signal
label), a fixture literal constructing test input (`eligibility: { state:
'needs_review', ... }` — data the test hands in, not data the phase computes), or
a test name asserting fit/eligibility/workflow stay visually separate.

**Conclusion:** the reason-code vocabulary this phase introduces (`SIGNAL_COPY` /
`SIGNAL_LABELS`, keyed on signal names like `naicsExact`, `assistanceListing`,
`genericTopical` — the same bounded-vocabulary pattern the task brief described
under the placeholder name `exact_industry_match`) is confirmed to be a label
layer over signals the scorer already emits, not a new scoring input. Fit band,
eligibility, and machine recommendation are three facts this phase deliberately
keeps separate (per its own docblocks and tests) rather than merges.

---

## Other phases worth a look (opportunistic, not exhaustive)

Not a full audit — flagged only because they surfaced naturally while reading the
completion matrix for context on P00/P09.

- **P32 ("Full opportunity assessment drawer") looks like a plausible additional
  Band C candidate.** Its diff (`git show 04193658 --stat`, PR #797) touches
  **zero files under `apps/api`** — only `FundingOpportunityDetail.tsx`,
  a new `OpportunityAssessmentPanel.tsx` + its test, a 22-line addition to
  `funding-opportunities-api.ts`, plus the usual fixture/CI floor bump. The
  `funding-opportunities-api.ts` diff checked out the same way as P09's: it adds
  `RECOMMENDATION_LABELS`/`RECOMMENDATION_COLORS` constant maps keyed on the
  pre-existing `MachineRecommendation` type — consolidating two previously
  independent label copies (the commit note frames it as fixing a card-vs-drawer
  label *parity* bug, not a scoring change). I did not read
  `OpportunityAssessmentPanel.tsx` in full, so this is a lead, not an attestation —
  but it fits this cluster's profile well enough that it seems worth a real Band C
  pass rather than whatever band it currently carries.

- **General caution for this banding exercise, not a new finding:** the matrix's
  own D-79 entry documents a phase (P43's scorer, and P41's DIBBS counterpart)
  that shipped genuinely dark ("nothing calls it") for days and was *then* wired
  into a live producer without the phase's own row being revisited (this is
  exactly `band-a-p51-ga-closeout.md`'s F-02/F-06 in this same directory). The
  general lesson transfers to banding: "ships dark, no caller today" (true of
  P09's API module, also true of P25's and P23's scoring logic while unwired) is a
  fact about *today's* wiring, not a durable property of the code. It's a good
  reason P09 was checked by reading its actual diff rather than by trusting the
  completion matrix's "nothing calls it yet" note alone — which is what this
  attestation did.

---

## Approval record

**Verdict:** `P00_BAND_C_ATTESTATION_CONFIRMED_INERT` and
`P09_BAND_C_ATTESTATION_CONFIRMED_PRESENTATION_ONLY` — 2026-08-13, by an
independent reviewer not involved in implementing this program. Both phases'
actual per-phase commits (isolated from the combined PR #769, not inferred from
it) were read in full for every production file they touch. P00: six files, zero
production code, CI-gate-only non-doc/test/fixture change. P09: ten files, four
production files, all four confirmed to operate only on pre-existing
scorer-assigned values (`strength`, `matchedOn`, `relevanceScore`, `decision`)
with no scorer/recommendation/eligibility file in the diff and zero callers of the
new API module. No finding in this pass requires escalating either phase out of
Band C.
