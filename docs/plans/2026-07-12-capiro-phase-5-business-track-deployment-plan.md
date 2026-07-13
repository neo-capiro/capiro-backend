# Phase 5 Deployment Plan — Business-Track Items (Pricing, Compliance, Remaining Proactivity)

**Source documents:**
- [`docs/plans/2026-07-12-capiro-strategic-blueprint-execution-plan.md`](2026-07-12-capiro-strategic-blueprint-execution-plan.md) — Phase 5 ("Business-track items, months 3–12, parallel to Phase 4") **and its §5 pricing-tension section, which this phase's §5.1 resolves.**
- `Capiro_Strategic_Product_and_Growth_Blueprint_v2.docx` — §9 + Table 40 (compliance capability model), §9.2/§9.3 (guardrails + workflow), §11 + Table 45 (pricing tiers), §11.1 (pricing principles), §5.4 (access/retention/deletion), §3.2 (proactive behaviors), §12.5 gate #6 ("do not broaden beyond the defense wedge until context consistency is demonstrated across the three flagship workflows").
- [`docs/plans/2026-07-12-capiro-phase-1-memory-ledger-deployment-plan.md`](2026-07-12-capiro-phase-1-memory-ledger-deployment-plan.md) + [Phase 2](2026-07-12-capiro-phase-2-context-compiler-auditor-deployment-plan.md) — the ledger + Context Compiler that this phase's proactive-behavior workstream hard-depends on.
- [`docs/plans/2026-07-12-capiro-phase-3-workspace-trustworthy-deployment-plan.md`](2026-07-12-capiro-phase-3-workspace-trustworthy-deployment-plan.md) — its risk-tier work is the precedent this phase's entitlement/compliance-gating reuses.

**Status:** PROPOSED — but note this phase is unusual: two of its three workstreams are **gated on non-engineering decisions** (a leadership pricing call, and qualified legal-counsel review of compliance rules), and the third is **gated on Phases 1–2 shipping**. This document is as much a sequencing-and-decision framework as an engineering plan.

---

## 0. Why this phase is different from Phases 1–4

Phases 1–4 were engineering plans with leadership decisions sprinkled in. Phase 5 inverts that: it is **three business/strategy tracks that happen to require engineering**, not the reverse. Each of its three items is blocked on something other than code:

