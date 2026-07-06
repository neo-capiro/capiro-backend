import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MeriContext, ToolRegistry } from '@capiro/meriv2-core';
import { MeriRegistryService } from '../meri-registry.service.js';
import { RequestScopedLlmClient, type AnthropicToolSchema } from '../request-scoped-llm.client.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import {
  ASSISTANT_TOOLS,
  PROPOSE_EDITS_TOOL,
  buildSystemPrompt,
  sanitizeEdits,
  toolLabel,
  type AssistantResult,
  type AssistantStep,
  type InEditorInput,
} from './in-editor-prompt.js';

const MAX_ROUNDS = 5;
const MAX_TOKENS = 4096;
const TOOL_RESULT_CHARS = 12_000;

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * MeriV2-served in-editor assistant (A3). Reproduces apps/api's bounded,
 * READ-ONLY agentic loop, but tool execution goes through the orchestrator
 * registry (scoped + gated) and the model runs on the tenant's key (BYOK2, via
 * RequestScopedLlmClient). Tool JSON-schemas are fetched from apps/api at
 * request time so definitions stay single-sourced. The loop must run inside a
 * RequestCredentialsStore scope (the controller sets it) so both the delegated
 * tool calls (bearer) and the LLM (tenant credential) resolve.
 *
 * v1 returns { reply, edits, steps }; the fail-open grounding/structural
 * enrichment (confidence/structuralWarnings) is a follow-up — omitting it
 * matches the legacy path with the verifier disabled.
 */
@Injectable()
export class InEditorAssistantService {
  private readonly logger = new Logger(InEditorAssistantService.name);
  private readonly registry: ToolRegistry;
  private readonly llm: RequestScopedLlmClient;
  private readonly apiBaseUrl: string;
  private readonly callTimeoutMs: number;

  constructor(registryService: MeriRegistryService, config: ConfigService) {
    this.registry = registryService.registry;
    // Reuse the ONE request-scoped LLM client (BYOK2) the registry built — the
    // single global-key-read site lives in MeriRegistryService, so this surface
    // stays BYOK4-clean (never reads the global Anthropic env key itself). The
    // tenant key wins per-request; the default model is the orchestrator's (Sonnet).
    this.llm = registryService.llm;
    this.callTimeoutMs = Number.parseInt(config.get<string>('MERIV2_TIMEOUT_MS') ?? '120000', 10);
    this.apiBaseUrl = (
      config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  async run(ctx: MeriContext, dto: InEditorInput): Promise<AssistantResult> {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = (dto.messages ?? [])
      .filter(
        (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string',
      )
      .slice(-20)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text as string }));
    if (!messages.length || messages[messages.length - 1]?.role !== 'user') {
      return { reply: 'What would you like me to do with this document?', edits: [] };
    }

    const system = buildSystemPrompt(dto);
    const toolSchemas = [...(await this.fetchToolSchemas()), PROPOSE_EDITS_TOOL];
    const steps: AssistantStep[] = [];

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      let content: ContentBlock[];
      let stopReason: string | null;
      try {
        const resp = await this.llm.completeWithTools({
          system,
          messages,
          tools: toolSchemas as AnthropicToolSchema[],
          maxTokens: MAX_TOKENS,
          timeoutMs: this.callTimeoutMs,
        });
        content = resp.content as ContentBlock[];
        stopReason = resp.stopReason;
      } catch (e) {
        this.logger.warn(`in-editor model call failed: ${(e as Error).message}`);
        return {
          reply: 'Sorry — I hit an error reaching the model. Please try again in a moment.',
          edits: [],
        };
      }

      const textOut = content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
        .trim();
      const toolUses = content.filter(
        (b): b is ContentBlock & { id: string; name: string; input?: Record<string, unknown> } =>
          b.type === 'tool_use' && typeof b.name === 'string' && typeof b.id === 'string',
      );

      // Terminal: the model proposed its answer (+ optional edits).
      const propose = toolUses.find((t) => t.name === 'propose_document_edits');
      if (propose) {
        const input = propose.input ?? {};
        const reply = typeof input.reply === 'string' && input.reply.trim() ? input.reply : textOut;
        const edits = sanitizeEdits(input.edits);
        return { reply: reply || 'Done.', edits, steps };
      }

      // No tools requested → plain conversational answer.
      if (!toolUses.length || stopReason !== 'tool_use') {
        return { reply: textOut || 'Done.', edits: [], steps };
      }

      // Execute the requested read-only data tools through the registry and feed
      // results back. The registry enforces scoping (and would gate any write —
      // none are in the allowlist).
      messages.push({ role: 'assistant', content });
      const results = await Promise.all(
        toolUses.map(async (tu) => {
          let result: unknown;
          if (!ASSISTANT_TOOLS.has(tu.name)) {
            result = { error: `Tool "${tu.name}" is not available in the document assistant.` };
            steps.push({
              tool: tu.name,
              label: toolLabel(tu.name),
              status: 'error',
              detail: 'unavailable',
            });
          } else {
            try {
              result = await this.registry.invoke(tu.name, tu.input ?? {}, ctx);
              steps.push({ tool: tu.name, label: toolLabel(tu.name), status: 'done' });
            } catch (e) {
              result = { error: (e as Error).message };
              steps.push({
                tool: tu.name,
                label: toolLabel(tu.name),
                status: 'error',
                detail: (e as Error).message.slice(0, 120),
              });
            }
          }
          return {
            type: 'tool_result' as const,
            tool_use_id: tu.id,
            content: JSON.stringify(result ?? {}).slice(0, TOOL_RESULT_CHARS),
          };
        }),
      );
      messages.push({ role: 'user', content: results });
    }

    return {
      reply:
        'I gathered some context but ran out of steps before composing a full answer — ask again and I’ll continue.',
      edits: [],
      steps,
    };
  }

  /**
   * Fetch the Anthropic tool schemas from apps/api (single source) with the
   * caller's bearer, filtered to the read-only allowlist. On failure, degrade to
   * no data tools (the model can still reply, just without lookups).
   */
  private async fetchToolSchemas(): Promise<AnthropicToolSchema[]> {
    const bearer = RequestCredentialsStore.get()?.bearerToken;
    if (!bearer) {
      this.logger.warn('in-editor: no bearer to fetch tool schemas; proceeding without data tools');
      return [];
    }
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/clio/tool-schemas`, {
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { schemas?: AnthropicToolSchema[] };
      return (body.schemas ?? []).filter((s) => ASSISTANT_TOOLS.has(s.name));
    } catch (e) {
      this.logger.warn(`in-editor: tool-schema fetch failed (${(e as Error).message})`);
      return [];
    }
  }
}
