# HANDOFF — 2026-08-19, closeout pickup

**Read this file first — it supersedes nothing but summarizes everything.** This program now has
a long paper trail across multiple sessions. This document is the single current-state entry
point; the files it points to have the full detail. Goal for whoever picks this up: get this
program to an honest, real "closed" state — not necessarily fully enabled, but with every open
question either resolved or explicitly, deliberately deferred in writing.

**Document trail, oldest to newest** (all in
`docs/plans/funding-opportunities-makegov-v1/`, review-worktree copies are at
`C:\dev\capiro-fo-ga-review-wt\...` — same relative paths):
1. `completion-matrix.md` / `decision-log.md` — the program's own long-running tracking docs (real repo, not the review worktree)
2. `HANDOFF-2026-08-13-ga-review.md` (+ its §10 addendum) — the original 118-finding independent review, then the decisions/PassRole/ECR-pruning/EventBridge-creation saga
3. `IMPLEMENTATION-HANDOFF-2026-08-14.md` — priority-ordered implementation plan for every remaining fix, with `independent-review/FIX-PLAN-*.md` as the detailed backing docs
4. `independent-review/MASTER-FINDINGS-QUEUE.md` — all 118 original findings, severity-ranked
5. `independent-review/completion-matrix-updates.md` — proposed (not yet applied) real matrix edits
6. **This file** — current state as of 2026-08-19, plus what's needed to actually close

---

## 1. Current live state (verified today, not assumed)

**All 7 `fo-dev-*` EventBridge rules are ENABLED** — confirmed live via `aws events describe-rule`
on every one of them, today. Nothing has fired yet (no running/recently-stopped tasks on
`capiro-dev-api-sync-jobs`), but their crons fire daily 13:10–13:35 UTC.

**This is the single most important open question in this document: were the prerequisite fixes
actually applied before these were enabled?** The `IMPLEMENTATION-HANDOFF-2026-08-14.md` plan
explicitly said enablement should wait on: the P46 webhook fix, the DIBBS scoring fix, the SBIR
scoring fix, and the Meri forecast-flag gap. As of this document, **I have no confirmation any of
those four fixes were implemented, merged, or deployed** — only that detailed plans exist for
them (`independent-review/FIX-PLAN-*.md`). If they were NOT applied first:
- `fo-dev-generate-dibbs-opportunity-candidates` risks flooding real clients with false "pursue"
  recommendations the moment DIBBS Award data exists for any client (the proven 1-award→10/10
  false-positive bug).
- `fo-dev-generate-sbir-opportunity-candidates` will likely just harmlessly produce nothing (the
  agency-normalization bug), lower risk but also pointless.
- `fo-dev-process-tango-events` drains a queue fed by a webhook receiver that, per the P46 review,
  silently and permanently drops real deliveries — so it's draining an incomplete/wrong picture,
  though not itself dangerous.

**First action for whoever picks this up: confirm whether those fixes shipped.** Check
`git log origin/main` for merges matching the FIX-PLAN branch names, check the actual
`dibbs-relevance.ts`/`sam-opportunity-relevance.ts`/`tango-webhook.service.ts` content against
what the fix plans specify. If they did NOT ship, seriously consider disabling
`fo-dev-generate-dibbs-opportunity-candidates` specifically (`aws events disable-rule --name
fo-dev-generate-dibbs-opportunity-candidates`) until the scoring fix lands — that's the one with
real client-facing blast radius.

**Live UI inspection performed today** (`os.capiro.ai`, signed in as Neo) — this was explicitly
requested this session (previous handoffs excluded UI validation; this one includes it):

