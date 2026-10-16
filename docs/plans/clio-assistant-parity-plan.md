> **Scope status — backend cleanup successor.** Historical frontend execution status. Read [the existing progress audit](clio-assistant-parity-progress.md) for recorded implementation and qualification distinctions. The original Proposed status and design below are preserved. Current frontend parity belongs to `capiro-frontend`; retained Meri/Fable backend and sandbox implementations remain active dependencies.
> Source retirement: [PR30](https://github.com/neo-capiro/capiro-backend/pull/30), exact `7b6bda7ca75ea86afb36c76f013f550fdd79e42f`.

# Clio Assistant-Parity Implementation Plan

Six features that close the experience gap between Clio and ChatGPT/Claude, grounded in the current codebase. Each feature has current state (with file references), design, implementation steps, measurable success criteria, risks, and effort.

**Date:** 2026-06-10 · **Owner:** TBD · **Status:** Proposed

## Sequencing & effort summary

| Phase | Feature | Effort (eng-days) | Depends on |
|---|---|---|---|
| 1 (wk 1–2) | F1 Attachment reading (PDF + vision) | 3–5 | — |
| 1 (wk 1–2) | F3 Extended thinking on deep tier | 3–4 | — |
| 2 (wk 3–4) | F2 Conversation compaction + history search | 5–8 | — |
| 2–3 (wk 3–6) | F5 Client knowledge base | 8–12 | F1 (text extraction) |
| 3 (wk 5–7) | F6 MCP client + firm skills | 12–17 | — |
| 4 (wk 8–11) | F4 Analysis sandbox | 15–25 + security review | infra decision |

Cross-cutting conventions (apply to every feature): pure helpers with `*.spec.ts` unit tests per repo convention; eval cases added under `apps/api/src/clio/evals/`; per-tenant feature flags with an env kill-switch; audit-log entries for new side-effecting actions; reuse `clio-circuit-breaker.ts` for any new external dependency.

---

## F1 — Reading what you hand it (PDF + image attachments)

**Current state.** `clio-attachment.helpers.ts` detects kinds (`pdf | docx | image | text | unsupported`) and enforces the 10MB cap, but extraction only exists for docx (mammoth) and text. PDF/image are detected and then dropped — marked "documented follow-up" in the module header.

**Design.** Two paths by kind. PDFs: server-side text extraction (e.g. `unpdf` or `pdf-parse`; pick one, no native binaries) → normalized text, capped (e.g. first 150 pages / 40k chars with an explicit `[truncated]` marker the model can see). Images: no extraction — pass as native Anthropic vision blocks (`{type:'image', source:{type:'base64', media_type, data}}`) in the user turn, since the Messages API reads them directly. Scanned PDFs (no text layer) are out of scope for v1; detect (<100 chars extracted) and tell the user.

**Steps**

1. Add `extractPdfText(buffer): { text, pages, truncated }` next to the existing docx extraction in the Clio service I/O layer; keep `clio-attachment.helpers.ts` pure (caps, truncation marker, scanned-PDF detection threshold as pure functions + specs).
2. Extend the turn-assembly path to emit image attachments as vision content blocks instead of text placeholders; enforce Anthropic image limits (size/count) in a pure validator.
3. MIME-sniff magic bytes server-side (don't trust extension/content-type alone) before parsing; reject mismatches as `unsupported`.
4. Surface state in the drawer: per-attachment chip (parsed ✓ / truncated / unsupported with reason).
5. Evals: ~20-case set — text PDFs (bill text, LDA filing PDF, J-book excerpt), charts/screenshots as images, a scanned PDF, an oversized file.

**Success criteria**

- p95 extraction time < 5s for a 10MB text PDF; no event-loop blocking (extraction off the request path or chunked).
- ≥ 90% on the attachment Q&A eval (answer grounded in the attachment, correct).
- An uploaded chart/screenshot can be described and queried (vision round-trip works).
- Scanned PDFs and unsupported types produce an explicit user-visible explanation, never a silent drop.
- Magic-byte spoof tests (e.g. `.pdf` that is actually HTML) are rejected.

**Risks.** PDF parser edge cases (encrypted, malformed) — wrap in try/catch with friendly failure; cap parser CPU via page limit.

---

## F2 — Long-conversation handling (compaction + history search)

**Current state.** Turns replay full message history into the model (`clio.service.ts` agentic loop); nothing compacts old turns, so long threads will eventually degrade or overflow. History rail lists conversations but has no search. `ContextEmbedding` (pgvector, `schema.prisma:832`) already powers semantic recall for memory.

**Design.** Rolling summary per conversation: when estimated history tokens exceed a budget (configurable, e.g. 50k), summarize the oldest turns with a small model (Haiku-class) into a structured running summary stored on the conversation; prompt becomes `[summary block] + last N verbatim turns` (N≈12). Durable facts continue to flow through ClioMemory (unchanged). History search: embed user/assistant message text into `ContextEmbedding` (`sourceType:'clio_message'`) via the existing embed worker + hash-skip, with keyword ILIKE fallback (same pattern as memory recall).

**Steps**

1. Migration: `ClioConversation.summary TEXT`, `summaryUpToMessageId UUID`, `summaryTokens INT`.
2. Pure helpers (`clio-compaction.helpers.ts` + specs): token estimation, compaction-trigger decision, summary-prompt construction, merge of new summary over old.
3. Service: after-turn async compaction job (never blocks the streaming reply); summary regenerated incrementally (`old summary + turns since` → `new summary`).
4. Turn assembly: inject summary block ahead of verbatim tail; verify prompt-cache friendliness (summary sits in the dynamic tail, not the cached base — consistent with the P0-1 split in `composeSystemParts`).
5. Search: index messages on write; `GET /clio/conversations/search?q=` endpoint (tenant + user scoped); search box in the history rail.
6. Evals: synthetic 300-turn conversation fixture; 20 "needle" probes referencing facts from early turns.

**Success criteria**

- A 300-turn conversation completes turns with no context-overflow errors and bounded prompt size (≤ budget + tail).
- ≥ 95% retention on needle probes whose answers live in compacted turns (answered from the summary).
- Compaction adds zero user-visible latency (async) and ≤ 1 small-model call per ~15 turns.
- History search: top-3 hit rate ≥ 90% on a 25-query eval against seeded conversations; p95 < 700ms.
- Encrypted meeting notes never enter summaries or the message index.

**Risks.** Summary drift/loss of nuance — keep last N turns verbatim, regenerate summary incrementally, and pin tool-result citations of record into the summary block.

---

## F3 — Extended thinking on the deep tier

**Current state.** Tier routing exists: `clio.service.ts:1308` picks `deep` vs `fast` (`deepIntent || longQuery`); the UI already renders a tier pill and a thought-process timeline (`chat-tp*` in `chat.css`). Model calls don't request extended thinking.

**Design.** For `tier === 'deep'` turns and Research-mode gather/synthesize calls, enable Anthropic extended thinking with a configurable budget (env: `CLIO_THINKING_BUDGET_TOKENS`, e.g. 8k chat / 16k research). Stream `thinking_delta` events into a collapsible "Reasoning" entry at the top of the existing timeline. Thinking text is ephemeral UI: never persisted to `ClioMessage`, never fed to the confidence checker, never included in artifacts or docgen.

**Steps**

1. Add thinking params to deep-tier and research Messages calls (`clio.service.ts`, `clio-research.service.ts`); handle the new streaming event types in the SSE relay.
2. Pure helper + specs: event-to-timeline mapping, redaction guarantee (a single function that strips thinking blocks before persistence — unit-tested).
3. UI: "Reasoning" accordion in `chat-tp` body, collapsed by default, live-streaming while open.
4. Config + kill-switch (`CLIO_EXTENDED_THINKING=off` reverts to current behavior); per-tenant flag optional.
5. Eval: 20 deep-tier prompts (bill analysis, briefing) judged pairwise old-vs-new.

**Success criteria**

- Deep-tier turns stream visible reasoning into the timeline; fast-tier turns are unchanged.
- Pairwise quality eval: new ≥ 60% win-rate on deep-tier outputs.
- Automated check: zero thinking text in persisted messages, artifacts, confidence-check inputs, or exports (regression spec).
- p95 deep-turn latency increase ≤ 35%; kill-switch restores baseline with no deploy.

**Risks.** Token cost growth — budget caps + per-tenant flag; monitor usage via existing token-usage extraction (`clio-prompt.helpers.ts:117`).

---

## F4 — Analysis sandbox (code interpreter)

**Current state.** None. Tool registry (`clio-tools.service.ts`) has no execution capability; docgen renders structured specs only. This is the largest blast-radius addition — treat as security-first.

**Design.** A `run_analysis` tool: Clio writes Python, the platform executes it in a locked-down worker and returns stdout, result tables, and chart PNGs. Hard scope for v1: **no network egress, no DB credentials inside the sandbox, read-only inputs.** Inputs are datasets Clio already fetched via its tools (LDA rows, PE budget timelines, award rows) serialized to CSV/JSON files mounted read-only. Runtime: pooled containers hardened with gVisor or nsjail (decision spike in week 1), pinned image with python + pandas/numpy/matplotlib only. Limits: 30s CPU, 1GB RAM, 64 processes, 20MB output, no DNS. Outputs: charts stored as `ClioArtifact` images, embeddable in chat and Word/PPT docgen. Every run audit-logged (tenant, user, code hash, dataset refs). Per-tenant feature flag, default off.

**Steps**

1. Week-1 spike: gVisor vs nsjail vs Firecracker on current infra (`infra/`, `docker/`); pick + document in an ADR.
2. Sandbox runner service (separate process/host from the API): job queue, pool warm-up, resource enforcement, kill-on-limit.
3. `run_analysis` tool registration: schema (code, named dataset refs, expected outputs); mark side-effecting=false but rate-limited; wire dataset hand-off from prior tool results in the agentic round.
4. Chart/table return path → artifact storage → render in drawer (image message) → docgen embedding (extend `clio-docgen` image support).
5. Security review + internal pen-test against the checklist below; only then enable for a pilot tenant.
6. Evals: 15 analysis tasks with ground-truth numbers (sum LDA spend by registrant, YoY PE deltas, district facility counts).

**Success criteria**

- Pen-test checklist passes: no network egress (including DNS), no filesystem escape, no credential material in the sandbox image/env, resource limits kill runaway code, concurrent tenants isolated.
- ≥ 90% numerically correct on the analysis eval (verified against SQL ground truth).
- A requested chart renders in chat and lands correctly in a generated Word/PPT file.
- p95 warm execution < 2.5s, cold < 6s; failures return readable stderr to the user, never a hang.
- Audit log entry for 100% of runs; kill-switch removes the tool from the registry instantly.

**Risks.** Sandbox escape (mitigate: gVisor/nsjail + no secrets + egress-deny by default + separate host); cost (pool sizing + per-tenant quotas); prompt-injected malicious code is contained by the same isolation (code can't reach anything).

---

## F5 — Client knowledge base ("Projects" for clients)

**Current state — better than expected.** The client profile page already has the exact tabs requested: `ClientProfilePage.tsx` renders `overview`, `people`, `facilities`, `documents` (plus capabilities/workflows/intelligence/dow-directory). Backing models exist: `Client` (profile + intake + issue codes, `schema.prisma:261`), `ClientPerson` (`:1257`), `ClientFacility` with `congressionalDistrict` (`:1278`), `EngagementAttachment` (S3-backed docs, `:576`). `ContextEmbedding` (`:832`) is a tenant/client-scoped pgvector table with an embed worker and content-hash skip. **The gap is purely that Clio can't retrieve any of it semantically** — so the KB feature is: index the four tabs, give Clio a retrieval tool, and auto-ground client-scoped chats.

**Design.** One indexing pipeline, four source types into `ContextEmbedding` (all with `clientId` set):

| KB tab | sourceType | Content embedded |
|---|---|---|
| Overview | `client_profile` | name, description, product, sector, issue codes, intake highlights, UEI/NAICS/PSC |
| People | `client_person` | name, title, role, contact, lastContact, notes |
| Facilities | `client_facility` | name, address, state, congressional district, employee count, notes |
| Documents | `client_doc_chunk` | extracted text (reuses F1 extractors) chunked ~1k tokens / 15% overlap, one row per chunk |

Retrieval is two-layer: (a) a new `search_client_knowledge` tool (query + clientId + optional kind filter → pgvector cosine top-k, typed citations `client_kb`); (b) an always-on KB snapshot injected into client-scoped conversations (≤ ~1.2k tokens: profile digest, top people, facility footprint grouped by district, 5 most recent documents) — built once per turn in the pre-loaded context block. Facility rows join districts to member targeting ("which members care about this client") — surfaced in the snapshot. Deletes/updates propagate: on row delete or content-hash change, purge/re-embed (`sourceType`,`sourceId`). Encrypted meeting notes are explicitly excluded.

**Steps**

1. Indexer: extend the existing embed worker with the four source types; backfill job for existing tenants (batched, rate-limited).
2. Document chunking helper (`clio-kb.helpers.ts`, pure + specs): chunking, snapshot assembly, token caps, district grouping.
3. F1 extractor reuse for `EngagementAttachment` content (pdf/docx/text; images indexed by filename + meeting/mail context only in v1).
4. Tool registration `search_client_knowledge` in `clio-tools.service.ts` (+ citation type `client_kb` in `clio-citations.helpers.ts`).
5. Turn assembly: inject KB snapshot for client-scoped conversations; respect prompt-cache split.
6. Lifecycle hooks: attachment/person/facility/profile mutations enqueue re-index or purge.
7. UI affordances: indexing-status chip on the Documents tab; "Ask Clio about this client" button on the profile header (opens drawer pre-scoped).
8. Evals: 30 Q&A over a seeded KB client (people lookups, doc content, facility/district questions, profile facts).

**Success criteria**

- Upload → retrievable ≤ 2 min p95; profile/people/facility edits reflected ≤ 5 min.
- "Who at [client] handles [topic]?", "Summarize [uploaded doc]", "Which districts have [client] facilities, and who represents them?" all answer correctly with KB citation chips — ≥ 90% on the 30-case eval.
- Client-scoped chats include the KB snapshot automatically (visible in the trace) with zero extra user action.
- Tenant isolation verified by RLS test (cross-tenant query returns nothing); deleting a document removes its chunks from retrieval ≤ 5 min.
- Encrypted meeting notes provably absent from the index (spec + audit query).

**Risks.** Index bloat on large doc sets — chunk caps + per-client quota (e.g. 2k chunks v1); stale denormalized snapshot — hash-skip keeps re-embeds cheap.

---

## F6 — Extensibility: MCP client + firm-authored skills

### F6a — MCP client (finish P3-1)

**Current state.** `clio-mcp.helpers.ts` has the tested core: `McpClient` interface, `tools/list` parsing, `mcp__<server>__<tool>` bridging with 1024-char description cap. Missing: a live transport, server config, registration in `clio-tools.service.ts`, and routing in tool execution.

**Steps**

1. Transport: implement `McpClient` over stdio and streamable HTTP using the official MCP SDK; auth = bearer header for HTTP, env for stdio child processes.
2. Config: `ClioMcpServer` table (tenantId, name, transport, endpoint/command, authRef, toolAllowlist, readOnlyTools, enabled) + admin CRUD; secrets in the existing credentials store, never in the row.
3. Registry: on boot + 15-min refresh (and admin "refresh now"), `listTools` → `bridgeMcpTool` → merge into tool schemas; per-tenant filtering at request time.
4. Execution: route `parseBridgedToolName` hits to the right client; wrap calls in `clio-circuit-breaker.ts`; treat every MCP tool as side-effecting (serialized + audited) unless explicitly allowlisted read-only.
5. Injection hardening: sanitize tool descriptions/results (strip system-prompt-like markers, cap result size, label results as untrusted data in the tool-result block).
6. Eval: malicious-server fixture (hostile descriptions + results) — behavior must not deviate on 10 probe prompts.

**Success criteria**

- Two reference servers (one stdio, one HTTP) connect in staging; their tools appear namespaced in the trace and round-trip correctly.
- Server down ⇒ circuit-breaker degrades gracefully (tool reports unavailable; turn continues).
- Tenant with MCP disabled sees zero bridged tools; non-allowlisted tools never registered.
- Injection eval: 0/10 behavioral deviations; oversized results truncated with marker.
- Every MCP write call lands in `AuditLog`.

### F6b — Firm-authored skills (finish P3-4)

**Current state.** `clio-firm-skills.helpers.ts` has the security core: validation (id shape, length/count caps, tool allowlist ≤ 12, reserved-trigger protection for built-ins like `generate_briefing`, `analyze_bill`, `prep_hearing`) and safe merge where built-ins win. Missing: persistence, CRUD, authoring UI.

**Steps**

1. Migration: `ClioFirmSkill` (tenantId, skillJson, version, enabled, createdByUserId, updatedAt) — tenant-cascade + RLS like ClioMemory.
2. Endpoints: admin-gated CRUD + "test run" (dry-run returns the resolved template/sections without executing tools).
3. Registry wiring: tenant skills loaded + `safeMerge`d into the P0-5 skill registry at session start; cache with invalidation on save.
4. UI: Settings → Skills — list, editor form (name, triggers ≤ 5, sections ≤ 12, addendum ≤ 2000 chars, tool allowlist picker), enable/disable, version history.
5. Evals: trigger-routing test (custom trigger fires the skill; reserved trigger rejected at save), output respects sections.

**Success criteria**

- An admin authors an "Earmark Request Memo" skill in the UI; saying its trigger phrase produces output with the skill's sections, firm-wide, within one session refresh.
- Validation rejects: reserved triggers, oversized fields, tools outside the allowlist (spec-covered).
- Skills are tenant-isolated (RLS test) and built-ins always win on conflict (existing helper spec extended to persisted path).
- Disable takes effect ≤ 1 min; version history restorable.

**Effort.** F6a 6–9 days; F6b 6–8 days (UI included).

---

## Rollout & measurement

Ship order follows the phase table; each feature goes out behind a tenant flag with a one-week pilot (Capiro internal tenant), then default-on except F4 (explicit opt-in per tenant). Add an eval CI job that runs the per-feature eval sets nightly; regressions block default-on promotion. Track per-feature adoption (tool-call counts, attachment parse counts, KB retrievals, thinking-enabled turns) via the existing trace/audit plumbing so success criteria are measured from production data, not anecdote.
