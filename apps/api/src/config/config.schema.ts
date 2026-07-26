import { z } from 'zod';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  API_PORT: z.coerce.number().int().positive().default(4000),
  API_BIND_HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),

  CLERK_SECRET_KEY: z.string().min(1, 'CLERK_SECRET_KEY is required'),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1, 'CLERK_WEBHOOK_SIGNING_SECRET is required'),
  CLERK_JWT_ISSUER: z.string().url().optional(),

  WEB_ORIGIN: z.string().optional(),

  // Tenant assets bucket (logos, future documents).
  ASSETS_BUCKET: z.string().optional(),
  DIRECTORY_S3_BUCKET: z.string().optional(),
  DIRECTORY_S3_PREFIX: z.string().optional(),
  DIRECTORY_S3_LATEST_KEY: z.string().default('UPDATED DIRECTORY/LATEST.json'),
  // LegiStorm is used only by the scheduled directory-refresh CLI. Keep the key
  // optional at API-server boot; the CLI itself fails closed when it is absent.
  LEGISTORM_API_KEY: z.string().min(1).optional(),
  LEGISTORM_BASE_URL: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === 'https:', 'LEGISTORM_BASE_URL must use HTTPS')
    .default('https://api.legistorm.com/v2.019.10/congress'),
  // LegiStorm caps `limit` at 100 per request; larger values return HTTP 422.
  LEGISTORM_PAGE_SIZE: z.coerce.number().int().positive().max(100).default(100),
  LEGISTORM_MAX_PAGES: z.coerce.number().int().positive().default(10_000),
  LEGISTORM_REQUEST_DELAY_MS: z.coerce.number().int().nonnegative().default(400),
  LEGISTORM_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  LEGISTORM_MAX_RETRY_DELAY_MS: z.coerce.number().int().positive().default(30_000),
  LEGISTORM_OVERLAP_DAYS: z.coerce.number().int().nonnegative().default(2),
  // Legislative Districts API (WS-B, LegiStorm gaps/enrichment plan) — a
  // DIFFERENT base URL than LEGISTORM_BASE_URL above (that one is the
  // Congressional API, v2.019.10/congress). Used only by the scheduled
  // districts-refresh CLI (sync-legistorm-districts), which ALSO hardcodes
  // this same value as its own fallback — so an incomplete env-wiring never
  // silently sends a districts request to the congress endpoint.
  LEGISTORM_DISTRICTS_BASE_URL: z
    .string()
    .url()
    .refine(
      (value) => new URL(value).protocol === 'https:',
      'LEGISTORM_DISTRICTS_BASE_URL must use HTTPS',
    )
    .default('https://api.legistorm.com/v2.023.07/legislative_districts'),
  AWS_REGION_DEFAULT: z.string().default('us-east-1'),

  // Census ACS 5-year demographics sync (District Nexus). Secret already
  // provisioned out-of-band as capiro/<env>/census_api_key. Used only by the
  // scheduled sync-census CLI; optional at API-server boot so the long-lived
  // serve/migrate tasks don't require it (mirrors LEGISTORM_API_KEY above).
  CENSUS_API_KEY: z.string().min(1).optional(),

  // PE Watch defense-budget ingestion (Step: LlamaParse + immutable S3 archive).
  // LLAMA_CLOUD_API_KEY is optional at API-server boot; only the ingestion CLI
  // (ingest-defense-budget-pdf) hard-requires it and fails closed when absent.
  LLAMA_CLOUD_API_KEY: z.string().min(1).optional(),
  LLAMA_CLOUD_BASE_URL: z
    .string()
    .url()
    .refine((v) => new URL(v).protocol === 'https:', 'LLAMA_CLOUD_BASE_URL must use HTTPS')
    .default('https://api.cloud.llamaindex.ai'),
  // Immutable raw-archive bucket (Object Lock GOVERNANCE, dedicated KMS CMK).
  // A SourceDocument row is NOT proof of archival; the ingestion pipeline writes
  // original bytes here BEFORE parsing and records the returned VersionId.
  DEFENSE_BUDGET_RAW_BUCKET: z.string().optional(),
  DEFENSE_BUDGET_AUDIT_BUCKET: z.string().optional(),
  DEFENSE_BUDGET_RAW_KMS_KEY_ARN: z.string().optional(),
  DEFENSE_BUDGET_RETENTION_YEARS: z.coerce.number().int().positive().default(7),

  // Optional AI providers. Meeting prep endpoints fail closed with 503 until
  // one provider key is configured; they never return canned prep.
  AI_PROVIDER: z.enum(['openai', 'anthropic']).optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),

  // Meeting-debrief model overrides (scoped to generateMeetingDebrief ONLY — the
  // notetaker summary + the manual "Generate Debrief" flow — so bumping the debrief
  // model never changes prep / talking-points / outreach / campaign, which keep
  // reading OPENAI_MODEL / ANTHROPIC_MODEL). Unlike OUTREACH_DRAFT_MODEL these
  // default to a concrete better-than-mini/haiku model rather than '' because the
  // upgrade is the intended behavior: debriefs must not run on gpt-4.1-mini or
  // claude-haiku. Both ids are already in AI_PRICING so COGS stays correct. A
  // tenant's explicit BYOK modelOverride still wins over these (see
  // generateMeetingDebrief). Set to '' to fall back to the global model.
  DEBRIEF_OPENAI_MODEL: z.string().default('gpt-4.1'),
  DEBRIEF_ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),

  // Phase 1 SSOT-consolidation recall source (docs/plans/…phase-1-ssot-cutover-plan.md).
  // Governs where Meri's learned-fact recall (loadRelevantMemories) reads from:
  //   'clio'       — clio_memory.embedding (OpenAI), today's behavior. DEFAULT.
  //   'union'      — clio-recall ∪ projection-recall (memory_items→context_embeddings,
  //                  Titan), deduped. A SUPERSET: projection failures are caught and
  //                  degrade to clio-only, so recall can never drop below 'clio'.
  //   'projection' — projection only (the collapse). Flip ONLY after 'union' is
  //                  observed stable and diag-memory-recall-parity reads
  //                  wouldDropOnCollapse=0 for every tenant.
  // Out-of-band flag flip, never on by a code deploy alone. Landed inert at 'clio'.
  MEMORY_RECALL_SOURCE: z.enum(['clio', 'union', 'projection']).default('clio'),

  // Relevance floor for the PROJECTION recall path (memory_items →
  // context_embeddings, Titan v2 cosine similarity). The clio path has always
  // floored at score > 0.3 (OpenAI space — semanticMemorySearch); the
  // projection path shipped with none, so when nothing relevant exists the
  // LIMIT still fills with weak tail matches. Titan and OpenAI similarity
  // scales are NOT comparable; measured on dev memory-item embeddings
  // (2026-07-19, n=7503): random-pair (unrelated) p50 0.091 / p99 0.383;
  // nearest-neighbor (related) p10 0.509 / p50 0.869. Default 0.4 sits between
  // the noise p99 and the related p10. Re-tune against real query traffic
  // during the 'union' canary; 0 disables the floor.
  MEMORY_PROJECTION_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.4),

  // (Phase 4's MEMORY_CONFIDENCE_WEIGHT was superseded by the unified Phase 5
  // reranker — confidence is now one weight in MEMORY_RECALL_W_CONFIDENCE under
  // the MERI_RECALL_RERANK switch below.)

  // Phase 4 — write-path confidence floor for MODEL-extracted memories
  // (auto-learn). Default 0.7 reproduces the previously-hardcoded gate exactly
  // (meri.service.ts maybeLearnFromConversation). A model extraction below this
  // is not auto-committed; explicit human saves are unscored and unaffected.
  MEMORY_MIN_WRITE_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),

  // ── Phase 5 — retrieval quality (memory-scoring.helpers.ts) ────────────────
  // Master switch for unified similarity+recency+confidence recall fusion.
  // 'off' (default) = pure-cosine order, byte-identical to pre-Phase-5. Flip
  // to 'on' out-of-band, canaried per tenant via
  // settings_jsonb.clioFeatureFlags.meriRecallRerank, after the union canary.
  MERI_RECALL_RERANK: z.enum(['off', 'on']).default('off'),
  // Recency half-life (days): a memory that hasn't been confirmed/updated in
  // this many days contributes half its recency factor. Long by default so a
  // durable fact ("HQ is DC") is barely penalized; tune during canary.
  MEMORY_RECALL_HALFLIFE_DAYS: z.coerce.number().min(1).default(180),
  // Fusion weights (normalized to sum 1 at use). Defaults keep similarity
  // dominant so rerank only reorders near-ties by recency/confidence.
  MEMORY_RECALL_W_SIM: z.coerce.number().min(0).default(0.6),
  MEMORY_RECALL_W_RECENCY: z.coerce.number().min(0).default(0.25),
  MEMORY_RECALL_W_CONFIDENCE: z.coerce.number().min(0).default(0.15),
  // Over-fetch multiplier when rerank is on: fetch K×N (capped 30) candidates so
  // a fresh/confident row the raw top-K would have dropped can be promoted.
  MEMORY_RECALL_OVERFETCH: z.coerce.number().int().min(1).max(10).default(3),
  // Neutral confidence prior for rows with no confidence (unscored/human/legacy).
  MEMORY_RECALL_NEUTRAL_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),
  // Clio (OpenAI-space) recall floor — was hardcoded 0.3 in semanticMemorySearch;
  // now configurable, default 0.3 = exact parity.
  MEMORY_CLIO_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.3),
  // Context assembly budget unit. 'chars' (default) = today's behavior exactly;
  // 'tokens' switches truncation to the shared token estimator (provably ~inert
  // at the calibrated ratio). Flip out-of-band once token parity is confirmed.
  MERI_CONTEXT_BUDGET_UNIT: z.enum(['chars', 'tokens']).default('chars'),

  // ── Phase 6 — governed ingestion + retention (all default OFF/inert) ───────
  // IMPORTANT: these use the house string-allowlist transform, NOT
  // z.coerce.boolean() — the latter coerces via Boolean(str), so ANY non-empty
  // value (incl. 'false'/'0'/'off') would evaluate TRUE and ARM a destructive
  // route. Here ONLY 'true'/'1'/'yes'/'on' enable; anything else (incl. unset,
  // 'false') stays off. Never rely on writing '=false' to disable — leave unset.
  //
  // MEMORY_PURGE_ENABLED — master switch for the retention purge routes + script
  // execute path. Off ⇒ POST /memory/purge/* returns 503 and the script refuses
  // --execute. (The other three are RESERVED — see note below.)
  MEMORY_PURGE_ENABLED: z
    .string()
    .default('false')
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),
  // RESERVED (consumer NOT yet built — flipping is currently a NO-OP; do not rely
  // on it). MEMORY_AUTOLEARN_GOVERNED will route auto-learn through the candidate
  // flow; today auto-learn still writes clio_memory directly regardless of this.
  MEMORY_AUTOLEARN_GOVERNED: z
    .string()
    .default('false')
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),
  // RESERVED (NO-OP today): GET /memory/learned surface is not yet implemented.
  MEMORY_LEARNED_SURFACE_ENABLED: z
    .string()
    .default('false')
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),
  // RESERVED (NO-OP today): the nightly retention-policy purge pass is not yet
  // implemented in refresh-memory-graph.
  MEMORY_RETENTION_SWEEP: z
    .string()
    .default('false')
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),

  // Phase 7A — recall-miss observability. Emit CloudWatch EMF metrics at the
  // memory-recall boundary (hit / empty / error). Default 'on' (side-effect-only,
  // never changes recall behavior); flip to 'off' as a kill-switch if noisy.
  MERI_CONTEXT_METRICS: z.enum(['on', 'off']).default('on'),

  // ── Track B — knowledge-graph revival (all dark by default) ────────────────
  // Master traversal source. 'legacy' = today's per-request System A build;
  // 'cache' = the materialized kg_edge_cache + bounded scoped traversal (needs
  // migrations 20260722010000/020000 clone-rehearsed first). Landed inert.
  KG_TRAVERSAL_SOURCE: z.enum(['legacy', 'cache']).default('legacy'),
  // The intel per-client KG endpoint (getKnowledgeGraph → unscoped kg_walk).
  // 'off' (default) ⇒ 404/503: closes the orphaned, RLS-exempt, unscoped live
  // surface until the scoped bounded traversal replaces it. 'scoped' re-enables
  // it on the wall/tenant-scoped path only.
  KG_INTEL_GRAPH: z.enum(['off', 'scoped']).default('off'),
  // GraphRAG fusion into Meri recall. Default off; per-tenant canary via
  // settings_jsonb.clioFeatureFlags.meriRecallGraph. Fail-safe (graph failure
  // never blanks recall). Inert until the cache substrate + fusion land.
  MERI_RECALL_GRAPH: z
    .string()
    .default('false')
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),

  // Outreach prompt-assembly version (plan W2). 'v1' = the legacy single-string
  // prompt + JSON context dump; 'v2' = PromptSpec v2 (real system prompt, context
  // precedence ladder, spotlighted untrusted content, no raw JSON dump). Defaults
  // to 'v1' so the flip is an explicit, out-of-band config change validated by the
  // outreach evals A/B (W2.7) — never on by a code deploy alone.
  OUTREACH_PROMPT_SPEC: z.enum(['v1', 'v2']).default('v1'),

  // Outreach task-tier model config (plan W3.2 / D2). OPT-IN, exactly like the
  // prompt-spec + async flags: defaults preserve current behavior (global
  // provider order + the resolved cred model, i.e. today's gpt-4.1-mini/haiku),
  // so a code deploy NEVER silently changes the drafting model or COGS. The D2
  // flip — prefer Anthropic + draft on claude-sonnet-4-6 — is an explicit
  // out-of-band env set (OUTREACH_PROVIDER=anthropic, OUTREACH_DRAFT_MODEL=
  // claude-sonnet-4-6) applied per the task-def recipe AFTER eval validation +
  // Ninja's COGS sign-off. Empty OUTREACH_DRAFT_MODEL = no override. FAST_MODEL
  // is reserved for cheaper sub-tasks as they migrate onto the tiered client.
  OUTREACH_PROVIDER: z.enum(['openai', 'anthropic']).optional(),
  OUTREACH_DRAFT_MODEL: z.string().default(''),
  OUTREACH_FAST_MODEL: z.string().default(''),

  // Per-tenant daily outreach token ceiling (plan W3.4 / A7): total (input +
  // output) AI tokens across outreach generation workflows in the current UTC
  // day. Soft-warn at 80% (generation proceeds, wizard shows a banner), hard-stop
  // at 100% (typed 429 the wizard renders). Default is generous (6M ≈ 5M in / 1M
  // out); set 0 to disable the ceiling entirely.
  OUTREACH_DAILY_TOKEN_BUDGET: z.coerce.number().int().nonnegative().default(6_000_000),

  // Async outreach pipeline flags (plan W4). When ON, generate/send run as
  // Postgres jobs off the request path (past the ALB idle ceiling); OFF keeps the
  // synchronous endpoints. Rolled out independently and default OFF so the async
  // path is opt-in per environment until canary-verified.
  OUTREACH_ASYNC_GEN: z
    .string()
    .default('false')
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),
  OUTREACH_ASYNC_SEND: z
    .string()
    .default('false')
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),
  // Worker cadence + how long a claimed item may sit before it is considered
  // abandoned (crash) and reclaimed. Generation reclaim is safe (at-least-once);
  // send items stuck in 'sending' are NOT auto-reclaimed (at-most-once).
  OUTREACH_JOB_SWEEP_MS: z.coerce.number().int().positive().default(5_000),
  OUTREACH_JOB_STALE_MS: z.coerce.number().int().positive().default(120_000),

  // Engagement Phase 0 — trust boundary + external-send integrity.
  //
  // ENGAGEMENT_VERSIONED_OUTREACH: when ON, every externally sendable draft is
  // an immutable, audited outreach_draft_versions row, real sending goes through
  // durable send intents (version ids only), and the legacy raw-body
  // POST /outreach/send-batch route is refused for real sends. OFF keeps the
  // pre-Phase-0 synchronous path byte-for-byte, so the migration + new API can
  // deploy inert and be enabled per environment afterwards.
  //
  // ENGAGEMENT_EXTERNAL_SEND_V2_REQUIRED: when ON, a REAL (non-test) send is
  // refused unless the draft version was produced under PromptSpec v2 or later.
  // Independent of the flag above so a canary can turn versioning on first and
  // gate prompt quality separately.
  //
  // Both default OFF in repository code: enabling either is an explicit
  // out-of-band environment change, never a consequence of a code deploy.
  ENGAGEMENT_VERSIONED_OUTREACH: z
    .string()
    .default('false')
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),
  ENGAGEMENT_EXTERNAL_SEND_V2_REQUIRED: z
    .string()
    .default('false')
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),

  // Engagement auto-sync scheduler: periodic reconciliation syncs for connected
  // M365/Google mailboxes. Webhooks are a latency optimization, NOT a
  // reliability mechanism — Graph subscriptions expire after 6 days and were
  // only renewed during syncs, so webhook-only connections went permanently
  // silent (observed: mailboxes stale for weeks while showing "connected").
  // The scheduler guarantees eventual freshness, renews subscriptions, and
  // pulls quiet mailboxes through backfills. Kill-switch: set false/0/no/off.
  ENGAGEMENT_AUTO_SYNC: z
    .string()
    .default('true')
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),
  // Per-connection sync cadence. Delta syncs are cheap (changes-only); 20 min
  // keeps Gmail historyId cursors alive and folder coverage fresh.
  ENGAGEMENT_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(20),

  // SAM.gov Contract Opportunities API key (api.data.gov). Stored in Secrets
  // Manager and injected as an env var; optional so non-prod boots without it.
  SAM_GOV_API_KEY: z.string().optional(),
  // Kill-switch for SAM Entity-Management gov-id enrichment (UEI/CAGE/NAICS on
  // client create/import). Defaults ON; set false/0/no/off to pause enrichment
  // (e.g. if SAM is degraded or quota is exhausted) WITHOUT a code deploy.
  SAM_ENRICHMENT_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),

  // Meri chat brain (single Anthropic-native model + budgets). Env-driven so
  // the model and token ceiling are not hard-coded in service code.
  CLIO_MODEL: z.string().default('claude-sonnet-4-6'),
  CLIO_MAX_TOKENS: z.coerce.number().int().positive().default(4000),
  CLIO_INTENT_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  CLIO_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // Max characters of prior conversation history sent to the model. Older turns
  // beyond this budget are dropped (oldest-first) to avoid silent context-limit
  // 400s on long sessions. ~80k chars ≈ 20k tokens — comfortably within the
  // Sonnet 200k window while leaving room for system blocks, tools, and the
  // current turn. Raised from 24k (which silently evicted context in long /
  // data-heavy threads — users reported Meri "losing context").
  CLIO_HISTORY_CHAR_BUDGET: z.coerce.number().int().positive().default(80_000),
  // Max agentic tool-use rounds per message before forcing a final answer (P2-3).
  CLIO_MAX_TOOL_ROUNDS: z.coerce.number().int().positive().default(8),
  // Wall-clock budget for a whole turn across all rounds (P2-3). When exceeded the
  // loop stops and wraps up gracefully. <= 0 disables. Keep <= the request timeout.
  CLIO_TURN_BUDGET_MS: z.coerce.number().int().min(0).default(90_000),
  // Anthropic prompt caching (P0-1). When enabled, cache breakpoints are placed
  // on the static system base and the tool-schema block, so repeated turns within
  // the ~5-minute cache TTL reuse that prefix (response usage reports
  // cache_read_input_tokens > 0). Only the static prefix is cached; per-turn
  // context and messages are never cached. Set false/0/no/off to disable.
  CLIO_PROMPT_CACHE_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  // Per-tool execution timeout (P0-2). Within an agentic round, read-only tools
  // run concurrently and side-effecting tools serially; each tool call is bounded
  // by this timeout. On timeout the model receives an error tool_result and the
  // turn proceeds (the tool is not hard-aborted).
  CLIO_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // Max retries for idempotent (read-only) Meri tools; side-effecting tools never
  // retry. After repeated failures a per-(tenant, tool) circuit breaker pauses the
  // tool so the turn proceeds without it instead of retrying a dead dependency (P2-2).
  CLIO_TOOL_RETRIES: z.coerce.number().int().min(0).default(1),
  // Inline citations (P0-3). When enabled, numbered sources are injected into
  // tool results and the model cites them as [N]; hallucinated markers are
  // stripped post-hoc and the used citations are emitted (SSE) + persisted to
  // clio_message.metadata.citations. Set false/0/no/off to disable.
  CLIO_CITATIONS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  // Skill registry (P0-5). When enabled, migrated intents resolve their guidance
  // + output template from meri/skills/*; un-migrated intents fall back to the
  // legacy inline maps. Migrated skills are byte-identical to the legacy entries,
  // so toggling this never changes output. Set false/0/no/off to force the
  // legacy path.
  CLIO_SKILLS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  // Grounding/verifier gate (P0-6). When enabled, deliverables (briefings/memos)
  // get a cheap second pass (CLIO_INTENT_MODEL) that flags claims unsupported by
  // retrieved sources; >20% unsupported marks the output low-confidence. Never
  // gates raw chat. Fail-open. Set false/0/no/off to disable.
  CLIO_VERIFIER_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  // Suggested next actions (P2-4): after an answer, a cheap intent-model pass
  // proposes 2-3 follow-up prompts rendered as clickable chips. Fail-open.
  CLIO_SUGGESTIONS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),

  // Extended thinking on the deep tier (assistant-parity F3). When enabled,
  // deep-tier chat turns and deep-research gather/synthesize calls request
  // model reasoning, streamed to the UI timeline as it happens. 'adaptive'
  // mode (default, recommended on the Claude 4.6-family models Meri runs on,
  // where fixed thinking budgets are deprecated) lets the model decide when
  // and how much to think; 'budget' mode sends a fixed budget_tokens for
  // pinned older models. Thinking text is ephemeral UI: never persisted to
  // messages/artifacts, never fed to the confidence checker. Kill-switch: set
  // false/0/no/off to restore exact baseline requests with no deploy.
  CLIO_EXTENDED_THINKING: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  CLIO_THINKING_MODE: z.enum(['adaptive', 'budget']).default('adaptive'),
  // Budget mode: the fixed thinking budget. Adaptive mode: extra max_tokens
  // headroom granted so thinking never crowds out the visible answer.
  CLIO_THINKING_BUDGET_TOKENS: z.coerce.number().int().positive().default(8000),
  CLIO_RESEARCH_THINKING_BUDGET_TOKENS: z.coerce.number().int().positive().default(16_000),

  // Long-conversation compaction (assistant-parity F2). An after-turn async
  // job folds turns older than the verbatim tail into a rolling per-
  // conversation summary (small intent-tier model) once the un-summarized
  // text reaches the trigger budget; turn assembly then sends
  // [summary block] + last-N verbatim turns instead of replaying everything.
  // Kill-switch: set CLIO_COMPACTION_ENABLED=false to stop compacting (the
  // stored summary keeps being injected for already-compacted threads).
  CLIO_COMPACTION_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  CLIO_COMPACTION_TRIGGER_TOKENS: z.coerce.number().int().positive().default(5000),
  CLIO_COMPACTION_TAIL_MESSAGES: z.coerce.number().int().positive().default(12),
  // Conversation-history search index (F2): embeds chat messages into
  // context_embeddings (sourceType 'clio_message') after each turn. Search
  // degrades to keyword ILIKE when embeddings are unavailable or disabled.
  CLIO_MESSAGE_INDEX_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  // Client knowledge base (assistant-parity F5): indexes client profile,
  // people, facilities, and uploaded documents into context_embeddings for
  // the search_client_knowledge tool + the always-on client-chat snapshot.
  // Kill-switch: set false/0/no/off to stop indexing and snapshot injection
  // (the retrieval tool degrades to empty results).
  CLIO_CLIENT_KB_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  // Tenant-configured MCP servers (assistant-parity F6a). Kill-switch: set
  // false/0/no/off and no bridged tools register or execute, instantly.
  CLIO_MCP_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  // stdio MCP servers spawn a child process ON THE API HOST, so the exact
  // command must be allowlisted here by the platform operator (comma-
  // separated). Empty (default) = stdio servers refuse to start; tenant
  // admins can only configure streamable-HTTP servers on their own.
  CLIO_MCP_STDIO_ALLOWED_COMMANDS: z.string().optional(),
  // Connector library (connector-library v1). Absolute callback URL registered
  // as the OAuth redirect_uri for connectors that use OAuth 2.1 (dynamic client
  // registration). Must point at GET /api/clio/mcp-oauth/callback on the app
  // origin, e.g. https://app.capiro.ai/api/clio/mcp-oauth/callback. Unset =
  // OAuth connectors can't be connected (token/none connectors still work).
  CLIO_MCP_OAUTH_REDIRECT_URI: z.string().url().optional(),
  // Where the OAuth callback bounces the browser back to after connecting.
  CLIO_MCP_OAUTH_SUCCESS_REDIRECT: z.string().default('/settings/integrations'),
  // SSRF guard: connector endpoints must be https and must NOT target a
  // private/loopback/link-local address. Set true ONLY for local development to
  // permit http://localhost / 127.0.0.1 MCP servers. Never enable in prod.
  CLIO_MCP_ALLOW_INSECURE_LOCAL: z
    .string()
    .default('false')
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),
  // Firm-authored skills (assistant-parity F6b). Kill-switch: set
  // false/0/no/off and tenant skills stop loading at turn time (rows are
  // retained; CRUD still works).
  CLIO_FIRM_SKILLS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  // Analysis sandbox (assistant-parity F4). The run_analysis tool registers
  // only for tenants that opted in (settings_jsonb.clioFeatureFlags
  // .runAnalysis = true — pilot default OFF) AND while this env kill-switch
  // is on; flipping it off removes the tool from the registry instantly.
  // The runner is a separate no-egress Fargate service (apps/clio-sandbox,
  // ADR 0001); URL + bearer token configure the VPC-internal hop.
  CLIO_ANALYSIS_SANDBOX_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  CLIO_SANDBOX_URL: z.string().url().optional(),
  CLIO_SANDBOX_TOKEN: z.string().optional(),

  // Meri public web search (search_public_web). 'duckduckgo' (default) keeps the
  // existing scraped DDG behavior with zero new dependencies; 'tavily'/'serper'
  // call the respective search API when its key is configured, with automatic
  // DDG fallback on provider error or a missing key — so setting only the
  // provider (without a key) never breaks the tool.
  CLIO_WEB_SEARCH_PROVIDER: z.enum(['duckduckgo', 'tavily', 'serper']).default('duckduckgo'),
  TAVILY_API_KEY: z.string().optional(),
  SERPER_API_KEY: z.string().optional(),

  // Meri Deep Research (a heavier, multi-round agentic research run that produces
  // a long, cited report artifact). Separate budgets from the chat drawer because
  // research runs longer and writes a much larger output.
  CLIO_RESEARCH_MODEL: z.string().default('claude-sonnet-4-6'),
  CLIO_RESEARCH_PLAN_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  CLIO_RESEARCH_MAX_TOKENS: z.coerce.number().int().positive().default(8000),
  CLIO_RESEARCH_MAX_TOOL_ROUNDS: z.coerce.number().int().positive().default(10),
  // Per-request timeout for the deep-research model calls. A single research
  // turn legitimately runs minutes (gathering across many tools, then streaming
  // an 8k-token report), so the 120s interactive chat timeout
  // (CLIO_REQUEST_TIMEOUT_MS) is far too short — it was aborting research runs
  // before the report was written, leaving only the "Sources consulted" list.
  CLIO_RESEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),

  // 32-byte base64 or hex key used for AES-256-GCM encrypted meeting notes.
  NOTES_ENCRYPTION_KEY: z.string().optional(),
  NOTES_ENCRYPTION_KEY_VERSION: z.string().default('v1'),

  // 32-byte base64 or hex key for AES-256-GCM at-rest encryption of OAuth
  // access/refresh tokens stored in engagement_connection_tokens. Distinct
  // from NOTES_ENCRYPTION_KEY so a key compromise on either side is contained.
  OAUTH_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: z.string().default('v1'),

  // 32-byte base64 or hex key for AES-256-GCM at-rest encryption of
  // per-tenant AI provider keys (tenant_ai_credentials). Dedicated key —
  // do not reuse the notes/OAuth keys, so a compromise stays contained.
  // Unset = bring-your-own-key feature inactive (global env keys only).
  AI_CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  AI_CREDENTIAL_ENCRYPTION_KEY_VERSION: z.string().default('v1'),

  // Shared secret for trusted backend-service callers (currently: intel-api's
  // live-hearing tenant-AI-credential resolve, BYOK3). Checked by
  // InternalServiceGuard against the `x-internal-service-secret` header — NOT
  // a user-facing auth path, so it never returns a raw provider key to a
  // browser-held Clerk JWT. Unset = the guarded route is fully disabled
  // (fail-closed), not fail-open.
  INTERNAL_SERVICE_SECRET: z.string().optional(),

  // Gate-bypass hardening for POST /api/clio/tools/:name: when 'true', that
  // endpoint (which executes WRITE tools with no compliance gate — the gate
  // lives in the MeriV2 orchestrator) requires the INTERNAL_SERVICE_SECRET
  // header IN ADDITION to the user JWT, so only the orchestrator (post-gate),
  // never a rogue user bearer, can reach it. Default false = OBSERVE (log a
  // secret-less call, allow it) so the orchestrator can be confirmed sending the
  // secret before enforcement. See ToolServiceSecretGuard.
  MERI_TOOLS_REQUIRE_SERVICE_SECRET: z
    .string()
    .default('false')
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),

  // Recall.ai meeting-notetaker bot (docs/plans/meeting-notetaker-bot-plan.md).
  // RECALL_API_KEY authenticates outbound bot dispatch/poll calls (sent as the
  // `Authorization: Token <key>` scheme, NOT Bearer). RECALL_WEBHOOK_SECRET
  // (whsec_…) verifies inbound Svix-signed Recall webhooks. RECALL_API_BASE_URL
  // selects the region host — Recall regions are isolated deployments with their
  // own keys/data-residency, so this must match the region the API key belongs
  // to. Capiro's Recall workspace is us-west-2 (US West / Oregon). The two secrets
  // are optional: unset = the notetaker feature is inert (no bot can be
  // dispatched), matching the fail-closed posture of the other provider keys.
  RECALL_API_KEY: z.string().optional(),
  RECALL_WEBHOOK_SECRET: z.string().optional(),
  RECALL_API_BASE_URL: z.string().url().default('https://us-west-2.recall.ai'),
  // Global kill-switch for the meeting-notetaker feature. Read directly from
  // process.env by tenant-flags.notetakerEnabled(); declared here for validation
  // and visibility. Only the literal 'true' enables; ANDed with the per-tenant
  // `notetaker.enabled` flag so the feature stays dormant until BOTH are on.
  NOTETAKER_ENABLED: z.string().optional(),

  // Retention window (days) for notetaker call TRANSCRIPTS. The notetaker reconcile
  // sweep deletes source='notetaker' EngagementAttachments (S3 object + row + KB
  // chunks) older than this — the derived meeting NOTES and DEBRIEFS are separate
  // tables with no cascade and are kept forever. 0 (or negative) disables the sweep
  // leg entirely (kill-switch / tuning lever without a redeploy). Default 30 days.
  NOTETAKER_TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().default(30),

  // 32+ byte secret used to HMAC-sign the `state` parameter in OAuth flows so
  // a callback can be tied back to the connection that started it.
  OAUTH_STATE_SECRET: z.string().optional(),

  // Microsoft 365 Graph OAuth (capiro-outlook app registration). Cert auth is
  // used because the capiro.ai tenant blocks client secrets. The private key
  // is a PEM string; if it doesn't start with "-----BEGIN" the loader treats
  // it as base64-encoded PEM (handy for env-var transport).
  MICROSOFT_CLIENT_ID: z.string().optional(),
  // MICROSOFT_TENANT_ID is retained for reference/diagnostics only. It must NOT
  // drive the OAuth authority: customers connect their own Outlook mailboxes
  // from ANY Azure AD org, so the authority is multi-tenant (MICROSOFT_AUTHORITY
  // below). Pinning the authority to this single tenant GUID (= the capiro.ai
  // tenant) was what rejected every external customer with AADSTS50020.
  MICROSOFT_TENANT_ID: z.string().optional(),
  // OAuth authority for the Microsoft 365 integration. Defaults to the shared
  // multi-tenant `/organizations` endpoint so work/school accounts from any
  // customer Azure AD tenant can connect. The capiro-outlook app registration
  // is already multi-tenant (AzureADMultipleOrgs), so no Azure change is needed.
  // Override only for a deliberately single-tenant deployment.
  MICROSOFT_AUTHORITY: z.string().url().default('https://login.microsoftonline.com/organizations'),
  MICROSOFT_CERT_THUMBPRINT: z.string().optional(),
  MICROSOFT_CERT_PRIVATE_KEY: z.string().optional(),
  // APP_SIGN_IN_URL is injected by CDK per env (compute-stack apiSharedEnv).
  // The prod default here keeps prod working if ever run without CDK injection.
  APP_SIGN_IN_URL: z.string().url().default('https://app.capiro.ai/sign-in'),
  // Optional override for Clerk invitation redirect URLs. When unset, the
  // tenant-admin invitation flow derives the URL from the first entry of
  // WEB_ORIGIN (which is a comma-separated CORS allowlist). Set this
  // explicitly when the primary host differs from the first allowed
  // origin or when invitation links should land on a non-standard route.
  INVITATION_REDIRECT_URL: z.string().url().optional(),
  MICROSOFT_REDIRECT_URI: z
    .string()
    .url()
    .default('https://app.capiro.ai/api/engagement/integrations/microsoft/callback'),
  MICROSOFT_OAUTH_SUCCESS_REDIRECT: z.string().default('/settings/integrations'),
  MICROSOFT_GRAPH_NOTIFICATION_URL: z
    .string()
    .url()
    .default('https://app.capiro.ai/api/engagement/integrations/microsoft/notifications'),

  // Google Workspace OAuth (capiro-gmail-integration GCP project). Unlike the
  // Microsoft app registration (which uses certificate auth because the
  // capiro.ai Azure tenant blocks client secrets), Google's Web-application
  // OAuth client uses a standard client secret — there is no cert-based
  // confidential-client option for this delegated, multi-tenant flow. The
  // secret lives in AWS Secrets Manager (capiro/dev/GOOGLE_CLIENT_SECRET),
  // never in plaintext. All keys are optional so the feature stays inert
  // (capabilities() reports configured:false, routes 503) until wired —
  // matching the fail-closed posture of MICROSOFT_* and RECALL_*.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z
    .string()
    .url()
    .default('https://app.capiro.ai/api/engagement/integrations/google/callback'),
  GOOGLE_OAUTH_SUCCESS_REDIRECT: z.string().default('/settings/integrations'),

  // Public landing page demo requests are stored in Postgres and emailed via
  // Amazon SES. The source address must be a verified SES identity.
  DEMO_REQUEST_EMAIL_FROM: z.string().email().default('sales@capiro.ai'),
  DEMO_REQUEST_EMAIL_TO: z.string().email().default('sales@capiro.ai'),

  // GovInfo (api.data.gov) — congressional bills, committee reports, public laws.
  // Key is an api.data.gov key sourced from Secrets Manager (injected as env by CDK).
  // Endpoints fail closed (the service throws) when the key is unset.
  GOVINFO_API_KEY: z.string().optional(),
  // S3 bucket for cached GovInfo PDFs (committee reports, public laws).
  GOVINFO_CACHE_BUCKET: z.string().optional(),

  // Billing enforcement (onboarding v1). ALL Stripe access moved to
  // apps/onboard-api (the single Stripe writer — checkout/portal/webhooks/
  // overage; see docs/plans/onboarding-v1-plan.md). apps/api keeps only the
  // read-side billing views (summary/state) and the 402 client-slot gate,
  // switched by this explicit flag now that the old implicit
  // Boolean(STRIPE_SECRET_KEY) signal no longer exists in this service.
  // Flip to true at billing activation (after comp-existing-tenants has run).
  BILLING_ENFORCED: z
    .string()
    .default('false')
    .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())),

  // ── Client-profile Tracker tab: bill-change alert delivery ────────────────
  // Master kill-switch for the alert pipeline (change detection + fan-out).
  // Set false/0/no/off to pause all Tracker alert delivery without a deploy.
  TRACKER_ALERTS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  // Catch-up detection: scan congress_bill_action rows newer than each tracked
  // bill's snapshot (vs. only the latest-action rollup), so a skipped run or a
  // burst of actions between runs never drops an intermediate material move.
  // Default on; set false/0/no/off to fall back to legacy latest-action-only.
  TRACKER_SCAN_ACTION_HISTORY: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  // Client-context enrichment: attach a deterministic "why this matters to
  // {client}" line + matched watchlist tags to each alert. Purely additive
  // display; set false/0/no/off to send bare alerts if it ever misbehaves.
  TRACKER_ALERT_ENRICH: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  // LLM "what happened" summary on each alert. Runs on the TENANT's own
  // Anthropic key when they have an active BYO credential (decrypted via the
  // shared AES-256-GCM resolver — no new crypto), else the global
  // ANTHROPIC_API_KEY; spend is metered to ai_usage_events. Fail-safe: no key /
  // error / timeout → the alert still sends, just without the summary line.
  // Default on; set false/0/no/off to disable (e.g. to cap LLM cost) w/o deploy.
  TRACKER_ALERT_SUMMARY: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())),
  // Single-sender guard for the intel-api tracker cutover (Capiro Intelligence
  // unification, plan §8/§Phase 8). When ON, the legacy detector SKIPS delivery
  // (email/SMS fan-out) for any tenant that intel-api has taken ownership of —
  // an ENABLED `intel_feature_flag` row for feature='tracker_owner_intel'. This
  // guarantees exactly one sender per tenant at cutover. DEFAULT OFF: while off,
  // the guard code never runs and legacy behavior is 100% unchanged. It skips
  // ONLY delivery, never the in-app `intelligence_change` feed (kept until the
  // Phase-7 UI repoint). NOTE: intentionally does NOT honor the internal-tenant
  // always-on hardcode — intel does not deliver for the internal tenant during
  // shadow, so legacy must keep sending there; only an explicit per-tenant flag
  // row transfers delivery ownership.
  TRACKER_SINGLE_SENDER_GUARD: z
    .string()
    .default('false')
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),
  // From-address for Tracker alert emails (must be a verified SES identity).
  TRACKER_ALERT_EMAIL_FROM: z.string().email().default('alerts@capiro.ai'),
  // From-address for Workspace collaborator-invite emails (E-19). capiro.ai is a
  // verified SES domain identity, so any @capiro.ai sender works without new infra.
  WORKSPACE_INVITE_EMAIL_FROM: z.string().email().default('notifications@capiro.ai'),
  // Base URL used to build deep links in alert emails/SMS back to the client
  // profile Tracker tab.
  TRACKER_APP_BASE_URL: z.string().url().default('https://app.capiro.ai'),
  // SMS provider. 'none' (default) keeps SMS DORMANT: the OTP-verify + alert
  // fan-out code paths run end-to-end but no message is sent (logged + recorded
  // as 'suppressed'). 'sns' uses AWS End User Messaging (SNS publish) once an
  // origination number is provisioned AND @aws-sdk/client-sns is installed.
  TRACKER_SMS_PROVIDER: z.enum(['none', 'sns']).default('none'),
  // E.164 origination number / 10DLC / toll-free or SNS sender id used as the
  // SMS "from". Required before SMS can actually deliver (provisioning has
  // carrier lead time — see docs).
  TRACKER_SMS_ORIGINATION_NUMBER: z.string().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