- DIBBS, SBIR, and Agency forecast rails all still show **0 rows** in the Triage Inbox — no
  flooding has happened yet, whatever the reason (crons haven't hit real qualifying data, or
  simply haven't run long enough).
- **New, live bug found**: opening a real Grants.gov opportunity's detail drawer, the
  **Requirements section shows "Requirements failed to load"** — a genuine request failure
  (correctly distinguished from an empty list by the UI's own honest copy: *"This is a request
  failure, not an empty requirement list. Nothing can be concluded about what the solicitation
  requires."*). This is P31 territory (evidence-bound requirement extraction) and needs its own
  investigation — not previously known, found live just now.
- **New, live, unrelated-but-urgent bug**: the page banner reads **"SAM.gov all-federal contract
  opportunities: current to Jul 29 — LAST RUN FAILED Aug 19"** — the core SAM.gov sync (not part
  of the DIBBS/SBIR work at all, one of the original, already-shipped rails) is currently 3 weeks
  stale with a failed last run. Worth its own investigation independent of everything else in this
  document — this affects every client's contract-opportunity data, not just the new rails.
- **Confirmed, NOT a gap**: Budget context (P44) and Risk context (P45) UI components are fully
  built, tested, and wired into `FundingOpportunityDetail.tsx` in both the legacy and vnext page
  trees (`OpportunityBudgetContext.tsx`, `OpportunityRiskPanel.tsx`) — verified via code search,
  not just "didn't see it live." They're correctly invisible because their flags are off, which is
  correct given the underlying data tables are genuinely empty with no ingestion path (see §2).
  **No UI work is needed here** — if these ever get enabled, the frontend is ready.
- **Testing limitation, not a finding**: could not inspect a live DIBBS/SBIR/forecast opportunity's
  own detail page (dead-end source-record link, stale-vs-empty wording) because zero real
  candidate rows exist for any of those three rails right now. The original Band B UI/triage
  review's findings on this (stale/empty state wording, DIBBS/SBIR dead-end links) remain
  un-reverified live — re-check once real candidates exist.

## 2. A separate agent's findings today (not this session, but same program — see below)

A different session/agent reported checking phases in the P37/P38/P44/P45 family. Findings,
independently useful:

- **P38-adjacent (structured Meri assessment) service is real and reaches its handler live**:
  a 586-line service + 586-line schema, model transport genuinely wired in production
  (`meri.module.ts:164`, `.withCompletion(...)` with per-tenant BYOK — confirmed this matters,
  because without it the service would silently report `modelState: 'unavailable'` instead of
  erroring, making any test meaningless). Verified live: an assessment POST went from 404 (flag
  guard) to 400 (`clientId must be a UUID`) once probed with a deliberately invalid body — confirms
  the handler is reached, no tokens spent, no audit artifact written by the probe itself.
- **P44/P45 (budget/risk context) code is real and tested, but the underlying data cannot exist
  yet**: `tango_budget_account`, `tango_budget_vendor_flow`, `tango_procurement_protest`,
  `tango_entity_exclusion` are all at 0 rows, and there is **no ingestion path anywhere in the
  codebase** — only the two migrations that create these tables, the two services that read them,
  and one diag script. That agent correctly stopped short of enabling either flag: a permanently
  empty panel in front of analysts is worse than not shipping. **Recommendation, matches the DIBBS
  precedent**: record this as a known, deliberate, code-complete-but-data-blocked state in the
  completion matrix — not silently ambiguous.
- **Resolved, not a new mystery**: that agent found `/intel-api/feature-flags` reports 16 flags for
  `capiro-internal` vs. 14 rows in the DB table, and flagged the 2-flag gap as unexplained. **It
  isn't** — this program's own earlier review already found the mechanism:
  `feature-flag.service.ts`'s `enabledFor()` hardcodes three bypass extras for the internal tenant
  (`hearing_watch`, `bill_360`, `defense_funding_intel`) beyond whatever's actually in the DB. Two
  of the three are the "extra" flags found; the third (`hearing_watch`) is presumably already a
  real row for this tenant. No further investigation needed here.

## 3. What "close" actually requires from here

In rough order:

1. **Answer §1's question**: were the P46/DIBBS-scoring/SBIR-scoring/Meri-flag fixes applied
   before the EventBridge rules were enabled? If not, decide whether to disable
   `fo-dev-generate-dibbs-opportunity-candidates` until the scoring fix ships.
2. Implement the fixes in `IMPLEMENTATION-HANDOFF-2026-08-14.md` that haven't shipped yet — use
   that document's per-fix session-splitting guidance.
3. Investigate and fix the two NEW live bugs from §1 (Requirements-failed-to-load, SAM.gov
   sync-failed-since-Aug-19) — neither has a plan document yet, both need their own
   investigation-then-fix pass.
4. Apply `completion-matrix-updates.md` for real, and add THREE more decisions that aren't in it
   yet: the "no DIBBS flag" exception, "design-partner acceptance deferred," and now also
   "budget/risk context: code-complete, permanently data-blocked, do not enable" (§2 above).
5. Run the P49 canary — the actual human browser walk. This is the one piece of "UI validation"
   that still can't be delegated to an agent; everything else in this document can be.
6. Continue independent review into the 9 originally-uncovered phases (P05, P20, P21, P31, P37,
   P38, P39, P44, P45) — partially started already per §2, but not with the formal
   `phase-2-independent-live-validation.md` verdict convention the rest of this program uses. Worth
   redoing those two (P38, P44/P45) formally so the matrix can carry a real verdict, not just an
   informal chat report.
7. Once 1–6 are done: that's genuine GA per Neo's own bar ("prove correctness, not completeness").
   Full-catalog ingestion keeps running in the background indefinitely, by design — it was never
   the gate.

## 4. What NOT to do without checking first

- Don't enable anything further (webhooks, additional flags) until §3.1's question is answered.
- Don't run `cdk deploy Capiro-dev-Compute` — confirmed to have caused a real production incident
  (2026-07-25), still true, never revisit this without a much bigger, separate conversation.
- Don't assume silence means safety — this program's single biggest, six-times-independently-confirmed
  finding is that a no-op run reads identical to a healthy one. Verify with real data/logs, not
  absence of errors.
