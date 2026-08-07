# Phase 3 → Outreach V3 Handoff

**Phase 3 rule:** prove the exact current Engagement experience against `engagement-api`; do not implement V3.

This handoff records what the current system already provides and what remains intentional later work. It is derived from the Phase 3 UI/API inventory plus the accepted Outreach V3 master context; it does not claim future capabilities are implemented.

## Current data/API support that V3 can reuse later

| Area | Current support | Phase 3 observation |
|---|---|---|
| Outreach records | current `OutreachRecord` list/create/update/delete/resume APIs and nullable `clientId` | preserved as Outreach v2; no client is kept truthful rather than fabricated |
| Audiences | current saved audience/list/group APIs and members | existing list/group semantics remain intact |
| Contacts | Engagement contacts plus current Directory/client-contact surfaces | available as source data; Phase 3 adds no recommendation engine |
| Meetings | meeting list/detail, prep/notes/debrief/task associations | parity workload includes deep links and stored context; provider actions remain denied in preview |
| Context library | current Outreach context-library/current context APIs | reusable input; no governed V3 context selector is added |
| Attachments | current metadata plus governed external attachment actions | metadata can be reused; external storage/extraction ownership remains Phase 4 |
| Draft artifacts/versions | immutable Outreach draft artifact/version infrastructure | stays authoritative; V3 must reuse it rather than invent mutable send payloads |
| Audit/review | existing exact-version audit/review infrastructure | V3 must preserve its release/sendability semantics |
| Send intents | durable send-intent/delivery infrastructure | remains authoritative and disabled in Phase 3 shadow runtime |
| Integrations/mailboxes | stored Google/Microsoft connection and capability state | V3 may select a sender later; OAuth/sync/provider ownership is not moved by Phase 3 |

## Missing API/state shape for Outreach V3

These remain intentionally absent from Phase 3 production source and are protected by `scripts/verify-engagement-phase3-prototype-boundary.mjs`:

- canonical Campaign Spec persistence;
- V3 session/event/checkpoint state;
- server-validated command boundary (`SET_GOAL`, target/context/delivery commands, etc.);
- LangGraph orchestration;
- goal-first conversational shell;
- V3 target recommendation service and coverage analysis;
- target-profile snapshots and freshness/conflict classification;
- governed context accept/reject/exclusion state;
- personalized-separate / uniform-separate / shared-thread V3 delivery state;
- representative-sample generation state;
- V3 preflight state and send-confirmation workflow;
- bottom/always-visible Meri conversation surface from the current prototype.

## Authorization gaps V3 must resolve later

V3 cannot treat a browser reference as authorization. Before any future command uses a target, client, context item, attachment, mailbox, draft version, or relationship record, the server must re-resolve it and apply tenant/user/client/ethical-wall authorization.

Specific gaps carried forward:

1. Target profiles need explicit target-specific context scope; a fact about Person A must never become Person B's context.
2. Multi-client/coalition outreach needs explicit sponsor/context separation so confidential client context cannot become campaign-global.
3. Required policy and writing guidance need different evidence semantics; writing style is not factual evidence.
4. External-action ownership (credentials, OAuth, sync, generation, attachments, notetaker, send) depends on the Phase 4 boundaries in `phase-3-to-phase-4-gap-ledger.md`.
5. Broad institutional-memory hints remain gated by the separate memory trust/governance work described in the master context.

## Fixture needs for the V3 phase

The Phase 3 fixtures are intentionally current-product fixtures. Later V3 acceptance will need additional deterministic state for:

- no-client, one-client, multi-client, coalition and internal sponsor scopes;
- targets with verified/stale/missing/conflicting identity/profile data;
- relationship/no-relationship target samples;
- ethical-wall and target-specific context exclusions;
- each V3 delivery pattern;
- sample-first generation and exception-first review;
- dirty/stale/held/failed draft lifecycle;
- sender-mailbox and attachment preflight states;
- idempotent send confirmation and unknown-delivery recovery.

Do not retrofit those into Phase 3 fixtures merely to make V3 look partially implemented.

## Phase 3 boundary result expected at closeout

A green Phase 3 means:

- Outreach v2 is still the sole production wizard;
- its current records, local persistence, deep links and reads work through main and preview;
- provider/generation/send actions are intentionally refused in preview before side effects;
- no V3 route/component/state machine/graph/prototype asset ships;
- Phase 4 ownership gaps are explicit rather than hidden.

Only a later V3 phase should intentionally diverge from the current Outreach UX.
