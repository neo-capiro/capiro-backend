import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FinalSegment, ExtractionResult } from './hearing.types.js';
import { HearingAiCredentialResolver } from './hearing-ai-credential-resolver.client.js';

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
  private readonly internalSecret?: string;

  constructor(
    config: ConfigService,
    private readonly aiCredentials: HearingAiCredentialResolver,
  ) {
    this.baseUrl = config.get<string>('MERIV2_ORCHESTRATOR_URL');
    this.timeoutMs = Number.parseInt(config.get<string>('MERIV2_TIMEOUT_MS') ?? '8000', 10);
    this.internalSecret = config.get<string>('INTERNAL_SERVICE_SECRET');
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
    /** Clerk subject of the user whose session opened the socket. Delegated to
     *  MeriV2, which resolves the Capiro user from it and 401s without one. */
    clerkUserId: string;
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

    // BYOK3: resolve the tenant's key (cached) so this runs on THEIR credential,
    // not the orchestrator's global fallback. Absent/failed resolve → the
    // header is simply omitted and the orchestrator falls back exactly as it
    // does today (no behavior change for a tenant with no key configured).
    const aiProvider = await this.aiCredentials.resolve(params.tenantId);

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
          ...this.authHeaders(params.tenantId, params.clerkUserId),
          'x-tenant-id': params.tenantId,
          ...(aiProvider ? { 'x-capiro-ai-provider': JSON.stringify(aiProvider) } : {}),
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
      this.logger.warn(
        `orchestrator extract failed (${(err as Error).message}); degrading to raw segment`,
      );
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
    clerkUserId: string;
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
    const aiProvider = await this.aiCredentials.resolve(params.tenantId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs * 3);
    try {
      const res = await fetch(
        `${this.baseUrl}/meri-api/tools/generate_post_hearing_summary/invoke`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...this.authHeaders(params.tenantId, params.clerkUserId),
            'x-tenant-id': params.tenantId,
            ...(aiProvider ? { 'x-capiro-ai-provider': JSON.stringify(aiProvider) } : {}),
          },
          // Only the tool's schema fields belong in `input`; tenant and user
          // identity are transport concerns (headers), not tool input.
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
        },
      );
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

  /**
   * Service-to-service authentication for MeriV2.
   *
   * This used to replay the BROWSER's Clerk JWT, captured from the WebSocket
   * query string at connect time and retained for the life of the socket — up
   * to four hours. Clerk session tokens live about 60 seconds, so nearly every
   * call after the first minute was made with an expired credential. Because
   * this client degrades gracefully, that surfaced not as an error but as
   * silently missing AI extraction on long hearings.
   *
   * Now: the shared INTERNAL_SERVICE_SECRET plus an explicitly delegated tenant
   * and user. MeriV2 re-checks that the delegated user still holds an ACTIVE
   * membership, so this conveys identity, not authorization.
   */
  private authHeaders(tenantId: string, clerkUserId: string): Record<string, string> {
    if (!this.internalSecret) {
      // Fail loudly in logs but let the call proceed unauthenticated so the
      // graceful-degrade contract holds — MeriV2 will reject it.
      this.logger.warn('INTERNAL_SERVICE_SECRET is not configured; MeriV2 call will be rejected');
      return {};
    }
    return {
      'x-internal-service-secret': this.internalSecret,
      'x-capiro-delegated-tenant': tenantId,
      'x-capiro-delegated-user': clerkUserId,
    };
  }
}
