# Phase 27C — Conflict, Deduplication & Supersession

Phase 27B generated governed candidates from LearningSignals but explicitly
deferred one thing: nothing checked a new candidate against ACTIVE memory
for a near-duplicate or contradiction (its own disclosed gap — no stable
key linked a candidate to a committed `memory_items` row, and real matching
needs the semantic capability the handoff permitted deferring). Phase 27C
closes that gap. It still promotes nothing and resolves nothing — it
detects and flags.

## What this is

`LearningSignalMemoryConflictService` (`apps/api/src/learning/`) is a new,
read-only search step `LearningSignalCandidateService` runs for every
eligible candidate: does this candidate's real fact text match something
already in active memory? It reuses the existing embedding infrastructure
(`context_embeddings` ⋈ `memory_items`, Titan via `embedText`) — the exact
pattern already proven by `MeriToolsService.searchMemory` /
`MeriService.projectionRecall` — extracted into its own service rather than
copied a third time, not a new embeddings stack.

## The core example

```
Active memory:  "Client wants monthly congressional updates."
New candidate:   "Client wants weekly congressional updates."
```

These embed as highly similar (same topic) but are NOT the same text after
normalization — `classifyMemoryConflictMatch` returns
`probable_contradiction`. The candidate is still created (eligible), with
`contradictsMemoryItemId` pointing at the active item and `conflictStatus:
'open'` — **on the candidate only**. The active item is never read for a
write, never updated, never superseded. Both records persist, each with its
own provenance; a human reviewer decides what happens next (accept/revise/
reject the candidate, and separately, whether the old item should be marked
stale or superseded — that action goes through the *existing*
`MemoryGovernanceActionService.markStale` / `ImmutableMemoryVersionService`
correction flow a human explicitly drives, not anything this phase calls
automatically).

## Similarity classification

`packages/meriv2-core/src/learning/conflict-contract.ts`, pure and
DB-free — mirrors `candidate-contract.ts`'s style:

| Cosine score | Text equal (normalized) | Classification |
|---|---|---|
| ≥ 0.90 | yes | `duplicate` — corroborates active memory, no new candidate |
| ≥ 0.90 | no | `probable_contradiction` — candidate created, flagged |
| 0.78–0.90 | either | `possible_related` — candidate created, flagged (weaker language) |
| < 0.78 | — | `unrelated` — candidate created normally, no flag |

Deliberately high thresholds: general recall relevance
(`MEMORY_PROJECTION_MIN_SCORE = 0.4`) tolerates loosely-related results on
purpose; near-duplicate/contradiction detection must not, or every vaguely
similar memory would get flagged. "Safe handling when confidence is
insufficient" (handoff) is `possible_related`'s entire reason to exist — a
mid-confidence match is never silently promoted to a confident
contradiction claim.

## What gets embedded — and what deliberately doesn't

The candidate's stored `value` (a safe JSON summary, per 27B) is not
embeddable fact text. `LearningSignalCandidateService.resolveFactText`
fetches the REAL fact text ephemerally, for this one search, never
persisting it anywhere new:

- **CRM** (`crm_finding_accepted`): the finding's `proposed_value_jsonb` —
  structured enrichment data the finding row already durably stores, so
  deriving searchable text from it adds no new exposure.
- **Meri** (`meri_feedback_{positive,negative}`): the feedback note on
  `clio_messages.metadata_jsonb.feedback.note`, fetched only if `hasNote`.
  27A/27B deliberately never copied this note into the signal ("never
  copies the free-text note into the signal — only whether one was left");
  fetching it here for a single throwaway embedding preserves that
  principle — nothing new is written to disk. No note → conflict detection
  is skipped entirely for that signal (unchanged 27B behavior).

## What's compared, and what's deliberately NOT (yet)

- **Candidate vs. ACTIVE memory** (the concrete example, and the primary
  ask): implemented, as above.
- **Candidate vs. PENDING candidates**: unchanged from 27B for CRM (exact
  `(clientId, kind, targetKey)` key match, `findExactDuplicate`) — by
  construction a second pending candidate for the same key can never exist
  (the first one blocks it), so there's no live "two different pending
  values for the same key" case to additionally detect. **Not extended to
  semantic matching for Meri pending-vs-pending** — doing so would require
  either persisting note text somewhere (breaking the privacy principle
  above) or re-deriving it per comparison (real added complexity for a
  narrower payoff than the active-memory case). Documented deferral, not an
  oversight.
- **Semantic near-duplicate matching**: exact + semantic against active
  memory is real; against other pending candidates is exact-only (CRM) or
  absent (Meri). This mirrors the handoff's own explicit allowance —
  conservative exact detection enforced, semantic detection surfaced where
  it matters most first.

## Evidence-lineage independence

Carried forward structurally, not reimplemented: `classifyLearningSignalEligibility`
(27B) already refuses `ai_generated_only` provenance at `eligible`, so
every candidate this phase's conflict detection ever runs against is
already known to be `human_explicit`. A repeated AI generation can never
even reach the comparison step, let alone count as corroboration.

## Explicit supersession — detected, not executed

`old → superseded-by → new` is a real, existing mechanism
(`MemoryItem.supersedesId`, `ImmutableMemoryVersionService.insertVersion`).
Phase 27C does not drive it. What 27C hands forward is the PRECURSOR: a
pending candidate whose `contradictsMemoryItemId` + `conflictStatus='open'`
tell a reviewer (or, later, 27D's governance integration) exactly which
active item this candidate probably supersedes, with full provenance intact
on both sides. Executing the supersession — human-approved, going through
the existing correction/contradiction machinery — is 27D's job, consistent
with "do not add promotion/approval automation yet."

## Architecture guard changes

`check-learning-signal-new-bypasses.mjs`'s active-memory ban is now
verb-scoped rather than a bare-mention ban: a `SELECT ... FROM memory_items`
is legitimate detection work; `INSERT INTO` / `UPDATE` / `DELETE FROM` /
`.create(` / `.update(` / `.upsert(` / `.delete(` against `memory_items` or
`clio_memory` remain banned with zero exceptions, anywhere under
`apps/api/src/learning/`, in every Phase 27 sub-phase. `MemoryStoreService`,
`ImmutableMemoryVersionService`, and `MemoryConflictService` stay
full unconditional symbol bans — 27C detects, it never drives the services
that actually mutate an active item's own state.

## Schema

**No new migration.** `MemoryCandidate.contradictsMemoryItemId` and
`conflictStatus` already existed (Phase 3's
`memory_governance_context_v2`/`memory_governance_lineage`) — previously
populated only by the human-driven correction/contradiction UI flow
(`ImmutableMemoryVersionService`), never by `proposeSaveMemory`. This phase
extends `MemorySaveRequest`/`proposeSaveMemory` (same additive,
backward-compatible pattern as 27B's `sourceType`/`proposedMemoryClass`
fields) so `LearningSignalCandidateService` can populate them too, without
touching the column defaults every other existing caller relies on.

## What this explicitly does NOT do

- No write to `memory_items`/`clio_memory` — read-only search, verb-banned
  even for the one approved file.
- No execution of supersession/staleness on the active item — 27D.
- No semantic candidate-vs-pending-candidate matching for Meri — documented
  deferral (privacy principle).
- No production rollout — `LEARNING_CANDIDATE_GENERATION` stays dark;
  nothing in this phase changes when candidate generation itself runs.
