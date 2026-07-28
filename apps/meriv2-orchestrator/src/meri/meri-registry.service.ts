import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InMemoryToolRegistry,
  PolicyApprovalGate,
  PROPOSED_CAPIRO_RULES,
  registerDelegatedTools,
  ruleBasedCompliancePolicy,
  denyAllApprovals,
  createGetClientContextTool,
  createTagLivePolicyMentionsTool,
  createGeneratePostHearingSummaryTool,
  type ToolRegistry,
} from '@capiro/meriv2-core';
import { ApiClientContextRepo } from './api-client-context.repo.js';
import { ApiToolExecutorRepo } from './api-tool-executor.repo.js';
import { RequestScopedLlmClient } from './request-scoped-llm.client.js';
import { parseCacheEnabledFlag } from './prompt-cache.helpers.js';
import { IN_EDITOR_DELEGATED_TOOLS } from './delegated-tools.catalog.js';
import { WRITE_DELEGATED_TOOLS } from './write-tools.catalog.js';
import { FULL_CHAT_READ_TOOLS } from './full-chat-read-tools.catalog.js';

/**
 * Owns the single MeriV2 tool registry the orchestrator hosts. Registers the
 * client-context tool plus the LLM-backed hearing-reasoning tools
 * (`tag_live_policy_mentions`, `generate_post_hearing_summary`) that intel-api
 * calls. Nothing executes a tool except through `registry.invoke`, which
 * enforces input validation + scoping + the write approval gate.
 *
 * The LLM tools register only when an Anthropic key is configured
 * (ANTHROPIC_API_KEY); without it the orchestrator still serves the other tools
 * and intel-api degrades to its deterministic fallback.
 */
@Injectable()
export class MeriRegistryService {
  readonly registry: ToolRegistry;
  /**
   * The ONE request-scoped LLM client (BYOK2 resolver). Exposed so other
   * orchestrator surfaces (the in-editor assistant loop) reuse the same
   * tenant-first client — keeping the single global-key-read site here.
   */
  readonly llm: RequestScopedLlmClient;
  private readonly logger = new Logger(MeriRegistryService.name);

