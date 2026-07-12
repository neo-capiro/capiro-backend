# Capiro Strategic Blueprint → Execution Plan

**Source:** `Capiro_Strategic_Product_and_Growth_Blueprint_v2.docx` ("Strategic Product, Technology and Growth Blueprint," rev. July 12, 2026)
**This document:** a gap analysis of the blueprint against the actual current codebase/product (verified 2026-07-12 via a 9-pillar parallel code audit), followed by a phased execution plan.
**Audience:** Capiro.ai leadership (Ninja + team).

---

## 0. The headline finding

The blueprint reads like a plan for a company starting from zero. **Capiro is not starting from zero.** Across almost every one of the blueprint's 9 architectural pillars, real, load-bearing infrastructure already exists in production or in active build. The central strategic pivot the blueprint asks for — treat governed operating memory as a first-class product pillar — is not a greenfield ask here; it's a **consolidation and finishing** problem layered on top of systems that already do most of the individual jobs.

That reframes the job of this plan. It is not "build the blueprint." It is:

1. **Name the recurring pattern** that shows up in all 9 pillars: deep, correct logic gets built, then stops one step short of live — sitting in shadow mode, unscheduled, unwired, or dead-code-disabled. Closing that last mile is cheaper and faster than any net-new build in the blueprint.
2. **Consolidate fragmentation.** Several pillars have 2–3 parallel systems solving adjacent problems (three separate "memory" stores, two separate LLM-routing layers, a legacy chat agent running alongside its own replacement). The blueprint's "one shared runtime / one Context Compiler / one canonical ledger" thesis is the fix for a fragmentation pattern that is already visible and already causing real incidents (the outreach hallucinations that triggered the audit work were a direct product of surface-divergent context).
3. **Resolve one genuine strategic tension** the audit surfaced: current pricing is flat **$200/client-slot/month** (~$2.4K/client/year), decided by Ninja the same week as this blueprint — roughly 10–40x below the blueprint's proposed $50K–$180K+ **annual** enterprise contracts. This is not an engineering gap. It needs an explicit leadership call (§5).
4. **Treat one pillar as genuinely greenfield** and sequence it last, exactly as the blueprint itself recommends: compliance-filing assistance for Capiro's own clients does not exist in any form today.

---

## 1. Where things actually stand, pillar by pillar

Each row: blueprint ask → verified current reality → what's missing → effort to close.

