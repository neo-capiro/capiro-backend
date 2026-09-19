# Phase 2 handoff — accepted interfaces and what remains

Prepared 2026-09-19 as part of the Phase 0/1 closeout. **Read `closeout-report.md` first for the actual PASS/FAIL/BLOCKED verdict.** This document describes what Phase 2 may build on and what it must not assume. It does not itself declare Phase 1 complete, and **a Phase 1 requirement that did not pass is listed as a Phase 1 blocker in the closeout report — it is never laundered into this document as a "Phase 2 carryover."**

## 1. Interfaces Phase 2 can treat as accepted

These are stable, tested and should be reused rather than reinvented. Changing them is a breaking change that needs its own review.

| Interface | Where | What Phase 2 gets |
|---|---|---|
| Authorization envelope | `hermes-runtime.contracts.ts` (`MeriHermesAuthorizationEnvelope`) | Server-created, immutable per run, never sent to the model. Carries tenant, actor, conversation, execution scope, audience, authorized client/mailbox ids, tool policy, authorization version, budget. **Add fields here rather than passing scope out-of-band.** |
| Broker boundary | `meri-hermes-broker.service.ts` | The *only* path a worker has into application data. Per-call re-authorization (token, run binding, scope equality, liveness, envelope expiry, authorization version, current membership) plus tool allow/deny/readOnly/budget. New Phase 2 tools (MCP, mail, data gateway) **must** be added behind `assertTool` here, not exposed directly to the worker. |
| Revocation fencing | `meri-hermes-broker.service.ts` → adapter stop path | On membership revocation, authorization-version mismatch or envelope expiry the worker is actually stopped and the run fenced terminal, not merely denied its next call. Phase 2 tools inherit this for free. |
| Durable run/event/interaction store | `meri-hermes-prisma-run-repository.ts`, tables `meri_agent_runs` / `meri_agent_run_events` / `meri_agent_interactions` / `meri_execution_scopes` | Atomic admission with single-writer-per-conversation, request-fingerprint idempotency, atomic `seq` allocation, fenced terminal transitions, transactional finalize, durable dispatch tracking, ordered cross-replica delivery and a pruning-safe recovery snapshot. |
| Event contract | `meri-hermes-event-translator.ts`, contracts.md §4 | Hermes wire event → Meri durable event (`kind`, `visibility`, `payload.frames[]`) → browser SSE frame. New event kinds go through the translator; **never stream raw tool payloads or hidden reasoning.** |
| Governed recall port | `meri-hermes-recall.ports.ts` (`ContextPlaneRecallPort`) | Institutional memory stays authoritative in Meri, reached through the canonical Context Plane rail. There is no ungoverned local-memory fallback and Phase 2 must not add one. |
| Pilot gate | `meri-hermes-flags.ts` + `meriv3-runtime.proxy.ts` | Three independent keys, default closed, canonical tenant ids only, client fields ignored. Phase 2 capability flags should compose with this, not bypass it. |
| Interaction UI contract | contracts.md §6, `HermesApprovalCard.tsx`, `meri-hermes-interactions.ts` | Approvals expose **Run once / Deny** only; clarifications are durable continuations answerable after their run ends. |

**Ticket #6 (governed recall) is accepted once here and reused.** Phase 2 does not re-litigate the recall path; it extends it with additional authorized sources.

## 2. What Phase 2 must not assume

- **Not proven at scale.** The tested envelope is 1 tenant / 2 users / private scopes, with the numeric limits in `decisions.md` §4. Nothing here demonstrates 25, 100 or 500 scopes. Phase 2's new data/mail/MCP call paths must be brought under the *same* budget and fairness controls — a new call path that bypasses the parent reservation is a regression, not a feature.
- **Not a coverage claim.** `data-inventory.md` counts **Prisma model declarations** across 12 schemas including explicit projection schemas — not distinct business tables (see `checks-report.md` correction C7). Real coverage requires the Phase 2A catalog and per-field policy classification.
- **Proposed ≠ saved.** The runtime can propose a governed memory candidate; it is never an admin and Phase 0/1 never observed a commit. Any Phase 2 feature that reports a memory as "saved" must be reading the authoritative service, not the proposal.
- **Background learning is off.** Automatic skill learning, the skill registry, curator, staged approval and persona settings are **2B** and are explicitly disabled in Phase 1. Do not enable any of them without also delivering the lifecycle guarantee that an idle timer cannot discard enabled unfinished work.
- **No external business writes exist yet through the runtime.** Business actions remain with Meri's own executor and approval records. This is load-bearing for the current rollback story (rollback cannot un-send something the runtime never had the power to send). Phase 4 changes that and must re-establish the property with idempotency keys and reconciliation.

## 3. Remaining work by milestone

| Milestone | Scope |
|---|---|
| **2** | MCP broker facade (preserving chat-only managed-connector restrictions), indexed mail via the broker with explicit mailbox selection and coverage/freshness, broker exposure of existing native Meri tools **after** fixing the actor/client checks the Phase 0 audit found missing (`get_representation`, `find_contacts`, federal-market `clientId`, `schedule_task`) |
| **2A** | Comprehensive data gateway: all-schema catalog and per-field policy classification, `discover/describe/query/read_record/read_related/export`, validated joins, coverage CI gate that fails on unclassified new business data. Largest single item; estimate only after the catalog spike |
| **2B** | Skill registry with versions/rollback/provenance, automatic background learning lifecycle and accounting, curator, staged skill approval, tenant persona settings and versioning |
| **3** | Shared rooms: membership, roles, audience model, private-result routing, migration that does not widen existing workspace visibility |
| **4** | Controlled external actions: drafts, explicit account selection, exact-payload approval binding, idempotency and execution reconciliation |
| **5 / 5A** | Proactive scheduled work; then the full native experience — delegation/subagents, goals, heartbeat, cron wake, Bot Mode specialists, browser automation, media, session fork/steer UX, filesystem checkpoints |

## 4. Known defects and debts carried forward (not Phase 1 blockers)

1. `/v1/skills` returns **HTTP 500** on the pinned build (`TypeError: _find_all_skills() got an unexpected keyword argument 'include_editorial'`) — re-verified during this closeout. Skill listing must come from the scope volume or the 2B registry, not this endpoint, until upstream fixes it or the pin moves.
2. Upstream seeds **58 bundled skills** at first boot; only the top-level MIT license was reviewed. A bundled-skill license review is a prerequisite for distribution sign-off.
3. Cross-replica **live push** is delivered by ordered durable polling rather than a push bus. Correct and replica-agnostic, but it trades latency and adds steady database read load; a notification bus is a reasonable Phase 2+ optimisation, not a correctness fix.
4. Tool-progress events below the recovery snapshot are intentionally not replayed after pruning. Pending interactions are unaffected (they are recovered from their own table).