/**
 * Parse + enforce the cross-field rules the plain schema cannot express.
 *
 * CLERK_JWT_ISSUER stays `.optional()` above on purpose: making it a hard
 * schema requirement would break every unit test that builds a config object,
 * and the schema is imported in contexts that never boot the app. The boot-time
 * requirement lives here instead.
 *
 * Deliberately gated on `NODE_ENV !== 'test'` and NOT on
 * `NODE_ENV === 'production'`: apps/api runs with NODE_ENV=development in the
 * LIVE capiro-dev deployment (which IS production), so a production-only gate
 * would be a silent no-op exactly where the control matters.
 *
 * Safe to ship for apps/api specifically — capiro-dev-api already sets
 * CLERK_JWT_ISSUER. Do NOT copy this guard into apps/intel-api, whose live task
 * definition does not set it; that service would crashloop.
 */
export function validateConfig(raw: Record<string, unknown>): AppConfig {
  const parsed = configSchema.parse(raw);
  if (parsed.NODE_ENV !== 'test' && !parsed.CLERK_JWT_ISSUER) {
    throw new Error(
      'CLERK_JWT_ISSUER is required outside tests — set it in the ECS task definition ' +
        '(e.g. https://clerk.app.capiro.ai). Refusing to start without issuer pinning.',
    );
  }
  return parsed;
}
