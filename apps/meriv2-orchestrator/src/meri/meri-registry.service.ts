import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AnthropicLlmClient,
  InMemoryToolRegistry,
  createGetClientContextTool,
  createTagLivePolicyMentionsTool,
  createGeneratePostHearingSummaryTool,
  type ToolRegistry,
} from '@capiro/meriv2-core';
import { ApiClientContextRepo } from './api-client-context.repo.js';

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
    const registry = new InMemoryToolRegistry();
    registry.register(createGetClientContextTool(clientContextRepo));

    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    const model = config.get<string>('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-5';
    if (apiKey) {
      const llm = new AnthropicLlmClient({ apiKey, model });
      registry.register(createTagLivePolicyMentionsTool(llm));
      registry.register(createGeneratePostHearingSummaryTool(llm));
      this.logger.log(`Hearing reasoning tools registered (model=${model})`);
    } else {
      this.logger.warn('ANTHROPIC_API_KEY unset — hearing reasoning tools NOT registered');
    }

    this.registry = registry;
  }
}
