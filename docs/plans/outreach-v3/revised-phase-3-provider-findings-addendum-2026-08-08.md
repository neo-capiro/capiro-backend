# Revised Outreach Phase 3 — Provider Findings Addendum

Date: 2026-08-08

## Open blocker

### P3-PROVIDER-001 — Blocking P2 — stateless reasoning tool loop must request encrypted reasoning content

**Classification:** provider/API contract defect  
**Status:** OPEN / BLOCKING

Phase 3 defaults to:

```text
stateMode=capiro_managed
OpenAI store=false
```

The provider adapter correctly carries prior response output and `function_call_output` items through the same turn, but the current raw Responses request does not explicitly request:

```text
reasoning.encrypted_content
```

OpenAI's stateless reasoning guidance requires encrypted reasoning content when reasoning items must be carried across calls without provider-side response storage. Without it, a reasoning-model function/tool loop can lose the reasoning state needed for the next raw Responses call even though Capiro correctly passes the visible/function-call items.

This is a provider-transport defect only. It does not require changing campaign truth, retention defaults, or proposal authority.

## Required repair

In `openai-outreach-reasoning.provider.ts`:

1. when using a reasoning model in `capiro_managed` / `store=false` mode, request encrypted reasoning output with the Responses `include` field;
2. keep returned reasoning items only in the in-memory `response.output` chain used for the same provider turn;
3. send those transient items back with subsequent `function_call_output` items for the same turn;
4. never write encrypted reasoning content to:
   - `outreach_reasoning_conversations`;
   - `outreach_reasoning_turns`;
   - Phase 2 event/proposal/state tables;
   - operational logs;
   - API responses;
5. Capiro-managed cross-turn continuity must still use visible stored transcript, not encrypted reasoning content;
6. provider-state mode keeps its existing separate opt-in contract;
7. make `outreach-reasoning-encrypted-content.spec.ts` green without weakening/removing the assertion.

Expected request fragment for the stateless reasoning path:

```text
include: ["reasoning.encrypted_content"]
store: false
```

The encrypted content is transient provider continuity material, not Capiro business state and not user-visible reasoning.

## Current code-review finding state

```text
Open P0 = 0
Open P1 = 0
Blocking P2 = 1   # P3-PROVIDER-001
```

Therefore:

```text
OUTREACH_V3_PHASE3_APPROVED = NOT POSSIBLE
```

until this provider contract is repaired and executable gates pass.

## Separate prerequisite blocker

Formal Phase 3 acceptance/deployment is also independently blocked until the exact Phase 2 lineage receives:

```text
OUTREACH_V3_PHASE2_APPROVED
```

Do not conflate the two blockers: Phase 2 approval does not waive this provider defect, and fixing this provider defect does not waive Phase 2 approval.