| # | Pillar (blueprint §) | Current reality (verified 2026-07-12) | What's actually missing | Gap size |
|---|---|---|---|---|
| 1 | **Memory & context governance** (§3.4–3.5, §4.6) | Two real, separate stores: an Institutional Memory layer (`memory_items`/`memory_edges`, live) and RLS-enforced `clio_memory` (`ENABLE/FORCE ROW LEVEL SECURITY`, DB-enforced — already ahead of the blueprint's own Day-0 ask). A third store, `meri_audit_ledger`, shipped *today*. Governance helper functions for purge/redact/export exist in code but **no route calls them**. | One canonical ledger (there are three, unreconciled); a candidate→approval→commit write path (writes are explicitly fire-and-forget today); a Context Compiler (doesn't exist — "EvidencePacket compiler" is an un-started future wave); the 8 user-facing memory verbs (remember/forget/confirm/export — zero exist); cross-surface context parity (4+ surfaces each hand-roll context independently). | **Large** — but ~40% of the DB-enforcement foundation is already done. |
| 2 | **Deterministic validators / hallucination auditor** (§4.4–4.5) | The best-aligned pillar in the company. A real, deterministic (non-LLM) auditor with 8 checks (D1/D4/D4b/D6/D7/D9/D11), a 3-incident golden regression suite, and a persistence table (`meri_audit_ledger`), live in **shadow mode** on 3 surfaces (legacy chat, deep research, GA orchestrator chat). | Enforcement (shadow-only everywhere — nothing blocks bad output yet); the specific checks the blueprint calls out as most novel: enactment-proof (public-law ID + date required before "enacted"), legislative stage-ordering, negative-assertion/coverage checks, deadline-timezone normalization; wiring onto **outreach and alert-memo** — the two surfaces where the original fact-checked incidents actually happened, and the two still unwired. | **Medium** — extend an already-working system, don't build a new one. |
| 3 | **MeriV2 shared runtime / model gateway** (§4.1–4.3) | A real shared orchestrator core (`packages/meriv2-core`) unifies 3 MeriV2 surfaces behind one tool registry, one compliance gate, one LLM client. | The legacy monolithic agent (`meri.service.ts`, ~3,900 lines) still runs chat by default; MeriV2 full-chat is live only for one tenant. No unified model gateway — MeriV2's LLM client is Anthropic-only; a real multi-provider gateway with BYOK already exists but serves **only outreach**, disconnected from MeriV2 entirely. Approval gating is binary (pass/warn/block), not the blueprint's 4-tier risk model. | **Medium-large** — mostly convergence of two things that already work separately. |
| 4 | **Workspace / Artifact Studio** (§6) | A real doc-gen engine (Fargate, `apps/workspace`), 10-product/20-template catalogue that maps well onto the blueprint's own defense-document list, working DOCX/PDF export, version history, collaboration, edit-lock. | **Zero claim-level citations anywhere in generated output.** The one approval-gate mechanism is literally dead code (`gates: []`, hardcoded, comment says "removed — only added friction"). No "context used" panel, no exclusions view, no artifact-approval/memory-promotion split. Several context-sourcing groups are explicit `mock: true` stubs. | **Large** — this is the least-built pillar relative to its blueprint ambition. |
| 5 | **Defense budget intelligence** (§8) | By far the most mature pillar. A genuine provenance-rich graph (`ProgramElement` → `ProgramElementYear` stage ladder → `ProgramElementYearSourceValue` + `SourceDocument`, page-level citations, sha256-versioned source docs). A live precedence/reconciliation engine matching the blueprint's "budget timeline reconciler" almost exactly. A real delta/mark-impact engine (`DeltaEngineService`) computing materiality-scored changes and affected-client fan-out. A 9-rule anomaly detector. | Assembly, not architecture: no single narrative timeline UI stitches request→marks→enactment into one story; the mark-impact engine explains deltas but doesn't propose next actions; the appropriations-conference field is schema-reserved but unpopulated; the email alert rail is built but dark (gated on an unset env var). | **Small–Medium** — mostly finish-the-rollout, not new build. |
| 6 | **Legislative intelligence** (§4.4, alerting) | A real vote/rule truth layer (`deriveBillStatus`) correctly resolves procedurally-failed bills (the H.R.8800 case) instead of reading raw bill text optimistically. All 8 alert emitters are live. A genuine weighted relevance/materiality/urgency/political/priority scorer is computed and persisted per alert. | The computed ranking score is **persisted but ignored** — the web feed hardcodes chronological order (`const order: FeedOrder = 'date'`). "Enacted" is regex-heuristic, not gated on a structured public-law-ID+date field. "No hearings scheduled" is silence-as-evidence with no coverage check. | **Small** — the ranking fix alone is close to a one-line UI change. |
| 7 | **Compliance assistance (for Capiro's own clients)** (§9) | **Genuinely greenfield.** Everything that exists under "compliance/FARA/LD-2" is either (a) ingestion of *other parties'* public federal/state filings as competitive intelligence, or (b) an AI chat-safety guardrail that refuses to help a user evade disclosure rules. Nothing resembling activity capture, jurisdiction rules, a disclosure ledger, or draft-filing generation exists for Capiro's own clients. | Everything in blueprint §9.1. Reusable adjacent infrastructure exists (a generic `AuditLog` table, Outlook/Gmail calendar-email connectors, the Meetings activity model, and the compliance-rules PASS/WARN/BLOCK engine pattern already used for AI-action gating), but the module itself is a from-scratch build. | **Large**, but correctly sequenced last (see §4, Phase 5). |
| 8 | **GTM, packaging, pricing** (§10–11) | Pricing was decided the same week as this blueprint: flat **$200/client-slot/month**, no volume tiers (explicitly removed by a recent Ninja decision), Stripe-metered LLM overage on top. Slot-based billing unit (active client count) already matches the blueprint's "value tied to active client workspaces" principle in spirit. | Everything about the blueprint's tier/ACV structure: no Boutique/Professional/Enterprise tiers, no annual contracts (Stripe is monthly-only), no core-vs-premium entitlement logic anywhere in billing (a dead, unused `planTier` column is the only hook). This is a **strategic pricing decision gap**, not a technical one — see §5. | **Strategic**, not an engineering gap. |
| 9 | **Proactive "Chief of Staff" behaviors** (§3.2) | Meri is overwhelmingly reactive. One real autonomous behavior exists: the Meeting Notetaker auto-drafts a debrief when a transcript completes (one tenant only). | Two features are **fully built and simply never scheduled**: quiet-client detection (30-day cadence gap) and automatic meeting-brief generation — both coded, both registered as runnable verbs, neither has an EventBridge rule. The old in-chat trigger that used to call proactive-alert generation was removed and never replaced with a cron. Outreach-campaign-recommendation, stale-position detection, and coalition-path suggestion are fully aspirational — no code exists. | **Mixed** — two items are a same-week fix; the rest need the memory/context work in Phases 1–2 first. |

---

## 2. The pattern leadership should see across all nine rows

**"Built, but not wired, scheduled, or enforced."** This shows up in every single pillar:

- The hallucination auditor: built, shadow-only, never enforced.
- Legislative ranking: computed and stored, UI ignores it.
- Proactive alerts: coded, registered, never scheduled.
- Memory governance (purge/export/redact): written as pure functions, no route calls them.
- PE budget email alerts: built, gated on an unset env var, dark.
- MeriV2 full chat: built, live for exactly one tenant.

This is not a criticism of engineering quality — the underlying logic is consistently well-built and, per the audit, often *more* sophisticated than the blueprint assumes. It's a signal about where the process leaks: Capiro's execution motion is strong at building and weak at the final "flip the switch, wire the last consumer, schedule the cron" step. **The single highest-leverage move available to leadership is to require a "wired and observed in production" bar before crediting a feature as done** — several items in Phase 0 below cost almost nothing to ship precisely because the hard part is already finished.

The second pattern: **parallel fragmented systems.** Three memory stores. Two independent LLM-routing/model-gateway implementations (MeriV2's Anthropic-only client vs. outreach's real multi-provider gateway). A legacy chat agent running in parallel with its intended replacement. The blueprint's "one shared runtime" thesis isn't abstract architecture — it's the fix for a fragmentation problem that has already caused a real, name-checked incident (the outreach hallucinations that triggered the entire grounding-audit workstream trace directly to context assembled independently, outside any shared contract).

---

## 3. Phased execution plan

Phases can overlap; sequencing reflects dependencies, not calendar exclusivity. Phase numbers replace the blueprint's generic "Days 0-30/31-60/61-90" cadence with sequencing calibrated to what's actually already built.

### Phase 0 — Flip the switches (1–2 weeks, near-zero net-new code)

Every item here is already built; the task is scheduling, wiring, or a config flip.

| Action | What it unlocks |
|---|---|
| Wire the persisted alert-relevance score into `TrackerFeedPanel` (replace hardcoded `order: FeedOrder = 'date'`) | Immediate, real "rank by client impact/deadline/confidence" — blueprint §1.2, no backend work needed |
| Schedule `emit-clio-alerts` (quiet-client + meeting-prep detection) and `generate-meeting-briefings` via EventBridge | Two of the blueprint's named proactive behaviors (§3.2) go from dead code to live with no build |
| Decide the PE alert email canary (`PE_ALERT_EMAIL_TENANTS`) and flip it for capiro-internal | Mark-impact-engine alerts start reaching users |
| Route the existing memory-governance helper functions (`selectForPurge`, `redactSections`, `toManifestRow`) to real API endpoints | First real "forget"/"export" user actions, even before the canonical-ledger consolidation lands |

### Phase 1 — One memory, one ledger (weeks 1–6)

Directly targets Gap #1, the blueprint's own stated top priority ("do not position institutional memory as a moat until private scopes are database-enforced and users can inspect, correct, and revoke memory").

- **Pick the canonical store.** Recommend `memory_items`/`memory_edges` (the Institutional Memory layer) as the canonical ledger — it already has a class taxonomy closest to the blueprint's six memory classes and RLS groundwork. `clio_memory` becomes a write-through/legacy-compatible view feeding it, not a second source of truth. `meri_audit_ledger` stays intentionally separate — it's an audit trail of *claims*, not a memory store, and the blueprint's own model treats those as distinct.
- **Replace fire-and-forget writes with a candidate lifecycle.** Even a minimal version — candidate created → source/provenance attached → duplicate/contradiction check → commit — closes the blueprint's single most-cited anti-pattern.
- **Ship the first real user-facing memory verbs** on one surface only (chat): confirm, correct/supersede, forget. Don't require cross-surface parity yet — that's Phase 2.
- **Finish institutional-memory Phases 3–4** (private fail-closed access, firm-memory governance gate) — both are already scoped with open design questions per the implementation-status doc; they need a decision, not a redesign.

*Gate before calling this done:* private/matter scopes are enforced at the database boundary (not just application checks), and a user can actually click "forget" somewhere and watch it disappear.

### Phase 2 — Context Compiler v1 + auditor enforcement (weeks 4–10, overlaps Phase 1)

- **Build a real Context Compiler** by promoting the existing outreach context builder (already the richest, per its own 2026-07-11 audit: 20+ channels, correctly tiered) to a shared module, then port chat, alert-memo, and eventually Workspace onto it — rather than building a fifth parallel context assembler from scratch.
- **Extend the auditor** with the three highest-value missing checks: enactment-proof (require a structured public-law ID + date field before the "enacted" label), legislative-stage-ordering, and negative-assertion/coverage checking.
- **Wire the auditor onto outreach and alert-memo** — the two surfaces still missing it, and the two where the original incidents happened. Run the shadow→tune→enforce cycle that's already planned, but prioritize enforce-first on these two surfaces (matches the auditor plan's own ADR).

