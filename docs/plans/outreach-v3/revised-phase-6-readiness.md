# Outreach V3 Revised Phase 6 — UI Readiness from Phase 5

## Gate

Phase 6 is the final Outreach V3 UI implementation phase for the revised roadmap.

**Do not begin final UI implementation until the product owner supplies and approves the new mockups.** The previous standalone Outreach prototype remains historical product-requirement evidence only and is not the final visual contract.

## Backend surfaces ready for the UI

### Campaign state

Phase 2 provides:

- session create/list/read/archive;
- canonical Campaign Spec;
- immutable state versions;
- optimistic concurrency;
- direct deterministic commands;
- pending proposals;
- explicit Apply/reject;
- derived readiness/blockers;
- history/events.

### Reasoning

Phase 3 provides:

- OpenAI reasoning conversation;
- model/tool loop;
- Capiro-managed/provider-managed continuity modes;
- read-only Capiro capabilities;
- structured command proposals;
- state-version race protection;
- no direct mutation authority.

### Targets

Phase 4 provides:

- target search/recommendations;
- target profile;
- relationship analysis;
- target coverage;
- similar targets;
- canonical selected-target snapshots;
- target health/drift;
- add/remove/reject-recommendation commands.

### Context and strategy

Phase 5 provides:

- governed context search;
- government research;
- document inspection;
- exact context classes/scopes;
- context review/drift;
- deterministic strategy recommendation;
- accept/exclude context commands;
- sponsor/client isolation.

## UI principles that remain authoritative regardless of mockup styling

- Goal-first conversational start.
- Client/sponsor is optional and may be firm, single client, multi-client, coalition, internal team, none, or unresolved.
- Sponsor and audience are separate.
- Recommendations never auto-add targets.
- Model proposals never auto-apply.
- Every proposed state change has visible Apply/reject semantics.
- Target profile distinguishes current/stale/limited/missing/restricted conditions.
- Target-specific context remains visibly target-specific.
- Writing guidance is visually distinct from factual evidence.
- Client-confidential context must expose its client scope without leaking inaccessible clients.
- Readiness/blockers come from backend canonical state; the UI must not invent a second wizard-state source of truth.
- Generation/send controls remain unavailable until their later phases.
- Model outage must not make deterministic campaign state unreadable.
- Mobile prioritizes the conversation and critical actions.

## Required mockup intake before coding

When final mockups arrive:

1. preserve original files/screens as immutable design evidence;
2. enumerate every page/state/modal/panel/button/gadget;
3. map every interactive element to an existing backend query/command/proposal action;
4. identify any visual action that has no backend owner;
5. identify every loading/empty/disabled/error/stale/conflict/resume state;
6. resolve mockup/backend conflicts in favor of canonical security/state contracts;
7. freeze responsive breakpoints and mobile behavior;
8. freeze an exact Phase 6 route/component/state manifest;
9. then implement.

## Phase 6 must not silently implement later-phase authority

Do not add UI that can actually:

```text
generate final drafts
approve immutable drafts
preflight a send
send email
retry unknown delivery
commit memory
```

If the mockup visually includes those later-stage controls, render them only according to the roadmap’s later-phase availability contract unless the roadmap is explicitly changed.

## Combined Phase 4-6 verification

After Phase 6 implementation, run one combined validation covering:

- Phase 4 target authorization/grounding;
- Phase 5 context/client/ethical-wall scope;
- Phase 6 exact visual/control contract;
- state/proposal persistence and resume;
- browser desktop/tablet/mobile;
- accessibility;
- stale/conflict/error states;
- current Outreach v2/current Engagement regression;
- no generation/send authority before later phases;
- independent review and final P0/P1/blocking-P2 ledger.

Phase 4 and Phase 5 are not considered independently verified until that combined pass completes.
