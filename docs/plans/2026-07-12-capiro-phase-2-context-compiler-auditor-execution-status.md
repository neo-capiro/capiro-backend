# Phase 2 — Context Compiler v1 + Auditor Enforcement — Execution Status

Companion to Ninja's Phase 2 deployment plan (proposed 2026-07-12). Records what
the current-state audit found (much of §1's "current state" table was already
stale on the day it was written — a parallel effort had shipped more than the
plan's own accounting credited) and what shipped in this pass.

## Headline: the plan's own current-state table was stale before kickoff

Auditing the actual code (not the plan's prose) against `packages/meriv2-core/src/grounding/auditor.ts`
found:

- **All 11 named deterministic checks are already shipped** — D1, D3, D4
  (text + evidence-backed), D4b, D5, D6, D7, D8, D9, D10, D11. The plan's §1
  table said "8 of ~11… missing: D3, D5, D8, D10" — those four were already in
  `runAuditor`'s check list. This eliminates most of 5.1D's scope; see below.
- **5.1A (outreach) and 5.1B (alert-memo) auditor wiring were already shipped**
  — confirmed via `runAuditor` call sites in `engagement.service.ts`
  (`generateBatchEmails`) and `alert-memo.service.ts`, both persisting to
  `meri_audit_ledger` with the correct `surface` tag. Matches Ninja's own
  memory note that #429 already covered this.
- **5.1C (GA-chat persist) was already shipped** — `chat-assistant.service.ts`'s
  `auditReplyShadow` persists to `meri_audit_ledger` with `surface='chat'`.
  Matches memory's note that #430 covered this. Verified via `git merge-base`
  that both commits (`b1f064a`, `94b5d90`) are ancestors of `409061c` — the
  Phase 1 merge already deployed to prod. **G1 and G2 of this phase's exit
  gate were therefore already met at kickoff**, not new work.

Net effect: the real remaining gap wasn't "wire 3 surfaces" — it was narrower
and, in one case, more serious than the plan anticipated (see the regression
below).

## What shipped this pass (branch `feat/phase2-context-compiler-auditor`)

1. **Live regression fix (found during this audit, unrelated to a workstream
   number, fixed as the top-priority item):** `apps/meriv2-orchestrator`'s
   `PrismaService` never received the Phase 1 `withTenantUser` method — it's a
   separate class from apps/api's (same DB, different app). The ONE place in
   the orchestrator reading a private (`visibility='user'`) `memory_items` row
   — `MeriContextResolver.loadUserVoice`, which feeds GA-chat's (the default
   surface for every tenant) per-turn firm/user-voice context — still used
   plain `withTenant`. Under the Phase 1 owner-aware RLS policy that never sets
   `app.current_user`, so it silently returned zero rows for every GA-chat turn
   from the moment the 1C policy went live on prod TODAY (2026-07-12), during
   this same execution's Phase 1 deploy. Users' "My Writing Style" / "My
   Profile" files stopped reaching GA-chat, silently, with no error. **Fixed**:
   added `withTenantUser` to the orchestrator's `PrismaService` (mirrors
   apps/api's exactly) and converted `loadUserVoice` to use it. Regression test
   added (`meri-context.resolver.spec.ts`) asserting `withTenantUser` (not
   `withTenant`) is called with the right tenant/user ids and that the private
   row's content actually reaches `MeriContext.userVoice`.
2. **5.2A-0 — outreach's single-record path had the SAME `clientContext`
   silent-drop bug PR #405 fixed on the batch path, still live.**
   `EngagementService.outreachContext()` (used by `generateOutreachDraft`, the
   single-record/meeting-linked draft path — distinct from the batch/campaign
   generator) assigned `clientContext` as a raw object; PromptSpec v2's
   `nonEmptyStr()` only renders strings, so it silently dropped to nothing.
   Confirmed reachable: `generateOutreachDraft` is a single, ungated code path
   — whenever `OUTREACH_PROMPT_SPEC=v2` is live for a tenant (it is, per prior
   work), any client-scoped single-record draft went through this silently
   degraded. **Fixed**: reused the existing `renderClientRelationshipSnapshot()`
   helper (the exact fix already applied to the batch path), so both outreach
   generation paths now share one rendering behavior for this field.
3. **5.2C — alert-memo's frozen-snapshot gap (RC3), coupled with the
   already-shipped 5.1B per the plan's own D5.** `AlertMemoService.generate()`
   only ever had the alert's frozen Feed snapshot as ground truth — its own
   code comment admitted "there's no live get_bill_status… call here." Fixed
   by reusing `EngagementService.billTruthBlock()` (made non-private; already
   the single source of truth for outreach's bill-truth block, so this avoids
   building a second bill-status query for a third surface): the alert-memo
   now (a) fetches the bill's CURRENT status live when the alert resolves to a
   real bill, (b) injects it as an explicit, dated "CURRENT status… supersedes
   any earlier snapshot" claim into the fact sheet the LLM drafts from, and (c)
   builds a real `get_bill_status`-shaped ledger entry from the SAME live data
   for the auditor — so `checkFailedRuleFraming` / `checkSponsorExistence` /
   `checkAsOfFreshness` are no longer checking the memo against its own frozen
   input. Best-effort throughout (a lookup failure — hearing-only alert, DB
   miss, error — never blocks memo generation; the pre-existing `scaffold()`
   fallback is untouched). 4 new tests cover: live status reaches the prompt
   and supersedes the stale snapshot; a hearing-only alert never attempts the
   lookup; a lookup failure doesn't block generation; and — with
   `MERI_AUDITOR_MODE=shadow` — the ledger now carries the live
   `get_bill_status` entry and the auditor's D6 check fires against it.

All three land as small, additive, well-tested changes: `pnpm --filter
@capiro/api typecheck` and `pnpm --filter @capiro/meriv2-orchestrator
typecheck` both clean; the full apps/api suite (272 suites / 2694 tests) shows
zero regressions from these changes (7 pre-existing failing suites are in
`program-element/extractors/bill-pe-extractor` — confirmed via `git log`/`git
diff` to be untouched by, and unrelated to, this work).

## The real remaining gap: enforcement has no teeth on ANY surface yet

This is the single most important finding of this pass and the natural next
step. `runAuditor`'s `decisionFor()` already computes a real decision —
`deliver` / `deliver_with_flags` / `repair` / `hold` — and already hardcodes
outreach/alert/research as fully-blocking under `enforce` (any finding →
`hold`). But **none of the four wired call sites act on `verdict.decision`**:

- Legacy chat (`meri.service.ts`) and GA-chat (`chat-assistant.service.ts`):
  log + persist only, regardless of decision.
- Outreach (`generateBatchEmails`) and alert-memo (`AlertMemoService.generate`):
  under `annotate`/`enforce`, both only prepend an internal-only warning note —
  identical behavior whether the computed decision is `deliver_with_flags`,
  `repair`, or `hold`. A draft or memo is never actually withheld.

Practically: **flipping `MERI_AUDITOR_MODE` to `enforce` today would change
nothing observable on any surface.** This is currently harmless — no tenant is
in `enforce` — but it means this phase's own G3 exit criterion ("a held draft
is genuinely blocked, not merely logged") is not met anywhere, and won't be
until the callers branch on the decision. Building real hold/repair behavior
touches user-facing send/delivery semantics on 3 different surfaces with 3
different UI implications (a blocked campaign send vs. a memo that doesn't
auto-file vs. a chat reply that gets repaired/retried) — that's a deliberate,
reviewable change in its own right, not something to bundle into this same
pass. **Recommended as the next concrete step**, scoped per surface:
alert-memo first (simplest — skip auto-file, return a `heldForReview` result
field instead of a completed memo; already has an analogous `lowConfidence`
precedent the frontend understands), then outreach (needs to find the actual
send-gate, not just draft-generation, given `generateBatchEmails` is 2,000+
lines and drafts are already human-reviewed before send — worth confirming
with Ninja where "hold" should actually bite), then the two chat surfaces
(scoped by the user's own Phase 2.5 correction note).

## Not attempted this pass (honest scope cut, not forgotten)

- **5.1D** — now narrowed to exactly 3 net-new checks (D12 enactment-proof,
  D13 legislative-stage-ordering, D14 negative-assertion coverage), since
  D3/D5/D8/D10 turned out to already exist. Not started.
- **5.1E** — per-tenant auditor rollout mechanism (`tenant-flags.ts` entry).
  Not started; also not yet meaningful until the decision-handling gap above
  closes (flipping enforce per-tenant today still wouldn't hold anything).
- **5.2A-1 / 5.2A-2** — consolidating the triplicated firm/user-voice loader
  and extracting outreach's remaining context channels into a shared module.
  Not started. Given today's regression (item 1 above) was caused by exactly
  this kind of triplication living in two different apps, this is now a
  higher-confidence "do it soon" than before, but is real refactor work on a
  2,000+-line method per the plan's own risk note — deliberately not rushed
  alongside everything else in this pass.
- **5.2B / 5.2D** — exposing shared channels to chat as tools, and the
  cross-surface trace-metadata log. Not started.
- Decisions D1–D6 (§3 of the plan): not formally ratified with Ninja; this
  pass's actual choices (shared-gatherer-not-yet-built, reuse
  `billTruthBlock` as the single bill-truth source, defer the rollout
  mechanism) are consistent with the plan's own recommendations, so no
  conflict — but they haven't been said back to Ninja as decisions the way
  Phase 0/1's D-logs were.

## Exit gate — honest status after this pass

- **G1** outreach + alert-memo audited in shadow, correct surface tag — **MET**
  (already shipped pre-kickoff; this pass made 5.1B's data actually meaningful
  via 5.2C).
- **G2** GA-chat shadow findings persist to `meri_audit_ledger` — **MET**
  (already shipped pre-kickoff, verified deployed).
- **G3** at least one surface flipped to enforce for capiro-internal, verified
  to actually block a held draft — **NOT MET**. Blocked on the decision-handling
  gap above, which is now precisely scoped.
- **G4** 3 new deterministic checks, golden-tested — **NOT MET** (D12/D13/D14
  not started; D3/D5/D8/D10 already existed, which is not the same 3 checks
  the gate intends).
- **G5** shared gatherer across chat/outreach/alert-memo — **NOT MET** (5.2A-1/
  5.2A-2/5.2B not started).
- **G6** alert-memo no longer trusts a frozen snapshot — **MET** (5.2C, this
  pass).
- **G7** shared trace-metadata log — **NOT MET** (5.2D not started).
- **G8** per-tenant rollout mechanism in use — **NOT MET** (5.1E not started).
- **G9** zero regressions — **MET so far** (typecheck + full suite clean for
  everything touched this pass).

Three of nine gates met, one materially strengthened (5.1B's data quality via
5.2C), one live regression found and fixed that predates this phase's own
numbering. The decision-handling gap is the highest-leverage next step —
without it, G3/G8 are structurally unreachable regardless of how much of
5.1E/5.2* gets built.
