# Capiro Engagement Program — Canonical Plan Index

**Last updated:** 2026-08-10
**Repository:** `neo-capiro/capirov2`
**Current active implementation stack:** Outreach V3 Phase 6 draft PR #891
**Rule:** current repository contracts and the newest explicitly accepted product artifact beat stale line-number/file anchors in historical plans.

## Start here in a fresh session

Read these files in this order:

1. [`2026-08-10-session-handoff.md`](./2026-08-10-session-handoff.md) — exact current program state, PR stack, what is done, what is not, and the next execution sequence.
2. [`canonical-remaining-work-plan.md`](./canonical-remaining-work-plan.md) — current executable remaining-work authority across Engagement API extraction, Outreach V3, generation/send governance, and final cutover.
3. [`source-plan-provenance.md`](./source-plan-provenance.md) — maps every historical plan filename to its current repo authority and implementation status.
4. Outreach V3 current implementation docs under [`../outreach-v3/`](../outreach-v3/).
5. Engagement API extraction/current-runtime docs under [`../engagement-api/`](../engagement-api/).

Do **not** reconstruct the program from chat history if these files are available.

## Program streams

The Engagement program has four related but distinct plan families. They overlap intentionally; none should be mistaken for the whole program by itself.

### A. Engagement API extraction / Fargate ownership

Purpose: move the existing Engagement Manager request-serving runtime into the dedicated `engagement-api` service while preserving one shared source tree/database and transferring background/external ownership only after request parity is proven.

Current repo truth:

- Phase 1 local runtime landed through merged PR #755.
- Phase 3 full current-UI parity/preview landed through merged PR #781, with accepted Phase 2 dark-runtime work in its ancestry.
- Current runtime/ownership handoffs live under `docs/plans/engagement-api/`.
- Canonical customer routing, background workers, OAuth callbacks, Recall, schedulers, external actions, and legacy retirement remain separate later cutover work unless a current repo handoff explicitly says otherwise.

Historical source filenames are indexed in `source-plan-provenance.md`.

### B. Engagement trust boundary / generation / UX / SOC 2

Purpose: immutable versioned drafts, exact-version audit/approval, durable send intents, at-most-once provider delivery, evidence packets, governed generation, meeting-artifact governance, user-facing exception states, release evaluations, and SOC 2 evidence.

Historical package names:

- `00-engagement-implementation-roadmap-index.md`
- `phase-0-engagement-trust-boundary-plan.md`
- `phase-1-engagement-generation-context-plan.md`
- `phase-2-engagement-ux-completion-plan.md`
- `phase-3-engagement-quality-soc2-validation-plan.md`
- `capiro-engagement-deep-audit.md`

These plans contain critical safety invariants that still govern future Outreach V3 generation/send work, but stale implementation anchors must be reconciled against the current tree before execution.

### C. Engagement context correctness / async generation

Purpose: recipient-isolated Evidence Packets, async parity, durable authorized Intel snapshots, bounded large-batch work, group audience correctness, truthful provenance UX, permanent matrix evaluations, and controlled canary closeout.

Historical package names:

- `phase-0-engagement-containment-client-boundaries.md`
- `phase-1-recipient-evidence-packet-isolation.md`
- `phase-2-async-versioned-generation-parity.md`
- `phase-3-async-intel-authorized-snapshots.md`
- `phase-4-large-batch-context-scaling.md`
- `phase-5-group-audience-correctness.md`
- `phase-6-context-trust-and-provenance-ux.md`
- `phase-7-evaluation-and-ci-release-gates.md`
- `phase-8-production-canary-and-closeout.md`
- `99-independent-review-prompt.md`

The current codebase must be audited phase-by-phase before treating any of these as incomplete; several foundations have already been implemented through other Engagement/Outreach work.

### D. Outreach V3 conversational rebuild

Purpose: Campaign Spec + deterministic commands + thin reasoning + target intelligence + governed context + final conversational UI, followed later by samples/drafts/approval/preflight/send/outcomes.

Current active PR chain:

```text
#822  Revised Phase 1 — shared foundations
  ↓
#862  Revised Phase 2 — Campaign Spec + command engine
  ↓
#881  Revised Phase 3 — thin reasoning gateway
  ↓
#883  Revised Phase 4 — target intelligence
  ↓
#890  Revised Phase 5 — governed context + strategy
  ↓
#891  Revised Phase 6 — conversational planning UI
```

PRs #822/#862/#881/#883/#890/#891 are not equivalent to a completed Engagement-wide production cutover.

## Current visual authority for Outreach V3

The product owner supplied `Outreach V3 (standalone)(2).html` on 2026-08-10 and made it the final layout/interaction authority where it differs from the earlier Figma page.

Frozen artifact SHA-256:

```text
84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453
```

Canonical repo contract:

```text
docs/plans/outreach-v3/revised-phase-6-standalone-layout-supersession.md
```

Non-negotiable rules include:

- one centered workbench, not a permanent desktop chat/work split;
- six user-visible stages: Goal → Targets → Delivery → Context → Drafts → Send;
- Sponsor grouped inside Goal;
- Strategy/planning grouped inside Drafts;
- collapsible Campaign Brief;
- Meri conversation docked across the bottom;
- live Meri question visible beside the composer;
- transcript expands upward over the work without navigation;
- target profile remains nested in target selection;
- mobile is conversation-first with reachable 44px controls;
- model proposals never mutate state without explicit Apply.

## Global safety invariants

These apply across every plan family unless a later explicitly reviewed contract strengthens them:

1. Tenant isolation and user/ethical-wall authorization fail closed.
2. The browser may submit IDs and authenticated user input; it does not own authoritative source bodies or canonical Campaign Spec state.
3. Meri/reasoning may recommend and create pending proposals; it may not directly mutate canonical campaign state or send.
4. A recipient's scoped context may never influence another recipient's draft, plan, verifier, or manifest.
5. A client-scoped source may never enter another client's campaign/draft.
6. Writing guidance is not factual evidence.
7. Every externally sendable draft is an immutable, audited exact version.
8. Real provider delivery requires a durable send intent created before the provider call.
9. Ambiguous/unknown provider outcomes are never automatically retried.
10. Provider/model/S3/network calls do not occur inside database transactions.
11. Regeneration or editing never overwrites an approved immutable version in place.
12. Existing Classic Outreach remains available until an explicit, validated retirement phase.
13. Background workers, OAuth callbacks, Recall, schedulers, and external-action ownership move one subsystem at a time with one active owner.
14. No production/customer feature activation is implied by merging or deploying dark code.

## Merge/deploy policy

Unless the product owner explicitly authorizes it in the current session:

- do not merge stacked Outreach PRs;
- do not deploy to AWS;
- do not apply shared/production migrations;
- do not enable customer V3;
- do not transfer background/external-action ownership.

A Capiro-internal canary is a distinct operation and must preserve a fast Classic/current-owner rollback.
