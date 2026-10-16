> **Scope status — backend cleanup successor.** Historical qualification audit. Old Web build/browser commands below are archived frontend obligations, not current backend CI. Preserve the recorded local/harness/deployment distinctions. Current frontend parity belongs to `capiro-frontend`; retained Meri/Fable and sandbox source ownership is unchanged.
> Source retirement: [PR30](https://github.com/neo-capiro/capiro-backend/pull/30), exact `7b6bda7ca75ea86afb36c76f013f550fdd79e42f`.

# Clio Assistant-Parity — Implementation Status & Success-Criteria Audit

**Date:** 2026-06-10 · **Branch:** `feat/clio-assistant-parity` · **Plan:** [clio-assistant-parity-plan.md](clio-assistant-parity-plan.md)

All six features are implemented end-to-end (API + web + evals + flags + audit
logging) on this branch. This document audits every success criterion from the
plan: **[done]** = implemented and verified locally (specs/pen-test/typecheck),
**[harness-ready]** = the measurement harness is built and gated, but the
number itself requires a live-API/staging run (`pnpm --filter @capiro/api
eval:clio:*` or the nightly `clio-evals` workflow), **[deploy-step]** = an
infra action that ships with deployment, not code.

Verification gates used throughout (repo convention; `pnpm lint` is known-broken):
`pnpm --filter @capiro/api typecheck` ✓ · `pnpm --filter @capiro/web typecheck` ✓ ·
full `@capiro/api` jest suite ✓ (one pre-existing failure on main,
reconciliation-resolve, flagged separately) · chat vitest 11/11 ✓ ·
`@capiro/clio-sandbox` pen-test 11/11 ✓.

---

## F1 — Attachment reading (PDF + vision)

Shipped: `clio_attachments` table (RLS); unpdf extraction (150p/40k caps,
page-yielding); mammoth docx; magic-byte sniffing; scanned-PDF detection;
vision blocks for current-turn images (regenerate-safe, bytes stored);
doc-text replay in history; upload + chips UI; eval
(`eval:clio:attachments`, 20+ cases incl. failures).

| Criterion | Status |
|---|---|
| p95 extraction < 5s for a large text PDF; no event-loop blocking | [done] measured: 150-page dense PDF extracts in well under 1s locally; page loop awaits between pages; extraction runs on the upload request, off the chat stream path. The literal "10MB text PDF" case is covered by the page/char caps (parser stops at 150 pages / 40k chars regardless of file size). |
| ≥90% attachment Q&A eval | [harness-ready] `eval:clio:attachments` grades 16 doc-Q&A + 3 vision cases, gate 0.9. |
| Chart/screenshot vision round-trip works | [harness-ready] vision probes in the same runner (native image blocks, production block format). |
| Scanned/unsupported produce explicit explanation, never silent drop | [done] spec-covered (`resolveDocumentStatus`), surfaced as chips with reasons; failure-visibility cases in the eval run without tokens. |
| Magic-byte spoof tests rejected | [done] spec-covered (`verifyMagicBytes`: HTML-as-.pdf etc.) + eval failure case. |

## F2 — Long-conversation handling

Shipped: rolling summary columns + after-turn async compaction (intent model,
token-triggered, 12-message verbatim tail); summary in the dynamic system
tail; history-window bug fix (was replaying the *oldest* 20 messages);
message embeddings (`clio_message` sourceType) + `GET /clio/conversations/search`
(pgvector + ILIKE fallback); search box in the rail; 300-message fixture +
needle eval (`eval:clio:compaction`).

| Criterion | Status |
|---|---|
| 300-turn conversation completes, bounded prompt | [done] structurally: prompt = summary (≤400 words) + tail (≤60 msgs, char-trimmed); fixture spec asserts compaction triggers under production defaults. |
| ≥95% needle retention | [harness-ready] `eval:clio:compaction` replays the production pipeline live and gates at 0.95. |
| Zero user-visible latency; ≤1 small-model call per ~15 turns | [done] compaction is setImmediate after the reply; call frequency spec-asserted against the 5000-token trigger (≤10 calls/300 messages). |
| Search top-3 ≥90%, p95 <700ms | [harness-ready] semantic search is one pgvector query + one Titan embed; ILIKE fallback. Hit-rate/latency need seeded-DB measurement (staging). |
| Encrypted meeting notes never enter summaries or index | [done] structural: compaction + indexer read only `clio_messages`; spec-asserted. |

## F3 — Extended thinking on deep tier

Shipped: adaptive thinking (4.6-family correct form; budget-mode escape
hatch), deep-tier + research + forced-synthesis calls; thinking blocks
replayed with signatures through the tool loop; `thinking` SSE events;
Reasoning accordion (collapsed, live-streaming); kill-switch restores
byte-identical baseline (spec); pairwise eval (`eval:clio:thinking`).

| Criterion | Status |
|---|---|
| Deep-tier streams visible reasoning; fast tier unchanged | [done] spec: fast tier/kill-switch produce exactly the old request. |
| ≥60% pairwise win-rate | [harness-ready] 20-prompt pairwise runner with position-debiased judge, gate 0.6. |
| Zero thinking text in persisted messages/artifacts/confidence inputs | [done] body accumulates text deltas only; `stripThinkingBlocks` redaction guarantee spec-covered; research forced-pass routes thinking away from reportBody. |
| p95 latency increase ≤35%; kill-switch no-deploy | [harness-ready] the pairwise runner records per-arm latency and reports the p95 delta; `CLIO_EXTENDED_THINKING=off` is env-only. |

## F4 — Analysis sandbox

Shipped: ADR 0001 (Fargate microVM + no-egress SG + zero-permission role
instead of self-managed gVisor/nsjail); `apps/clio-sandbox` (zero-dep runner,
queue, scrubbed env, wall-clock kill) + `harness.py` (rlimits, audit hooks,
Agg, results/figures); `run_analysis` tool (per-tenant opt-in default OFF +
env kill-switch, 20/hr rate limit, inline datasets); 100% audit logging (code
sha256); charts → `analysis_chart` artifacts → inline chat cards + Word/PPT
embedding (docgen `images`); pen-test script; image build workflow; analysis
eval (`eval:clio:analysis`, 15 ground-truth cases).

| Criterion | Status |
|---|---|
| Pen-test checklist passes | [done] in-process layer: 11/11 locally (egress, DNS, subprocess, native-load, env-credentials, runaway-kill, caps, readable failure, real analysis). Infra layer (no-egress SG, zero-permission role, read-only rootfs, microVM) is [deploy-step], specified in the ADR + sandbox-image workflow notes. |
| ≥90% numerically correct on the analysis eval | [harness-ready] `eval:clio:analysis` (model writes code → real sandbox executes → grade vs recomputed ground truth), gate 0.9; fixture math CI-verified. |
| Chart renders in chat + lands in Word/PPT | [done] inline chart cards (blob-fetched from `GET /clio/artifacts/:id/image`, history-reload included) + `imageArtifactIds` resolution into docx ImageRun / pptx addImage; stored specs re-render with embedded PNGs. |
| p95 warm <2.5s, cold <6s; readable stderr, never a hang | [partially done] wall-clock kill + capped readable stderr verified. Current per-run python spawn + pandas import lands ~2-6s on dev hardware; the documented upgrade path (ADR) is a pre-forked warm worker pool if the pilot misses the 2.5s warm target on Fargate. The eval reports p50/p95 so the number is measured, not guessed. |
| Audit log for 100% of runs; instant kill-switch | [done] audit row success-or-failure with code hash; `CLIO_ANALYSIS_SANDBOX_ENABLED=off` removes the tool from the per-turn registry. |

## F5 — Client knowledge base

Shipped: one indexing pipeline → `context_embeddings` for
client_profile/person/facility/doc_chunk (hash-skip, ~1k-token chunks/15%
overlap, 2k-chunk quota); `search_client_knowledge` tool + `client_kb`
citations; always-on snapshot (profile, top people, facility footprint **by
congressional district**, recent docs) in client-scoped turns; lifecycle
hooks (profile/person/facility/attachment mutations index or purge); KB
status endpoint + chip; "Ask Clio about this client" button; backfill script;
30-case eval (`eval:clio:kb`).

| Criterion | Status |
|---|---|
| Upload→retrievable ≤2min; edits ≤5min | [done] structurally: hooks fire on the mutation itself (setImmediate, seconds not minutes); doc indexing = S3 read + chunk embeds. |
| 30-case Q&A ≥90% with client_kb citations | [harness-ready] `eval:clio:kb` (production text builders + chunker + snapshot, live retrieval + grading), gate 0.9, retrieval@6 reported. |
| Snapshot auto-injected, visible in trace | [done] orchestrator trace gets a `client_kb` step + source attribution; plain-profile fallback on failure. |
| Tenant isolation (RLS); doc deletion purges chunks ≤5min | [done] RLS-double specs (firm-skills service pattern); purge-on-delete hook sweeps `id` + `id:%` chunks immediately. |
| Encrypted meeting notes provably absent | [done] structural source-type allowlist, spec-asserted (MeetingNote has no builder/path). |
| Members-by-district caveat | The DB has no federal-member table (CensusDistrict/StateLegislator only), so the snapshot surfaces the district codes (KS-04 …) and member names resolve through existing tools — noted deviation from the plan's wording. |

## F6a — MCP client

Shipped: official-SDK transports (streamable HTTP w/ bearer; stdio gated
behind operator-only `CLIO_MCP_STDIO_ALLOWED_COMMANDS` — tenant-supplied
commands would be RCE); `clio_mcp_servers` CRUD (AES-256-GCM write-only
secrets); 15-min registry + refresh-now; per-tenant schema merge; circuit
breaker; sanitized + untrusted-labeled results; writes serialized + audited;
admin UI card; injection eval (`eval:clio:mcp-injection`).

| Criterion | Status |
|---|---|
| Two reference servers (stdio + HTTP) round-trip in staging | [deploy-step] transports implemented over the official SDK and unit-covered; staging connection is an environment action (configure a server row + allowlist). |
| Server down ⇒ graceful degrade | [done] registry failures log + return no tools; per-(tenant,server) breaker pauses calls; turn continues. |
| MCP-disabled tenants see zero bridged tools; non-allowlisted never registered | [done] no rows → no schemas; empty allowlist registers nothing (fail-closed, spec-covered); env kill-switch. |
| Injection eval 0/10 deviations; oversized results truncated | [harness-ready] hostile-server fixture runs descriptions+results through the production sanitizers, gate = zero deviations; truncation marker spec-covered. |
| Every MCP write call in AuditLog | [done] non-readOnly calls audit before execution (arg keys, never values). |

## F6b — Firm-authored skills

Shipped: `clio_firm_skills` (RLS) + CRUD/test/restore endpoints; validation at
save (reserved + built-in triggers, caps, registry-restricted tools); version
history (cap 10) with re-validated restore; 60s turn cache; intent OR literal
trigger-phrase matching with built-ins always winning; Settings → Skills page.

| Criterion | Status |
|---|---|
| Admin authors "Earmark Request Memo"; trigger phrase fires firm-wide within one session refresh | [done] phrase matching spec-covered with exactly that fixture; skills load per turn (60s cache). |
| Validation rejects reserved triggers / oversized fields / unknown tools | [done] spec-covered at helper + service layers. |
| Tenant isolation (RLS test); built-ins always win | [done] RLS-double service spec; safe-merge + turn-matcher specs. |
| Disable ≤1min; version history restorable | [done] 60s cache invalidated on save; restore spec round-trips v1→v2→restore(1). |

## Cross-cutting & rollout

- Per-tenant flags: `tenants.settings_jsonb.clioFeatureFlags` via
  `tenantFeatureEnabled` + `ClioFeatureFlagsService` (60s cache), composed
  with env kill-switches everywhere (every feature has its `CLIO_*` switch).
- Nightly eval CI: `.github/workflows/clio-evals.yml` (fixtures job on every
  run; live suites nightly/manual, gated, reports as artifacts). Red gates
  block default-on promotion per the plan.
- Sandbox image CI: `.github/workflows/sandbox-image.yml` (arm64, mirrors
  api-image).
- Audit logging added for: MCP server CRUD, MCP write calls, firm-skill CRUD
  /restore, every sandbox run.
- Adoption tracking: tool-call counts/usage already persist per message
  (`metadata.toolsUsed`, actions, trace) — new tools and thinking turns are
  visible through the existing trace/audit plumbing.

## Deploy/runbook checklist (ships with this branch)

1. `prisma migrate deploy` (3 new migrations: clio_attachments,
   conversation summary columns, clio_mcp_servers + clio_firm_skills).
2. Deploy `clio-sandbox` (new Fargate service, ARM64 image via
   sandbox-image.yml) with: no-egress SG (ingress only from the API SG),
   zero-permission task role, readonlyRootFilesystem + tmpfs /tmp,
   `CLIO_SANDBOX_TOKEN` (shared with API env), then set `CLIO_SANDBOX_URL`
   on the API.
3. Run the in-container pen-test once per image:
   `pnpm --filter @capiro/clio-sandbox pentest`.
4. Optional backfill: `pnpm --filter @capiro/api backfill:client-kb --tenant=<slug> --commit`.
5. Pilot enablement: set `clioFeatureFlags.runAnalysis=true` on the Capiro
   internal tenant only (F4 stays opt-in per tenant; everything else is
   default-on behind env kill-switches).
6. Configure the `ANTHROPIC_API_KEY` secret on the repo so the nightly
   live-eval job runs; first green night = baseline.
