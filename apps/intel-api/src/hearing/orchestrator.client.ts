import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FinalSegment, ExtractionResult } from './hearing.types.js';
import { HearingAiCredentialResolver } from './hearing-ai-credential-resolver.client.js';
import type { PostHearingClientInput } from './client-brief-context.client.js';
import {
  editorialOutput,
  type EditorialToolInput,
  type EditorialToolOutput,
  publishedRecordOutput,
  type PublishedRecordToolInput,
  type PublishedRecordToolResult,
} from '@capiro/meriv2-core';

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
  async editorialBrief(
    tenantId: string,
    clerkUserId: string,
    input: EditorialToolInput,
    clientId?: string,
  ): Promise<EditorialToolOutput> {
    if (!this.baseUrl) throw Error('EDITORIAL_PROVIDER_UNAVAILABLE');
    const aiProvider = await this.aiCredentials.resolve(tenantId);
    const response = await fetch(`${this.baseUrl}/meri-api/tools/generate_editorial_brief/invoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.authHeaders(tenantId, clerkUserId),
        'x-tenant-id': tenantId,
        ...(aiProvider ? { 'x-capiro-ai-provider': JSON.stringify(aiProvider) } : {}),
      },
      body: JSON.stringify({ input, ...(clientId ? { clientId, surface: 'memo' } : {}) }),
      signal: AbortSignal.timeout(120000),
      redirect: 'error',
    });
    if (!response.ok) throw Error('EDITORIAL_PROVIDER_UNAVAILABLE');
    const envelope = (await response.json()) as { result?: unknown };
    return { ...editorialOutput.parse(envelope.result), promptVersion: 'capiro-editorial-v1' };
  }
  async publishedRecords(
    tenantId: string,
    clerkUserId: string,
    input: PublishedRecordToolInput,
    clientId?: string,
  ): Promise<PublishedRecordToolResult> {
    if (!this.baseUrl) throw Error('RECORD_BRIEF_PROVIDER_UNAVAILABLE');
    const aiProvider = await this.aiCredentials.resolve(tenantId);
    const response = await fetch(
      `${this.baseUrl}/meri-api/tools/generate_published_record_brief/invoke`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.authHeaders(tenantId, clerkUserId),
          'x-tenant-id': tenantId,
          ...(aiProvider ? { 'x-capiro-ai-provider': JSON.stringify(aiProvider) } : {}),
        },
        body: JSON.stringify({ input, ...(clientId ? { clientId, surface: 'memo' } : {}) }),
        signal: AbortSignal.timeout(120000),
      },
    );
    if (!response.ok) throw Error('RECORD_BRIEF_PROVIDER_UNAVAILABLE');
    const envelope = (await response.json()) as { result?: unknown };
    const result = publishedRecordOutput.parse(envelope.result);
    return { ...result, promptVersion: 'published-record-brief-v1' };
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
    /** Durable jobs must distinguish a provider outage from an empty result. */
    requireSuccess?: boolean;
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
      jurisdiction?: string | null;
      legislativeSession?: string | null;
    };
  }): Promise<ExtractionResult> {
    const empty: ExtractionResult = { entityMentions: [], issueTags: [] };
    if (!this.baseUrl) {
      if (params.requireSuccess) throw new Error('Hearing analysis is not configured');
      return empty;
    }

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
        if (params.requireSuccess) throw new Error(`Hearing analysis HTTP ${res.status}`);
        this.logger.warn(`orchestrator extract HTTP ${res.status}; degrading to raw segment`);
        return empty;
      }
      const envelope = (await res.json()) as { result?: Partial<ExtractionResult> } | null;
      const data: Partial<ExtractionResult> = envelope?.result ?? {};
      if (
        params.requireSuccess &&
        (!envelope?.result || !Array.isArray(data.entityMentions) || !Array.isArray(data.issueTags))
      ) {
        throw new Error('Hearing analysis response is incomplete');
      }
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
      if (params.requireSuccess) throw err;
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
   * opportunities, next steps, draft client email). Returns null on failure so
   * the caller can surface synthesis as unavailable.
   */
  async summarizeHearing(params: {
    tenantId: string;
    sessionId: string;
    clerkUserId: string;
    title: string;
    quotes: Array<{ text: string; speakerName?: string; timestampMs: number }>;
    mentions: Array<{ type: string; label: string; ref: string | null }>;
    actionItems: string[];
    /** The client the recap is written FOR; absent/null = client-agnostic brief. */
    client?: PostHearingClientInput | null;
    /**
     * LEGACY narrative source: bounded, decrypted FINAL transcript segments for
     * the authored recap. Distinct from `evidence` (governed branch, untouched).
     * When present the recap runs the strict narrative schema branch.
     */
    narrativeSource?: Array<{
      segmentId: string;
      text: string;
      startMs: number;
      endMs: number;
      speakerLabel?: string | null;
    }>;
    evidence?: Array<{
      segmentId: string;
      text: string;
      startMs: number;
      endMs: number;
      speakerLabel?: string | null;
    }>;
    jurisdiction?: string | null;
    legislativeSession?: string | null;
    publicationKind?: 'live_update' | 'hearing_recap';
    folderContext?: Array<{
      id: string;
      name: string;
      jurisdiction: string;
      session: string;
      bills: Array<{
        id: string;
        number: string;
        position: string;
        importance: string;
        topPriority: boolean;
        externalComments: string;
      }>;
    }>;
  }): Promise<{
    executiveSummary: string;
    tone: string;
    risks: string[];
    opportunities: string[];
    recommendedNextSteps: string[];
    draftClientEmail: { subject: string; body: string };
    /** Absent from an orchestrator that predates client-aware briefs. */
    clientContext?: 'applied' | 'unavailable' | 'none';
    claims?: Array<{
      id: string;
      kind: 'quote' | 'observation' | 'analysis';
      text: string;
      evidenceIds: string[];
    }>;
    promptVersion?: string;
    /** NEW (legacy narrative branch). Model-authored report title + themes. */
    summaryTitle?: string;
    keyDevelopments?: Array<{ title: string; text: string; evidenceIds: string[] }>;
  } | null> {
    // Log every unavailable result so an operator can distinguish transport,
    // provider, and response failures without logging transcript content.
    if (!this.baseUrl) {
      this.logger.warn(
        `summarizeHearing skipped session=${params.sessionId}: no orchestrator base URL configured`,
      );
      return null;
    }
    const aiProvider = await this.aiCredentials.resolve(params.tenantId);
    const controller = new AbortController();
    // summarizeHearing's outer deadline must cover the provider's own structured-
    // generation window. The EVIDENCE branch runs a bounded manual-thinking step
    // on a 60s inner budget → 65s outer. The legacy NARRATIVE branch runs a
    // strict-schema authored recap on a 120s provider budget (strict compilation
    // adds latency) → 130s outer, still within the UI's 175s allowance and the
    // ALB's 300s idle timeout. The plain legacy (no source) recap keeps the 35s
    // floor and extraction keeps the single-timeout behavior.
    const budgetMs = params.evidence
      ? 65000
      : params.narrativeSource
        ? 130000
        : Math.max(this.timeoutMs * 3, 35000);
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
              ...(params.client ? { client: params.client } : {}),
              ...(params.narrativeSource ? { narrativeSource: params.narrativeSource } : {}),
              ...(params.evidence
                ? {
                    evidence: params.evidence,
                    jurisdiction: params.jurisdiction,
                    legislativeSession: params.legislativeSession,
                    publicationKind: params.publicationKind,
                    folderContext: params.folderContext,
                  }
                : {}),
            },
            // Transport-level scope, not tool input: from `clientId` the
            // orchestrator compiles this client's steering and checks the ethical
            // wall; `memo` is the external-deliverable surface — a recap is filed
            // into the client's Documents, so its context provenance must be
            // recorded, not best-effort. Omitted for a client-agnostic brief so
            // that request stays byte-identical to before.
            ...(params.client ? { clientId: params.client.clientId, surface: 'memo' } : {}),
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        this.logger.warn(
          `summarizeHearing HTTP ${res.status} session=${params.sessionId}; ` +
            `returning no synthesis`,
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
          clientContext?: 'applied' | 'unavailable' | 'none';
          claims?: Array<{
            id: string;
            kind: 'quote' | 'observation' | 'analysis';
            text: string;
            evidenceIds: string[];
          }>;
          promptVersion?: string;
          summaryTitle?: string;
          keyDevelopments?: Array<{ title: string; text: string; evidenceIds: string[] }>;
        };
      } | null;
      if (!envelope?.result) {
        this.logger.warn(
          `summarizeHearing returned no result envelope session=${params.sessionId}; ` +
            `returning no synthesis`,
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
          `returning no synthesis`,
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
