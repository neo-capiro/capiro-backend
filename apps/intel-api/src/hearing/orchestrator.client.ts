import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FinalSegment, ExtractionResult } from './hearing.types.js';

/**
 * Calls the MeriV2 orchestrator tool registry to turn a final transcript
 * segment into structured intelligence (entity mentions, relevance score,
 * key quote, action item, speaker resolution, summary card).
 *
 * Deepgram does STT; THIS calls the registry for ALL reasoning — the
 * orchestrator-first contract (SC5.7). The same registry tools back the chat
 * surface, so "pull every quote on X" post-hearing uses the same path.
 *
 * GRACEFUL DEGRADE: if the orchestrator is unreachable, transcription and
 * persistence MUST NOT block. We log, return an empty extraction, and the raw
 * (un-enriched) segment is still committed. Enrichment can be backfilled later.
 */
@Injectable()
export class OrchestratorClient {
  private readonly logger = new Logger(OrchestratorClient.name);
  private readonly baseUrl?: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('MERIV2_ORCHESTRATOR_URL');
    this.timeoutMs = Number.parseInt(config.get<string>('MERIV2_TIMEOUT_MS') ?? '8000', 10);
  }

  get configured(): boolean {
    return Boolean(this.baseUrl);
  }

  /**
   * Run the extraction pass for one final segment within a tenant/session scope.
   * Returns an empty result on any failure (never throws into the stream path).
   */
  async extract(params: {
    tenantId: string;
    sessionId: string;
    authToken: string;
    segment: FinalSegment;
    sessionContext: {
      clientId?: string | null;
      issueIds: string[];
      billIds: string[];
      programElementIds: string[];
      committeeId?: string | null;
    };
  }): Promise<ExtractionResult> {
    const empty: ExtractionResult = { entityMentions: [], issueTags: [] };
    if (!this.baseUrl) return empty;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Generic registry contract: hit `/tools/:name/invoke`, wrap the tool input
      // under `input` (the controller reads `body.input`), and read the tool's
      // return value back under `result` (the controller returns `{ tool, result }`).
      const res = await fetch(`${this.baseUrl}/meri-api/tools/tag_live_policy_mentions/invoke`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${params.authToken}`,
          'x-tenant-id': params.tenantId,
        },
        body: JSON.stringify({
          input: {
            sessionId: params.sessionId,
            segment: params.segment,
            context: params.sessionContext,
          },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`orchestrator extract HTTP ${res.status}; degrading to raw segment`);
        return empty;
      }
      const envelope = (await res.json()) as { result?: Partial<ExtractionResult> } | null;
      const data: Partial<ExtractionResult> = envelope?.result ?? {};
      return {
        entityMentions: data.entityMentions ?? [],
        keyQuote: data.keyQuote,
        actionItem: data.actionItem,
        clientRelevanceScore: data.clientRelevanceScore,
        issueTags: data.issueTags ?? [],
        resolvedSpeakerId: data.resolvedSpeakerId,
        resolvedSpeakerName: data.resolvedSpeakerName,
        summaryCard: data.summaryCard,
      };
    } catch (err) {
      this.logger.warn(`orchestrator extract failed (${(err as Error).message}); degrading to raw segment`);
      return empty;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Narrative synthesis for the post-hearing brief (exec summary, tone, risks,
   * opportunities, next steps, draft client email). Returns null on any failure
   * so the caller falls back to deterministic assembly.
   */
  async summarizeHearing(params: {
    tenantId: string;
    sessionId: string;
    authToken: string;
    title: string;
    quotes: Array<{ text: string; speakerName?: string; timestampMs: number }>;
    mentions: Array<{ type: string; label: string; ref: string | null }>;
    actionItems: string[];
  }): Promise<{
    executiveSummary: string;
    tone: string;
    risks: string[];
    opportunities: string[];
    recommendedNextSteps: string[];
    draftClientEmail: { subject: string; body: string };
  } | null> {
    if (!this.baseUrl) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs * 3);
    try {
      const res = await fetch(`${this.baseUrl}/meri-api/tools/generate_post_hearing_summary/invoke`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${params.authToken}`,
          'x-tenant-id': params.tenantId,
        },
        // Only the tool's schema fields belong in `input`; tenantId/authToken are
        // transport concerns (x-tenant-id header + bearer), not tool input.
        body: JSON.stringify({
          input: {
            sessionId: params.sessionId,
            title: params.title,
            quotes: params.quotes,
            mentions: params.mentions,
            actionItems: params.actionItems,
          },
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const envelope = (await res.json()) as {
        result?: {
          executiveSummary: string;
          tone: string;
          risks: string[];
          opportunities: string[];
          recommendedNextSteps: string[];
          draftClientEmail: { subject: string; body: string };
        };
      } | null;
      return envelope?.result ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
