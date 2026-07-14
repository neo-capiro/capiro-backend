import { Injectable, Logger } from '@nestjs/common';

/** The resolved tenant AI credential forwarded to the orchestrator (BYOK option c). */
export interface ResolvedAiForChatHeader {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  usedTenantKey: boolean;
  modelOverridden: boolean;
}

/**
 * Events the orchestrator's POST /meri-api/chat/stream emits (orchestrator
 * shapes, NOT the legacy ChatDrawer union — MeriService translates). Kept
 * structurally in sync with the orchestrator's ChatStreamEvent + the stream
 * controller's start/done/error framing.
 */
export type MeriV2ChatStreamEvent =
  | { type: 'start' }
  | { type: 'tool_call'; tool: string; label: string }
  | {
      type: 'tool_done';
      tool: string;
      label: string;
      status: 'done' | 'error' | 'pending_approval' | 'blocked';
      detail?: string;
    }
  | { type: 'pending_approval'; tool: string; label: string; fingerprint: string; reason: string }
  | {
      type: 'artifact';
      artifact: {
        id: string;
        title: string;
        kind: string;
        bodyText?: string;
        downloadUrl?: string;
        filename?: string;
        mimeType?: string;
      };
    }
  | { type: 'text'; text: string }
  | {
      type: 'done';
      reply: string;
      intent?: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      };
      citations?: Array<{
        n: number;
        type: string;
        id: string;
        title: string;
        url: string | null;
        snippet: string | null;
        tool: string;
      }>;
      steps: Array<{
        tool: string;
        label: string;
        detail?: string;
        status: 'done' | 'error' | 'pending_approval' | 'blocked';
      }>;
      pendingApprovals?: Array<{ tool: string; fingerprint: string; reason: string }>;
      aborted?: boolean;
    }
  | { type: 'error'; message: string };

/**
 * Streaming HTTP client to the MeriV2 orchestrator's full-chat surface
 * (Workstream C4). Used ONLY by the flag-gated proxy branch in
 * MeriService.streamMessage: when `meriv2.fullChat` is ON (and MERIV2_ENABLED)
 * the legacy chat stream is served by the orchestrator's agentic loop instead
 * of the in-process path. Both flags default OFF → never called.
 *
 * Same conventions as the in-editor MeriV2OrchestratorClient: base URL from
 * MERIV2_ORCHESTRATOR_URL, the caller's Clerk bearer is REQUIRED (delegated
 * tools + the approval check re-authenticate with it), and the resolved tenant
 * AI credential rides the x-capiro-ai-provider header (raw key — TLS-only,
 * never logged).
 */
@Injectable()
export class MeriV2ChatClient {
  private readonly logger = new Logger(MeriV2ChatClient.name);
  private readonly baseUrl = (process.env.MERIV2_ORCHESTRATOR_URL ?? '').replace(/\/+$/, '');

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  /**
   * Run one chat turn on the orchestrator, invoking `onEvent` per parsed frame
   * (including the terminal `done`/`error`). Resolves when the stream ends.
   * Throws on connection failure or non-2xx — the caller decides how to surface
   * it (there is deliberately NO silent fallback to the legacy loop once the
   * flag routed a turn here; rollback is the flag).
   */
  async streamChat(params: {
    bearerToken: string;
    input: {
      messages: Array<{ role: 'user' | 'assistant'; text: string }>;
      clientId?: string;
      conversationId?: string;
      /** Pre-warmed memory recall lines (loadRelevantMemories) — legacy parity. */
      memoryContext?: string[];
      /** Matched firm-skill system addendum (1B.3), resolved by the proxy. */
      skillAddendum?: string;
      /** Rolling-compaction summary of earlier turns (1A.6), from the proxy. */
      conversationSummary?: string;
    };
    aiProvider?: ResolvedAiForChatHeader;
    signal?: AbortSignal;
    onEvent: (event: MeriV2ChatStreamEvent) => void;
  }): Promise<void> {
    if (!this.configured) {
      throw new Error('MERIV2_ORCHESTRATOR_URL is not configured');
    }
    if (!params.bearerToken) {
      throw new Error('MeriV2 chat proxy requires the caller bearer token');
    }
    const res = await fetch(`${this.baseUrl}/meri-api/chat/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.bearerToken}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(params.aiProvider ? { 'x-capiro-ai-provider': JSON.stringify(params.aiProvider) } : {}),
      },
      body: JSON.stringify(params.input),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!res.ok || !res.body) {
      throw new Error(`MeriV2 chat stream failed: ${res.status} ${res.statusText}`);
    }

    // Same framing the legacy surface emits and ChatDrawer parses: newline-split
    // lines, `data: <json>` payloads, unparseable lines skipped.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        try {
          params.onEvent(JSON.parse(jsonStr) as MeriV2ChatStreamEvent);
        } catch {
          this.logger.debug('MeriV2 chat stream: skipped unparseable frame');
        }
      }
    }
  }
}
