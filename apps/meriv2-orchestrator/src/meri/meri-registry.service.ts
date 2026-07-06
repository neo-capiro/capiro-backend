import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InMemoryToolRegistry,
  PolicyApprovalGate,
  PROPOSED_CAPIRO_RULES,
  registerDelegatedTools,
  ruleBasedCompliancePolicy,
  RepoBackedApprovalStore,
  createGetClientContextTool,
  createTagLivePolicyMentionsTool,
  createGeneratePostHearingSummaryTool,
  type ToolRegistry,
} from '@capiro/meriv2-core';
import { ApiClientContextRepo } from './api-client-context.repo.js';
import { ApiToolExecutorRepo } from './api-tool-executor.repo.js';
import { ApiApprovalRepo } from './api-approval.repo.js';
import { RequestScopedLlmClient } from './request-scoped-llm.client.js';
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
    approvalRepo: ApiApprovalRepo,
    config: ConfigService,
  ) {
    // Write tools fail closed: the registry requires an ApprovalGate for any
    // `readOnly:false` tool. The gate runs the B2 rules engine on the TIERED
    // production ruleset (PROPOSED_CAPIRO_RULES — external sends / CRM
    // mutations / standing automation => WARN; internal artifacts + task
    // bookkeeping => PASS, matching what the legacy surface already executes
    // freely; anything unnamed falls back to WARN) and, on WARN, consults the
    // ApprovalStore (B3/B4): the RepoBackedApprovalStore fingerprints the
    // proposed action and asks apps/api (ApiApprovalRepo) whether a human
    // approved THIS exact action. Unapproved → ApprovalPendingError (write
    // held); approved → proceeds. The repo is fail-closed (any error → not
    // approved), so a WARN write never slips through unapproved.
    const registry = new InMemoryToolRegistry({
      approvalGate: new PolicyApprovalGate(
        ruleBasedCompliancePolicy([...PROPOSED_CAPIRO_RULES]),
        new RepoBackedApprovalStore(approvalRepo),
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

    // Workstream C (write-tool porting): the 14 side-effecting Meri tools,
    // delegated the same way, but `readOnly:false` — every invoke now runs the
    // PolicyApprovalGate above BEFORE the delegated call. With no ApprovalStore
    // wired yet (B3/B4) and the WARN fallback, invoking one of these ALWAYS
    // throws `ApprovalPendingError` and never reaches apps/api — registering
    // them here proves the gate mechanism end-to-end without executing a real
    // side effect or inventing an approval UX. No live surface calls these
    // tools yet (in-editor stays read-only; full chat is not built on MeriV2).
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
    // apps/api's COMPLETE 53-tool surface available (see
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
    const model = config.get<string>('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-5';
    const llm = new RequestScopedLlmClient(apiKey, model);
    registry.register(createTagLivePolicyMentionsTool(llm));
    registry.register(createGeneratePostHearingSummaryTool(llm));
    this.logger.log(
      `Hearing reasoning tools registered (defaultModel=${model}, globalKeyFallback=${Boolean(apiKey)})`,
    );

    this.registry = registry;
    this.llm = llm;
  }
}
