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
    /**
     * The government-affairs frame the analyst set up the session with. Meri gets
     * only what the session actually carries — a null committee or an empty
     * agency list is passed through as-is rather than guessed at.
     */
    sessionContext: {
      clientId?: string | null;
      issueIds: string[];
      billIds: string[];
      programElementIds: string[];
      agencyIds: string[];
      committeeId?: string | null;
      /** The scheduled committee_hearing row this session was created from. */
      hearingId?: string | null;
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
    // Every `return null` below is logged. This method degrades to a
    // deterministic recap on failure, and the caller ALSO swallows null quietly,
    // so an unlogged null meant a recap could silently drop from Meri synthesis
    // to bare assembly with no trace anywhere. That is exactly what happened on
    // 2026-07-29: a 62-minute Senate hearing produced a recap whose summary was a
    // bare flagged-moment count, and nothing in the API logs said why.
    if (!this.baseUrl) {
      this.logger.warn(
        `summarizeHearing skipped session=${params.sessionId}: no orchestrator base URL configured`,
      );
      return null;
    }
    const aiProvider = await this.aiCredentials.resolve(params.tenantId);
    const controller = new AbortController();
    const budgetMs = this.timeoutMs * 3;
    const timer = setTimeout(() => controller.abort(), budgetMs);
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
      if (!res.ok) {
        this.logger.warn(
          `summarizeHearing HTTP ${res.status} session=${params.sessionId}; ` +
            `falling back to deterministic recap`,
        );
        return null;
      }
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
      if (!envelope?.result) {
        this.logger.warn(
          `summarizeHearing returned no result envelope session=${params.sessionId}; ` +
            `falling back to deterministic recap`,
        );
        return null;
      }
      return envelope.result;
    } catch (err) {
      // Distinguish OUR timeout from any other transport failure. Note an abort
      // can also originate INSIDE the orchestrator (its own LLM failover aborts
      // and surfaces as a 5xx/closed socket), so a timeout here does not by
      // itself mean this budget is too small — check the orchestrator's own logs
      // for RequestScopedLlmClient before raising it.
      const aborted = controller.signal.aborted;
      this.logger.warn(
        `summarizeHearing ${aborted ? `timed out after ${budgetMs}ms` : 'failed'} ` +
          `session=${params.sessionId}: ${(err as Error).message}; ` +
          `falling back to deterministic recap`,
      );
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
