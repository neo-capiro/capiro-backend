# Fix plan — P1-4/B-1 (DIBBS prior-CAGE signal is item-unscoped) and P1-5/B-2 (SBIR agency-acronym matching)

**Status:** PLANNED — nothing in this document has been implemented. No source file, test file,
or schema file has been modified. This is a plan for a future engineer/agent to execute.

**Scope:** Exactly the two P1 scoring-precision bugs below, both already proven live in
`docs/plans/funding-opportunities-makegov-v1/independent-review/band-b-matching-scoring.md`
(findings B-1, B-2) and tracked in `MASTER-FINDINGS-QUEUE.md` as **P1-4** and **P1-5**. Four
related, lower-severity findings from the same review (B-3, B-4 is fixed as a side effect here —
see §6.3 — B-5, B-6) are explicitly not touched — see [§9](#9-explicitly-out-of-scope).

**Verified against:** `origin/main` at `3e2a691baa2a94802047ded1c3fe7a5dfd4e366c` (fetched
2026-08-14; tip is PR #955, `feat(directory): give vNext member profiles the same depth as
canonical`). `band-b-matching-scoring.md` reviewed commit `d800dcfde5`. Confirmed by
`git log d800dcfde5..origin/main --oneline -- <every file this plan touches or cites>` that
**zero commits touched any relevant path** in between (the 7 commits in that range are all
Directory vNext / Meri workspace UI work) — so every quote below is simultaneously "what
`band-b-matching-scoring.md` found on 2026-08-13" and "what is on `origin/main` today,
2026-08-14."

**Method:** Read-only. All source was read via `git show origin/main:<path>` against
`C:\dev\capirov2` (branch `agent/fo-p36-outcome-capture`, with unrelated uncommitted changes —
never touched). No file in `C:\dev\capirov2` was modified. `C:\dev\capiro-fo-ga-review-wt` (branch
`docs/fo-ga-independent-review`, itself behind current `origin/main` and carrying its own
unrelated uncommitted doc edits) was used only to write this one new file.

---

## TL;DR

- **Both bugs are confirmed present, verbatim, at current `origin/main`.** See [§1](#1-bug-1-confirmed-current-state)
  and [§4](#4-bug-2-confirmed-current-state).
- **Bug 1 (DIBBS):** `priorCageAwardHistory` — "has this CAGE ever won *any* DLA award," with zero
  NSN/part/nomenclature correlation — sits in the same "strong, floor-clearing" rule as an exact
  part match. Fix: move it into the existing weak-evidence rule (same bucket as
  `capabilityTextMatch`), and stop the branch's prose from claiming item-specific relevance it
  doesn't have. One function, `apps/api/src/funding-opportunities/dibbs-relevance.ts`; no producer
  change needed. See [§2](#2-bug-1-fix-design).
- **Bug 1's consequence, stated plainly:** because DIBBS's other two strong signals
  (`exactNsnMatch`, `exactPartNumberMatch`) are hardcoded `false` at the only call site (no client
  parts store exists), this fix makes `clearsSuggestionFloor: true` **unreachable** with today's
  data. **DIBBS will create zero new suggested rows, and mark existing machine-suggested rows
  stale, until a client parts store exists.** This is not a side effect to bury — see
  [§3](#3-bug-1-downstream-consequence-dibbs-goes-quiet), which is written to be read on its own.
- **Bug 2 (SBIR):** the real SBIR source publishes `agency: "DOD"` (proven: 5/5 records in the
  real capture fixture); `federal_award` stores `"Department of Defense"` /
  `"DEPT OF THE NAVY"`. The canonical, already-shared `normAgency` normalizes spelling variants but
  never expands an abbreviation. Fix: add a small closed abbreviation table to the **existing**
  canonical `normAgency` (`sam-opportunity-relevance.ts`), which SBIR's producer already imports
  and calls correctly — **no producer change needed**. See [§5](#5-bug-2-fix-design).
- **Repo-wide inventory found three copies of agency-name comparison**, not one: the canonical
  exported `normAgency`, a **private, buggier duplicate** in `forecast-opportunity-read.service.ts`
  (already flagged as B-4 in the same review — its own docblock claims parity with the canonical
  version it does not have), and two *unrelated*, wrong-shape data maps (`AGENCY_SECTOR_MAP`,
  `ACRONYM_EXPANSIONS`) that must not be reused for this purpose. This plan fixes the canonical
  function **and** deletes the forecast duplicate in the same change, so this doesn't become a
  fourth copy. See [§4.2](#42-repo-wide-inventory-every-agency-name-comparison-found).
- **Bug 2's consequence:** purely additive — every existing passing test uses full-name-shaped
  fixtures on both sides and is unaffected; the fix only makes *new*, previously-impossible matches
  succeed. No "goes quiet" risk, the opposite asymmetry from Bug 1. See
  [§6](#6-bug-2-downstream-consequence-purely-additive).
- Touches 2 production files total (`dibbs-relevance.ts`; `sam-opportunity-relevance.ts` +
  delete-and-import in `forecast-opportunity-read.service.ts`) and 4 spec files. See
  [§7](#7-implementation-order) for the exact sequence.

---

## 1. Bug 1 — confirmed current state

`apps/api/src/funding-opportunities/dibbs-relevance.ts`, function `scoreDibbsRelevance`, Rule 4
(current lines 275–291):

```ts
  // ── Rule 4: an exact part-level match, or a prior award on this CAGE ────
  const hasStrongMatch = input.exactNsnMatch || input.exactPartNumberMatch || input.priorCageAwardHistory;
  if (hasStrongMatch) {
    const partLevel = input.exactNsnMatch || input.exactPartNumberMatch;
    return {
      machineRecommendation: 'pursue',
      recommendationConfidence: partLevel && input.priorCageAwardHistory ? 'high' : 'medium',
      primaryReason: partLevel
        ? 'An exact part-level match against this client\'s recorded parts.'
        : "A prior DLA award to this client's own CAGE code on this kind of item.",
      primaryRisk: imminent && days != null ? `The quote window closes in ${days} day${days === 1 ? '' : 's'}.` : null,
      recommendedNextAction: strongAction(input, imminent, days),
      reasonCodes: codes,
      clearsSuggestionFloor: true,
      dibbsPartProfileGap: partGap,
    };
  }
```

`priorCageAwardHistory` alone (no part-level evidence at all) satisfies `hasStrongMatch`, reaches
`machineRecommendation: 'pursue'`, and sets `clearsSuggestionFloor: true` — the field this
program's own convention says only a genuinely strong signal may set (see the file's own docblock,
current lines 63–72, "P41's acceptance: 'a capability-text-only match cannot clear the suggestion
floor'... `clearsSuggestionFloor` states that directly rather than leaving a producer to
re-derive it").

The field's doc comment (current lines 126–127) is honest about what it measures:

```ts
  /** LIVE. A `tango_dibbs_award` whose `awardeeCage`/`awardeeCageCode` is this client's own recorded CAGE. */
  priorCageAwardHistory: boolean;
```

— "this client's own recorded CAGE," full stop, no item qualifier. The branch's *prose* two lines
away in Rule 4 says something the field comment does not support: **"on this kind of item."**
`band-b-matching-scoring.md` (B-1) names this exact split precisely: "The producer implemented the
field comment. A single-phase reviewer reading only P41 sees a consistent scorer; a single-phase
reviewer reading only the producer sees a faithful implementation of the field comment."

The value is established in `apps/api/scripts/generate-dibbs-opportunity-candidates.ts`,
function `hasPriorCageAward` (current lines 284–296) — confirmed this is still the current name
and location; it has not moved or been renamed:

```ts
export async function hasPriorCageAward(
  prisma: Pick<DibbsCandidatesPrisma, '$queryRaw'>,
  cage: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ hit: number }>`
    SELECT 1 AS hit
    FROM tango_dibbs_award
    WHERE upper(trim(awardee_cage)) = ${cage}
       OR upper(trim(awardee_cage_code)) = ${cage}
    LIMIT 1
  `;
  return rows.length > 0;
}
```

No NSN, part number, or nomenclature predicate — by design, and the function's own doc comment
(lines 272–282) never claims one; it says plainly "Whether **ANY** `tango_dibbs_award` names this
CAGE as its awardee." **This function is not buggy and needs no code change** — it does exactly
what it says. The defect is entirely that its result is fed into a "strong" rule in the scorer.

The result is computed **once per client** and reused for **every solicitation** in the run
(current lines 389–401, consumed at 445/458):

```ts
        for (const client of clientPage) {
          const history = await readAwardHistoryByBasis(prisma, buildAwardHistoryIdentity(client, contractorUeis));
          profileByClient.set(client.clientId, buildClientOpportunityProfile(client, history));

          const cage = normalizeCage(client.cageCode);
          priorCageByClient.set(
            client.clientId,
            cage != null ? await hasPriorCageAward(prisma, cage) : false,
          );
        }
        ...
              const priorCage = priorCageByClient.get(client.clientId)!;
              for (const row of solicitationPage) {
                ...
                  const scored = scoreDibbsRelevance({
                    ...
                    exactNsnMatch: false,              // DORMANT — no client part/NSN store exists
                    exactPartNumberMatch: false,        // DORMANT — no client part/NSN store exists
                    priorCageAwardHistory: priorCage,   // the SAME boolean, for every row in this page
                    ...
```

**Measured, live, against the repository's own real capture fixture** (`band-b-matching-scoring.md`
§"How the live verification was done," re-confirmed unchanged by the commit-range check above):
client CAGE `81873` (`WOODWARD HRT INC`, real record, one real prior award — a shipping cover
plate, part `1730LN0035253`) produced a floor-clearing `pursue` row for **10 of 10** open items in
the real DIBBS capture, including:

```
DISK DRIVE UNIT · COUNTER AND CHUTE A · PLATE,CLAMP,GEARBOX · ROPE,FIBROUS ·
SHIPPING AND STORAGE · BATTERY ASSEMBLY · BOLT, MACHINE ·
PRODUCTION LOT TESTING (GOVERNMENT) · CONTRACTOR FIRST ARTICLE TEST · SLING, MULTIPLE LEG
```

every one with the stated reason `"A prior DLA award to this client's own CAGE code on this kind
of item."` — an actuation/shipping-hardware-adjacent manufacturer with a plate award being told it
has relevant history on fibrous rope and multi-leg slings. Confirmed independently in this session
by reading `apps/api/src/external/tango/__fixtures__/real-captures/dibbs-contract-capture-2026-08-09.json`
directly: the RFQs really do carry unrelated real NSNs and nomenclatures (`"nomenclature": "DISK
DRIVE UNIT", "nsn": "7025017288545"`; `"nomenclature": "COUNTER AND CHUTE A", "nsn":
"1730010824002"`, etc.) — none corresponds to the awarded shipping-cover part.

**Precedent this program has already established for exactly this shape of mistake**, and does not
follow here: `client-opportunity-profile.types.ts`, `AwardHistoryFacts.contractOffices`'s own doc
comment (current lines 122–128):

> "Feeding it the awarding sub-tier created an office signal that could never fire and surfaced
> agency names to users as 'prior office' terms."

`dibbs-relevance.ts`'s own file docblock (current lines 56–61) repeats the warning in the abstract
("A dormant signal fed a lookalike is a defect") — but `priorCageAwardHistory` is not a *dormant*
signal fed a lookalike; it is a *live* signal whose real, honestly-described value was then
mis-classified as strong one layer up. Same family of mistake, different mechanism.

---

## 2. Bug 1 — fix design

### 2.1 Principle already established in this program, being applied consistently

`capabilityTextMatch` is already correctly capped (current lines 130–131 and Rule 5, lines
293–313): "LIVE, and WEAK BY RULE... Cannot clear the floor alone." The fix is to put
`priorCageAwardHistory` in the same bucket, for the same reason: real evidence, zero correlation to
the specific item, therefore worth *showing*, never sufficient to *suggest*. This also matches how
`sbir-relevance.ts` already treats its own analogous agency-level signal — Rule 5 there
(`priorAgencyHistory`) never reaches `'pursue'` at all, and only clears the floor when a *stronger*
sub-fact (`historyIsIdentifierBacked`) also holds. DIBBS's CAGE signal has no equivalent
stronger sub-fact available, so it should not clear the floor under any condition — full parity
with `capabilityTextMatch`, not partial parity with SBIR's agency rule.

### 2.2 Exact change — `dibbs-relevance.ts`

**Change A — narrow `hasStrongMatch` to part-level evidence only.** Current lines 275–291,
replace with:

```ts
  // ── Rule 4: an exact part-level match ───────────────────────────────────
  //
  // ONLY exact NSN/part-number evidence lives here. `priorCageAwardHistory` is
  // deliberately NOT part of `hasStrongMatch` — see P1-4/B-1
  // (docs/plans/funding-opportunities-makegov-v1/independent-review/band-b-matching-scoring.md,
  // FIX-PLAN-dibbs-sbir-scoring.md): `hasPriorCageAward` (the generate script)
  // proves this CAGE won SOME DLA award, with zero correlation to THIS item's
  // NSN, part number, or nomenclature. Treating it as strong let it clear the
  // floor alone for 10 of 10 unrelated real solicitations, for a client whose
  // one real award was for an unrelated part (a shipping-cover plate; the
  // floor-clearing items included fibrous rope and multi-leg slings).
  const hasStrongMatch = input.exactNsnMatch || input.exactPartNumberMatch;
  if (hasStrongMatch) {
    return {
      machineRecommendation: 'pursue',
      // A prior CAGE award is real corroboration ONCE a genuine part-level
      // match already exists — it cannot manufacture the match, but it can
      // still raise confidence in one that's already there.
      recommendationConfidence: input.priorCageAwardHistory ? 'high' : 'medium',
      primaryReason: 'An exact part-level match against this client\'s recorded parts.',
      primaryRisk: imminent && days != null ? `The quote window closes in ${days} day${days === 1 ? '' : 's'}.` : null,
      recommendedNextAction: strongAction(input, imminent, days),
      reasonCodes: codes,
      clearsSuggestionFloor: true,
      dibbsPartProfileGap: partGap,
    };
  }
```

Note what's removed: the `partLevel` local (now always true inside this branch — part-level
evidence is the *only* way in) and the two-armed `primaryReason`/confidence ternaries that used to
have a CAGE-only branch. The confidence line keeps exactly one conditional — `priorCageAwardHistory`
as a corroboration bonus on top of a real part match — which is the same behavior the existing test
"part-level evidence AND prior CAGE history together raise confidence to high" already expects (see
[§4.1](#41-existing-tests-dibbs-relevancespects), no change needed to that test's assertions).

**Change B — Rule 5 gains an honest, CAGE-specific reason.** Current lines 293–313, replace with:

```ts
  // ── Rule 5: weak evidence only — capability text, prior CAGE award, ─────
  // and/or a buyer match. NONE of these ties the client to THIS item.
  //
  // P41's acceptance, stated directly: generic manufacturing terms are weak.
  // "We make brackets" against a nomenclature reading "BRACKET, ANGLE" is a
  // coincidence of vocabulary, not evidence this client makes THIS part. A
  // prior CAGE award (P1-4/B-1) is the same shape of problem by a different
  // mechanism: `hasPriorCageAward` has no NSN/part/nomenclature correlation at
  // all, so "this CAGE won some DLA award" is exactly as unspecific to this
  // item as a capability-text coincidence is. Both are worth showing to a
  // reviewer; neither is worth manufacturing a suggestion from.
  const hasCageHistory = substantive.includes('prior_cage_award_history');
  const hasCapabilityText = substantive.includes('capability_text_match');
  const primaryReason = hasCageHistory && hasCapabilityText
    ? "This client's CAGE code has DLA award history, and the item's nomenclature matches the " +
      "client's capability text — neither ties this client to this specific NSN or part number."
    : hasCageHistory
      ? "This client's CAGE code has DLA award history, but not on this NSN, part number, or item."
      : hasCapabilityText
        ? "The item's nomenclature matches the client's capability text, which is a vocabulary " +
          "match and not part-level evidence."
        : 'Some evidence ties this item to the client, but no exact part-level match.';
  return {
    machineRecommendation: 'monitor',
    recommendationConfidence: 'low',
    primaryReason,
    primaryRisk: null,
    recommendedNextAction: partGap
      ? 'Confirm with the client whether they supply this NSN, and record their part numbers so this can be matched rather than guessed.'
      : 'Confirm with the client whether they supply this NSN.',
    reasonCodes: codes,
    clearsSuggestionFloor: false,
    dibbsPartProfileGap: partGap,
  };
}
```

This is the concrete answer to "fix the display/explanation text": the false, item-specific claim
("on this kind of item") is gone from the strong branch entirely (that branch is now only ever
reached by a real part-level match, where the claim is true), and the honest, broader claim ("this
client's CAGE code has DLA award history," with no item qualifier) is what a CAGE-only match now
produces, at `'monitor'`, not `'pursue'`.

**Change C — update the field doc comment so the next reader can't reintroduce this.** Current
lines 126–127:

```ts
  /** LIVE. A `tango_dibbs_award` whose `awardeeCage`/`awardeeCageCode` is this client's own recorded CAGE. */
  priorCageAwardHistory: boolean;
```

Replace with (matching the "LIVE, and WEAK BY RULE" phrasing already used one field below it, line
130):

```ts
  /**
   * LIVE, and WEAK BY RULE (P1-4/B-1): a `tango_dibbs_award` whose
   * `awardeeCage`/`awardeeCageCode` is this client's own recorded CAGE — ANY
   * award, with zero correlation to THIS item's NSN, part number, or
   * nomenclature. Cannot clear the suggestion floor alone. It CAN raise
   * confidence to 'high' when paired with a genuine exact NSN/part match
   * (Rule 4) — a real corroborating fact once real evidence already exists,
   * never a substitute for it.
   */
  priorCageAwardHistory: boolean;
```

**Change D (recommended, matches house style) — a regression note in the file's top docblock.**
This codebase consistently documents shipped-and-fixed regressions in place (see the `daysUntil`
comment, current lines 174–188, and the SAM rail's own agency-abbreviation history in
`sam-opportunity-relevance.spec.ts` lines 77–83). Insert a new section after "── THE FLOOR RULE IS
ITS OWN FIELD, NOT AN INFERENCE ──" (current lines 63–72):

```ts
 * ── priorCageAwardHistory WAS TREATED AS STRONG; IT IS WEAK (P1-4 / B-1) ────
 *
 * Originally grouped with exact NSN/part matches on the theory that a prior
 * DLA award to the client's own CAGE is meaningful. It is real signal, but
 * `hasPriorCageAward` (`generate-dibbs-opportunity-candidates.ts`) answers
 * "has this CAGE EVER won ANY DLA award" — zero correlation to the item being
 * scored — and the value is computed ONCE PER CLIENT and reused for every
 * solicitation in a run. Treating it as strong meant one unrelated prior
 * award (in the case that surfaced this, a shipping-cover plate) cleared the
 * suggestion floor for 10 of 10 open items, including fibrous rope and
 * multi-leg slings. It now lives in Rule 5 next to `capabilityTextMatch`:
 * real, worth showing, incapable of clearing the floor alone. See
 * `docs/plans/funding-opportunities-makegov-v1/independent-review/
 * band-b-matching-scoring.md` (B-1) and `FIX-PLAN-dibbs-sbir-scoring.md`.
```

Optional/stylistic — does not block the fix if the implementer wants a smaller diff, but this
program's own documented culture (multiple regression notes already in this exact file) treats this
as close to a house requirement, not a nicety.

### 2.3 What does NOT change

- `hasPriorCageAward` itself (`generate-dibbs-opportunity-candidates.ts:284–296`) — honest today,
  no code change.
- The call site that constructs `scoreDibbsRelevance`'s input
  (`generate-dibbs-opportunity-candidates.ts:449–468`) — `priorCageAwardHistory: priorCage` stays
  exactly as-is; the fix is entirely inside the scorer's rule table.
- `strongAction` (lines 316–322) — unchanged; still only reachable from Rule 4, still branches on
  `documentType`.
- `DIBBS_REASON_CODES` / the `prior_cage_award_history` reason-code string itself — stays. It
  accurately names *what fired*; the fix changes *how much weight* that firing carries and *what
  prose accompanies it*, not the code's name.

---

## 3. Bug 1 — downstream consequence: DIBBS goes quiet

**State this plainly, because it changes what "GA-ready" means for this rail specifically.**

`decideProducerAction` (`apps/api/src/funding-opportunities/producer-decision.ts:19–47`) gates
every create/refresh on:

```ts
  const qualifies = meetsSuggestionFloor && relevanceScore >= minRelevance;
  ...
  return qualifies ? { action: 'create', relevanceScore } : { action: 'skip_below_floor' };
```

and for an existing non-human-decided row, `qualifies === false` on a re-run produces `mark_stale`
(once) rather than a continued `refresh`.

Today, `clearsSuggestionFloor: true` is reachable in exactly one way in production:
`priorCageAwardHistory` alone, because the other two candidates for `hasStrongMatch`
(`exactNsnMatch`, `exactPartNumberMatch`) are **hardcoded `false`** at the only call site
(`generate-dibbs-opportunity-candidates.ts:456–457`, "DORMANT — no client part/NSN store exists")
and `clientHasRecordedParts` is hardcoded `false` too (line 466). There is no client parts store
anywhere in this schema — `dibbs-relevance.ts`'s own file doc says so directly (lines 37–46).

**After this fix, `hasStrongMatch` requires `exactNsnMatch || exactPartNumberMatch` — both
permanently `false` in production. `scoreDibbsRelevance` can therefore never return
`clearsSuggestionFloor: true` under any input the current producer can actually construct.**
Concretely, once this fix ships and the next `generate-dibbs-opportunity-candidates` run executes:

- **Zero new `clientFundingOpportunity` rows with `source: 'dibbs'` will ever be created**, for any
  client, regardless of CAGE history, capability text, or any combination — every candidate hits
  `skip_below_floor`.
- **Every existing machine-suggested (`evidenceSourceType: 'deterministic_relevance_v1'`,
  non-human-decided) DIBBS row will be marked `stale`** on its next evaluation, because it no
  longer qualifies. (Rows a human has acted on — `userCreated`, or `workflowStatus` in `saved` /
  `pursuing` / `dismissed` / `won` / `lost` — are protected by `decideProducerAction`'s
  human-decision short-circuit and are never touched, regardless of this fix.)
- This is confirmed structurally by the producer's own test harness: `generate-dibbs-opportunity-candidates.spec.ts`'s
  fake-Prisma builder says so about itself, current lines 173–178: *"with exactNsnMatch/exactPartNumberMatch
  always false in this producer (dormant signals), prior CAGE award history is the ONLY signal that
  can clear the suggestion floor, so a 'happy path' fixture needs one unless a test is specifically
  about the floor NOT clearing."* Remove that one signal from the floor-clearing set, and — by this
  file's own comment — there is no longer any happy path fixture that clears the floor. See
  [§8.2](#82-generate-dibbs-opportunity-candidatesspects) for the full accounting of which of that
  file's own tests this breaks and how to repair them.

**What this means for "GA-ready":** DIBBS's live matching capability, as currently wired, reduces to
"an honest zero." Every open bid-board item will be evaluated (visible in `evaluated`/`opportunitiesRead`
counts) and every one will correctly report why it didn't qualify (`skip_below_floor`,
`dibbsPartProfileGap: 'no_client_parts_recorded'` where applicable) — but the DIBBS rail will
produce **no pursue-able suggestions for any client, ever, until a client parts store exists** to
populate `exactNsnMatch`/`exactPartNumberMatch`/`clientHasRecordedParts` with real data. This is the
correct and intended behavior post-fix (an honest "we have no matching signal yet" beats a
fabricated one), but it is a material change from what DIBBS does *today* (fan out a `pursue` to
every open item for any client with CAGE history), and "GA-ready for DIBBS" must be understood as
"correctly, honestly produces nothing" rather than "produces suggestions," until that follow-on data
source exists. Anyone evaluating DIBBS's rollout readiness after this fix should not expect to see
created rows in a smoke test unless the parts store also lands — a `created: 0` result across an
entire real corpus is the *fix working*, not a regression, and dashboards / alerts that treat "zero
DIBBS suggestions" as an anomaly should be updated or suppressed accordingly (flagged here since it
falls just outside this plan's scope; see [§9](#9-explicitly-out-of-scope)).

---

## 4. Bug 2 — confirmed current state

### 4.1 The mismatch, proven against real data

`apps/api/src/external/tango/__fixtures__/real-captures/sbir-contract-capture-2026-08-09.json`
(read directly this session) — all 5 `topics` records carry `"agency": "DOD"`, verbatim, zero
variance. `apps/api/src/external/tango/tango-sbir.mapper.ts:144` stores this with no
transformation: `agency: str(raw['agency'])`. So `tango_sbir_topic.agency` is `"DOD"` for every
real DOD-sponsored topic.

`apps/api/src/funding-opportunities/client-opportunity-profile.repository.ts:403–412` builds a
client's `contractAgencies` from `federal_award.awarding_agency` (toptier — e.g. `"Department of
Defense"`) **and** `awarding_sub_tier` (e.g. `"DEPT OF THE NAVY"`), confirmed by its own comment:

```ts
    // Both tiers are agency evidence, and both granularities are needed:
    // `sam_opportunity.agency` is sub-tier shaped ('DEPT OF THE NAVY'), so
    // `awarding_agency` alone ('Department of Defense') never matched a notice.
    contractAgencies: dedupeStrings([
      ...contracts.map((r) => r.awarding_agency),
      ...contracts.map((r) => r.awarding_sub_tier),
    ]),
```

Neither tier is ever a bare 2–4 letter abbreviation. This flows unchanged into
`client-opportunity-profile.builder.ts:80` (`priorAgencies: history.contractAgencies`), read by
SBIR's producer at `apps/api/scripts/generate-sbir-opportunity-candidates.ts:429–453`:

```ts
              const priorAgencies = new Set(
                profile.sam.priorAgencies.map(normAgency).filter(Boolean),
              );
              ...
                    priorAgencyHistory:
                      topic.agency != null && priorAgencies.has(normAgency(topic.agency)),
```

`normAgency` is imported at line 47 from the **canonical, already-shared, already-exported**
`apps/api/src/funding-opportunities/sam-opportunity-relevance.ts:241–248` — confirmed this producer
already does the right thing architecturally (imports the shared function; does **not** define its
own copy):

```ts
export function normAgency(v: string | null | undefined): string {
  return norm(v)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\bdept\b\.?/g, 'department')
    .replace(/\bhq\b/g, 'headquarters')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
```

This closed rewrite set was built (its own doc comment, lines 224–240) for a **different, already-
solved** mismatch: SAM's sub-tier-shaped `'DEPT OF THE NAVY'` vs. the award table's
`'Department of the Navy'` — case, `"Dept"` vs `"Department"`, and a trailing parenthetical acronym
(`'DEFENSE HEALTH AGENCY (DHA)'`). None of those rewrites bridges a bare top-level abbreviation to
a full department name:

```
normAgency("DOD")                    = "dod"
normAgency("Department of Defense")  = "department of defense"
```

— confirmed by direct evaluation of the function above; `"dod"` contains neither `"dept"` nor
`"hq"` as whole words, has no trailing parenthetical, and has no punctuation to collapse, so no
rewrite rule touches it. `"dod" !== "department of defense"`: the set intersection
`priorAgencies.has(normAgency(topic.agency))` is empty for every real DOD-sponsored topic against
every real client, no matter how strong that client's actual DoD contract history is.

**Measured, live** (`band-b-matching-scoring.md`, re-confirmed unchanged): two identical realistic
clients, differing only in how their award row spells the agency —

```
cli-0002-autonomy  (award row: 'Department of Defense' / 'DEPT OF THE NAVY', the REAL shape) → 0 rows
cli-0003-dodliteral (award row: literally 'DOD', a synthetic isolation control)              → 5 rows
```

**Why this passed every existing test:** `generate-sbir-opportunity-candidates.spec.ts`'s
`topicRow()` default fixture is `agency: 'Defense Health Agency'` (line 89) — full-name shaped —
and the one test explicitly about agency normalization (`'agency names are compared normalized,
not verbatim'`, line 363) uses `'Defense Health Agency (DHA)'` — a parenthetical-acronym case,
which `normAgency` already handles. Confirmed directly this session: a full-text search of that
spec file for `normAgency|priorAgenc|'DOD'|Department of Defense` returns **zero** matches outside
the `Defense Health Agency` family — the abbreviation shape is never exercised anywhere in that
file's ~560 lines. `sbir-relevance.ts` and `sbir-relevance.spec.ts` need **no change** — confirmed
by reading both in full: the pure scorer's Rule 5 (agency history, gated on
`historyIsIdentifierBacked` for floor-clearing) is already correctly designed; the defect is
entirely upstream, in whether `priorAgencyHistory` ever becomes `true` on real data.

### 4.2 Repo-wide inventory: every agency-name comparison found

Searched (`git grep`, against `origin/main`, whole repo, `*.ts`) for `normAgency`,
`normalizeAgency`, `agencyNorm`, agency abbreviation/alias map name patterns, `"DEPARTMENT OF
DEFENSE"`, `'DOD'`/`"DOD"`, `CGAC`, and `toptier`. Every hit, and its fitness for this fix:

| # | Location | What it is | Fit for SBIR's identity-matching purpose? |
|---|---|---|---|
| 1 | `apps/api/src/funding-opportunities/sam-opportunity-relevance.ts:241–248`, exported `normAgency` | The **canonical** agency-identity normalizer. Already imported and correctly used by SBIR's own producer (line 47) and by the SAM scorer itself (line 348–349). | **Yes — this is the one to extend.** Proven, tested (`sam-opportunity-relevance.spec.ts:63–95`), already the shared dependency for 2 of the 3 rails that need it. |
| 2 | `apps/api/src/funding-opportunities/forecast-opportunity-read.service.ts:261–267`, **private** `normAgency` | A **duplicate**, not an import of #1. Its own doc comment (lines 251–260) claims "the same closed set of rewrites `normAgency` applies on the SAM rail" — **false**, per B-4 below. | **No — delete it; migrate to #1 instead of extending it.** Already independently buggy; fixing it in place would still leave a third copy risk. |
| 3 | `packages/shared/src/index.ts:290–317`, `AGENCY_SECTOR_MAP` | Agency name/abbreviation → **`SectorTag[]` categorization** (e.g. `'Army Corps of Engineers': ['ENVIRONMENT_WATER', 'DEFENSE']`), for comment-period/alert sector tagging. Many-to-many by design; a judgment call, not an identity fact. | **No.** Wrong semantics entirely — "which sector does this belong to" is not "is this the same organization as that." Reusing it would risk exactly the kind of near-miss `normAgency`'s own docblock says to avoid. Useful only as corroborating evidence that `'DOD'` is a recognized abbreviation elsewhere in this codebase's data model. |
| 4 | `apps/api/src/intelligence/term-expansion.ts:17–44`, `ACRONYM_EXPANSIONS` | Acronym → **free-text phrase expansion** for bill/policy-text keyword search (`dod: 'department of defense'`). Its own docblock: "conservative... omitted to avoid false expansions," built for a different algorithm (phrase search, not set-membership identity match). | **No**, for the same reason as #3 — different problem, different domain (`intelligence`, not `funding-opportunities`). Independently corroborates that `dod → department of defense` is a safe, unambiguous mapping (a second, unrelated part of this codebase already encodes exactly that fact). |
| 5 | `CGAC` (grep) | Nothing. Zero hits repo-wide. | N/A — no CGAC/toptier-agency-code crosswalk table exists anywhere in this codebase. |
| 6 | `toptier` (grep) | Only USAspending API **filter-shape** literals (`{ tier: 'toptier', name: ... }` in `sync-federal-award.ts`, `sync-federal-assistance-awards.ts`) — a request parameter, not a name-to-abbreviation mapping. | N/A — confirms there is no existing toptier-code↔name lookup table to reuse either. |

**Conclusion, answering the user's (a)/(b) choice directly: (a).** A canonical, adequate,
already-shared normalizer exists (#1). The fix is to extend it in place and point every rail
(including the already-known-buggy forecast rail, #2) at it — not to build a new fourth utility.

### 4.3 B-4, independently re-derived: forecast's private copy is buggy, and *why*, precisely

`forecast-opportunity-read.service.ts`'s own `norm` (lines 202–208) is **not** the same as SAM's:

```ts
/** Lowercase, punctuation collapsed to single spaces. */
function norm(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')   // <-- punctuation (including parens) collapsed HERE, first
    .trim();
}
```

vs. SAM's private `norm` (`sam-opportunity-relevance.ts:220–222`), which does only:

```ts
function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();   // no punctuation handling at all
}
```

Forecast's `normAgency` (lines 261–267) calls its own `norm` **first**, then tries to strip a
trailing parenthetical **second**:

```ts
function normAgency(value: string | null | undefined): string {
  return norm(value)                          // parens already turned into spaces here
    .replace(/\s*\([^)]*\)\s*$/, '')           // → this regex now matches nothing, ever
    .replace(/\bdept\b\.?/g, 'department')
    .replace(/\bhq\b/g, 'headquarters')
    .trim();
}
```

By the time the parenthetical-strip regex runs, `norm()` has already replaced `(` and `)` with
spaces, so `/\s*\([^)]*\)\s*$/` can never match — the line is silent dead code. Measured
(`band-b-matching-scoring.md`, independently re-derived here from the source, same conclusion):

```
normAgency("DEFENSE HEALTH AGENCY (DHA)")   SAM (canonical) = "defense health agency"
                                             forecast (private) = "defense health agency dha"  <-- the "dha" leaks in
```

So SAM's `normAgency` correctly treats `'DEFENSE HEALTH AGENCY (DHA)'` as the same organization as
a client's recorded `'Defense Health Agency'`; forecast's private copy does not, on a string its
own docblock (lines 254–255) explicitly claims to handle the same way. This is fixed automatically
by deleting the duplicate and importing the canonical one — see [§5.2](#52-migrate-forecast-off-its-private-copy).

---

## 5. Bug 2 — fix design

### 5.1 Extend the canonical `normAgency` — `sam-opportunity-relevance.ts`

Current lines 224–248, replace with:

```ts
/**
 * Agency names are compared across sources that spell the same organisation
 * differently, so a bare `norm` never matches them. Measured on capiro-dev
 * 2026-07-29 (SAM rail):
 *
 *   federal_award.awarding_sub_tier : 'Department of the Navy', 'Defense Logistics Agency'
 *   sam_opportunity.agency          : 'DEPT OF THE NAVY',       'DEFENSE LOGISTICS AGENCY'
 *
 * Case alone resolves 'Defense Logistics Agency'; 'Dept' vs 'Department' does
 * not, so every Navy/Army/Air Force notice missed its own client's award
 * history. SAM also suffixes acronyms — 'DEFENSE HEALTH AGENCY (DHA)' — which
 * never appear on the award side.
 *
 * A THIRD shape, proven on the real SBIR capture (P1-5/B-2, see
 * FIX-PLAN-dibbs-sbir-scoring.md and
 * apps/api/src/external/tango/__fixtures__/real-captures/sbir-contract-capture-2026-08-09.json,
 * 5/5 records): `tango_sbir_topic.agency` is a bare top-level department
 * ABBREVIATION — `'DOD'` — never sub-tier or full-name shaped, so even the
 * rewrites above never bridge it to `federal_award.awarding_agency`'s
 * `'Department of Defense'`. `AGENCY_ABBREVIATIONS` below is that bridge — a
 * small, closed abbreviation→full-name table, applied AFTER the rewrites
 * above so an abbreviation and its expansion always land on the same
 * normalized string. Only the toptier form needs a mapping: `contractAgencies`
 * (`client-opportunity-profile.repository.ts`) always includes the toptier
 * `awarding_agency` alongside any sub-tier, for EVERY contract under that
 * department, so 'DOD' only ever needs to match 'department of defense' —
 * never each sub-component name individually.
 *
 * This stays a small, closed set of rewrites rather than fuzzy matching: the
 * agency signal is evidence that a client has won work from this organisation
 * before, and a near-miss is not that evidence.
 *
 * VERIFY BEFORE EXTENDING: only 'dod' is proven against real provider data
 * (5/5 records in the capture above). Confirm any addition with
 * `SELECT DISTINCT agency FROM tango_sbir_topic` on capiro-dev (or a fresh
 * `diag-tango-contract-capture.ts` pull) before relying on it, and remove any
 * entry that turns out not to match what the provider actually sends — see
 * §5.3/§10 of FIX-PLAN-dibbs-sbir-scoring.md.
 */
const AGENCY_ABBREVIATIONS: Readonly<Record<string, string>> = Object.freeze({
  dod: 'department of defense',
});

export function normAgency(v: string | null | undefined): string {
  const rewritten = norm(v)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\bdept\b\.?/g, 'department')
    .replace(/\bhq\b/g, 'headquarters')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return AGENCY_ABBREVIATIONS[rewritten] ?? rewritten;
}
```

`AGENCY_ABBREVIATIONS` is **not exported** — matching this file's existing convention that only
`normAgency` itself, not its internal helpers (`norm`, `normCode` are also private), is part of the
public surface. Callers only ever need `normAgency`'s behavior, never the table directly.

**Why ship only `dod` now, not all eleven SBIR/STTR-participating agencies:** `dod` is the only
entry proven end-to-end against real data in this repository (real SBIR capture confirms the
source abbreviation; existing `award-history-identity.spec.ts`/`client-opportunity-profile.spec.ts`
fixtures confirm the award-history target string). The other ~10 SBIR-participating agencies
(HHS, NASA, NSF, DOE, DHS, USDA, ED, EPA, DOC, DOT) are plausible but **unverified** in this
repository — no real SBIR capture record shows them, and no in-repo evidence confirms USAspending's
exact toptier-name string for each (e.g., whether `federal_award.awarding_agency` for an EPA award
reads exactly `'Environmental Protection Agency'`). Per this program's own "build grounded in real
data" discipline, shipping guessed entries alongside a proven fix conflates two different confidence
levels in one change. Recommend shipping `dod` alone here, and tracking verification of the other
ten as an explicit fast-follow — see [§10](#10-open-questions--follow-ups).

### 5.2 Migrate forecast off its private copy — `forecast-opportunity-read.service.ts`

**Delete** the private `normAgency` function and its doc comment (current lines 251–267 — the
"Agency-name comparison form" docblock through the closing brace).

**Add** an import alongside the file's existing five sibling imports from this same directory
(after any of the existing `from './...'` lines near the top, e.g. after line 24's
`FundingOpportunitiesService` import):

```ts
import { normAgency } from './sam-opportunity-relevance.js';
```

**No other change in this file.** `deriveForecastSignals` (lines 298–349) calls `normAgency` at
lines 319 and 321 exactly as before — only the function's *definition* moves; every call site is
untouched, since the imported function has the identical name and signature. The file's own private
`norm` (line 203) and `normCode` (line 198) are **not** touched — both remain in independent use by
`containsWholeToken` (lines 222–227) and NAICS/PSC comparison (lines 303, 307), unrelated to agency
matching.

This single import-swap simultaneously: (1) closes the B-4 finding (forecast gains the working
parenthetical-strip, for free, because it now runs the canonical implementation), and (2) means
forecast automatically benefits from the `dod` abbreviation expansion too, with zero additional
code.

### 5.3 What does NOT change

- `generate-sbir-opportunity-candidates.ts` — already imports and calls the canonical `normAgency`
  correctly (line 47, 433, 453). **Zero changes needed to this file.**
- `sbir-relevance.ts` / `sbir-relevance.spec.ts` — the pure scorer's rule table is already correct
  (confirmed by full read, [§4.1](#41-the-mismatch-proven-against-real-data)). **Zero changes
  needed.**
- `AGENCY_SECTOR_MAP` (`packages/shared/src/index.ts`) and `ACRONYM_EXPANSIONS`
  (`apps/api/src/intelligence/term-expansion.ts`) — left exactly as-is; wrong tool for this job (see
  [§4.2](#42-repo-wide-inventory-every-agency-name-comparison-found)), not touched, not imported
  from.

---

## 6. Bug 2 — downstream consequence: purely additive

Unlike Bug 1, this fix carries **no regression risk to existing behavior** and no "goes quiet"
counterpart:

- `generate-sbir-opportunity-candidates.spec.ts`'s entire happy-path fixture set uses **identical,
  already-matching full-name strings on both sides** (`topicRow()`'s default `agency: 'Defense
  Health Agency'` against `makeFake({ contractAgencies: ['Defense Health Agency'] })`) — confirmed
  directly by reading the file. `AGENCY_ABBREVIATIONS['defense health agency']` is undefined, so the
  lookup falls through to the unchanged `rewritten` value via `?? rewritten` — every existing
  passing test that does not involve an abbreviation is bit-for-bit unaffected.
- `sam-opportunity-relevance.spec.ts`'s existing `test.each` for real SAM spellings (lines 84–95)
  and the "does not invent matches between different agencies" test (line 97+) exercise strings
  that never hit the new abbreviation table either — unaffected.
- The fix only makes **new** matches succeed that previously, incorrectly, did not. There is no
  path by which adding `dod → department of defense` causes a previously-true comparison to become
  false, or vice versa for any non-`'dod'`-shaped input.
- Net effect once shipped: SBIR/STTR topics sponsored by DOD-family agencies (the majority of real
  SBIR/STTR topic volume) become matchable against a client's real DoD contract history for the
  first time — this rail goes from "structurally zero DIBBS-adjacent" to "correctly produces
  `monitor`/`pursue` rows where genuine history exists," the opposite direction from Bug 1's
  consequence.

---

## 7. Implementation order

1. **`sam-opportunity-relevance.ts`** (§5.1) — no dependents need to change first; this is a pure
   additive change to an exported function's internals. Run `sam-opportunity-relevance.spec.ts`
   after this step in isolation.
2. **`forecast-opportunity-read.service.ts`** (§5.2) — depends on step 1 only for having something
   to import; can technically be done in the same commit. Run `forecast-opportunity-read.spec.ts`.
3. **`dibbs-relevance.ts`** (§2.2) — independent of steps 1–2 (different rail entirely); can be done
   before, after, or interleaved. Run `dibbs-relevance.spec.ts`.
4. **`generate-dibbs-opportunity-candidates.spec.ts`** rework (§8.2) — depends on step 3 landing
   first, since several assertions change in response to the scorer's new behavior.
5. Full `apps/api` typecheck + the four touched spec files + `funding-opportunities.boundaries.spec.ts`
   (sanity — confirmed in this session it contains no assertion touching either changed area, but
   cheap to re-run) + `sbir-relevance.spec.ts`/`generate-sbir-opportunity-candidates.spec.ts` (no
   changes expected, run to confirm zero regressions per §6).

Bug 1 and Bug 2 are fully independent — different files, different rails, no shared call site,
except that both plans touch code inside the same `apps/api/src/funding-opportunities/` directory.
They can be implemented and reviewed as two separate PRs, or one, without ordering constraints
between them.

---

## 8. Test plan

### 8.1 `dibbs-relevance.spec.ts`

| Current line(s) | Test | Change needed |
|---|---|---|
| 68–76 | `'capability text ALONE is weak...'` | None — this is the model the CAGE test below is rewritten to match. |
| **85–91** | `'a prior award to the client\'s own CAGE is strong on its own'` | **Invert.** This test currently pins the bug as intended behavior. Rewrite to: `test("a prior CAGE award ALONE is weak: it never reaches pursue and never clears the floor", () => { const result = scoreDibbsRelevance(input({ priorCageAwardHistory: true })); expect(result.machineRecommendation).toBe('monitor'); expect(result.clearsSuggestionFloor).toBe(false); expect(result.reasonCodes).toContain('prior_cage_award_history'); expect(result.primaryReason).toMatch(/DLA award history/i); expect(result.primaryReason).not.toMatch(/on this kind of item/i); });` — the last assertion is the direct regression guard for the misleading prose. |
| 93–101 | `'part-level evidence AND prior CAGE history together raise confidence to high'` | **No change to assertions.** Still true post-fix: `exactNsnMatch: true` alone → Rule 4, `'medium'`; `exactNsnMatch: true, priorCageAwardHistory: true` → Rule 4, `'high'` (via the retained `input.priorCageAwardHistory ? 'high' : 'medium'` conditional). Re-verify after the change; do not assume. |
| 143 | `'a null closing date is not a closure either'` | Uses `priorCageAwardHistory: true` only to reach `'pursue'` as a baseline; unrelated to what it tests. Swap fixture to `input({ closesDate: null, exactNsnMatch: true, clientHasRecordedParts: true })`. |
| 161–169, 172–176 (no change — doesn't assert recommendation), 178–185, 187–195, 197–209 (no change — doesn't assert recommendation), 211–218 | The "closing comparison is by calendar day" block | Every test that asserts `machineRecommendation === 'pursue'` while passing `priorCageAwardHistory: true` as its sole signal (lines 164, 180, 190, 213) needs the same fixture swap as line 143, to keep testing date arithmetic rather than depending on the now-removed strong-CAGE path. Tests that only check `reasonCodes` (line 173) are unaffected. |
| 222–235 | `'a client with no recorded parts gets the gap, on every rule path'` | No assertion change (it only checks `dibbsPartProfileGap`, computed independently of which rule matches) — but note the `input({ priorCageAwardHistory: true })` entry (line 229) now traverses Rule 5 instead of Rule 4. Optional: add one more entry, `input({ exactNsnMatch: true, clientHasRecordedParts: true })`, so the array still covers a genuine Rule-4 path for gap coverage (`clientHasRecordedParts: true` there means the gap should be `null` for that one — adjust the loop or split it out). |
| **275–283** | `'scoreDibbsRelevance admits only rfq and rfp document types'` | Uses `priorCageAwardHistory: true` to reach `'pursue'` so it can assert `strongAction`'s rfq/rfp branching. Swap both fixtures to `exactNsnMatch: true, clientHasRecordedParts: true` — `strongAction` is only ever called from Rule 4 post-fix, so this must reach Rule 4 via real part-level evidence. |
| 375–411 | `'every reason code the scorer can emit is in the declared vocabulary'` | No change. Still iterates `priorCageAwardHistory` as one of six boolean/enum axes (`2*2*2*2*3*2 = 96`); the rule that *consumes* the axis changed, not the axis set. |
| **413–426** | `'the floor is never cleared without part-level evidence or a prior CAGE award'` | **Rename and extend.** This title and permutation set currently *encode* the bug (they deliberately hold `priorCageAwardHistory` out of the loop). Rewrite: rename to `'the floor is never cleared by capability text, buyer history, or prior CAGE award alone — only part-level evidence clears it'`; add `priorCageAwardHistory` as a fourth loop axis (`[false, true]`), doubling the permutation count from 4 to 16; keep the `expect(...clearsSuggestionFloor).toBe(false)` assertion over all 16. This is the direct regression guard for Bug 1 at the pure-scorer level. |

**New test, using real fixture data (per this program's own convention)** — add to a new
`describe` block, sourcing real nomenclature/NSNs directly from the real capture so the regression
guard is anchored to the exact data shape that surfaced the bug, not a synthetic stand-in:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('P1-4/B-1 regression — real captured items, unrelated to the client\'s one real award', () => {
  const capture = JSON.parse(
    readFileSync(
      join(__dirname, '../../src/external/tango/__fixtures__/real-captures/dibbs-contract-capture-2026-08-09.json'),
      'utf8',
    ),
  );

  test('every real open RFQ, scored for a client whose ONLY evidence is prior CAGE history, stays below the floor', () => {
    for (const rfq of capture.rfqs) {
      const result = scoreDibbsRelevance(
        input({ priorCageAwardHistory: true, closesDate: '2099-01-01T00:00:00.000Z' }),
      );
      // Real nomenclature is not read by the pure scorer (that's the producer's
      // job) — this test's point is that NO amount of real, unrelated item data
      // changes the outcome for a client whose only tie is CAGE history: it is
      // always 'monitor', never 'pursue', regardless of which real item this is.
      expect(result.machineRecommendation).not.toBe('pursue');
      expect(result.clearsSuggestionFloor).toBe(false);
      void rfq; // present to document intent; scorer takes no item fields directly
    }
  });
});
```

(Note: `scoreDibbsRelevance` is item-agnostic by construction — it never reads nomenclature/NSN
itself, only booleans a caller establishes — so a real per-item loop at the *pure-scorer* layer is
necessarily a documentation device more than a variable one. The load-bearing real-fixture test
belongs at the *producer* layer, §8.2, where real nomenclature strings actually flow through
`capabilityTextMatch` and real solicitation rows actually get evaluated end-to-end.)

### 8.2 `generate-dibbs-opportunity-candidates.spec.ts`

**Structural note before the table:** this file's fake-Prisma "happy path" fixture
(`cagesWithAwards: ['1ABC2']` matching the default `clientRow()`'s CAGE) is, by the file's own
comment (lines 173–178), **the only way any test in this file reaches a `create`/`refresh`
outcome**, because `exactNsnMatch`/`exactPartNumberMatch`/`clientHasRecordedParts` are hardcoded in
production code with no test seam. After this fix, per [§3](#3-bug-1-downstream-consequence-dibbs-goes-quiet),
that path can never clear the floor. Recommended resolution, consistent with this codebase's
existing `jest.mock('../src/external/legiscan/legiscan.client.js', ...)` precedent
(`sync-legiscan-bills.spec.ts:26`, confirming module-mocking of a relative `.js`-suffixed sibling is
an established pattern here): mock `scoreDibbsRelevance` for the subset of tests whose actual
purpose is proving the producer's *wiring* (row shape, error handling, idempotency), which is a
different concern from proving the *scoring rules* (owned by `dibbs-relevance.spec.ts`, §8.1). This
is the architecturally-intended seam — this program deliberately separates pure scorers from impure
producers specifically so each can be tested independently of the other.

Add near the top of the file, alongside the existing fixture builders:

```ts
jest.mock('../src/funding-opportunities/dibbs-relevance.js', () => {
  const actual = jest.requireActual('../src/funding-opportunities/dibbs-relevance.js');
  return {
    ...actual,
    scoreDibbsRelevance: jest.fn(actual.scoreDibbsRelevance),
  };
});
```

— defaulting to the REAL implementation (so tests that don't override it keep exercising real
rules), with individual wiring-only tests able to do
`(scoreDibbsRelevance as jest.Mock).mockReturnValueOnce({ ...a full, valid, clearsSuggestionFloor: true result... })`
where they specifically need to prove create/refresh mechanics independent of whether today's data
can produce that result.

| Current line(s) | Test | Change needed |
|---|---|---|
| 49–87 | `describe('the confidence-bridge invariant...')` | Line 68's `{ priorCageAwardHistory: true }` entry must be **removed** from the "clears the floor" `test.each` list (it no longer does). Line 71's `{ exactNsnMatch: true, priorCageAwardHistory: true }` **stays** in that list (still clears the floor, still not-low confidence). Merge the removed case into the existing weak-evidence test (lines 82–86): add a second assertion there for `priorCageAwardHistory: true` alongside the existing `capabilityTextMatch: true` case, both expecting `clearsSuggestionFloor: false` / `'low'`. |
| 173–178 | Comment + `cagesWithAwards` default | Update the comment to state the post-fix reality: CAGE history alone can no longer clear the floor for anything; the default fixture now exists only to test the CAGE-query mechanics (case/whitespace-insensitivity, once-per-client), not to drive a happy path. |
| 246–255, 271–286, 288–293 | CAGE-query mechanics tests | **No change** — these assert on `cageQueries` / direct `hasPriorCageAward` calls, never on `r.created`. |
| **257–269** | `'a matching CAGE is found case- and whitespace-insensitively'` | Currently proxies through `r.created === 1`. Rewrite to assert the mechanism directly instead of through the now-gone floor-clearing side effect — e.g. mock `scoreDibbsRelevance` to return a `clearsSuggestionFloor: true` stub and assert `created` still fires for the whitespace-mismatched CAGE, OR (simpler, no mock needed) assert on `cageQueries` having matched (this fact is already covered more directly by line 288's dedicated `hasPriorCageAward` unit test — consider deleting this test as redundant once the direct test's coverage is confirmed sufficient). |
| **296–317** | `'a candidate row is always keyed on a SOLICITATION tangoDibbsId...'` | Needs the mock from above: `(scoreDibbsRelevance as jest.Mock).mockReturnValue({ machineRecommendation: 'pursue', recommendationConfidence: 'medium', primaryReason: 'stub', primaryRisk: null, recommendedNextAction: 'stub', reasonCodes: [], clearsSuggestionFloor: true, dibbsPartProfileGap: null })` before calling `generateDibbsCandidates`, so the `create` path fires. Assertions unchanged otherwise. |
| **321–333** | `'a dry run reports REAL counts and writes nothing'` | Split in two: (1) keep this test with the **default** (now-unmocked) fixture, updating the expectation to `r.created === 0` / `r.skipped` reflecting `skip_below_floor` — proving dry-run fidelity for the new, correct "nothing qualifies" reality; (2) add a second dry-run test using the `scoreDibbsRelevance` mock (clearsSuggestionFloor: true) proving dry-run still correctly predicts a `create` count of 1 without writing, when something WOULD qualify. |
| **335–357** | `'--commit writes a suggested, producer-owned row with the generic identity only'` | Needs the mock (as in the 296–317 row) to keep proving field-mapping correctness independent of whether real CAGE-only data can trigger it today. |
| **386–410** | `'re-running over its own row is idempotent: refresh, not a duplicate'` | Needs the mock to keep this exact test alive AND — separately, additively — add a new, unmocked test that is the direct proof the fix's consequence is handled correctly: `test('an existing suggested row whose only evidence is prior CAGE history is marked stale on the next run, not refreshed', async () => { /* existing: [{ ...workflowStatus: 'suggested', userCreated: false, evidenceSourceType: 'deterministic_relevance_v1', staleAt: null }], default CAGE-matching fixture */ const r = await generateDibbsCandidates(prisma, { ...commit: true }); expect(r.markedStale).toBe(1); expect(r.refreshed).toBe(0); }); ` — this is the direct, permanent regression test for the "existing suggestions go stale" half of §3's consequence. |
| 412–435 | `'a pursued row is never touched, and is counted as preserved'` | **No change** — the human-decision short-circuit in `decideProducerAction` runs before the floor check; unaffected by this fix regardless of mocking. |
| 437–511 | Tenant/client scoping, pagination, resume-cursor tests | **No change** — none depend on create/refresh outcomes. |
| **513–534** | `'one failing pair does not abort the rest of the run'` | Needs the mock (`clearsSuggestionFloor: true`, returned from every call) so `.create()` is actually invoked and can be made to throw on its first call, exactly as today, to keep proving per-pair error isolation. |
| 537–552 | `describe('resolveTenantIds', ...)` | No change — unrelated to scoring. |

### 8.3 `sam-opportunity-relevance.spec.ts`

Add immediately after the existing real-spelling `test.each` block (current lines 84–95), before
the "does not invent matches between different agencies" test:

```ts
// SBIR's raw provider `agency` field is a bare top-level department
// abbreviation ('DOD'), never sub-tier or full-name shaped — confirmed on the
// real capture fixture (5/5 records), see
// apps/api/src/external/tango/__fixtures__/real-captures/sbir-contract-capture-2026-08-09.json.
// P1-5/B-2: before AGENCY_ABBREVIATIONS, normAgency's rewrites never bridged
// an abbreviation to the department's own full name, so this never matched in
// production for any DOD-sponsored SBIR/STTR topic — proven by a controlled
// test: 5 matches feeding the literal 'DOD' into award history, 0 matches
// feeding the real 'Department of Defense' / 'DEPT OF THE NAVY'.
test('agency history bridges a bare department abbreviation to the toptier full name', () => {
  const r = scoreSamOpportunityRelevance(
    client({ priorAgencies: ['Department of Defense'] }),
    opp({ agency: 'DOD' }),
  );
  expect(r.matchedSignals.map((s) => s.signal)).toContain('agencyHistory');
});

test('a bare abbreviation does not falsely match an unrelated department', () => {
  const r = scoreSamOpportunityRelevance(
    client({ priorAgencies: ['Department of Health and Human Services'] }),
    opp({ agency: 'DOD' }),
  );
  expect(r.matchedSignals.map((s) => s.signal)).not.toContain('agencyHistory');
});
```

### 8.4 `forecast-opportunity-read.spec.ts`

No existing test breaks (confirmed: the file's only agency-related fixture, line 33,
`departmentName: 'Department of Defense'`, is full-name shaped and passes through the canonical
`normAgency` identically to how it passed through the old private one). Add one regression test
proving B-4 is closed and one proving the abbreviation now works on this rail too, near the
existing `describe('agency history-adjacent signals', ...)`-equivalent block (find via the existing
`priorAgencyHistory`/agency tests in this file and add alongside them):

```ts
test('B-4 closed: a parenthetical-suffixed agency name now matches, same as the SAM rail', () => {
  // Before migrating off the private normAgency, this diverged from SAM's
  // answer for the same input — see FIX-PLAN-dibbs-sbir-scoring.md §4.3.
  const signals = deriveForecastSignals(
    forecastSignalSource({ agency: 'DEFENSE HEALTH AGENCY (DHA)' }),
    forecastSignalProfile({ priorAgencies: ['Defense Health Agency'] }),
    { knownVehicleAccess: false, vehicleFitEnabled: false },
  );
  expect(signals.priorAgencyHistory).toBe(true);
});

test('a bare department abbreviation now matches too, via the shared normAgency', () => {
  const signals = deriveForecastSignals(
    forecastSignalSource({ agency: 'DOD' }),
    forecastSignalProfile({ priorAgencies: ['Department of Defense'] }),
    { knownVehicleAccess: false, vehicleFitEnabled: false },
  );
  expect(signals.priorAgencyHistory).toBe(true);
});
```

(Adjust the two helper-constructor names above to match whatever this spec file's actual
`ForecastSignalSource`/`ForecastSignalProfile` fixture builders are named — confirm exact names by
reading the top of `forecast-opportunity-read.spec.ts` before writing; not independently re-verified
in this pass since the file's agency-relevant section was sampled rather than read in full.)

### 8.5 New end-to-end real-fixture test — `generate-sbir-opportunity-candidates.spec.ts`

Per this program's convention (used by `tango-sbir.mapper.spec.ts:311–317`) of running real mapper
output through real code rather than only synthetic fixtures — add a new test using the exact same
`readFileSync`/`JSON.parse` idiom:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('P1-5/B-2 regression — the real SBIR capture actually matches real award history', () => {
  const capture = JSON.parse(
    readFileSync(
      join(__dirname, '../src/external/tango/__fixtures__/real-captures/sbir-contract-capture-2026-08-09.json'),
      'utf8',
    ),
  );

  test('a client with real (full-name) DoD contract history now creates rows for real DOD-agency topics', async () => {
    const realTopic = capture.topics[0]; // { agency: 'DOD', ... } — verified 5/5 in this fixture
    const { prisma, created } = makeFake({
      topics: [topicRow({ agency: realTopic.agency, title: realTopic.title })],
      contractAgencies: ['Department of Defense'], // the REAL award-history shape, not the literal 'DOD'
    });

    const r = await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });

    expect(r.created).toBe(1);
    expect((created[0] as any).matchSignals.reasonCodes).toContain('prior_agency_history');
  });
});
```

(Adjust `topicRow`/`makeFake` field names to the file's actual helper signatures, already confirmed
in [§4.1](#41-the-mismatch-proven-against-real-data) — `topicRow()` defaults `agency: 'Defense
Health Agency'`, so this test explicitly overrides it to the real captured `'DOD'` value. `TENANT`
is the file's existing constant.) This is the single test that most directly proves the fix: real
provider data shape in, real award-history shape in, a real created row out — the exact scenario
that was proven to fail before this fix and must be proven to succeed after it.

---

## 9. Explicitly out of scope

Four related, lower-severity findings from the same review are **not** addressed by this plan
(consistent with `FIX-PLAN-p46-webhooks.md`'s own precedent of scoping tightly and listing
adjacent findings rather than silently ignoring them):

- **B-3 (P2)** — three independent, already-diverged implementations of "capability text match"
  (forecast's whole-token `containsWholeToken` vs. DIBBS's and SBIR's byte-identical substring
  `capabilityTextMatch`, which false-positives on `rope`⊂`EUROPEAN`, `plate`⊂`TEMPLATE`, etc.). Not
  touched here; a real defect, but a different rail (text matching, not agency/CAGE identity) and a
  larger, three-file consolidation this plan's scope does not cover.
- **B-5 (P2)** — `relevanceScore` means a continuous 0–100 weighted score for SAM/grants but a
  three-valued `{90, 60, 30}` confidence-bucket proxy for DIBBS/SBIR, in the same database column.
  Not a scoring-precision bug in the sense this plan addresses (no wrong match, no false floor
  clear) — a display/comparability concern.
- **B-6 (P3)** — two latent double-counts in P41 (`exactNsnMatch`/`exactPartNumberMatch` both
  pushing separate `reasonCodes` for what's really one part identity; `priorCageAwardHistory`/
  `buyerHistory` would double-count if `buyerHistory` is ever implemented, since both would read
  `tango_dibbs_award`). Both are on currently-dormant signals — no live effect until a client parts
  store or buyer-history source exists.
- **The 10 unverified `AGENCY_ABBREVIATIONS` entries** (HHS, NASA, NSF, DOE, DHS, USDA, ED, EPA,
  DOC, DOT) — see [§10](#10-open-questions--follow-ups). Deliberately not shipped in this fix; only
  `dod` is proven.
- **DIBBS dashboards/alerts that treat zero suggestions as anomalous** — flagged in §3 as a likely
  needed follow-up once this fix ships, not designed here.

---

## 10. Open questions / follow-ups

1. **Verify the other ten SBIR-participating-agency abbreviations before adding them.** Run
   `SELECT DISTINCT agency FROM tango_sbir_topic` on `capiro-dev` once more real Tango data has
   synced, or capture a fresh, larger `/api/sbir/` pull via
   `apps/api/scripts/diag-tango-contract-capture.ts`. For each abbreviation confirmed present,
   independently confirm the exact toptier `awarding_agency` string USAspending/`federal_award`
   actually uses for that department (do not assume the textbook full name matches verbatim) before
   adding the pair to `AGENCY_ABBREVIATIONS`.
2. **DIBBS's "GA-ready" definition needs an explicit owner decision** once this fix lands (§3): is
   "correctly produces zero suggestions until a parts store exists" acceptable for the current GA
   milestone, or does it push DIBBS's usable launch behind a client-parts-store deliverable that
   does not currently exist in this schema? This plan fixes the precision bug; it does not resolve
   the product question of whether a quiet DIBBS rail is launchable.
3. **Any operator-facing dashboard, alert, or runbook that currently expects DIBBS to produce
   suggestions** (e.g., the EventBridge schedule drafts under this same `independent-review/`
   folder, or `docs/runbooks/funding-opportunities-rollout.md`) should be reviewed once this fix
   ships, since "zero created rows" becomes the correct steady state rather than a failure signal.
   Not enumerated exhaustively here — flagged for the implementer to check at rollout time.
