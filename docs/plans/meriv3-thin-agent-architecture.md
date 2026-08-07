# MeriV3 — Thin OpenAI Reasoning Runtime

**Status:** implemented on `agent/meriv3-openai-responses-canary`; dark until deployment and the three-key canary gate are enabled.

**Base:** `main` at `55039f431a00e7a850f92d0b909e7c02b1a2959a`.

## Product objective

MeriV3 should feel like a high-reasoning general assistant that works _inside Capiro_ rather than like a hand-built imitation of one.

The model owns:

- how to reason about an ambiguous request;
- which authorized read tools to call;
- whether another investigation round is materially useful;
- how to synthesize the evidence;
- how to explain conclusions, uncertainty and recommendations.

Capiro continues to own:

- authentication and tenant resolution;
- client scope and ethical walls;
- Context Packet and client knowledge;
- institutional memory and user/firm steering;
- tool contracts and tool execution;
- provenance and citations;
- claim assurance and release gates;
- policy packs;
- durable action proposals and human approval;
- conversation persistence, attachments and artifacts;
- audit and usage metering.

## Runtime topology

```text
Capiro web
  |
  | POST /api/clio/conversations/:id/stream
  v
apps/api — server-side runtime router
  |
  | non-canary or kill switch off
  +--------------------------> existing MeriV2 / legacy fallback
  |
  | canary gate passes
  v
apps/api MeriV3ProxyService
  - persists the user turn
  - compliance pre-screen/block
  - attachment/history replay
  - client KB and firm skill forwarding
  - resolves OpenAI credential
  - persists reply/artifacts/audit metadata
  |
  | authenticated TLS delegation
  v
apps/meriv2-orchestrator /meri-api/v3/chat/stream
  |
  v
OpenAI Responses API reasoning loop
  |
  | function calls
  v
existing governed Capiro ToolRegistry
  - read tools execute under MeriContext
  - write tools go through ApiActionProposalRepo
  - WARN writes return opaque proposal ids
  - policy-blocked writes never execute
```

MeriV2 remains available beside MeriV3. MeriV3 does not modify the V2 chat service, Workspace generation, the in-editor assistant, Strategy, Steward or Deep Research.

## Three-key canary gate

A turn reaches MeriV3 only when all three conditions are true:

1. `MERIV3_ENABLED=true` on `apps/api`;
2. the authenticated, server-resolved tenant slug is in `MERIV3_CANARY_TENANT_SLUGS` (default `capiro-internal`);
3. the tenant row explicitly contains `settings.clioFeatureFlags["meriv3.fullChat"] = true`.

The isolated orchestrator independently enforces the same three conditions. A browser flag, query parameter or request body cannot widen the canary.

Tenants outside the canary receive a 404 from the hidden V3 capability endpoints and continue to use MeriV2.

## Reasoning profiles

Product labels are stable; provider model ids and limits are server configuration. The defaults follow OpenAI's current GPT-5.6 family as verified on 2026-08-07.

| Mode     | Default model                   | Default effort | Default output cap | Tool rounds | Turn budget | Intended use                                 |
| -------- | ------------------------------- | -------------: | -----------------: | ----------: | ----------: | -------------------------------------------- |
| Fast     | GPT-5.6 Luna (`gpt-5.6-luna`)   |            low |              8,192 |           6 |         90s | direct lookups and simple questions          |
| Standard | GPT-5.6 Terra (`gpt-5.6-terra`) |         medium |             16,384 |          10 |        180s | everyday government-affairs work             |
| Deep     | GPT-5.6 Sol (`gpt-5.6`)         |           high |             24,576 |          14 |        300s | ambiguous strategy and multi-source analysis |
| Max      | GPT-5.6 Sol (`gpt-5.6`)         |            max |             32,768 |          18 |        480s | hardest configured reasoning tier            |

Defaults:

- `MERIV3_FAST_MODEL=gpt-5.6-luna`
- `MERIV3_MODEL=gpt-5.6-terra`
- `MERIV3_DEEP_MODEL=gpt-5.6`
- `MERIV3_MAX_MODEL` falls back to `MERIV3_DEEP_MODEL`

Every value is overrideable through the `MERIV3_*` environment variables in `meriv3-reasoning.ts`. An unsupported model/effort combination fails visibly; MeriV3 never silently downgrades a user-selected reasoning mode.

The selected mode is stored in the server-owned `clio_conversations.metadata.meriv3.reasoningMode`. It is not trusted from a free-form browser header at execution time.

## Responses API posture

Each provider request uses:

