import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InMemoryToolRegistry,
  PolicyApprovalGate,
  staticCompliancePolicy,
  createGetClientContextTool,
  createTagLivePolicyMentionsTool,
  createGeneratePostHearingSummaryTool,
  type ToolRegistry,
} from '@capiro/meriv2-core';
import { ApiClientContextRepo } from './api-client-context.repo.js';
import { RequestScopedLlmClient } from './request-scoped-llm.client.js';

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
  private readonly logger = new Logger(MeriRegistryService.name);

  constructor(clientContextRepo: ApiClientContextRepo, config: ConfigService) {
    // Write tools fail closed: the registry requires an ApprovalGate for any
    // `readOnly:false` tool. Wire the compliance gate now (fallback WARN =>
    // requires human approval) so that when write tools are ported (Workstream
    // C) they are gated from the first registration. No write tools are
    // registered yet, so this is a no-op for the current read-only surface.
    const registry = new InMemoryToolRegistry({
      approvalGate: new PolicyApprovalGate(staticCompliancePolicy({ fallback: 'WARN' })),
    });
    registry.register(createGetClientContextTool(clientContextRepo));

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
  }
}
