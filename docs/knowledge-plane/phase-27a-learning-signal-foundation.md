# Phase 27A — Learning Signal Foundation

Phase 27 is "Institutional Learning & Quality": does Capiro learn useful
institutional knowledge from work, govern it correctly, reuse it across the
product, and measurably improve outcomes over time? Phase 27A is the first
of seven planned sub-phases (27A–27G) and covers **signal capture only** —
nothing downstream of capture (candidate generation, dedupe/conflict,
governance integration, quality telemetry, evaluation, canary rollout)
exists yet. See the Phase 27 program handoff for the full roadmap.

## What this is

A `LearningSignal` is evidence that Capiro *may* have learned something
worth considering for future reuse — captured directly from existing
product behavior. It is explicitly **not** active memory:

- Capturing a signal never writes to `memory_items`, `memory_candidate`, or
  `clio_memory`.
- Capturing a signal never changes Context Plane recall, packet compilation,
  or any product operation's output.
- No promotion path exists yet. A signal sits in `learning_signal` with
  `status = 'captured'` until a later phase (27B: candidate generation, 27D:
  governance integration) builds the promotion pipeline.

This is deliberately an *extension* of the existing Context Plane / memory
governance system, not a new one. It reuses:

- The five frozen `SteeringLayer` values (`firm-identity`, `firm-playbook`,
  `user-voice`, `client-steering`, `client-people`) for `proposedMemoryLayer`.
- The `MemoryClass` / `MemoryAuthority` / `MemorySensitivity` vocabularies
  from `packages/meriv2-core/src/memory/governance.ts` for
  `proposedMemoryClass` / `sourceAuthority` / `sensitivity`.
- The existing `memory_candidate` lifecycle machinery as the intended target
  for 27B — nothing here reimplements dedupe, conflict detection, or
  approval state machines.

## Schema

`learning_signal` (`packages/meriv2-core/src/learning/contract.ts` for the
TypeScript contract; `apps/api/prisma/schema.prisma` `model LearningSignal`
for the Prisma model; migration
`20261212010000_learning_signal_foundation`).

Key fields:

| Field | Purpose |
|---|---|
| `tenantId` / `actorUserId` / `clientId` | Scoping. `actorUserId` is always the authenticated caller — never a request-payload value. |
| `sourceSurface` / `sourceObjectType` / `sourceObjectId` / `sourceRunId` | Pointer to the authoritative source object. No body text is ever duplicated here. |
| `signalType` | Closed vocabulary, one adapter per value. |
| `proposedMemoryLayer` / `proposedMemoryClass` | Best-guess proposal only — never acted on in 27A. |
| `evidenceRefs` (`evidence_jsonb`) | `Array<{type, id}>` pointers, never content. |
| `confidence` | Nullable. `null` means "not scored" — 27A never writes `0` as a stand-in for unknown (same invariant as Context Plane's `durationMs.provider`). |
| `sourceAuthority` | Nullable subset of `MemoryAuthority`. Neither 27A adapter sets this — see "What 27A deliberately does not do" below. |
| `provenanceKind` | `human_explicit` \| `human_implicit` \| `ai_generated_only` \| `system_derived`. Drives the anti-feedback-loop guard. |
| `governanceRequirement` | Fail-closed default `human_required`. |
| `idempotencyKey` | Unique per tenant; makes duplicate event delivery a no-op. |

RLS uses the canonical `current_tenant_id()`/`rls_bypass()` helpers from
`20260501000000_init_identity_tenancy` (belt-and-suspenders only — real
tenant isolation is `PrismaService`'s query-extension, same as every other
tenant-scoped table).

## The anti-feedback-loop invariant

> AI output cannot self-corroborate.

`assertNoAiSelfCorroboration()` (contract.ts) and a matching database CHECK
constraint (`learning_signal_no_ai_self_corroboration_chk`) both enforce: a
signal whose `provenanceKind` is `ai_generated_only` can never carry a
human-tier `sourceAuthority` (`firm_approved`, `client_approved`,
`external_authoritative`, `user_asserted`, `analyst_verified`). This closes
the specific loop the Phase 27 handoff calls out: AI output → ingested as a
"signal" → later seen again by the model → mistaken for corroboration →
confidence inflates. Enforced twice (app + DB) so a bug in one layer doesn't
silently defeat the invariant.

## What 27A deliberately does not do

- **No scoring or authority assignment.** Both adapters leave `confidence`
  and `sourceAuthority` `null`. Assigning a confidence score or an authority
  tier is 27B/27D work (candidate generation, evidence strengthening) — 27A's
  job is capture, not judgment.
- **No promotion.** There is no code path from `learning_signal` into
  `memory_candidate`/`memory_items`. The architecture guard
  (`scripts/check-learning-signal-new-bypasses.mjs`) enforces this: nothing
  under `apps/api/src/learning/` may reference `memory_items`,
  `memory_candidate`, `clio_memory`, `MemoryCandidateService`, or
  `MemoryStoreService`.
- **No CRM "correct" adapter.** The Fill-with-Meri product surface has no
  "accept but with this value instead" verb today — only accept/reject/
  restore. A `crm_finding_corrected` signal type would have nothing to hook
  into; adding one is a product feature, not a signal-capture gap.
- **No sixth context layer.** `assertKnownSteeringLayer()` plus a migration
  CHECK constraint both pin `proposedMemoryLayer` to exactly the five frozen
  values.

## Adapters (27A ships exactly two)

1. **Meri explicit feedback** (`apps/api/src/learning/adapters/meri-feedback.adapter.ts`)
   — hooked into `MeriService.recordMessageFeedback`, same transaction as the
   existing `clio_messages.metadata_jsonb.feedback` write. Thumbs-up →
   `meri_feedback_positive`; thumbs-down → `meri_feedback_negative`. The
   user's free-text note is never copied into the signal — only whether one
   was left (`provenance.hasNote`). This is the **personal/user-scoped**
   learning path (`proposedMemoryLayer: 'user-voice'`, or `'client-steering'`
   when the conversation is client-scoped).

2. **CRM Fill-with-Meri accept/reject** (`apps/api/src/learning/adapters/crm-fill-finding.adapter.ts`)
   — hooked into `ClientProfileFillService.applyFindings` (per accepted
   finding, same transaction as `markAccepted`) and `rejectFinding`. This is
   the **client-scoped** learning path (`proposedMemoryLayer: 'client-people'`
   for person findings, `'client-steering'` otherwise). Both hooks are
   best-effort: a capture failure is logged and swallowed, never allowed to
   undo or fail the CRM action it is evidence of.

Both adapters derive `actorUserId`/`tenantId` exclusively from the caller's
`TenantContext` — there is no code path by which a request payload can
attribute a signal to a different user or tenant.

## Operational kill switch

`LEARNING_SIGNAL_CAPTURE=disabled` turns off every capture call, fleet-wide,
with no redeploy (`learningSignalCaptureEnabled()` in contract.ts, checked
first thing in `LearningSignalCaptureService.capture()` before any
validation or DB access). Unlike the governance flags in `governance.ts`
(dark-by-default, armed only by `'enforce'`), this defaults to **enabled**:
capturing a signal is inert observability with no downstream effect yet, so
the safer default is capturing, with an explicit escape hatch if capture
itself ever needs to stop (e.g. unexpected write volume on a hot path).

## Read path

`LearningSignalQueryService` (`apps/api/src/learning/learning-signal-query.service.ts`)
is a minimal, wall-aware read path — `findById` / `listRecentForClient` /
`listRecentForTenant`. There is no review UI yet (that's 27D); this exists
so the ethical-wall invariant ("a walled client's signal cannot escape the
wall") is real and testable now, using the same `clientMemoryAllowed` /
`fetchDeniedClientIds` helpers memory recall already uses, with the same
fail-closed default (an unresolvable or denied client returns nothing, never
falls back to "allow").

## Validation

```
pnpm validate:knowledge-plane:phase26   # unchanged Context Plane gate — must still pass
pnpm validate:knowledge-plane:phase27   # this phase's architecture guard + test suite
```

`phase27`'s architecture guard (`check-learning-signal-new-bypasses.mjs`)
checks, every run:

1. No code outside `apps/api/src/learning/` writes `learning_signal`
   directly (bypassing `LearningSignalCaptureService`) — diff-scoped AND a
   repo-wide census (diff-blind spots don't get a pass).
2. Nothing inside the learning implementation directories references the
   governed-memory write surface (the "no promotion in 27A" invariant).
3. The Prisma model carries `tenantId` (auto-covered by the tenant-scope
   guard) and no vector/embedding column.
4. The migration's `proposed_memory_layer` CHECK constraint lists exactly
   the five frozen layers.

## Rollout

27A ships **signal capture only** — no production behavior changes for any
existing operation, no promotion, nothing user-visible. The safe next step
per the program's own rollout sequence (handoff §27) is: enable capture for
one signal source, verify signal quality in production, *then* move to 27B
(candidate generation). Do not enable both adapters and start building
promotion logic in the same rollout step.
