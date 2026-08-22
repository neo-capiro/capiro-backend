# Phase 27B — Governed Candidate Generation

Phase 27A built signal capture only — a `LearningSignal` is evidence, never
active memory, with no promotion path. Phase 27B adds exactly one new step:
**LearningSignal → governed candidate**. It still promotes nothing into
active memory; that remains 27C (dedupe/conflict resolution) and 27D
(governance integration) work.

## What this is

`LearningSignalCandidateService` (`apps/api/src/learning/learning-signal-candidate.service.ts`)
is the ONE path from a captured signal to a `memory_candidate` row. Nothing
else creates a candidate from a signal — enforced by an extension of 27A's
own architecture guard (`scripts/check-learning-signal-new-bypasses.mjs`).

This is an *extension* of the existing governed-memory candidate pipeline
(`MemoryCandidateService` → `GovernedMemoryCandidateService` →
`SettingsAwareMemoryCandidateService`, `memory-candidate-rules.ts`,
`memory-transition-audit.service.ts`, the `review_request`-based review
workflow), not a parallel one. No `LearningMemoryCandidate` table was
created — `memory_candidate` already had everything 27B needed
(`sourceType`/`sourceId`, `memoryClass`/`memoryAuthority`, a widenable
`source_kind` CHECK, a governed review queue). The one new table,
`learning_signal_candidate_outcome`, is not a second candidate store — it
carries no proposed fact/value, only *why* a signal did or didn't produce a
candidate (the same relationship `memory_transition_audit` has to
`memory_candidate`/`memory_items`, one layer upstream).

## Eligibility

Every signal `LearningSignalCandidateService` looks at gets exactly one
outcome, never silently dropped:

| Eligibility | Trigger |
|---|---|
| `negative_feedback_only` | `signalType === 'crm_finding_rejected'` — always, checked first, unconditionally. A rejected finding is suppression evidence, never a new factual candidate. |
| `ai_only` | `provenanceKind === 'ai_generated_only'` — no human confirmed this. |
| `blocked_by_policy` | `sensitivity === 'restricted'`, or the actor has lost ethical-wall access to the signal's client. |
| `unsupported_scope` | No `proposedMemoryLayer` — doesn't map to any of the five frozen context layers. |
| `insufficient_evidence` | Zero evidence refs, OR a bare Meri thumbs up/down with no note and no reason codes — not every rating becomes memory. |
| `duplicate` | An equivalent pending/active candidate already exists (CRM only — see Dedupe below). |
| `eligible` | Everything else: `meri_feedback_{positive,negative}` with a note or reason codes, or `crm_finding_accepted` with evidence. |

## Never auto-commits

`memory-candidate-rules.ts` gained one new rule,
`memory.learning_signal.requires_review`, checked *before*
`memory.personal.auto_commit`. Every candidate this service proposes goes
through the exact same `MemoryCandidateService.proposeSaveMemory` entry
point every other candidate source uses — but this rule guarantees it always
lands `pending`, regardless of scope. Without this, a Meri user-voice
candidate (naturally `scope: 'user_private'`) would otherwise hit
`memory.personal.auto_commit` and become active memory with zero review —
exactly the "self-learning != self-approving" failure mode the Phase 27
handoff calls out.

## Scope cannot widen

`clientId`/`actorUserId` passed to `proposeSaveMemory` always come from the
loaded `learning_signal` row itself — there is no other input to the
service that could substitute a different identity or client. A CRM finding
about client A can structurally never become a candidate for client B; a
personal Meri signal can structurally never become firm-wide memory (its
`scope` is computed as `user_private` whenever `clientId` is null, `client`
otherwise — never `firm`).

## Provenance and confidence/authority proposal

