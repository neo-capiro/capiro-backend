# Outreach V3 Phase 6 — Standalone Layout Supersession

**Accepted artifact:** `Outreach V3 (standalone)(2).html`
**Artifact sha256:** `84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453`
**Accepted by product owner:** 2026-08-10
**Applies to:** Phase 6 visual layout, responsive behavior, component placement, stage grouping, and conversation interaction
**Does not supersede:** canonical Campaign Spec, command authorization, tenant isolation, ethical walls, reasoning proposal-only authority, or Phase 6 generation/send boundaries

## Supersession

The standalone artifact supersedes the earlier Phase 6 Figma page only where the two disagree about layout or interaction placement. Existing Figma assets remain useful component and styling references, but the production Phase 6 workspace must follow this standalone contract.

## Non-negotiable layout rules

1. The desktop screen is **not** a permanent conversation/work split.
2. There is one centered workbench with the active work surface capped at roughly 1060px of content.
3. The conversation is one bar docked across the bottom of the interface.
4. Meri's live turn/question remains visible beside the input on every stage.
5. Full transcript/history expands upward from the dock over the workbench and collapses without navigating away.
6. The Campaign Brief is a collapsible strip: one-line summary when collapsed, detailed labelled fields when open.
7. Only six stages are user-visible: **Goal → Targets → Delivery → Context → Drafts → Send**.
8. Internal checkpoints remain richer: sponsor stays inside Goal; target criteria/coverage stay inside Targets; strategy/planning stays inside Drafts.
9. Target profiles are nested inside the target workbench, never a separate page and never a permanent app-level column.
10. Desktop uses a single work surface; tablet may use a resizable local split inside the workbench; mobile stacks conversation first and work below.
11. Mobile controls retain at least 44px hit targets and the composer remains reachable.
12. A typed instruction never applies itself. It produces a named proposal and the user explicitly Applies or Discards it.

## Phase 6 authority boundary

The standalone depicts later states for samples, drafts, preflight, send, delivery results, interrupted generation, and post-send learning. Those are **future visual states only** until their deterministic backend phases exist.

Phase 6 therefore stops at the planning-ready boundary:

- no representative sample generation API;
- no full draft generation API;
- no approval mutation;
- no preflight/send intent;
- no provider delivery;
- no delivery retry;
- no post-send memory commit.

Typing “send it” must never send from Phase 6.

## Production files owning this contract

- `OutreachV3Route.tsx` — one-workbench shell and six-stage grouping.
- `CampaignBrief.tsx` — collapsible canonical Campaign Brief strip.
- `OutreachConversation.tsx` — bottom conversation dock and expandable history.
- `outreach-v3-standalone.css` — responsive placement, palette, spacing, dock behavior.
- `TargetWorkspace.tsx` — target profile remains nested within target selection.
- `phase6-ui-contract.spec.ts` — permanent no-regression assertions.

## Acceptance

A Phase 6 implementation is visually noncompliant if any of the following are true:

- conversation consumes a permanent desktop column;
- work is split into app-level chat/work/brief columns;
- Sponsor or Strategy appears as an additional top-level stage;
- full transcript navigation replaces the work surface;
- target profile becomes a separate route/page;
- future generation/send controls become functional without their backend authority;
- mobile hides the live question or makes the composer unreachable.
