import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseProviderUsage, type ProviderUsage, type TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { LobbyIntelService } from '../lobby-intel/lobby-intel.service.js';
import { FederalSpendingService } from '../federal-spending/federal-spending.service.js';
import {
  AiCredentialResolverService,
  type ResolvedAiCredential,
} from './ai-credential-resolver.service.js';
import {
  buildOutreachPromptV2,
  OUTREACH_PROMPT_SPEC_VERSION,
  resolveOutreachMaxTokens,
  type OutreachPromptV2,
} from './outreach-prompt/prompt-spec-v2.js';
import { LlmCompletionService } from './llm-completion.service.js';

/** Legacy v1 outreach system line (Anthropic only; v1 OpenAI had none). */
const LEGACY_OUTREACH_SYSTEM =
  'You draft precise lobbying outreach from supplied CRM context. Return only valid JSON that matches the requested schema.';

const AI_TIMEOUT_MS = 90_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ServiceUnavailableException(
        `AI provider request timed out after ${AI_TIMEOUT_MS / 1000}s`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface MeetingPrepInput {
  meeting: Record<string, unknown>;
  client: Record<string, unknown> | null;
  attendees: Array<Record<string, unknown>>;
  congressionalDirectoryMatches: Array<Record<string, unknown>>;
  recentMeetings: Array<Record<string, unknown>>;
  recentThreads: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  /** Free-form context the user typed to ground/steer the prep generation. */
  additionalContext?: string | null;
  /** Firm identity + author voice + client strategic memory (rendered), for
   *  strategic framing, emphasis, and tone — NOT a source of meeting facts. */
  steeringContext?: string | null;
}

export interface MeetingPrepResult {
  agenda: string[];
  talkingPoints: string[];
  risks: string[];
  followUps: string[];
  summary: string;
  emailEvidence: string[];
  provider: 'openai' | 'anthropic';
  model: string;
  usage?: ProviderUsage;
  usedTenantKey?: boolean;
  raw: unknown;
}

export interface OutreachDraftInput {
  workflow: 'campaign' | 'follow_up' | 'prep' | 'outbound_campaign';
  client: Record<string, unknown> | null;
  meeting?: Record<string, unknown> | null;
  objective?: string | null;
  recipients: Array<Record<string, unknown>>;
  context: Record<string, unknown>;
  promptTemplate?: string | null;
  existingSubject?: string | null;
  existingBody?: string | null;
  /**
   * Audience shape for the campaign workflow. 'group' means the single supplied
   * recipient is a representative standing in for a whole group that receives
   * ONE shared email — so the prompt must use a collective salutation and must
   * NOT tailor to that one member (see buildOutreachPrompt). Absent/'individual'
   * keeps the existing per-recipient personalization behavior byte-for-byte.
   */
  audienceKind?: 'individual' | 'group';
}

export const POST_MEETING_MEMO_GUIDANCE_TEXT = [
  'Template name: post meeting memo.',
  'Generate an internal post-meeting memo in Markdown. This is not a normal campaign email.',
  'Use context.metadata.campaignCurrentDateTimeDisplay as the Date / Time value. If only context.metadata.campaignCurrentDateTime is present, format that timestamp. Do not use a stale or guessed date.',
  'Use only the supplied client, recipient, meeting, debrief, email thread, and congressional directory context. If a requested fact is not present, omit that bullet, participant, subsection, or section. Do not leave bracket placeholders, variable tokens, or made-up details.',
  'Use Directory member/staffer profiles for House/Senate labels, committee/subcommittee names, titles, offices, and chamber. Use client records for client participants and client details. Use email thread snippets or meeting attendees only when present. Use saved meeting debriefs for summaries, feedback, action items, and follow-ups.',
  'Organize the memo in this order when source data supports each section:',
  '## Date / Time',
  '**Use the resolved current day, date, time, and timezone from metadata.**',
  '# Meeting Participants',
  'Create a House subsection only when House participant or committee data is present; use the actual committee/subcommittee name in the heading when available.',
  '### Participants:',
  'Participant bullets should include only available name, title, committee, or office data.',
  'Create a Senate subsection only when Senate participant or committee data is present; use the actual committee/subcommittee name in the heading when available.',
  '# Summary - Key Takeaways',
  '## Purpose of Engagement',
  '## Core Problem Set',
  '## Platform / Initiative / Capability Overview',
  '## Differentiation from Other Solutions',
  '## Government Engagements to Date',
  '# Policy and Strategic Implications',
  '# House Staff Feedback',
  '# Senate Staff Feedback',
  '# Key Themes Identified',
  '### Policy Themes',
  '### Operational Themes',
  '### Strategic Themes',
  '# Risks / Concerns Raised',
  '# Opportunities Identified',
  '# Follow-Up Items and Next Steps',
  '## Action Items',
  '### Client or Organization',
  '### Congressional Staff',
  '## Materials to Provide',
  '# Strategic Assessment',
  '## Overall Sentiment',
  '## Key Opportunity Areas',
  '## Recommended Engagement Strategy',
  '# Internal Notes',
  'For optional sections, include them only when source context supports them.',
].join('\n');

const POST_MEETING_MEMO_GUIDANCE = POST_MEETING_MEMO_GUIDANCE_TEXT;

const PROMPT_TEMPLATE_GUIDANCE: Record<string, string> = {
  thank_you:
    "Tone: warm, gracious thank-you. Acknowledge the recipient's recent action or support, name the specific reason for thanks, and close with a brief offer to stay in touch. No new asks.",
  follow_up:
    'Tone: polite follow-up. Reference the prior touchpoint or meeting (use supplied notes/debriefs if present), restate one clear ask or next step, and propose a concrete next action.',
  memo: 'Format as a concise memo / position paper. Lead with a one-line summary, then short Background, Ask, and Supporting Points sections. Keep under 300 words; use plain language.',
  post_meeting_memo: POST_MEETING_MEMO_GUIDANCE,
  introduction:
    "Tone: introductory, professional. Briefly introduce the client and why you are reaching out, the relevance to the recipient's portfolio, and a low-friction first ask (e.g., a 15-minute conversation).",
  meeting_request:
    'Goal: request a meeting. State the reason for meeting, suggested 2-3 scheduling windows, who would attend, and a one-sentence agenda. Keep it short.',
  status_update:
    'Tone: brief progress update. List 2-4 short bullets on activity since last contact, current status, and next planned step. No new asks unless directly tied to the update.',
};

export interface OutreachDraftResult {
  subject: string;
  body: string;
  contextNote: string;
  provider: 'openai' | 'anthropic';
  model: string;
  usage?: ProviderUsage;
  usedTenantKey?: boolean;
  /** Prompt-assembly spec that produced this draft ('v1' legacy | 'v2' PromptSpec v2). */
  promptSpecVersion?: string;
  raw: unknown;
}

export interface MeetingDebriefDraftInput {
  meeting: Record<string, unknown>;
  client: Record<string, unknown> | null;
  attendees: Array<Record<string, unknown>>;
  prep: Record<string, unknown> | null;
  source: { method: 'upload' | 'manual' | 'voice'; text: string };
  visibleNotes: Array<Record<string, unknown>>;
  clientContext: Record<string, unknown> | null;
  congressionalDirectoryMatches: Array<Record<string, unknown>>;
  recentMeetings: Array<Record<string, unknown>>;
  recentThreads: Array<Record<string, unknown>>;
  /** Firm identity + author voice + client strategic memory (rendered),
   *  standing background for framing/tone only — never treated as meeting facts. */
  steeringContext?: string | null;
}

export interface MeetingDebriefDraftResult {
  recap: string;
  actionItems: string[];
  notes: string;
  provider: 'openai' | 'anthropic';
  model: string;
  usage?: ProviderUsage;
  usedTenantKey?: boolean;
  raw: unknown;
}

export interface CampaignEmailInput {
  campaign: Record<string, unknown>;
  client: Record<string, unknown> | null;
  meeting: Record<string, unknown> | null;
  debrief: Record<string, unknown> | null;
  prep: Record<string, unknown> | null;
  recipients: Array<Record<string, unknown>>;
  campaignType: string;
  customContext?: string | null;
}

export interface CampaignEmailResult {
  subject: string;
  body: string;
  provider: 'openai' | 'anthropic';
  model: string;
  usage?: ProviderUsage;
  usedTenantKey?: boolean;
  raw: unknown;
}

export interface TalkingPointsInput {
  client: Record<string, unknown> | null;
  selectedInsights: string[];
  additionalContext?: string | null;
}

export interface TalkingPointsResult {
  points: string[];
  provider: 'openai' | 'anthropic';
  model: string;
  usage?: ProviderUsage;
  usedTenantKey?: boolean;
}

const meetingPrepJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agenda', 'talkingPoints', 'risks', 'followUps', 'summary', 'emailEvidence'],
  properties: {
    agenda: { type: 'array', items: { type: 'string' } },
    talkingPoints: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    followUps: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    emailEvidence: { type: 'array', items: { type: 'string' } },
  },
};

const outreachDraftJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body', 'contextNote'],
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
    contextNote: { type: 'string' },
  },
};

const meetingDebriefJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['recap', 'actionItems', 'notes'],
  properties: {
    recap: { type: 'string' },
    actionItems: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

const campaignEmailJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body'],
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
  },
};

@Injectable()
export class EngagementAiService {
  private readonly logger = new Logger(EngagementAiService.name);
  private readonly openaiKey?: string;
  private readonly anthropicKey?: string;
  private readonly preferredProvider?: 'openai' | 'anthropic';
  private readonly openaiModel: string;
  private readonly anthropicModel: string;
  private readonly outreachPromptSpec: 'v1' | 'v2';
  private readonly outreachProvider?: 'openai' | 'anthropic';
  private readonly outreachDraftModel: string;
  /** D1 hardened completion client (retries, typed errors, caching, usage). */
  private readonly llm = new LlmCompletionService();

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly lobbyIntel: LobbyIntelService,
    private readonly federalSpending: FederalSpendingService,
    private readonly credentials: AiCredentialResolverService,
  ) {
    // Global env keys/models are kept ONLY for capabilities() reporting.
    // Actual per-call credentials (key + model + usedTenantKey) come from the
    // resolver, which prefers an active tenant key and falls back to these
    // same globals — so paths without a tenant key behave exactly as before.
    this.openaiKey = config.get('OPENAI_API_KEY', { infer: true });
    this.anthropicKey = config.get('ANTHROPIC_API_KEY', { infer: true });
    this.preferredProvider = config.get('AI_PROVIDER', { infer: true });
    this.openaiModel = config.get('OPENAI_MODEL', { infer: true });
    this.anthropicModel = config.get('ANTHROPIC_MODEL', { infer: true });
    this.outreachPromptSpec = config.get('OUTREACH_PROMPT_SPEC', { infer: true });
    this.outreachProvider = config.get('OUTREACH_PROVIDER', { infer: true });
    this.outreachDraftModel = config.get('OUTREACH_DRAFT_MODEL', { infer: true });
  }

  /**
   * True when outreach runs PromptSpec v2 (which emits a byte-stable, cacheable
   * user prefix + a cached system block). The batch generator uses this to decide
   * whether the warm-first fan-out (draft #1 first, then parallelize) is worth the
   * extra latency — it only pays off when there is a cache to warm.
   */
  get outreachCachingEnabled(): boolean {
    return this.outreachPromptSpec === 'v2';
  }

  /**
   * Assemble the outreach prompt for the active spec version. v2 (PromptSpec v2,
   * plan §3.1) applies to the campaign workflow only — follow_up/prep/outbound
   * keep their own bespoke guidance under v1 regardless of the flag. Returns a
   * `{ system, user }` split; v1 has no real system prompt so `system` is null
   * and the caller uses its existing one-line system string.
   */
  private assembleOutreachPrompt(input: OutreachDraftInput): {
    system: string | null;
    user: string;
    spec: OutreachPromptV2 | null;
  } {
    if (this.outreachPromptSpec === 'v2' && input.workflow === 'campaign') {
      const templateGuidanceText =
        input.promptTemplate && input.promptTemplate !== 'custom'
          ? (PROMPT_TEMPLATE_GUIDANCE[input.promptTemplate] ?? null)
          : null;
      const spec = buildOutreachPromptV2({ ...input, templateGuidanceText });
      return { system: spec.system, user: spec.user, spec };
    }
    return { system: null, user: this.buildOutreachPrompt(input), spec: null };
  }

  /**
   * Try to extract a client name from various AI input shapes for federal
   * contractor lookup. Returns null when no name is present.
   */
  private extractClientName(input: { client?: Record<string, unknown> | null }): string | null {
    const c = input.client;
    if (!c || typeof c !== 'object') return null;
    const name = (c as { name?: unknown }).name;
    return typeof name === 'string' && name.trim() ? name : null;
  }

  /**
   * Compact federal context block for AI prompts. Combines:
   *   - FederalSpending: matched contractor's contracts + top federal agencies
   *     they win business from (always, when the client name matches — this is
   *     client-specific and inherently relevant).
   *   - LobbyIntel market-wide surging issues + trending terms — RELEVANCE-GATED
   *     (C7): included only when the client is a matched federal contractor, for
   *     whom the defense-lobbying market context is on-point. A non-contractor
   *     client (e.g. a pure advocacy org) no longer gets market-wide LDA noise
   *     force-injected into every draft.
   * Returns "" when no useful data is available.
   */
  private async buildFederalContextBlock(clientName: string | null): Promise<string> {
    const parts: string[] = [];
    let hasContractorMatch = false;

    // Client-specific contracting context first — it also decides whether the
    // market-wide block is relevant enough to include.
    try {
      const spend = await this.federalSpending.getAiContext(clientName);
      if (spend.matchedContractor) {
        hasContractorMatch = true;
        const mc = spend.matchedContractor;
        const agencyList = mc.topAgencies
          .slice(0, 4)
          .map((a) => `${a.name} (${formatUsdCompact(a.amount)})`)
          .join('; ');
        const contractAmt =
          mc.totalContracts != null
            ? `${formatUsdCompact(mc.totalContracts)} in FY2025 federal contracts`
            : 'federal contracts (amount unknown)';
        parts.push(
          `Federal contracting context for this client: ${mc.name} won ${contractAmt}` +
            (mc.rankByContracts ? ` (rank #${mc.rankByContracts} nationally)` : '') +
            (mc.category ? `, primary category: ${mc.category}` : '') +
            (agencyList ? `. Top awarding agencies: ${agencyList}.` : '.'),
        );
      }
      if (hasContractorMatch && spend.topAgencyTotals.length) {
        const topAg = spend.topAgencyTotals
          .slice(0, 4)
          .map((a) => `${a.name}${a.budget ? ` (${formatUsdCompact(a.budget)})` : ''}`)
          .join(', ');
        if (topAg) parts.push(`Top federal agencies by budget: ${topAg}.`);
      }
    } catch (err) {
      this.logger.warn(`Federal spend context fetch failed (degrading): ${(err as Error).message}`);
    }

    // Market-wide surging LDA issues — only when the client is a federal
    // contractor (C7 relevance gate).
    if (hasContractorMatch) {
      try {
        const ctx = await this.lobbyIntel.getAiContext();
        const surge = ctx.surgingIssues
          .slice(0, 6)
          .map(
            (s) =>
              `${s.code} (${s.name})${s.surgePct != null ? `: +${Math.round(s.surgePct)}% QoQ` : ''}`,
          )
          .join('; ');
        const trending = ctx.trendingTopics
          .slice(0, 8)
          .map((t) => t.word)
          .filter(Boolean)
          .join(', ');
        if (surge || trending) {
          parts.push('Current federal lobbying context (Senate LDA, OpenLobby):');
          if (ctx.latestQuarter) parts.push(`Latest quarter: ${ctx.latestQuarter}.`);
          if (surge) parts.push(`Surging LDA issues: ${surge}.`);
          if (trending) parts.push(`Trending terms in filings: ${trending}.`);
        }
      } catch (err) {
        this.logger.warn(`Lobby context fetch failed (degrading): ${(err as Error).message}`);
      }
    }

    if (!parts.length) return '';
    parts.push(
      'Use these only when relevant to the client/recipient; do not force-fit unrelated topics or invent facts.',
    );
    return parts.join(' ');
  }

  capabilities() {
    return {
      openaiConfigured: Boolean(this.openaiKey),
      anthropicConfigured: Boolean(this.anthropicKey),
      activeProvider: this.resolveProvider(),
      openaiModel: this.openaiModel,
      anthropicModel: this.anthropicModel,
    };
  }

  async generateMeetingPrep(
    input: MeetingPrepInput,
    ctx?: TenantContext | null,
  ): Promise<MeetingPrepResult> {
    const federalContext = await this.buildFederalContextBlock(this.extractClientName(input));
    const enriched: MeetingPrepInput = federalContext
      ? {
          ...input,
          meeting: { ...input.meeting, federalLobbyIntel: federalContext },
        }
      : input;
    return this.withCredentialFallback('AI meeting prep', ctx, (cred) =>
      cred.provider === 'openai'
        ? this.generateWithOpenAi(enriched, cred)
        : this.generateWithAnthropic(enriched, cred),
    );
  }

  async generateOutreachDraft(
    input: OutreachDraftInput,
    ctx?: TenantContext | null,
    opts?: { creds?: ResolvedAiCredential[] },
  ): Promise<OutreachDraftResult> {
    const federalContext = await this.buildFederalContextBlock(this.extractClientName(input));
    const enriched = federalContext
      ? { ...input, context: { ...input.context, federalLobbyIntel: federalContext } }
      : input;
    // Campaign-sticky provider (M2/W3.2): when the caller supplies a pre-resolved
    // credential list (the batch pins ONE provider for the whole campaign), use it
    // as-is instead of re-resolving per recipient — so a mid-campaign fallback can
    // never split one send across two provider "voices".
    if (opts?.creds) {
      return this.invokeWithCreds('AI outreach drafting', opts.creds, (cred) =>
        this.draftOutreachViaClient(enriched, cred),
      );
    }
    return this.withCredentialFallback(
      'AI outreach drafting',
      ctx,
      (cred) => this.draftOutreachViaClient(enriched, cred),
      { preferredProvider: this.outreachProvider },
    );
  }

  /**
   * Resolve the ordered outreach credential list (global resolver order, then the
   * outreach provider preference applied — Anthropic-first per D2 when configured).
   * The batch generator resolves this ONCE and pins the winning provider across the
   * whole campaign (M2). Returns [] when nothing is configured; the caller decides
   * whether that is a hard failure.
   */
  async resolveOutreachCredentials(ctx?: TenantContext | null): Promise<ResolvedAiCredential[]> {
    const creds = await this.credentials.resolveOrder(ctx ?? null);
    return this.applyPreferredProvider(creds, this.outreachProvider);
  }

  async generateMeetingDebrief(
    input: MeetingDebriefDraftInput,
    ctx?: TenantContext | null,
  ): Promise<MeetingDebriefDraftResult> {
    return this.withCredentialFallback('AI debrief generation', ctx, (cred) =>
      cred.provider === 'openai'
        ? this.generateDebriefWithOpenAi(input, cred)
        : this.generateDebriefWithAnthropic(input, cred),
    );
  }

  async generateTalkingPoints(
    input: TalkingPointsInput,
    ctx?: TenantContext | null,
  ): Promise<TalkingPointsResult> {
    const prompt = [
      'Generate 3-5 sharp, specific talking points for a federal lobbying outreach campaign.',
      'Each talking point should be a single, persuasive sentence that a lobbyist could use in a congressional meeting or email.',
      'Base the talking points on the provided intelligence insights and client context.',
      'Do not invent facts. Use only the supplied context.',
      'Return JSON with a "points" array of strings.',
      input.client ? `Client context: ${JSON.stringify(input.client)}` : null,
      input.selectedInsights.length
        ? `Selected insights:\n${input.selectedInsights.map((s) => `- ${s}`).join('\n')}`
        : null,
      input.additionalContext ? `Additional context: ${input.additionalContext}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n\n');

    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['points'],
      properties: { points: { type: 'array', items: { type: 'string' } } },
    };

    return this.withCredentialFallback('AI talking points', ctx, async (cred) => {
      let raw: Record<string, unknown>;
      if (cred.provider === 'openai') {
        const res = await fetchWithTimeout('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cred.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: cred.model,
            input: prompt,
            text: { format: { type: 'json_schema', name: 'talking_points', strict: true, schema } },
          }),
        });
        raw = (await res.json()) as Record<string, unknown>;
        if (!res.ok)
          throw new ServiceUnavailableException(
            `OpenAI talking points failed: ${readProviderError(raw, res.status)}`,
          );
        const parsed = parseJsonObject(extractOpenAiText(raw));
        return {
          points: toStringList(parsed.points),
          provider: 'openai' as const,
          model: cred.model,
          usage: parseProviderUsage(raw),
          usedTenantKey: cred.usedTenantKey,
        };
      } else {
        const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': cred.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: cred.model,
            max_tokens: 800,
            system:
              'You are a federal lobbying expert. Generate precise talking points from the supplied context. Return only valid JSON.',
            messages: [
              { role: 'user', content: `${prompt}\n\nJSON schema:\n${JSON.stringify(schema)}` },
            ],
          }),
        });
        raw = (await res.json()) as Record<string, unknown>;
        if (!res.ok)
          throw new ServiceUnavailableException(
            `Anthropic talking points failed: ${readProviderError(raw, res.status)}`,
          );
        const parsed = parseJsonObject(extractAnthropicText(raw));
        return {
          points: toStringList(parsed.points),
          provider: 'anthropic' as const,
          model: cred.model,
          usage: parseProviderUsage(raw),
          usedTenantKey: cred.usedTenantKey,
        };
      }
    });
  }

  async generateCampaignEmail(
    input: CampaignEmailInput,
    ctx?: TenantContext | null,
  ): Promise<CampaignEmailResult> {
    const federalContext = await this.buildFederalContextBlock(this.extractClientName(input));
    const enriched = federalContext
      ? {
          ...input,
          customContext: input.customContext
            ? `${input.customContext}\n\n${federalContext}`
            : federalContext,
        }
      : input;
    return this.withCredentialFallback('AI campaign email generation', ctx, (cred) =>
      cred.provider === 'openai'
        ? this.generateCampaignWithOpenAi(enriched, cred)
        : this.generateCampaignWithAnthropic(enriched, cred),
    );
  }

  private resolveProvider(): 'openai' | 'anthropic' | null {
    if (this.preferredProvider === 'openai' && this.openaiKey) return 'openai';
    if (this.preferredProvider === 'anthropic' && this.anthropicKey) return 'anthropic';
    if (this.openaiKey) return 'openai';
    if (this.anthropicKey) return 'anthropic';
    return null;
  }

  /**
   * Resolve the per-call credential order (tenant key first when ctx is
   * supplied and one exists, else global env keys) and try each provider in
   * turn — same fallback semantics the old providerOrder loop had.
   */
  /** Reorder so `preferred` provider's creds come first, without disturbing the
   *  global resolver order used by other AI surfaces. */
  private applyPreferredProvider(
    creds: ResolvedAiCredential[],
    preferred?: 'openai' | 'anthropic',
  ): ResolvedAiCredential[] {
    if (!preferred) return creds;
    return [
      ...creds.filter((c) => c.provider === preferred),
      ...creds.filter((c) => c.provider !== preferred),
    ];
  }

  /** Try each credential in order until one succeeds; throw typed once all fail. */
  private async invokeWithCreds<T>(
    operation: string,
    creds: ResolvedAiCredential[],
    invoke: (cred: ResolvedAiCredential) => Promise<T>,
  ): Promise<T> {
    if (!creds.length) {
      throw new ServiceUnavailableException(
        `${operation} is not configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.`,
      );
    }
    const failures: string[] = [];
    for (const cred of creds) {
      try {
        return await invoke(cred);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'provider request failed';
        failures.push(`${cred.provider}: ${message}`);
        if (cred !== creds[creds.length - 1]) {
          this.logger.warn(
            `${operation} failed with ${cred.provider}; trying fallback provider. ${message}`,
          );
        }
      }
    }
    throw new ServiceUnavailableException(
      `${operation} failed for all configured providers. ${failures.join(' | ')}`,
    );
  }

  private async withCredentialFallback<T>(
    operation: string,
    ctx: TenantContext | null | undefined,
    invoke: (cred: ResolvedAiCredential) => Promise<T>,
    opts?: { preferredProvider?: 'openai' | 'anthropic' },
  ): Promise<T> {
    const creds = this.applyPreferredProvider(
      await this.credentials.resolveOrder(ctx ?? null),
      opts?.preferredProvider,
    );
    return this.invokeWithCreds(operation, creds, invoke);
  }

  private async generateWithOpenAi(
    input: MeetingPrepInput,
    cred: ResolvedAiCredential,
  ): Promise<MeetingPrepResult> {
    const response = await fetchWithTimeout('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cred.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cred.model,
        input: this.buildPrompt(input),
        text: {
          format: {
            type: 'json_schema',
            name: 'meeting_prep',
            strict: true,
            schema: meetingPrepJsonSchema,
          },
        },
      }),
    });

    const json = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `OpenAI meeting prep failed: ${readProviderError(json, response.status)}`,
      );
    }

    const parsed = parseJsonObject(extractOpenAiText(json));
    return {
      agenda: toStringList(parsed.agenda),
      talkingPoints: toStringList(parsed.talkingPoints),
      risks: toStringList(parsed.risks),
      followUps: toStringList(parsed.followUps),
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      emailEvidence: toStringList(parsed.emailEvidence),
      provider: 'openai',
      model: cred.model,
      usage: parseProviderUsage(json),
      usedTenantKey: cred.usedTenantKey,
      raw: json,
    };
  }

  private async generateWithAnthropic(
    input: MeetingPrepInput,
    cred: ResolvedAiCredential,
  ): Promise<MeetingPrepResult> {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': cred.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cred.model,
        max_tokens: 1600,
        system:
          'You generate concise lobbying meeting preparation. Return only valid JSON that matches the requested schema.',
        messages: [
          {
            role: 'user',
            content: `${this.buildPrompt(input)}\n\nJSON schema:\n${JSON.stringify(
              meetingPrepJsonSchema,
            )}`,
          },
        ],
      }),
    });

    const json = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `Anthropic meeting prep failed: ${readProviderError(json, response.status)}`,
      );
    }

    const parsed = parseJsonObject(extractAnthropicText(json));
    return {
      agenda: toStringList(parsed.agenda),
      talkingPoints: toStringList(parsed.talkingPoints),
      risks: toStringList(parsed.risks),
      followUps: toStringList(parsed.followUps),
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      emailEvidence: toStringList(parsed.emailEvidence),
      provider: 'anthropic',
      model: cred.model,
      usage: parseProviderUsage(json),
      usedTenantKey: cred.usedTenantKey,
      raw: json,
    };
  }

  /**
   * Draft outreach through the D1 client (LlmCompletionService). One path for
   * both providers + both spec versions: the client owns transport resilience
   * (429/5xx/network retries, typed errors), while this method owns the outreach
   * POLICY — spec selection, per-template budget, the 1.5x truncation retry
   * then honest typed failure (v2 only), and prompt-cache breakpoints (v2).
   *
   * v1 shape is preserved byte-for-byte: Anthropic keeps the legacy one-line
   * system + max_tokens 2400; OpenAI sends no `instructions` and no
   * `max_output_tokens` (empty system + undefined budget ⇒ the client omits both).
   */
  private async draftOutreachViaClient(
    input: OutreachDraftInput,
    cred: ResolvedAiCredential,
  ): Promise<OutreachDraftResult> {
    const assembled = this.assembleOutreachPrompt(input);
    const isV2 = Boolean(assembled.spec);

    // Task-tier model (W3.2/D2): a tenant's explicit modelOverride always wins
    // (BYOK); otherwise the configured OUTREACH_DRAFT_MODEL applies on Anthropic.
    // When OUTREACH_DRAFT_MODEL is unset (the default), there is NO override —
    // the resolved cred model is used, preserving current behavior so a deploy
    // never silently changes the drafting model.
    const model =
      cred.modelOverridden || cred.provider !== 'anthropic' || !this.outreachDraftModel
        ? cred.model
        : this.outreachDraftModel;

    const baseMax = isV2
      ? resolveOutreachMaxTokens({
          promptTemplate: input.promptTemplate,
          length:
            typeof input.context?.length === 'string' ? (input.context.length as string) : null,
        })
      : cred.provider === 'anthropic'
        ? 2400
        : undefined;

    const system = isV2
      ? assembled.spec!.system
      : cred.provider === 'anthropic'
        ? LEGACY_OUTREACH_SYSTEM
        : '';
    const userStatic = isV2 ? assembled.spec!.userStatic : '';
    const userVolatile = isV2 ? assembled.spec!.userVolatile : assembled.user;

    // Truncation policy: v2 retries once at 1.5x then fails typed; v1 does not
    // retry (historical behavior).
    const truncationRetries = isV2 ? 1 : 0;
    let result: Awaited<ReturnType<LlmCompletionService['complete']>> | null = null;
    for (let attempt = 0; attempt <= truncationRetries; attempt++) {
      const maxTokens =
        baseMax != null ? Math.ceil(baseMax * (attempt === 0 ? 1 : 1.5)) : undefined;
      result = await this.llm.complete({
        provider: cred.provider,
        apiKey: cred.apiKey,
        model,
        system,
        userStatic,
        userVolatile,
        jsonSchema: outreachDraftJsonSchema,
        jsonSchemaName: 'outreach_draft',
        maxTokens,
        // Prompt caching (W3.3) on the byte-stable v2 prefix (Anthropic).
        cacheSystem: isV2,
        cacheUserStatic: isV2,
        // Zero-trust Wave 1 (RC8): outreach drafts carry budget figures/bill
        // numbers — low temperature cuts the numeric-scramble sampling variance.
        // Anthropic-only inside the client (see LlmCompletionRequest.temperature).
        temperature: 0.2,
        timeoutMs: AI_TIMEOUT_MS,
      });
      if (!result.truncated || attempt === truncationRetries) break;
    }
    if (result && result.truncated && isV2) {
      throw new ServiceUnavailableException(
        `${cred.provider} outreach draft was truncated at the token limit after a retry; shorten the template or reduce attached context.`,
      );
    }

    const parsed = parseJsonObject(result!.text);
    return {
      subject: typeof parsed.subject === 'string' ? parsed.subject.trim() : '',
      body: typeof parsed.body === 'string' ? parsed.body.trim() : '',
      contextNote: typeof parsed.contextNote === 'string' ? parsed.contextNote.trim() : '',
      provider: cred.provider,
      model,
      usage: result!.usage,
      usedTenantKey: cred.usedTenantKey,
      promptSpecVersion: isV2 ? OUTREACH_PROMPT_SPEC_VERSION : 'v1',
      raw: result!.raw,
    };
  }

  private async generateDebriefWithOpenAi(
    input: MeetingDebriefDraftInput,
    cred: ResolvedAiCredential,
  ): Promise<MeetingDebriefDraftResult> {
    const response = await fetchWithTimeout('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cred.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cred.model,
        input: this.buildDebriefPrompt(input),
        text: {
          format: {
            type: 'json_schema',
            name: 'meeting_debrief',
            strict: true,
            schema: meetingDebriefJsonSchema,
          },
        },
      }),
    });

    const json = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `OpenAI debrief generation failed: ${readProviderError(json, response.status)}`,
      );
    }

    const parsed = parseJsonObject(extractOpenAiText(json));
    return {
      recap: typeof parsed.recap === 'string' ? parsed.recap.trim() : '',
      actionItems: toStringList(parsed.actionItems),
      notes: typeof parsed.notes === 'string' ? parsed.notes.trim() : '',
      provider: 'openai',
      model: cred.model,
      usage: parseProviderUsage(json),
      usedTenantKey: cred.usedTenantKey,
      raw: json,
    };
  }

  private async generateDebriefWithAnthropic(
    input: MeetingDebriefDraftInput,
    cred: ResolvedAiCredential,
  ): Promise<MeetingDebriefDraftResult> {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': cred.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cred.model,
        max_tokens: 1800,
        system:
          'You generate accurate lobbying meeting debriefs from supplied tenant CRM context. Return only valid JSON that matches the requested schema.',
        messages: [
          {
            role: 'user',
            content: `${this.buildDebriefPrompt(input)}\n\nJSON schema:\n${JSON.stringify(
              meetingDebriefJsonSchema,
            )}`,
          },
        ],
      }),
    });

    const json = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `Anthropic debrief generation failed: ${readProviderError(json, response.status)}`,
      );
    }

    const parsed = parseJsonObject(extractAnthropicText(json));
    return {
      recap: typeof parsed.recap === 'string' ? parsed.recap.trim() : '',
      actionItems: toStringList(parsed.actionItems),
      notes: typeof parsed.notes === 'string' ? parsed.notes.trim() : '',
      provider: 'anthropic',
      model: cred.model,
      usage: parseProviderUsage(json),
      usedTenantKey: cred.usedTenantKey,
      raw: json,
    };
  }

  private async generateCampaignWithOpenAi(
    input: CampaignEmailInput,
    cred: ResolvedAiCredential,
  ): Promise<CampaignEmailResult> {
    const response = await fetchWithTimeout('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cred.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cred.model,
        input: this.buildCampaignPrompt(input),
        text: {
          format: {
            type: 'json_schema',
            name: 'campaign_email',
            strict: true,
            schema: campaignEmailJsonSchema,
          },
        },
      }),
    });

    const json = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `OpenAI campaign email failed: ${readProviderError(json, response.status)}`,
      );
    }

    const parsed = parseJsonObject(extractOpenAiText(json));
    return {
      subject: typeof parsed.subject === 'string' ? parsed.subject.trim() : '',
      body: typeof parsed.body === 'string' ? parsed.body.trim() : '',
      provider: 'openai',
      model: cred.model,
      usage: parseProviderUsage(json),
      usedTenantKey: cred.usedTenantKey,
      raw: json,
    };
  }

  private async generateCampaignWithAnthropic(
    input: CampaignEmailInput,
    cred: ResolvedAiCredential,
  ): Promise<CampaignEmailResult> {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': cred.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cred.model,
        max_tokens: 2400,
        system:
          'You draft professional government affairs follow-up emails from lobbying CRM context. Return only valid JSON that matches the requested schema.',
        messages: [
          {
            role: 'user',
            content: `${this.buildCampaignPrompt(input)}\n\nJSON schema:\n${JSON.stringify(
              campaignEmailJsonSchema,
            )}`,
          },
        ],
      }),
    });

    const json = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new ServiceUnavailableException(
        `Anthropic campaign email failed: ${readProviderError(json, response.status)}`,
      );
    }

    const parsed = parseJsonObject(extractAnthropicText(json));
    return {
      subject: typeof parsed.subject === 'string' ? parsed.subject.trim() : '',
      body: typeof parsed.body === 'string' ? parsed.body.trim() : '',
      provider: 'anthropic',
      model: cred.model,
      usage: parseProviderUsage(json),
      usedTenantKey: cred.usedTenantKey,
      raw: json,
    };
  }

  private buildPrompt(input: MeetingPrepInput): string {
    const emailHighlights = formatMeetingPrepEmailHighlights(input.recentThreads);
    const hasEmailThreads = input.recentThreads.length > 0;
    const hasPriorMeetings = input.recentMeetings.length > 0;
    const hasDirectoryMatches = input.congressionalDirectoryMatches.length > 0;
    const hasTasks = input.tasks.length > 0;
    const userContext = (input.additionalContext ?? '').trim();
    const hasUserContext = userContext.length > 0;
    // Firm/author/client standing memory — HOW to frame + whose voice, not a
    // record of this meeting. Kept out of the JSON so the strict grounding rule
    // can't mine it for invented facts; labeled as background below.
    const steeringBlock = (input.steeringContext ?? '').trim();
    const hasSteering = steeringBlock.length > 0;
    // "Substantive" context = anything beyond the bare meeting record (subject,
    // time, attendee names). With none of it, the model must NOT invent a brief.
    const hasSubstantiveContext =
      hasEmailThreads || hasPriorMeetings || hasTasks || hasDirectoryMatches || hasUserContext;

    // Surface meeting logistics so the brief can lead with them.
    const meetingRecord = toRecord(input.meeting);
    const location =
      typeof meetingRecord.location === 'string' ? meetingRecord.location.trim() : '';
    const hasLocation = location.length > 0;

    return [
      'Write a lobbyist-ready meeting prep. Keep it concise, specific, and decision-focused.',
      // --- Hard anti-fabrication contract ---
      'STRICT GROUNDING RULES (highest priority, override everything else):',
      '- Every statement in agenda, talkingPoints, risks, followUps, summary, and emailEvidence MUST be directly supported by the supplied JSON context below (recentThreads emails, recentMeetings, tasks, congressionalDirectoryMatches, the meeting/client/attendee records) or the user-provided additional context.',
      '- Do NOT introduce any fact, policy position, relationship, history, statistic, commitment, priority, or topic that is not explicitly present in that data. No outside/world knowledge. No plausible-sounding guesses.',
      '- Do NOT infer what attendees think, want, or will say unless the source text states it.',
      '- If you are tempted to add a detail and cannot point to where it came from in the supplied data, omit it.',
      "- The recentMeetings and recentThreads reflect your FIRM's history with this client (they may involve colleagues, not just the reader). Treat them as the firm's shared record.",
      '',
      hasSubstantiveContext
        ? 'There IS supporting context below. Ground every line in it.'
        : 'INSUFFICIENT CONTEXT: there are no emails, prior meetings, tasks, directory matches, or user-provided notes for this meeting. Do NOT fabricate a brief. Instead: set summary to a short, honest statement that there is not enough context to prepare a substantive prep (e.g., "No emails, prior meetings, or notes were found for this meeting, so there isn\'t enough context to prepare a substantive brief. Add context below, or sync the relevant email threads."). Return EMPTY arrays for talkingPoints, risks, followUps, and emailEvidence. Keep agenda to logistics/objective placeholders only. Do not invent discussion priorities or attendee positions.',
      '',
      hasUserContext
        ? `USER-PROVIDED ADDITIONAL CONTEXT (authoritative; treat as factual input from the user and incorporate it):\n${userContext}`
        : 'No additional context was provided by the user.',
      '',
      hasSteering
        ? `FIRM, AUTHOR & CLIENT MEMORY (authoritative standing context — use it to shape strategy, emphasis, and tone; it is background, NOT a record of this meeting's events, so never present it as something said or decided here):\n${steeringBlock}`
        : '',
      '',
      hasLocation
        ? `MEETING LOGISTICS: this meeting has a location ("${location}"). OPEN the summary with a one-line logistics header stating the meeting date/time and this location, before any narrative. Make a "Logistics" item the FIRST entry in the agenda, naming the location and time. Use only the supplied meeting date/time fields verbatim; do not guess a timezone or reformat into one.`
        : 'MEETING LOGISTICS: no location is recorded for this meeting. Do not invent one. Open the summary with the meeting date/time only.',
      '',
      'CENTRAL SUBJECT & DISCUSSION POINTS: Determine the core subject of this meeting and its key discussion points by synthesizing the meeting subject/description, recentThreads (email correspondence), recentMeetings, tasks, and any user context. Surface them explicitly as a "Discussion Priorities" agenda section and as concrete talkingPoints. Where the threads or prior meetings reveal an open ask, pending decision, or unresolved thread, name it specifically. Do not assert a subject the supplied data does not support.',
      '',
      hasEmailThreads
        ? 'PRIOR CORRESPONDENCE: Summarize the previous relevant email conversations with specifics — who said what, when, the ask or commitment, and the current state of each thread — using ONLY the supplied recentThreads. Reflect that substance in the summary and talkingPoints (which the user sees), and also capture it as emailEvidence bullets that each name the sender, the date, and the concrete point. Quote or closely paraphrase; do not generalize the details away.'
        : 'PRIOR CORRESPONDENCE: no email threads are linked to this client/meeting. Do not reference or invent email history.',
      '',
      'Output structure (JSON fields):',
      'agenda: ordered section headers with one-line guidance. When supported by context, order them: Logistics (location/time, when present), Objective, Discussion Priorities, Attendee Context, Risks. Only include a section when supported by context.',
      'talkingPoints: concrete points the lobbyist can say in the room, each grounded in supplied context (empty array if none).',
      'risks: likely objections/sensitivities grounded in supplied context only (empty array if none).',
      'followUps: specific next steps with owner/timing when known; if unknown, leave timing blank rather than fabricating.',
      'summary: 2-4 sentence plain-language brief that OPENS with logistics (date/time, plus location when present), then covers who, why now, the central subject, and what success looks like — or the insufficient-context statement above when there is no context.',
      'emailEvidence: detailed bullets drawn from provided threads only — each names the sender and date and captures the specific point, ask, or commitment. Empty array when no threads.',
      '',
      hasDirectoryMatches
        ? 'Use congressionalDirectoryMatches for attendee context (role, committee/jurisdiction, office details) when present.'
        : 'No congressional directory matches were provided.',
      hasPriorMeetings
        ? 'Use recentMeetings to carry forward unresolved items and prior commitments that are explicitly documented.'
        : 'No prior meetings with these attendees were found.',
      hasTasks
        ? 'Use tasks to surface open/overdue work relevant to this meeting.'
        : 'No open tasks were found.',
      hasEmailThreads
        ? 'Use recentThreads as evidence for talkingPoints/risks/followUps; quote or paraphrase only what is present.'
        : 'No recentThreads were provided. Do not invent email-derived points.',
      'Tone: professional federal lobbying operator, direct, practical, no fluff.',
      'Return JSON only with: agenda, talkingPoints, risks, followUps, summary, emailEvidence.',
      'Email thread highlights (for grounding):',
      emailHighlights,
      JSON.stringify(input, null, 2),
    ].join('\n\n');
  }

  private buildOutreachPrompt(input: OutreachDraftInput): string {
    // A group campaign is ONE shared email to many recipients, represented here
    // by a single stand-in recipient. The default campaign guidance tells the
    // model to greet that recipient by first name and tailor to their committee
    // — correct for individuals/list members, but wrong for a group (it would
    // address the whole group as one member). Swap in a collective-salutation
    // rule for groups; the individual/list branch is byte-identical to before so
    // their generated prompts are unchanged.
    const campaignGuidance =
      input.audienceKind === 'group'
        ? 'Draft ONE shared email addressed to a group of congressional recipients. ALWAYS open the email body with a brief, natural COLLECTIVE greeting (e.g. "Hi all —", "Hello everyone,", or a salutation appropriate to the group); never open with "Dear", and never single out one member by first name. Do NOT tailor the message to any single member\'s committee, district/state, agency role, or record — write a message appropriate for EVERY recipient listed in the supplied context. Do not output literal variable tokens such as {district}, {committee}, {personal_note}, {address}, or {member_priority}. Do not invent recipient-specific facts.'
        : 'Draft a campaign for congressional recipients. ALWAYS open the email body with a brief, natural greeting that addresses the recipient by their real first name from the recipient data / RECIPIENT PROFILE (e.g. "Hi Dana —" or "Dana,"); never open with "Dear", and if no recipient name is available use a short professional greeting such as "Hello,". This greeting rule applies to every template, including memo- and brief-style templates. Do not output literal variable tokens such as {district}, {committee}, {personal_note}, {address}, or {member_priority}. Use supplied recipient data only when it is present; otherwise write around the missing detail. Do not invent recipient-specific facts.';
    const workflowGuidance = {
      campaign: campaignGuidance,
      follow_up:
        'Draft a post-meeting follow-up email. Include a brief recap, action items, and next steps from the supplied debrief/prep/context.',
      prep: 'Draft a clean prep distribution summary suitable for a colleague or client before the meeting. Include logistics, context, talking points, and participants from the approved prep.',
      outbound_campaign:
        'Draft an outbound campaign email using the supplied recent meeting attendees, prep summaries, debrief summaries, and directory office locations. Use existingSubject/existingBody and context.metadata.outboundTemplate as the selected template structure when present. Keep the letterhead near the top with Date, Participant Names, and Location. Use context.metadata.outboundCurrentDateTime as the current generated date/time. If no usable template content is present, create the email from the recipient context fields instead. Apply context.metadata.outboundTone when present. Preserve useful variables such as {current_date_time}, {attendee_names}, {attendee_emails}, {prep_summary}, {debrief_summary}, {meeting_location}, {meeting_subject}, and {meeting_date_time} so the final send can personalize each recipient preview. Do not invent missing details.',
    }[input.workflow];

    const templateGuidance =
      input.promptTemplate && input.promptTemplate !== 'custom'
        ? PROMPT_TEMPLATE_GUIDANCE[input.promptTemplate]
        : null;

    // Explicit tone directive (W0 interim). The wizard's chosen tone rides in
    // context.tone but was only ever part of the JSON context dump, where the
    // model routinely ignored it. Surface it as a first-class instruction. The
    // full tone/length contract lands with PromptSpec v2 (W2).
    const tone =
      typeof input.context?.tone === 'string' && (input.context.tone as string).trim()
        ? (input.context.tone as string).trim()
        : null;
    const toneGuidance = tone ? `Write in a ${tone} register.` : null;

    // The v2 outreach wizard sends a curated `contextItems` block as part
    // of `input.context`. Each item carries the user's intent: shared items
    // form the spine of the message, personalized items must be reflected
    // for that specific recipient, and per-item `Instruction:` lines are
    // direct user directives (e.g. "lead with this", "omit the deadline
    // language"). We hoist the block out of the raw JSON dump so the model
    // sees it as a first-class section with explicit guidance, and we
    // remove it from the JSON to avoid duplication that dilutes attention.
    const direction = typeof input.context?.direction === 'string' ? input.context.direction : null;
    const contextItemsBlock =
      typeof input.context?.contextItems === 'string' &&
      (input.context.contextItems as string).trim().length > 0
        ? (input.context.contextItems as string).trim()
        : null;
    // Voice/style grounding (hoisted out of the JSON dump so the "use only
    // supplied context" rule doesn't suppress it — style is HOW to write, not a
    // fact to cite).
    const writingStyleBlock =
      typeof input.context?.userWritingStyle === 'string' &&
      (input.context.userWritingStyle as string).trim().length > 0
        ? (input.context.userWritingStyle as string).trim()
        : null;
    // Recipient profile (who you're writing to — directory-derived). Hoisted like
    // the voice block so it reads as a first-class section rather than a JSON
    // field. Callers that don't set context.recipientProfile are unaffected.
    const recipientProfileBlock =
      typeof input.context?.recipientProfile === 'string' &&
      (input.context.recipientProfile as string).trim().length > 0
        ? (input.context.recipientProfile as string).trim()
        : null;
    const hoistFromContext = Boolean(
      contextItemsBlock || writingStyleBlock || recipientProfileBlock,
    );
    const contextWithoutItems = hoistFromContext
      ? Object.fromEntries(
          Object.entries(input.context ?? {}).filter(
            ([k]) =>
              k !== 'contextItems' &&
              k !== 'direction' &&
              k !== 'userWritingStyle' &&
              k !== 'recipientProfile',
          ),
        )
      : (input.context ?? {});
    // Keep the internal audience-routing flag out of the JSON context dump — it's
    // already reflected in the salutation guidance above, and excluding it keeps
    // the individual/list prompt byte-identical whether the flag is omitted or
    // explicitly 'individual'.
    const { audienceKind: _audienceKind, ...inputWithoutRouting } = input;
    const inputForJson: OutreachDraftInput = hoistFromContext
      ? { ...inputWithoutRouting, context: contextWithoutItems }
      : inputWithoutRouting;

    const directionGuidance = direction
      ? direction === 'on-behalf'
        ? "Direction: on-behalf-of-client. The sender is the lobbyist's user, writing as the representative of `client`. The recipient is a congressional or federal-agency contact. Use the client's voice and the client's asks; reference the client by name where natural. Sign as the user, not the client."
        : "Direction: from-lobbyist-to-clients. The sender is the lobbyist writing directly to their own portfolio client(s). The tone is internal briefing, informative, candid, action-oriented. Do not write as if pitching the client; you ARE the client's trusted operator."
      : null;

    // Sign-off must use the real logged-in user's name, never an invented one.
    const senderName =
      typeof input.context?.senderName === 'string' && input.context.senderName.trim()
        ? input.context.senderName.trim()
        : null;
    const senderSignature =
      typeof input.context?.senderSignature === 'string' && input.context.senderSignature.trim()
        ? input.context.senderSignature.trim()
        : null;
    // Campaign drafts (the v2 Outreach wizard) MUST NOT carry a signature block:
    // the sender's saved signature is appended separately at send time via the
    // wizard's "Append my email signature" toggle (see sendBatchEmails). Baking a
    // signature into the draft here produced duplicate/stale sign-offs the user
    // had to delete by hand. Other workflows (follow-up, prep) open a mailto and
    // never get an auto-append, so they keep signing off as before.
    const signatureGuidance =
      input.workflow === 'campaign'
        ? 'Do NOT add a signature block, sender name, title, company, or contact details at the end of the email — the app inserts the sender\'s signature separately after generation. You may end with a short closing line such as "Best," or "Thank you," on its own line, but write nothing after it.'
        : senderName
          ? `Sign off the email as the sender, ${senderName}. Use exactly this signature block at the end and do not invent a different name, company, or title:\n${senderSignature ?? senderName}`
          : 'Do not fabricate a sender name in the sign-off. If no sender name is provided, end the email without a made-up signature (use a neutral close such as "Best regards,").';

    const contextItemsGuidance = contextItemsBlock
      ? [
          'CURATED CONTEXT, treat this as the source-of-truth for what to include and how. The list below is grouped into:',
          '  • "Shared context", must inform every recipient\'s draft. These are the campaign\'s spine.',
          '  • "Personalized context for this recipient", must be reflected explicitly in this draft only. If a per-item `Instruction:` line is present, follow it (e.g. "lead with this", "omit the deadline language", "soften the ask").',
          'When a personalized item conflicts with a shared item, the personalized item wins for that recipient. If an item is a `[note]` kind, treat its body and Instruction as a direct user directive to obey, not as fact to cite.',
          'CRITICAL for `[note]` items: incorporate the note using ONLY the information it literally contains. Do NOT invent, embellish, or infer any additional specifics — for example, if a note says "It was nice meeting you at dinner last week", you may reference the dinner warmly but must NOT fabricate what was discussed, who attended, decisions made, topics, or any detail not explicitly written. When in doubt, paraphrase the note rather than expanding it.',
          'Do not cite items the user did not curate, do not pull from the raw JSON dump if those facts are not in the curated block. Do not enumerate the items back to the recipient; weave them into a coherent message.',
          '',
          contextItemsBlock,
        ].join('\n')
      : null;

    return [
      workflowGuidance,
      directionGuidance,
      templateGuidance ? `Prompt template: ${input.promptTemplate}. ${templateGuidance}` : null,
      toneGuidance,
      'Use only the provided client, meeting, recipient, and engagement context. Do not invent facts.',
      'Never return unresolved template variables or bracket placeholders in subject or body. Use real provided values or omit the unsupported line/phrase.',
      recipientProfileBlock
        ? `RECIPIENT PROFILE (who you are writing to — use for the correct salutation/title and to tailor the ask to their committee assignments and issue portfolio; treat as facts, do not invent anything beyond it):\n${recipientProfileBlock}`
        : null,
      writingStyleBlock
        ? `AUTHOR VOICE & STRATEGY (style guidance — apply to HOW you write, not as facts to cite; never copy sample content verbatim or invent details from it):\n${writingStyleBlock}`
        : null,
      contextItemsGuidance,
      signatureGuidance,
      'Return JSON with subject, body, and contextNote. The body must be directly editable by the user.',
      JSON.stringify(inputForJson, null, 2),
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n\n');
  }

  private buildDebriefPrompt(input: MeetingDebriefDraftInput): string {
    const sourceText = (input.source?.text ?? '').trim();
    const hasSource = sourceText.length > 0;
    // Firm/author/client memory is standing BACKGROUND for framing + tone; hoist
    // it out of the JSON dump so the strict "only supplied context" rule can't
    // mine invented "facts" from it, and label it so the model never treats it
    // as something that happened in this meeting.
    const steeringBlock = (input.steeringContext ?? '').trim();
    const { steeringContext: _steering, ...inputForJson } = input;

    return [
      'Write a concise, lobbyist-ready post-meeting debrief for CRM records.',
      "STRICT GROUNDING RULES (highest priority): the debrief MUST be built ONLY from the supplied source text (the user's meeting notes), visibleNotes, and the provided meeting/client/attendee/prep/directory context below. Do NOT invent facts, attendees, commitments, dates, numbers, policy positions, or outcomes. No outside knowledge. If a detail is not in the source text or supplied context, do not state it.",
      hasSource
        ? 'The user supplied meeting notes in source.text — treat that as the primary source of truth and stay within it.'
        : 'INSUFFICIENT CONTEXT: source.text is empty and there are no usable notes. Do NOT fabricate a debrief. Set recap to a short honest statement that there are no meeting notes to summarize yet (e.g., "No meeting notes were provided, so there is nothing to debrief yet. Add notes above to generate a debrief."), and return EMPTY arrays/empty notes. Do not invent what happened.',
      '',
      'Output structure (JSON fields):',
      'recap: short structured narrative with only these headings:',
      '  - What happened: who attended (if known), core discussion, decisions/commitments explicitly supported by source text.',
      '  - What matters: implications for committee/member/staffer engagement, only when evidenced.',
      '  - Recommended next move: one practical next engagement step grounded in the meeting outcome.',
      '',
      'actionItems: array of concrete, ownable follow-ups. Format: "[Owner], [Action] by [Timing if known]". If owner/timing is not in source, leave it generic instead of guessing.',
      '',
      'notes: brief internal notes for next touch (tone, strategic signal, cautions) only if directly supported by source text.',
      '',
      'Style: direct, brief, and actionable. No fluff. No speculation.',
      steeringBlock
        ? `FIRM, AUTHOR & CLIENT BACKGROUND (standing memory for FRAMING and TONE only — NOT a record of this meeting; never state it as an attendee, commitment, or event that occurred here):\n${steeringBlock}`
        : '',
      'Return JSON only with recap, actionItems, and notes.',
      JSON.stringify(inputForJson, null, 2),
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildCampaignPrompt(input: CampaignEmailInput): string {
    const typeGuidance: Record<string, string> = {
      post_meeting_followup:
        'This is a post-meeting follow-up email. Reference the specific meeting that occurred, key discussion points, commitments made, and next steps. The tone should be warm, professional, and action-oriented. Reference the attendees by name and role where available.',
      congressional_outreach:
        "This is a congressional outreach email. It should be policy-focused, referencing the client's program, capabilities, or legislative ask. Tailor to the recipient's committee jurisdiction and known priorities.",
      program_update:
        'This is a program update email to keep congressional contacts informed of client progress. Highlight recent milestones, upcoming activities, and any asks for continued support.',
      custom:
        'Draft a professional government affairs email using the supplied context. Match the tone and substance to the campaign objective.',
    };

    const guidance = typeGuidance[input.campaignType] ?? typeGuidance.custom;

    return [
      `Campaign type: ${input.campaignType}. ${guidance}`,
      'Use only the provided client, meeting, debrief, prep, and recipient context. Do not invent facts, commitments, or positions.',
      'The email should read as if written by a senior government affairs professional, not generic.',
      'Reference specific discussion points, action items, and next steps from the supplied meeting/debrief context when available.',
      'Do not use template variables or bracket placeholders (e.g. {recipient_name}, {recipient_title}, {meeting_date}, {action_items}); write the real values from the supplied context, or omit the detail when it is not available. Never leave an unresolved placeholder in the subject or body.',
      'Return JSON with subject and body.',
      input.customContext ? `Additional campaign context from user: ${input.customContext}` : '',
      JSON.stringify(input, null, 2),
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}

function extractOpenAiText(json: Record<string, unknown>): string {
  if (typeof json.output_text === 'string') return json.output_text;
  const output = Array.isArray(json.output) ? json.output : [];
  for (const item of output) {
    const content = toRecord(item).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = toRecord(part).text;
      if (typeof text === 'string') return text;
    }
  }
  return '';
}

function extractAnthropicText(json: Record<string, unknown>): string {
  const content = Array.isArray(json.content) ? json.content : [];
  return content
    .map((part) => {
      const record = toRecord(part);
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .join('\n')
    .trim();
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new ServiceUnavailableException('AI provider returned an empty response');
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new ServiceUnavailableException('AI provider returned non-JSON output');
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

function readProviderError(json: Record<string, unknown>, status: number): string {
  const error = toRecord(json.error);
  if (typeof error.message === 'string') return error.message;
  if (typeof json.message === 'string') return json.message;
  return `HTTP ${status}`;
}

/**
 * Compact USD formatter for prompt context. Adapts the unit to the magnitude so
 * sub-billion figures never collapse to a misleading "$0B" (the pre-W0 bug:
 * `Math.round(amount / 1e9)` rendered every contract under $500M as "$0B").
 */
export function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value)) return '$0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
  if (magnitude >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (magnitude >= 1e6) return `$${Math.round(value / 1e6).toLocaleString()}M`;
  if (magnitude >= 1e3) return `$${Math.round(value / 1e3).toLocaleString()}K`;
  return `$${Math.round(value).toLocaleString()}`;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
    .filter(Boolean);
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatMeetingPrepEmailHighlights(threads: Array<Record<string, unknown>>): string {
  if (!threads.length) return '- None';

  const lines: string[] = [];
  for (const thread of threads.slice(0, 8)) {
    const threadRecord = toRecord(thread);
    const threadId = typeof threadRecord.id === 'string' ? threadRecord.id : 'unknown-thread';
    const threadSubject =
      typeof threadRecord.subject === 'string' ? threadRecord.subject.trim() : '';
    const messages = Array.isArray(threadRecord.messages) ? threadRecord.messages : [];
    const lastMessageAt =
      typeof threadRecord.lastMessageAt === 'string' ? threadRecord.lastMessageAt : '';
    const headline = `- Thread ${threadId}${threadSubject ? `: ${threadSubject}` : ''}${lastMessageAt ? ` (${lastMessageAt})` : ''}`;
    lines.push(headline);

    if (!messages.length) {
      const snippet =
        typeof threadRecord.snippet === 'string' ? compactText(threadRecord.snippet) : '';
      if (snippet) lines.push(`  - Snippet: "${snippet}"`);
      continue;
    }

    for (const message of messages.slice(0, 3)) {
      const messageRecord = toRecord(message);
      const sender =
        typeof messageRecord.fromName === 'string' && messageRecord.fromName.trim()
          ? messageRecord.fromName.trim()
          : typeof messageRecord.fromEmail === 'string' && messageRecord.fromEmail.trim()
            ? messageRecord.fromEmail.trim()
            : 'unknown sender';
      const sentAt = typeof messageRecord.sentAt === 'string' ? messageRecord.sentAt : '';
      const quote =
        typeof messageRecord.bodyText === 'string'
          ? compactText(messageRecord.bodyText)
          : typeof messageRecord.subject === 'string'
            ? compactText(messageRecord.subject)
            : '';
      lines.push(`  - ${sender}${sentAt ? ` @ ${sentAt}` : ''}${quote ? `: "${quote}"` : ''}`);
    }
  }

  return lines.join('\n');
}

function compactText(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trim()}...`;
}