  constructor(
    clientContextRepo: ApiClientContextRepo,
    toolExecutor: ApiToolExecutorRepo,
    config: ConfigService,
  ) {
    // Write tools fail closed: the registry requires an ApprovalGate for any
    // `readOnly:false` tool. The gate runs the B2 rules engine on the TIERED
    // production ruleset (PROPOSED_CAPIRO_RULES — external sends / CRM record
    // mutations, incl. create_task/update_task / standing automation => WARN;
    // internal reversible artifacts + memory verbs => PASS; anything unnamed
    // falls back to WARN).
    //
    // Phase 0: a WARN decision ALWAYS throws ApprovalPendingError — there is no
    // "is this fingerprint already approved" check to consult anymore.
    // Approval now happens entirely out-of-band (the browser calls apps/api's
    // POST /api/clio/action-proposals/:id/approve directly; apps/api executes
    // the tool itself and never calls back into the orchestrator for that
    // action), so `denyAllApprovals` is not a placeholder — it is permanently
    // correct: this registry instance is never the thing that decides an
    // action is approved.
    const registry = new InMemoryToolRegistry({
      approvalGate: new PolicyApprovalGate(
        ruleBasedCompliancePolicy([...PROPOSED_CAPIRO_RULES]),
        denyAllApprovals,
      ),
    });
    registry.register(createGetClientContextTool(clientContextRepo));

    // Workstream C (strangler-fig): register the read-only Meri tool surface as
    // DELEGATED tools — each forwards execution to apps/api's authenticated
    // /api/clio/tools/:name (one impl, tenant-scoped, BYOK), reusing the same
    // bridge get_client_context uses. get_client_context is already registered
    // natively above, so it is skipped here to avoid a duplicate registration.
    const delegated = IN_EDITOR_DELEGATED_TOOLS.filter((t) => t.name !== 'get_client_context');
    const readNames = registerDelegatedTools(
      (def) => registry.register(def),
      delegated,
      toolExecutor,
    );
    this.logger.log(`Registered ${readNames.length} delegated read-only tools`);

    // Workstream C (write-tool porting): the side-effecting Meri tools,
    // delegated the same way, but `readOnly:false` — every invoke runs the
    // PolicyApprovalGate above BEFORE the delegated call. A WARN tool
    // (send/reply email, CRM record + task writes, standing automation) always
    // throws ApprovalPendingError and never reaches apps/api — the caller
    // (chat-assistant.service.ts) catches it and creates a durable
    // MeriActionProposal via ApiActionProposalRepo instead. A human then
    // approves that proposal directly against apps/api
    // (POST /api/clio/action-proposals/:id/approve), which executes the tool
    // itself; this registry is never consulted again for that action. A PASS
    // tool (internal artifacts + memory verbs) executes immediately. This is
    // LIVE: the GA full-chat surface (chat-assistant.service.ts) invokes these
    // tools through this registry.
    const writeNames = registerDelegatedTools(
      (def) => registry.register(def),
      WRITE_DELEGATED_TOOLS,
      toolExecutor,
    );
    this.logger.log(
      `Registered ${writeNames.length} delegated write tools (gated: B2 rules + B3/B4 approval store)`,
    );

    // Workstream C4 substrate: the remaining read-only apps/api tools not in
    // the in-editor allowlist (run_analysis, search_public_web, query_tasks,
    // etc.) — closes the catalog gap toward a future full-chat surface. Same
    // dormant registration as the write tools above: no live surface calls
    // these yet (C4's streaming loop is not built), but the registry now has
    // apps/api's COMPLETE 64-tool surface available (see
    // full-chat-read-tools.catalog.spec.ts's combined-coverage assertion).
    const fullChatReadNames = registerDelegatedTools(
      (def) => registry.register(def),
      FULL_CHAT_READ_TOOLS,
      toolExecutor,
    );
    this.logger.log(
      `Registered ${fullChatReadNames.length} additional read-only tools (C4 substrate)`,
    );

    // BYOK2: LLM tools bind the request-scoped client, which prefers the
    // caller-passed tenant credential (x-capiro-ai-provider, option c) and only
    // falls back to the global env key inside the resolver. Tools register
    // UNCONDITIONALLY — a tenant-key-only deployment (no global key) must still
    // serve them; with neither key the call throws and intel-api's extraction
    // degrades gracefully.
    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    // X1 fix: the reasoning tools (post-hearing summaries, live policy-mention
    // extraction) intentionally default to a STRONGER tier than the outreach-draft
    // default — this is the single documented fallback. It was a stale
    // `claude-sonnet-4-5`; bumped to the current sonnet the rest of the app uses
    // (CLIO_MODEL) so an unset ANTHROPIC_MODEL no longer resolves a retired id.
    const model = config.get<string>('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-6';
    // LLM resilience: when a GLOBAL OpenAI key is wired, it is the BYOK-safe
    // failover for global-key traffic if Anthropic is credit-exhausted/overloaded
    // (the 2026-07-15 fleet-wide Meri outage). Inert until OPENAI_API_KEY is set
    // on the orchestrator — so this is dark on merge and activates on the key
    // wire. A tenant's own BYOK key is never failed over to this global account.
    const openaiKey = config.get<string>('OPENAI_API_KEY');
    const openaiModel = config.get<string>('OPENAI_MODEL') ?? 'gpt-4.1';
    const globalFallback = openaiKey
      ? { apiKey: openaiKey, model: openaiModel, provider: 'openai' as const }
      : undefined;
    // Prompt caching (P0-1 orchestrator parity): same env var + default as
    // apps/api's CLIO_PROMPT_CACHE_ENABLED (one mental model for "is Meri
    // prompt caching on" across both surfaces), read here — the ONE place
    // this client is constructed, shared by chat/in-editor/strategy/steward.
    const promptCacheEnabled = parseCacheEnabledFlag(
      config.get<string>('CLIO_PROMPT_CACHE_ENABLED'),
      true,
    );
    const llm = new RequestScopedLlmClient(
      apiKey,
      model,
      undefined,
      globalFallback,
      promptCacheEnabled,
    );
    registry.register(createTagLivePolicyMentionsTool(llm));
    registry.register(createGeneratePostHearingSummaryTool(llm));
    this.logger.log(
      `Hearing reasoning tools registered (defaultModel=${model}, globalKeyFallback=${Boolean(apiKey)}, ` +
        `providerFailover=${globalFallback ? `global→${globalFallback.provider}` : 'off (no OPENAI_API_KEY)'}, ` +
        `promptCacheEnabled=${promptCacheEnabled})`,
    );

    this.registry = registry;
    this.llm = llm;
  }
}
