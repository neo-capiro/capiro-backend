import { Injectable, Logger } from '@nestjs/common';
import type { MeriContextPacketSummary } from '@capiro/meriv2-core';
import type { ResolvedAiForChatHeader } from './meriv2-chat.client.js';

export const MERIV3_REASONING_MODES = ['fast', 'standard', 'deep', 'max'] as const;
export type MeriV3ReasoningMode = (typeof MERIV3_REASONING_MODES)[number];

export interface MeriV3RetrievalStreamSummary {
  plan: {
    version: 1;
    queryClass: string;
    subjectScope: string;
    targetHint: string | null;
    recipeTool: string | null;
    requireCompleteCoverage: boolean;
    requiredDomains: string[];
    timeWindow: { expression: string; withinDays: number } | null;
  };
  coverage: {
    version: 1;
    complete: boolean;
    requestedDomains: string[];
    searchedDomains: string[];
    missingDomains: string[];
    partialDomains: string[];
    requestedEntityCount: number | null;
    searchedEntityCount: number | null;
    recordsEvaluated: number;
    recordsReturned: number;
    paginationComplete: boolean;
    truncated: boolean;
    sourceHealth: Array<{
      source: string;
      status: 'complete' | 'partial' | 'error' | 'unavailable';
      lastSyncAt?: string;
      detail?: string;
    }>;
    unavailableSources: Array<{ source: string; reason: string }>;
    toolsInvoked: string[];
    stopReason: 'complete' | 'partial' | 'no-retrieval-required';
  };
  /** Optional during rolling deploys where API and orchestrator revisions overlap. */
  trace?: {
    version: 1;
    startedAt: string;
    durationMs: number;
    modelTools: string[];
    recipeFirst: boolean | null;
    outOfPlanModelTools: string[];
    observedToolCalls: number;
    uniqueTools: string[];
    /** Sum of observed tool/recipe wall times; nested calls may overlap. */
    cumulativeToolMs: number;
    partialToolCount: number;
    errorToolCount: number;
    paginationDebt: string[];
    tools: Array<{
      tool: string;
      durationMs: number;
      returned: number;
      status: 'complete' | 'partial' | 'error' | 'unavailable';
      hasMore: boolean;
    }>;
  };
}

export type MeriV3ChatStreamEvent =
  | { type: 'start'; runtime?: 'meriv3'; reasoningMode?: MeriV3ReasoningMode }
  | {
      type: 'runtime';
      runtime: 'meriv3';
      model: string;
      reasoningMode: MeriV3ReasoningMode;
      reasoningEffort: string;
    }
  | { type: 'tool_call'; tool: string; label: string }
  | {
      type: 'tool_done';
      tool: string;
      label: string;
      status: 'done' | 'error' | 'pending_approval' | 'blocked';
      detail?: string;
    }
  | {
      type: 'pending_approval';
      tool: string;
      label: string;
      proposalId: string;
      status: string;
      reason: string;
      expiresAt: string;
      riskTier: string | null;
      policyCode: string | null;
      ruleId: string | null;
      policy: {
        source: string;
        mode: string;
        packKey: string;
        packVersion: string;
        binding: string;
        decisionHash: string;
        contextHash: string;
        decision: string;
        jurisdiction: string;
        channel: string;
        recipientType: string | null;
      };
      preview: {
        label: string;
        riskTier: string | null;
        leavesFirm: boolean;
        reversible: boolean;
        client?: { id: string; name?: string };
        fields: Record<string, string | number | boolean>;
        counts: Record<string, number>;
        reason: string;
      };
    }
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
  | { type: 'page_write'; target: string; subject?: string; body: string }
  | {
      type: 'grounding_caveat';
      topSeverity: string | null;
      findings: Array<{ check: string; severity: string; detail: string }>;
    }
  | {
      type: 'done';
      reply: string;
      runtime: 'meriv3';
      model: string;
      reasoningMode: MeriV3ReasoningMode;
      reasoningEffort: string;
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
      pendingApprovals?: Array<{
        tool: string;
        proposalId: string;
        reason: string;
        status: string;
      }>;
      contextPacket?: MeriContextPacketSummary;
      retrieval?: MeriV3RetrievalStreamSummary;
      aborted?: boolean;
    }
  | { type: 'error'; message: string };

@Injectable()
export class MeriV3ChatClient {
  private readonly logger = new Logger(MeriV3ChatClient.name);
  private readonly baseUrl = (process.env.MERIV2_ORCHESTRATOR_URL ?? '').replace(/\/+$/, '');

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  async streamChat(params: {
    bearerToken: string;
    input: {
      messages: Array<{ role: 'user' | 'assistant'; text: string }>;
      clientId?: string;
      conversationId?: string;
      memoryContext?: string[];
      skillAddendum?: string;
      conversationSummary?: string;
      clientKbSnapshot?: string;
      pageWrite?: boolean;
      currentTurnImages?: Array<{ mediaType: string; dataBase64: string }>;
      reasoningMode: MeriV3ReasoningMode;
    };
    aiProvider?: ResolvedAiForChatHeader;
    impersonateTenantId?: string;
    signal?: AbortSignal;
    onEvent: (event: MeriV3ChatStreamEvent) => void;
  }): Promise<void> {
    if (!this.configured) throw new Error('MERIV2_ORCHESTRATOR_URL is not configured');
    if (!params.bearerToken) throw new Error('MeriV3 chat proxy requires the caller bearer token');
    if (params.aiProvider && params.aiProvider.provider !== 'openai') {
      throw new Error('MeriV3 requires an OpenAI credential');
    }
    const response = await fetch(`${this.baseUrl}/meri-api/v3/chat/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.bearerToken}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(params.aiProvider ? { 'x-capiro-ai-provider': JSON.stringify(params.aiProvider) } : {}),
        ...(params.impersonateTenantId
          ? { 'x-capiro-impersonate-tenant': params.impersonateTenantId }
          : {}),
      },
      body: JSON.stringify(params.input),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => response.statusText);
      throw new Error(`MeriV3 chat stream failed: ${response.status} ${detail.slice(0, 240)}`);
    }

    const reader = response.body.getReader();
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
        const payload = line.slice(6).trim();
        if (!payload) continue;
        try {
          params.onEvent(JSON.parse(payload) as MeriV3ChatStreamEvent);
        } catch {
          this.logger.debug('MeriV3 chat stream: skipped unparseable frame');
        }
      }
    }
  }
}