1. **Pricing/entitlement** — blocked on a genuine, unresolved leadership decision (hold the flat $200/slot wedge vs. move to the blueprint's $50K–$180K+ annual enterprise tiers). The gap-analysis plan's own §5 explicitly refuses to resolve this and flags it for Ninja. This phase does **not** resolve the dollar amounts either — it builds the *entitlement architecture* that keeps either choice cheap, which is the one part that is safe to build regardless.
2. **Compliance-assistance module** — genuinely greenfield (verified: nothing for a tenant's *own* filings exists), and the blueprint is emphatic it must be counsel-reviewed, jurisdiction-versioned, and never auto-file. It is also gated by the blueprint's own §12.5 gate #6: don't broaden beyond the defense wedge until the core loop's context consistency (Phases 1–3) is demonstrated. So it is correctly sequenced last, as a narrow piloted build, not a big-bang.
3. **Remaining proactive behaviors** (campaign-recommendation, stale-position detection, coalition suggestion) — hard-blocked on the Phase 1 ledger and Phase 2 Context Compiler existing first; there is no code today and building them earlier would mean building on sand.

The honest framing for whoever scopes this: **most of Phase 5 is "wait for a decision or a dependency, then execute a well-scoped piece"** — not a continuous engineering sprint. The one genuinely large *build* is the compliance module, and it should be piloted narrowly before any general availability.

---

## 1. Current-state verification (code-verified 2026-07-12)

| Area | State | Evidence |
|---|---|---|
| Pricing model (live) | **Flat $200/client-slot/month, volume tiers explicitly REMOVED.** `CLIENT_SLOT_TIERS = [{minSlots, pricePerSlotUsd: 200}]` — a single tier; the code comment states the prior $180/$160 volume tiers were deliberately removed ("volume discounts are contact-sales only, never automatic"). 12-month price lock. LLM allowance $20/slot pooled, overage at 2×. Billing owned by the separate `onboard-api` service; `apps/api` is a billing reader (slot-limit 402 only). | `packages/shared/src/index.ts:442-489`; `project_billing`/`project_onboarding_v1` memories. |
| Entitlement / tier architecture | **Two dead hooks, no live gating.** `Tenant.planTier String @default("FOUNDATION")` (`schema.prisma:155`) is read **only** by one raw diagnostic SQL SELECT (`diag-tenant-config.ts:42`) — no Prisma query selects it, no code branches on it. A second partial hook exists: the `isBillingEntitled` helper (`@capiro/shared` index.ts:502, true for active/trialing/comped) has **no backend runtime guard caller** — only the frontend `SubscribePage` + a spec test reference it. No feature is plan-gated; every entitled tenant gets everything (PE Watch / defense-budget-intel included). The only live billing enforcement is a slot-COUNT paywall (HTTP 402 `CLIENT_SLOT_LIMIT` on client create/import, behind `BILLING_ENFORCED`, bypassed for `comped`) — no plan/feature dimension anywhere. | `schema.prisma:155`, `diag-tenant-config.ts:42`, `@capiro/shared` index.ts:502, `clients.service.ts:123-140`; corroborated by both direct grep and the Phase 5 research workflow. |
| Per-tenant feature flags | `tenant-flags.ts` (`settings_jsonb.clioFeatureFlags`) exists and is used for **rollout/beta gating** (e.g. `outreachClientProfile.enabled`, `meetingsV2.enabled`, MeriV2 surface flags) — **not** for entitlement/plan gating. It's a usable *mechanism* for entitlement, but it isn't wired to billing/plan today. | `apps/api/src/common/tenant-flags.ts`. |
| Compliance — for a tenant's OWN filings | **Genuinely greenfield — nothing exists.** No disclosure ledger, no jurisdiction-rules engine, no activity-capture-for-filing, no LD-2/FARA draft generation for the tenant's own lobbying activity (grep for `disclosureLedger`/`jurisdictionRule`/`filingDraft`/`lobbyingActivity`/`activity_capture` → zero hits). | Repo-wide grep, empty. |
| Compliance — what DOES exist | (a) **Ingestion of OTHER parties' public filings as competitive intel** — `sync-lda`/`sync-fara`/`sync-openlobby`; the intel path explicitly *excludes* a client's own filings when computing competitive signal (`intelligence.service.ts:4603-4624`, "Skip the client's own filings"). (b) **An AI chat-safety guardrail** — `compliance-rules.ts`'s PASS/WARN/BLOCK engine + prompt guardrails that refuse to help evade disclosure. Neither is filing-assistance. | `intelligence.service.ts:4603-4624`; `compliance-rules.ts` (11 outcome definitions, all in the `EXAMPLE_RULES`/seed, one live catch-all WARN). |
| Reusable adjacent infra for a compliance module | **All present** (the blueprint's own named building blocks): generic `AuditLog` table (`schema.prisma:1801-1821`, tenant-scoped, before/after jsonb — fits a disclosure/tombstone ledger); Outlook + Gmail calendar/email connectors (activity-capture sources — `project_outlook_integration`/`project_gmail_integration`); the Meetings activity model (`project_meetings_v2`); the `compliance-rules.ts` PASS/WARN/BLOCK engine pattern (jurisdiction-rule engine precedent); Phase 3's Workspace risk-tier + doc-generation engine (draft-filing generation precedent). | Cross-referenced from this session's Phase 1/2/3 research + the named memories. |
| Proactive behaviors — built + scheduled | Meeting Notetaker auto-debrief (one tenant, `project_meeting_notetaker`). | Prior memory. |
| Proactive behaviors — built, NOT scheduled | Quiet-client detection + meeting-prep detection (`emit-clio-alerts.ts`), scheduled meeting briefings (`generate-meeting-briefings.ts`) — both write `clio_proactive_alert` rows; scheduling handled in **Phase 0** (Item 2), not here. The old in-chat `generateProactiveAlerts()` still exists (`meri.service.ts:3374`) as the logic these scripts standalone-ified. | `meri.service.ts:3374, 3399-3450`; Phase 0 checklist Item 2. |
| Proactive behaviors — ASPIRATIONAL, no code | Outreach-campaign recommendation (when new legislative/budget language affects multiple clients), stale/contradictory client-position detection, coalition/stakeholder-path suggestion. **Confirmed zero implementing code** — grep for `detectStale`/`recommendCampaign`/`suggestCoalition`/`proposeCampaign` → nothing; the only `coalition` hit is `coalitionLetterSkill`, a user-invoked *drafting* skill, not proactive detection. | `lobbying-skills.ts:60-65` (drafting skill, not proactive); grep empty for detection engines. |

---

## 2. Objective

Per the gap-analysis plan's own Phase 5 framing:
1. **Build the entitlement/tiering architecture now** (not the dollar amounts — the *code* that makes gating possible) so defense-budget-intel and a future compliance module can be premium add-ons without a later re-platform. Resolve the pricing-strategy tension via an explicit leadership decision (blueprint §11, Table 45; gap-analysis §5).
2. **Ship a narrow compliance-assistance pilot** (e.g. LD-2 prep for 1–2 design partners), counsel-reviewed, honoring every §9.2 guardrail — only after Phases 1–3 land (blueprint §12.5 gate #6).
3. **Build the three remaining proactive behaviors** once the Phase 1 ledger + Phase 2 Context Compiler exist (blueprint §3.2, gated by §12.5 gate #3: "do not expand proactive behaviors until every recommendation can identify the evidence and memory that triggered it").

---

## 3. Decisions needed (Ninja / leadership — several are explicitly NOT engineering calls)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | **The pricing-strategy call itself** (the gap-analysis §5 tension): hold flat $200/slot as a low-friction adoption wedge, or move toward the blueprint's tiered annual enterprise contracts ($50K–$180K+)? | **This document does not recommend a dollar direction** — it's a go-to-market/finance decision, not an engineering one. What it *does* recommend: build the entitlement architecture (D2) regardless, since it's cheap insurance that doesn't force either outcome. | The gap-analysis plan's own §5 explicitly refuses to resolve this unilaterally, and rightly — it was decided (flat $200) the same week as the blueprint that contradicts it. Surface it for an explicit call; don't let a plan silently pick. |
| D2 | **Build the entitlement architecture now, before the dollar decision?** | **Yes.** Wire `planTier` (the existing dead column) to a real entitlement check — a small, additive `entitlements` map per tier consumed via the existing `tenant-flags.ts` mechanism. This is buildable and valuable no matter which way D1 goes. | Exactly the "cheap insurance" the gap-analysis §5 names: "building the entitlement/tiering architecture is cheap insurance — it doesn't force either pricing outcome, it just avoids a re-platform later." |
| D3 | **What goes in each tier / what becomes a premium add-on** (only actionable once D1 sets a direction)? | Recommend, per blueprint §11.1: **core memory governance stays included in every tier** (never a privacy upsell); defense-budget-intel / PE Watch, compliance-assistance, API/data-export, and custom connectors are the natural premium add-ons. | Blueprint §11.1 is explicit that memory governance must be included, not sold — getting this wrong is a trust/positioning error, not just a packaging one. |
| D4 | **Compliance module scope for the pilot**: LD-2 (federal lobbying disclosure) only, or LD-2 + FARA, or include a state jurisdiction? | **LD-2 federal only for the pilot**, 1–2 design partners. FARA and state jurisdictions are each their own rules-content + counsel-review effort; don't fan out jurisdictions before the single-jurisdiction workflow is proven. | Matches the blueprint's own "narrow jurisdictional scope" language (§12.4) and the gap-analysis's "LD-2 prep for 1–2 design partners" framing. |
| D5 | **Qualified counsel for the compliance rules** — who reviews/owns the jurisdiction-rule content, versioning, and the "requires counsel review" boundaries (blueprint §9.2: "reviewed by qualified professionals")? | Needs a named legal owner before any rules content ships — **this is a hard prerequisite, not a nice-to-have.** The engineering can build the rules *engine*; it cannot author or bless the rules *content*. | Blueprint §9.2 is unambiguous: rules must be "jurisdiction-specific, versioned, dated, and reviewed by qualified professionals." Shipping unreviewed compliance logic is a liability, not a feature. |
| D6 | **Proactive-behavior gating** — confirm the three aspirational behaviors wait for Phase 1 ledger + Phase 2 Context Compiler, per §12.5 gate #3? | **Confirm the wait.** Each must be able to name the evidence/memory that triggered it (gate #3); without the ledger + compiler, they can't, so they'd ship as exactly the "generic suggestion flood" the blueprint warns against (§3.2). | Building them earlier violates the blueprint's own explicit gate and produces low-trust output. |

---

## 4. Non-goals (explicitly deferred)

- **Resolving the pricing dollar amounts** — D1 is a leadership call this document deliberately leaves open; only the architecture (D2) is in engineering scope.
- **FARA / state-jurisdiction compliance** — pilot is LD-2 federal only (D4); other jurisdictions are follow-on efforts, each gated on its own counsel-reviewed rules content.
- **Direct e-filing** to any disclosure system — blueprint §9.2 explicitly says e-filing is added "only when the destination supports reliable integration and the approval chain is explicit." The pilot produces *drafts + review packages*, a human files them. Not in scope.
- **Any proactive behavior before Phases 1–2 ship** — hard dependency (D6).
- **Marketing/GTM execution** (blueprint §10) — this phase covers packaging/entitlement mechanics, not the sales motion or content strategy.

---

## 5. Workstreams

### 5.1 — Entitlement / tiering architecture (buildable now; dollar decision deferred to D1)

**What:** wire the two dead hooks (`planTier` column at `schema.prisma:155`; the caller-less `isBillingEntitled` helper at `@capiro/shared` index.ts:502) into one real, additive entitlement system. Define an `entitlements` map (which features/modules each tier unlocks) in `@capiro/shared`, resolved per-tenant via the existing `tenant-flags.ts` mechanism (so entitlement checks reuse the same code path as rollout flags, not a parallel one). Note there is **no app-wide paywall guard/interceptor today** — `isBillingEntitled` is only consulted client-side — so this workstream is also the first backend enforcement point for entitlement, not just tier-mapping. Add gating checks at the premium-feature boundaries (D3: defense-budget-intel/PE Watch, and — forward-looking — the compliance module and API/export). **Crucially: do not change any dollar amount or force any tenant onto a paid tier** — every current tenant maps to a tier that includes everything they have today (a no-op migration for existing behavior), so this ships without changing anyone's access. The value is purely that gating *becomes possible* the day D1 resolves.

**Files:** `schema.prisma` (no new column — `planTier` already exists; possibly a `tenant_entitlement` override table if per-tenant grants beyond tier are needed), `@capiro/shared` (tier→entitlement map), `tenant-flags.ts` (entitlement resolver alongside the flag resolver), premium-feature boundary checks (PE Watch endpoints, etc.), `onboard-api` (set `planTier` on subscription based on purchased tier — only meaningful once D1 defines tiers).

**Success criteria:**
- [ ] 5.1.1 `planTier` is read by a real entitlement resolver; a feature can be gated by tier in code.
- [ ] 5.1.2 Every existing tenant maps to a tier granting everything they have today — zero access change on ship (verified by a before/after access diff on a real tenant).
- [ ] 5.1.3 The entitlement check reuses the `tenant-flags.ts` mechanism, not a parallel one (per the anti-fragmentation principle).
- [ ] 5.1.4 Core memory governance (inspect/correct/revoke/export from Phase 1) is entitled to **every** tier, never gated (blueprint §11.1 — this is a hard rule, testable).
- [ ] 5.1.5 The dollar amounts and tier definitions are left as config, not hardcoded, so D1's eventual answer is a config change, not a code change.

### 5.2 — Compliance-assistance module (greenfield; pilot-scoped; counsel-gated)

**Prerequisites (hard):** Phases 1–3 shipped (§12.5 gate #6 — context consistency demonstrated); a named legal owner for rules content (D5); D4's scope set (LD-2 federal, 1–2 design partners).

**What:** build the blueprint Table 40 capability model, narrowly, reusing existing infra wherever possible rather than greenfielding all of it:
- **Activity capture** — reuse the existing Outlook/Gmail calendar+email connectors and the Meetings activity model as capture sources; add a lobbying-activity record type. (Do not rebuild connectors.)
- **Disclosure ledger** — model on the existing `AuditLog` table's shape (immutable, before/after, source/owner/reviewer), tenant- and **matter-scoped** (blueprint §9.2: compliance notes are matter-restricted, never auto-promoted to firm memory — this ties into Phase 1's scope model).
- **Jurisdiction rules + deadlines** — reuse the `compliance-rules.ts` PASS/WARN/BLOCK engine *pattern* for the rules mechanism; the LD-2-specific rule *content* is authored/reviewed by D5's legal owner, versioned + dated per §9.2.
- **Draft reporting** — reuse Phase 3's Workspace doc-generation engine to produce LD-2 draft worksheets/forms; add a "compare with prior filings" consistency check (the prior filings already exist in the LDA ingestion tables — competitive intel becomes self-audit here).
- **Approval + audit readiness** — reuse Phase 3's risk-tier gate (LD-2 filing = a High/Restricted-tier artifact) + Phase 1's audit-log tombstone pattern; every reported value links to its source activity (§9.2: "never silently convert an inferred activity into a filed fact").

**Guardrails (blueprint §9.2, non-negotiable, each testable):** rules jurisdiction-specific/versioned/dated/counsel-reviewed; classifications show facts+rule-version+uncertainty+what-needs-counsel; never auto-convert inferred→filed; privilege/confidentiality/retention/legal-hold configurable; matter-restricted, never auto-promoted to firm memory; legal hold preserves the record while suspending retrieval (distinct from deletion — reuse Phase 1's `legalHold`/`status='revoked'` distinction).

**Files:** a new module (likely a new bounded area in `apps/api`, or — given the doc-generation reuse — partly in `apps/workspace`), new `compliance_activity`/`disclosure_ledger`/`jurisdiction_rule` tables (RLS + matter-scope, following Phase 1's discipline), reuse of connectors/Meetings/AuditLog/compliance-rules/Workspace-gen.

**Success criteria:**
- [ ] 5.2.1 A design partner can capture lobbying activity (from calendar/email/meetings + manual entry) into a matter-scoped disclosure ledger.
- [ ] 5.2.2 The system drafts an LD-2 worksheet from the ledger, flagging missing data and comparing against prior filings — as a *draft for review*, never auto-filed.
- [ ] 5.2.3 Every guardrail in §9.2 is enforced and individually tested (especially: no inferred→filed conversion; matter-restriction; legal-hold-preserves-while-suspending).
- [ ] 5.2.4 A qualified legal owner (D5) has reviewed and signed off on the jurisdiction-rule content before it ships to any partner.
- [ ] 5.2.5 The module is gated as a premium entitlement (5.1) — it's not on by default for every tenant.
- [ ] 5.2.6 Deferred explicitly: direct e-filing (non-goal); FARA/state jurisdictions (D4).

### 5.3 — Remaining proactive behaviors (Phase 1/2-gated)

**Prerequisites (hard):** Phase 1 memory ledger + Phase 2 Context Compiler shipped (D6, §12.5 gate #3).

**What:** build the three aspirational behaviors, each able to name the evidence + memory that triggered it (gate #3), each surfacing as a `clio_proactive_alert` (reusing the existing model + inbox the scheduled `emit-clio-alerts` already feeds), each selective/explainable per §3.2 ("a small number of high-confidence, high-impact interventions," not a flood):
- **Outreach-campaign recommendation** — when new legislative/budget language (from the Phase 2-wired truth layer / LegiWatch alerts) affects multiple clients, propose a campaign, showing which clients and which language triggered it.
- **Stale/contradictory client-position detection** — before a draft, check the Phase 1 ledger for the client's approved positions and flag staleness (validity window expired, per Phase 1's `status`/`lastConfirmedAt` fields) or contradiction (per Phase 1's `contradictsId`).
- **Coalition/stakeholder-path suggestion** — via relationship + issue alignment, using the memory graph (`memory_edges`) and the directory, showing the evidence for the suggested path.

**Files:** new detection services (likely alongside `emit-clio-alerts`'s standalone pattern, or as Context-Compiler-consuming services), reuse of `clio_proactive_alert` + the alerts inbox, dependencies on Phase 1's `memory_items` governance fields and Phase 2's shared context contract.

**Success criteria:**
- [ ] 5.3.1 Each of the three behaviors produces a `clio_proactive_alert` that names its triggering evidence + memory (gate #3 — testable: an alert with no traceable trigger is a bug).
- [ ] 5.3.2 Stale-position detection reads Phase 1's real validity/status/contradiction fields — not a heuristic proxy (confirming the Phase 1 dependency is genuinely used, not worked around).
- [ ] 5.3.3 Output is selective (a small number of high-confidence interventions), not a generic suggestion flood — measured by a per-tenant alert-volume cap or confidence threshold.
- [ ] 5.3.4 These do not ship before Phases 1–2 (dependency gate honored, not bypassed with a stub).

---

## 6. Sequencing

Per the original framing (months 3–12, parallel to Phase 4), but honest about the gating:

| Timing | Work | Gated on |
|---|---|---|
| Now (independent) | 5.1 entitlement *architecture* (no-op on access, config-driven amounts). | Nothing — buildable today. |
| Now (decision) | Surface D1 (pricing strategy) to leadership. | Leadership availability, not engineering. |
| After D1 resolves | Populate 5.1's tier definitions + dollar amounts (config change, per 5.1.5). | D1. |
| After Phases 1–2 ship | 5.3 proactive behaviors. | Phase 1 ledger + Phase 2 Context Compiler (D6). |
| After Phases 1–3 ship + D5 legal owner named | 5.2 compliance pilot — the largest build; scope narrow (D4), counsel-gated (D5), premium-gated (5.1). | §12.5 gate #6 + D4 + D5. |

**None of these block Phase 4** — they run in parallel, and each waits on its own gate rather than on the others.

---

## 7. Rollout mechanics (repo-specific)

- **5.1** touches `onboard-api` (billing) + `apps/api` (entitlement checks) + `@capiro/shared` (tier map) — a coordinated multi-service roll, but low-risk since it's a no-op on existing access.
- **5.2** compliance is a new module with new RLS + matter-scoped tables — full Phase-1-style migration discipline (clone-rehearsal, canary, post-deploy check), and it deploys to whichever service(s) host it. Given the Workspace doc-gen reuse, part of it may live in `apps/workspace` (separate deploy, `capiro-dev-workspace-migrate` gotcha).
- **5.3** reuses `emit-clio-alerts`'s standalone-script + scheduled pattern (once Phase 0 wired the scheduler) or Context-Compiler-consuming services in `apps/api`.
- Standing prohibitions unchanged: no `cdk deploy Compute`; `packages/meriv2-core`/`@capiro/shared` changes need forced image rebuilds; canary `capiro-internal` first.

---

## 8. Rollback

| Workstream | Rollback |
|---|---|
| 5.1 (entitlement) | Since it's a no-op on existing access, the entitlement check can be disabled (flag) to grant everything to everyone — the pre-Phase-5 state — instantly, no data change. |
| 5.2 (compliance) | Premium-gated + pilot-scoped, so it's dark for all but 1–2 opted-in partners; disable the entitlement to fully retract. New tables are additive; the RLS-drop rollback pattern from Phase 1 applies. **Caveat: any real filing data a partner entered must be preserved/exported, not dropped — treat partner compliance data as sacred even on rollback.** |
| 5.3 (proactive) | Each behavior is a separable detection service — disable its schedule/flag to stop it; the `clio_proactive_alert` rows it produced are harmless (dismissable inbox items). |

---

## 9. Testing & verification checklist

- 5.1: a before/after access diff on a real tenant proving zero access change on ship (the load-bearing safety property).
- 5.2: each §9.2 guardrail gets its own test (no inferred→filed; matter-restriction enforced at the DB boundary; legal-hold preserves-while-suspending) — these are liability-grade, not nice-to-have.
- 5.2: a counsel sign-off artifact (D5) is a gating checklist item, not a code test — but it's a required exit criterion.
- 5.3: a test that an alert with no traceable evidence/memory trigger is rejected (gate #3 enforcement).

---

## 10. Phase 5 exit gate — success criteria

- [ ] **G1.** The entitlement architecture is live: `planTier` is read, features can be tier-gated, every existing tenant's access is unchanged, and core memory governance is entitled to every tier. *(5.1)*
- [ ] **G2.** The pricing-strategy decision (D1) has been explicitly made by leadership and recorded — whichever way it goes — and 5.1's tier config reflects it. *(D1)*
- [ ] **G3.** A counsel-reviewed (D5) LD-2 compliance pilot is live for 1–2 design partners, honoring every §9.2 guardrail, producing draft filings (never auto-filed), premium-gated. *(5.2)*
- [ ] **G4.** The three remaining proactive behaviors are live, each naming its triggering evidence+memory, selective not flooding, built on Phase 1's real ledger fields — not before Phases 1–2 shipped. *(5.3)*
- [ ] **G5.** No item shipped ahead of its gate: compliance did not precede Phases 1–3 + counsel; proactive behaviors did not precede Phases 1–2; entitlement did not silently change any tenant's pricing.

*Directly answers the gap-analysis §5 pricing tension (resolved by an explicit decision + architecture, not silently) and the blueprint's §12.5 gates #3 and #6 (proactive-behavior and defense-wedge gates honored).*

---

## 11. Metrics to instrument (blueprint Table 51 + §11 economics, scoped to this phase)

- **Entitlement coverage**: # of premium features actually gated by tier (0 today → the count D3 defines).
- **Compliance pilot**: # design partners live; # LD-2 drafts produced; # guardrail violations caught (target 0 inferred→filed conversions).
- **Proactive-behavior precision**: for each of the three, the ratio of acted-on vs. dismissed alerts (the §3.2 "selective, high-confidence" test — a low ratio means it's flooding, the exact failure the blueprint warns against).
- **Commercial (only meaningful post-D1)**: if tiered pricing is adopted — ACV by tier, add-on attach rate (compliance/defense-intel), per blueprint §11.4's unit-economics targets. Not instrumented if the flat-wedge is held.

---

## 12. Risks specific to this phase

- **The pricing decision (D1) is a real strategic fork that this plan cannot and should not make** — leaving it unresolved indefinitely is itself a risk (the gap-analysis §7 notes the flat-$200-vs-blueprint-tiers contradiction "reads as strategy drift to anyone comparing this blueprint to the live Stripe configuration"). Force the decision; the architecture (5.1) is cheap either way, but the *decision* shouldn't drift.
- **Compliance is a liability surface, not just a feature** — shipping any jurisdiction-rule content without a named qualified-counsel owner (D5) is a legal exposure. This is the one workstream where "move fast" is actively wrong; the blueprint's §9.2 guardrails are there for liability reasons, not product polish.
- **Compliance depends on Phases 1–3 being genuinely done, not nominally done** — its matter-restriction, audit-ledger, and draft-generation reuse all lean on Phase 1's scope model, Phase 3's risk-tier gate, and the memory governance being real. If those shipped with gaps, the compliance module inherits them in a liability-sensitive context.
- **Proactive behaviors are trust-fragile** — a stale-position detector that fires on bad data, or a campaign recommender that floods, actively erodes the "Chief of Staff" positioning. §12.5 gate #3 (must name the trigger) is the guardrail; enforce it as a hard test (5.3.1), not an aspiration.
- **Entitlement gating could accidentally restrict an existing tenant** — the no-op-on-access property (5.1.2) is the load-bearing safety check; a bug there means a paying customer loses a feature they had. Test it as a before/after diff on real tenants, not just unit tests.