- `store: false`;
- native `reasoning.effort`;
- developer-defined function tools;
- `parallel_tool_calls: true` when tools are present;
- a hashed `safety_identifier` derived from tenant + user;
- request-local replay of response reasoning/function-call items as required by the API;
- no provider conversation id or provider-side state.

Provider reasoning items are never:

- emitted through SSE;
- persisted in `clio_messages`;
- written to the audit ledger;
- returned in a tool result;
- stored in browser state.

The visible work log contains bounded tool/source/approval events only.

## Tool and action authority

MeriV3 converts the existing Capiro tool schemas into Responses function tools. Tool inputs are still revalidated and executed by Capiro.

Read flow:

```text
model function call
  -> pinned-client scope check
  -> governed ToolRegistry.invoke(name, input, MeriContext)
  -> untrusted result wrapper + citations + claim ledger
  -> function_call_output returned to the model
```

Write flow:

```text
model function call
  -> pinned-client scope check
  -> ApiActionProposalRepo.create
     -> PASS: execute through existing authority
     -> WARN: durable proposal, opaque proposalId, inert until approval
     -> BLOCK: no execution
```

The browser never receives a write payload or policy fingerprint as authority. It approves the opaque proposal id through the existing action-proposal endpoint.

## Client isolation

The conversation's persisted `client_id` is the scope authority.

When a tool schema declares `clientId`:

- an omitted value is set to the conversation client;
- the exact conversation client is accepted;
- a different client is refused before the tool executes.

The popup header uses `changeSessionClient`, which immediately persists the new conversation client. It never displays a local-only client choice.

## Grounding and assurance

MeriV3 reuses:

- the shared Meri grounding invariant;
- government-affairs evidence planning;
- tool-result citation extraction;
- Form A and Form B citation validation;
- claim-ledger construction;
- the deterministic grounding auditor;
- government-affairs domain checks;
- pre-persist deliverable assurance;
- high-risk pre-release assurance.

A high-risk answer is replaced with an honest hold message when enforce mode cannot verify it. An empty retrieval is never treated as proof of absence.

## Conversation ownership

`apps/api` remains the canonical conversation owner.

It handles:

- user-message persistence;
- regenerate/edit-and-resend planning;
- document and image attachment replay;
- existing compacted summary replay;
- assistant-message persistence;
- runtime/model/mode/usage metadata;
- artifact-message linkage;
- compliance metadata.

When a compacted summary exists, MeriV3 replays only messages newer than the summary boundary. The summary and old messages are not injected twice.

## Usage and estimated cost

Every model round is recorded under workflow `meriv3_chat` with provider, actual returned model, input/output tokens, cached-input tokens and whether a tenant key was used.

The isolated runtime registers the current GPT-5.6 public list-price estimates:

| Model         | Input / 1M | Cached input / 1M | Output / 1M |
| ------------- | ---------: | ----------------: | ----------: |
| GPT-5.6 Luna  |      $1.00 |             $0.10 |       $6.00 |
| GPT-5.6 Terra |      $2.50 |             $0.25 |      $15.00 |
| GPT-5.6 Sol   |      $5.00 |             $0.50 |      $30.00 |

The existing shared cost helper prices all input tokens at the base input rate, while cached-token counts are stored separately. The database `costUsd` is therefore a conservative estimate when cache hits occur; an exact discounted calculation can be derived from the stored token dimensions during canary analysis.

## Popup workspace

For the MeriV3 canary, clicking the Meri bubble opens a named, resizable top-level browser window at `/?meriWindow=1`.

This is a real browser/OS window, not a draggable element inside the Capiro page. The user can:

- move it to another monitor;
- resize, maximize or minimize it through the operating system;
- keep it beside the main Capiro window;
- click the launcher again to focus/reuse the same named window.

If a browser blocks the popup, Capiro falls back to the full in-page undocked workspace—not the skinny drawer.

The workspace follows the supplied prototype:

- 264px neutral thread rail;
- 52px command header;
- centered 720px conversation column;
- white/graphite/neutral palette with restrained rust accent;
- grouped conversation history;
- bottom composer;
- visible server-persisted client-scope selector;
- Fast / Standard / Deep / Max picker;
- existing production chat controller for attachments, approvals, citations, research and artifacts.

## Non-goals for this canary

- no LangChain or LangGraph dependency;
- no Workspace runtime migration;
- no in-editor runtime migration;
- no Strategy runtime migration;
- no Deep Research rewrite;
- no database migration;
- no removal of MeriV2;
- no provider-side conversation storage;
- no raw chain-of-thought UI.

## Rollback invariant

Turning the tenant flag off causes the next turn to invoke the original `MeriService.streamMessage`. Turning `MERIV3_ENABLED` off is the global kill switch. No migration or data rollback is required.