*Gate:* at least chat + outreach + alert-memo consume the same context contract and log the same inclusion/exclusion trace metadata.

### Phase 3 — Make Workspace trustworthy (weeks 8–14)

Workspace is the most visible "core loop" surface and currently the least aligned with the blueprint's trust requirements.

- Add claim-level citations to generated output, reusing the grounding/claim-gate infrastructure from Phase 2's auditor work rather than building a parallel citation system.
- Replace the dead `gates: []` approval mechanism with a real review step tied to a risk tier (low/moderate/high/restricted, per blueprint §3.3).
- Ship a v1 "Context used in this draft" panel — even just listing which memory/context items were pulled in delivers most of the trust value; the exclusions view can follow.
- Close the one-way flow: an approved artifact should be able to propose a memory candidate back into the Phase-1 ledger, reviewed separately from artifact approval (blueprint §6.4's central point).

### Phase 4 — Finish the moat, converge the runtime (months 3–6)

- Assemble the already-strong PE data/delta/anomaly pieces into one narrative "request → marks → enactment" artifact per program element — this is UX/assembly work, not new data modeling.
- Flip the PE email rail + web toggle fully live; populate the appropriations-conference field; extend the mark-impact engine to propose next actions, not just explain deltas.
- Converge the two LLM-routing systems: give MeriV2 the multi-provider/BYOK gateway that outreach already has, instead of maintaining both.
- Finish the legacy→MeriV2 chat migration for all tenants; build the real 4-tier approval-risk model on top of the existing binary gate.

### Phase 5 — Business-track items (months 3–12, parallel to Phase 4)

- **Pricing reconciliation** (needs a leadership decision — see §5 below) — at minimum, introduce a tier/entitlement *architecture* now (even before dollar amounts move) so defense-budget-intel and any future compliance module can be gated as premium add-ons without a later re-platform.
- **Compliance-assistance module** — genuinely greenfield; correctly sequenced last, per the blueprint's own gate ("do not broaden beyond the defense wedge until context consistency is demonstrated"). Scope a narrow pilot (e.g., LD-2 prep for 1–2 design partners) only after Phases 1–3 land.
- **Remaining proactive behaviors** (outreach-campaign recommendation, stale-position detection, coalition suggestion) — these genuinely need the Phase 1 ledger and Phase 2 Context Compiler to exist first; don't attempt them earlier.

---

## 4. Decisions that need Ninja / leadership (not engineering calls)

1. **Pricing model.** Hold the current flat per-slot SaaS pricing, or move toward the blueprint's workspace/annual-contract enterprise model? This was just decided (2026-07-06/07) — flagging the tension now rather than silently proposing a reversal.
2. **Canonical memory store.** Confirm (or override) the recommendation to make `memory_items` canonical and `clio_memory` a derived view.
3. **Auditor enforce-first surface.** Confirm outreach + alert-memo as the first surfaces to flip from shadow to enforce, ahead of legacy/GA chat.
4. **Compliance-assistance timing.** Confirm it stays sequenced in Phase 5 (post core-loop trust work) rather than pulled forward.
5. **MeriV2 full-chat rollout.** Confirm timeline for moving the remaining tenants off the legacy `meri.service.ts` agent.

---

## 5. The pricing tension, stated plainly

The blueprint assumes annual, workspace-based enterprise contracts ($50K–$180K+/year). The live product bills **$200/client-slot/month** — for a 10-client boutique firm (the blueprint's own "Boutique" example), that's ~$24K/year against a blueprint band of $50K–$90K. This isn't a rounding difference; it's a different pricing category (usage-metered SaaS vs. enterprise-contract).

Two honest paths, not a recommendation to pick one silently:
- **Hold current pricing** and treat it as a deliberate low-friction-adoption wedge strategy, revisit once outcome/time-saved metrics (blueprint §12.6) exist to justify a premium ask.
- **Move toward tiered annual contracts** as the product's trust/governance surfaces (Phases 1–3) come online — but this is a go-to-market and finance decision, not something this plan should resolve unilaterally.

Either way, building the entitlement/tiering *architecture* in Phase 5 is cheap insurance — it doesn't force either pricing outcome, it just avoids a re-platform later.

---

## 6. Metrics to start instrumenting now

Borrowing the blueprint's own framework (§12.6), scoped to what's actually measurable today:

- **Surface context parity**: # of {chat, outreach, workspace, alert-memo} on the shared Context Compiler (currently 0 of 4 — track to 4).
- **Auditor coverage × enforcement**: checks live (currently 7 of the ~10+ the blueprint implies) × surfaces wired (3 of 5) × mode (shadow only today — track first enforce flip).
- **Memory-verb coverage**: of the 8 blueprint verbs (use-once/remember/remember-for-client/propose-for-firm/confirm/correct/forget/export), how many exist as real user actions (0 today).
- **"Built but dark" backlog**: track the Phase-0 punch list to zero, then keep the list at zero going forward as a process discipline, not a one-time cleanup.
- **Citation coverage in Workspace output**: % of generated artifacts with at least one inline source citation (0% today).

---

## 7. Risks specific to Capiro (not the blueprint's generic list)

- **Fragmentation compounds if Phase 1–2 slip.** Every month the 3 memory stores and 2 LLM-routing systems stay unreconciled, more surfaces get built on top of one or the other, raising the eventual consolidation cost.
- **Shadow-mode auditor findings are accumulating unread.** If the shadow-observation cycle isn't actively monitored, the tuning data needed to safely flip to enforce goes stale or gets ignored, and the "detection layer complete" status quietly becomes "detection layer built, nobody's looking."
- **Pricing tension left unresolved reads as strategy drift** to anyone comparing this blueprint to the live Stripe configuration — worth resolving explicitly (§5) before this blueprint circulates further, rather than let the contradiction sit.
- **The "built but not wired" pattern is a leading indicator, not just a backlog.** If Phase 0 isn't treated as a forcing function to change how "done" is defined, the same pattern will recur in Phases 1–4.