`packages/meriv2-core/src/learning/candidate-contract.ts` (pure, DB-free,
mirrors `contract.ts`'s style) computes a `{memoryClass, memoryAuthority,
proposedConfidence, confidenceReasons[]}` proposal — never
`firm_approved`/`client_approved` (those require an actual human approval
decision, not a generation-time guess):

- Meri feedback → `user_preference` / `user_asserted`, confidence bumped by
  a note being present and by reason-code count.
- CRM accepted finding → `client_steering` / `external_authoritative` if the
  underlying source is an authoritative registry (`sam_gov`, `lda`),
  otherwise `analyst_verified`. Confidence is driven by source quality, not
  evidence-reference count — corroboration is never mistaken for
  independent verification.

The candidate's `value` is a safe, structured evidence *summary* (signal
type, proposed layer/class/authority, whether a note was left, reason
codes, source system) — never a copy of the note or message body. A human
reviewer sees enough to know what to go look at.

## Idempotency and duplicate detection

- **Signal → outcome**: `learning_signal_candidate_outcome.learningSignalId`
  is unique — at most one outcome per signal, ever. Re-processing a decided
  signal is a same-value no-op.
- **Signal → candidate**: a partial unique index,
  `memory_candidate_learning_signal_source_unique` on
  `(tenant_id, source_id) WHERE source_type = 'learning_signal_capture'`,
  is the database-level backstop against a concurrent double-create race.
  `LearningSignalCandidateService` catches the resulting unique-violation
  and records the outcome against whichever candidate won the race — never
  creates a second one.
- **Exact duplicate** (conservative, CRM-only in 27B): a Fill-with-Meri
  finding is naturally keyed by `(clientId, kind, targetKey)`, so two
  acceptances of "the same fact" collapse onto the first pending candidate
  rather than each producing their own. Meri feedback has no such
  structured key without reading message content (which 27B deliberately
  never copies into a signal) — **semantic near-duplicate detection for
  Meri is explicitly deferred**, not approximated unsafely. This is a
  documented scope boundary, not an oversight: the Phase 27 handoff
  explicitly permits "exact duplicate enforced, semantic duplicate
  detected/flagged for later resolution" as an acceptable 27B posture.

## Processing model

Explicitly batch-triggered (`LearningSignalCandidateService.processBatch`,
invoked from `scripts/run-learning-signal-candidate-generation.ts`), not
wired into the Meri feedback / CRM Fill request path at all. A candidate-
generation failure — for one signal, or the whole batch — cannot affect the
product action that captured the signal in the first place, because it
never runs in the same request or transaction as that action. One failing
signal in a batch does not stop the rest from processing.

## Independent kill switch

`LEARNING_CANDIDATE_GENERATION` (`learningCandidateGenerationEnabled`,
`apps/api/src/learning/learning-signal-candidate.service.ts`) is dark by
default — the opposite default from 27A's capture switch, deliberately:
capturing a signal is inert, but generating a candidate writes a real row
into the governed review queue a human may see. Must be the exact literal
`enabled` to arm, mirroring `governedMemoryLifecycleEnabled`'s
fail-closed convention. Capture and candidate generation are controlled
completely independently — capture can run in production while candidate
generation stays off, or vice versa in a test tenant.

## What this explicitly does NOT do

- No promotion into active memory (`memory_items`/`clio_memory`) — enforced
  by the architecture guard's active-memory ban, unconditional even for the
  one approved candidate-generation file.
- No semantic/embedding-backed duplicate merging.
- No production rollout — both `LEARNING_SIGNAL_CAPTURE` (27A) and
  `LEARNING_CANDIDATE_GENERATION` (27B) ship dark; this PR does not flip
  either flag for any tenant.

## Disclosed gap: conflict flagging against ACTIVE memory (handoff §16)

The handoff asks for a `potential_conflict` flag (reusing
`MemoryCandidate.conflictStatus`, which already exists and defaults
`'none'`) when a signal appears to contradict *active* memory, without
mutating that memory. **This is genuinely not implemented against
`memory_items` in this PR**, and it is a real gap, not a nuance — recorded
here rather than silently left out.

Why: exact-key conflict detection needs a stable key shared between a
candidate and an existing `memory_items` row. The CRM exact-*duplicate*
check above works because it only compares candidates against other
candidates using a key 27B itself controls end-to-end
(`provenance_jsonb->>'kind'`/`targetKey'`). But nothing yet establishes what
slug/key a *committed* `memory_items` row derived from a Fill-with-Meri
finding would carry — that naming convention doesn't exist before this PR,
and inventing one here risks baking in an assumption 27C would have to
unwind. The alternative, semantic matching against arbitrary existing
memory content, is the same embedding-backed capability the handoff
explicitly permits deferring for duplicate detection (§13) — the same
reasoning applies to conflict detection, which is strictly harder (it needs
to recognize opposite claims, not just the same claim twice).

Recommended for 27C, which already owns conflict *resolution*: establish the
slug/key convention Fill-with-Meri-sourced `memory_items` will use (so a
future candidate can exact-match against it), or land the
embedding-backed semantic pass and use it for both duplicate and conflict
detection at once, rather than building two bespoke matchers.
