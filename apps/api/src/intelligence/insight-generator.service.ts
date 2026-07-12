import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  SUBMISSION_TRACK_LABELS,
  currentCycleFyOf,
  renderPeFundingForModel,
  type ModelFundingYear,
  type SubmissionTrack,
} from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LobbyIntelService } from '../lobby-intel/lobby-intel.service.js';
import { FederalSpendingService } from '../federal-spending/federal-spending.service.js';
import { addDateInZone, dateBoundsInZone, dayBoundsInZone } from './time-bounds.js';

const AI_TIMEOUT_MS = 90_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ServiceUnavailableException(`AI request timed out after ${AI_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
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
  if (!trimmed) throw new ServiceUnavailableException('AI returned empty response');
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new ServiceUnavailableException('AI returned non-JSON output');
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const SYSTEM_PROMPT = `You are a senior federal government affairs analyst at a top-tier lobbying firm. Generate actionable intelligence insights from the provided data. Each insight must:
1. State a specific, verifiable finding (not a generic observation)
2. Explain WHY it matters to a government affairs professional
3. Suggest a concrete next step (meeting, filing, outreach, monitoring)
4. Reference the specific data that supports the finding

Do not invent facts. Do not speculate beyond what the data supports. If there is nothing notable, return an empty insights array.`;

const INSIGHTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['insights'],
  properties: {
    insights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'title', 'body', 'severity', 'suggestedAction', 'dataPoints'],
        properties: {
          category: {
            type: 'string',
            enum: [
              'market_shift',
              'competitive_move',
              'regulatory_alert',
              'legislative_signal',
              'client_opportunity',
              'risk_flag',
            ],
          },
          title: { type: 'string' },
          body: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'notable', 'critical'] },
          suggestedAction: { type: 'string' },
          dataPoints: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['source', 'metric', 'value'],
              properties: {
                source: { type: 'string' },
                metric: { type: 'string' },
                value: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

const DAILY_BRIEFING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['heroSummary', 'whatsNew', 'whatsComing', 'suggestedActions', 'programElementStatus'],
  properties: {
    heroSummary: { type: 'string' },
    whatsNew: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'source', 'detail', 'citation'],
        properties: {
          title: { type: 'string' },
          source: { type: 'string' },
          detail: { type: 'string' },
          citation: { type: 'string' },
        },
      },
    },
    whatsComing: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'date', 'type', 'action'],
        properties: {
          title: { type: 'string' },
          date: { type: 'string' },
          type: { type: 'string' },
          action: { type: 'string' },
        },
      },
    },
    suggestedActions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'rationale', 'urgency'],
        properties: {
          action: { type: 'string' },
          rationale: { type: 'string' },
          urgency: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    programElementStatus: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['peCode', 'title', 'severity', 'narrative'],
        properties: {
          peCode: { type: 'string' },
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'notable', 'info'] },
          narrative: { type: 'string' },
        },
      },
    },
  },
};

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 3,
  notable: 2,
  info: 1,
};

interface PeNarrativeContext {
  peCode: string;
  title: string;
  service: string | null;
  fy: number | null;
  request: string | null;
  hascMark: string | null;
  sascMark: string | null;
  hacDMark: string | null;
  sacDMark: string | null;
  conferenceProbability: string | null;
  /**
   * RC1: the fully-labeled authoritative funding block (FY + stage +
   * authorization/appropriations vehicle + signed vs-request + NDAA conference),
   * rendered from the shared serializer so the briefing prompt never carries a
   * unit-less, vehicle-less, direction-less dollar figure.
   */
  fundingBlock: string;
  changes: Array<{
    id: string;
    severity: string;
    source: string;
    changeType: string;
    title: string;
    detectedAt: string;
    citation: string;
  }>;
  billsInMarkup: Array<{
    billId: string;
    title: string;
    latestActionText: string | null;
    latestActionDate: string | null;
    citation: string;
  }>;
  suggestedActions: string[];
  topSeverity: 'critical' | 'notable' | 'info';
}

function formatDecimalValue(value: Prisma.Decimal | number | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value.toFixed(2) : null;
  return value.toFixed(2);
}

function normalizePeCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function collectPeCodesFromIntakeData(intakeData: unknown): string[] {
  if (!intakeData || typeof intakeData !== 'object' || Array.isArray(intakeData)) return [];
  const asRecord = intakeData as Record<string, unknown>;
  const raw = asRecord.peNumber;
  if (typeof raw === 'string') {
    const single = normalizePeCode(raw);
    return single ? [single] : [];
  }
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => normalizePeCode(entry))
      .filter((entry): entry is string => Boolean(entry));
  }
  return [];
}

function isDefenseProfile(client: {
  profileType: string | null;
  sectorTag: string | null;
}): boolean {
  const profileType = (client.profileType ?? '').toLowerCase();
  const sectorTag = (client.sectorTag ?? '').toLowerCase();
  return profileType.includes('defense') || sectorTag.includes('defense');
}

function toPeTopSeverity(changes: Array<{ severity: string }>): 'critical' | 'notable' | 'info' {
  let best: 'critical' | 'notable' | 'info' = 'info';
  for (const change of changes) {
    if (change.severity === 'critical') return 'critical';
    if (change.severity === 'notable') best = 'notable';
  }
  return best;
}

function sortBySeverityDesc<T extends { topSeverity: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => (SEVERITY_WEIGHT[b.topSeverity] ?? 0) - (SEVERITY_WEIGHT[a.topSeverity] ?? 0),
  );
}

function toSafeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function isCheapModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const normalized = model.toLowerCase();
  return normalized.includes('gpt-4o-mini') || normalized.includes('haiku');
}

function toCheapModel(currentModel: string, provider: 'openai' | 'anthropic'): string {
  if (isCheapModel(currentModel)) return currentModel;
  return provider === 'openai' ? 'gpt-4o-mini' : 'claude-3-5-haiku-20241022';
}

function toIsoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function pickStructuredPeStatus(
  parsed: Record<string, unknown>,
  peContextsByCode: Map<string, PeNarrativeContext>,
): Array<{
  peCode: string;
  title: string;
  severity: 'critical' | 'notable' | 'info';
  narrative: string;
}> {
  const rows = Array.isArray(parsed.programElementStatus) ? parsed.programElementStatus : [];
  const out: Array<{
    peCode: string;
    title: string;
    severity: 'critical' | 'notable' | 'info';
    narrative: string;
  }> = [];

  for (const item of rows) {
    const record = toRecord(item);
    const peCode = normalizePeCode(record.peCode);
    let narrative = typeof record.narrative === 'string' ? record.narrative.trim() : '';
    if (!peCode || !narrative) continue;
    const ctx = peContextsByCode.get(peCode);
    if (!ctx) continue;

    const severity =
      record.severity === 'critical' || record.severity === 'notable' || record.severity === 'info'
        ? (record.severity as 'critical' | 'notable' | 'info')
        : ctx.topSeverity;

    if (!/\[[^\]]+\]/.test(narrative)) {
      const fallbackCitation = ctx.changes[0]?.citation ?? `[${peCode}]`;
      narrative = `${narrative} ${fallbackCitation}`.trim();
    }

    out.push({
      peCode,
      title: ctx.title,
      severity,
      narrative,
    });
  }

  return out.sort(
    (a, b) => (SEVERITY_WEIGHT[b.severity] ?? 0) - (SEVERITY_WEIGHT[a.severity] ?? 0),
  );
}

function getStringFromData(data: Prisma.JsonValue, keys: string[]): string | null {
  const record = toRecord(data);
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function buildPeCitation(peCode: string, data: Prisma.JsonValue): string {
  const markers = [`[${peCode}]`];
  const billId = getStringFromData(data, ['billId', 'bill_id']);
  const docketId = getStringFromData(data, ['docketId', 'docket_id']);
  if (billId) markers.push(`[${billId}]`);
  if (docketId) markers.push(`[${docketId}]`);
  return markers.join(' ');
}

function sanitizePeChangeSeverity(value: string): 'critical' | 'notable' | 'info' {
  if (value === 'critical' || value === 'notable' || value === 'info') return value;
  return 'info';
}

function buildPeSuggestedActions(context: {
  title: string;
  topSeverity: 'critical' | 'notable' | 'info';
  billsInMarkupCount: number;
}): string[] {
  const actions: string[] = [];
  if (context.topSeverity === 'critical') {
    actions.push(`Escalate ${context.title} funding delta with same-day principal outreach.`);
  } else if (context.topSeverity === 'notable') {
    actions.push(
      `Prepare a 48-hour engagement brief for ${context.title} focused on current committee signals.`,
    );
  } else {
    actions.push(
      `Track ${context.title} change signals daily and refresh talking points before next touchpoint.`,
    );
  }

  if (context.billsInMarkupCount > 0) {
    actions.push(
      'Prioritize markup-cycle offices tied to active bills and align asks to current bill text.',
    );
  }

  return actions;
}

@Injectable()
export class InsightGeneratorService {
  private readonly logger = new Logger(InsightGeneratorService.name);
  private readonly openaiKey?: string;
  private readonly anthropicKey?: string;
  private readonly preferredProvider?: 'openai' | 'anthropic';
  private readonly openaiModel: string;
  private readonly anthropicModel: string;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly lobbyIntel: LobbyIntelService,
    private readonly federalSpending: FederalSpendingService,
  ) {
    this.openaiKey = config.get('OPENAI_API_KEY', { infer: true });
    this.anthropicKey = config.get('ANTHROPIC_API_KEY', { infer: true });
    this.preferredProvider = config.get('AI_PROVIDER', { infer: true });
    this.openaiModel = config.get('OPENAI_MODEL', { infer: true });
    this.anthropicModel = config.get('ANTHROPIC_MODEL', { infer: true });
  }

  /** Generate market-wide intelligence insights from lobby intel + spending data */
  async generateMarketInsights() {
    const [lobbyCtx, spendCtx] = await Promise.all([
      this.lobbyIntel.getAiContext().catch(() => null),
      this.federalSpending.getAiContext(null).catch(() => null),
    ]);

    const contextParts: string[] = [];
    if (lobbyCtx) {
      const surge = lobbyCtx.surgingIssues
        .slice(0, 10)
        .map(
          (s) =>
            `${s.code} (${s.name}): ${s.surgePct != null ? `+${Math.round(s.surgePct)}% QoQ` : 'surging'}`,
        )
        .join('\n');
      const trending = lobbyCtx.trendingTopics
        .slice(0, 15)
        .map((t) => t.word)
        .join(', ');
      if (surge)
        contextParts.push(
          `SURGING LDA ISSUES (latest quarter: ${lobbyCtx.latestQuarter ?? 'unknown'}):\n${surge}`,
        );
      if (trending) contextParts.push(`TRENDING TERMS IN FILINGS: ${trending}`);
    }
    if (spendCtx?.topAgencyTotals?.length) {
      const agencies = spendCtx.topAgencyTotals
        .slice(0, 8)
        .map(
          (a) =>
            `${a.name}: ${a.budget ? `$${(a.budget / 1e12).toFixed(1)}T budget` : 'budget unknown'}`,
        )
        .join('\n');
      contextParts.push(`TOP FEDERAL AGENCIES BY BUDGET:\n${agencies}`);
    }

    if (!contextParts.length) {
      return { insights: [], message: 'No intelligence data available for analysis' };
    }

    const prompt = `Analyze the following federal lobbying and government spending data. Generate 3-5 actionable intelligence insights for government affairs professionals.\n\n${contextParts.join('\n\n')}`;

    const result = await this.callAi(prompt, INSIGHTS_SCHEMA);
    const parsed = parseJsonObject(result.text);
    const insights = Array.isArray(parsed.insights) ? parsed.insights : [];

    // Save to DB
    const saved = [];
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    for (const ins of insights.slice(0, 10)) {
      const record = toRecord(ins);
      const row = await this.prisma.intelligenceInsight.create({
        data: {
          category: typeof record.category === 'string' ? record.category : 'market_shift',
          title: typeof record.title === 'string' ? record.title : 'Untitled',
          body: typeof record.body === 'string' ? record.body : '',
          severity: typeof record.severity === 'string' ? record.severity : 'info',
          dataPoints: record.dataPoints
            ? (record.dataPoints as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          expiresAt,
        },
      });
      saved.push(row);
    }

    return { insights: saved, provider: result.provider, model: result.model };
  }

  /** Generate a structured daily intelligence briefing for a specific CRM client */
  async generateClientBriefing(clientId: string, tenantId: string) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId },
        include: { capabilities: true },
      }),
    );
    if (!client) throw new NotFoundException('Client not found');

    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const fourteenDaysOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const clientPeCodes = new Set<string>();
    for (const code of collectPeCodesFromIntakeData(client.intakeData)) {
      clientPeCodes.add(code);
    }
    for (const capability of client.capabilities ?? []) {
      const code = normalizePeCode(capability.peNumber);
      if (code) clientPeCodes.add(code);
    }

    // Resolve LDA issue codes via confirmed mapping
    const ldaMapping = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findFirst({
        where: { clientId, source: 'lda', confirmed: true },
      }),
    );
    let issueCodes: string[] = [];
    if (ldaMapping) {
      const codeRows = await this.prisma.$queryRaw<Array<{ issue_codes: string[] }>>`
        SELECT COALESCE(issue_codes, '{}') AS issue_codes
        FROM lda_client WHERE id = ${Number(ldaMapping.externalId)}
      `;
      issueCodes = codeRows[0]?.issue_codes ?? [];
    }

    // Build OR conditions avoiding conditional spreads inside Prisma calls.
    // Comment-period emitters populate `relatedIssues` via SECTOR_TO_LDA_CODES, so
    // sector-mapped events now reach this OR branch even without explicit client linkage.
    const changeOrConditions: Record<string, unknown>[] = [{ relatedClientIds: { has: clientId } }];
    if (issueCodes.length) changeOrConditions.push({ relatedIssues: { hasSome: issueCodes } });
    const changeWhere: Record<string, unknown> = {
      detectedAt: { gte: yesterday },
      OR: changeOrConditions,
    };

    // Gather all context in parallel
    const peCodes = Array.from(clientPeCodes);
    const [
      lobbyCtx,
      spendCtx,
      ldaMatch,
      recentChanges,
      upcomingHearings,
      commentDeadlines,
      peDetails,
      peRecentChanges,
      peMarkupBills,
    ] = await Promise.all([
      this.lobbyIntel.getAiContext().catch(() => null),
      this.federalSpending.getAiContext(client.name).catch(() => null),
      this.prisma.$queryRaw<
        Array<{
          name: string;
          total_filings: number;
          total_spending: number | null;
          issue_codes: string[];
          similarity: number;
        }>
      >`
        SELECT name, total_filings, total_spending, COALESCE(issue_codes, '{}') as issue_codes,
               similarity(name, ${client.name}) as similarity
        FROM lda_client WHERE similarity(name, ${client.name}) > 0.3
        ORDER BY similarity DESC LIMIT 1
      `.catch(() => []),
      this.prisma.intelligenceChange.findMany({
        where: changeWhere,
        orderBy: { detectedAt: 'desc' },
        take: 20,
      }),
      this.prisma.committeeHearing.findMany({
        where: { date: { gte: now, lte: fourteenDaysOut } },
        orderBy: { date: 'asc' },
        take: 10,
      }),
      this.prisma.federalRegisterDocument.findMany({
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          commentEndDate: { gt: now, lte: fourteenDaysOut },
        },
        orderBy: { commentEndDate: 'asc' },
        take: 10,
        select: { title: true, type: true, commentEndDate: true, agencyNames: true, topics: true },
      }),
      peCodes.length
        ? this.prisma.programElement.findMany({
            where: { peCode: { in: peCodes } },
            select: {
              peCode: true,
              title: true,
              service: true,
              years: {
                orderBy: { fy: 'desc' },
                take: 1,
                select: {
                  fy: true,
                  request: true,
                  hascMark: true,
                  sascMark: true,
                  hacDMark: true,
                  sacDMark: true,
                  conference: true,
                  ndaaConference: true,
                  enacted: true,
                },
              },
              conferenceProbabilities: {
                orderBy: { fy: 'desc' },
                take: 1,
                select: {
                  fy: true,
                  predicted: true,
                },
              },
            },
          })
        : Promise.resolve([]),
      peCodes.length
        ? this.prisma.intelligenceChange.findMany({
            where: {
              detectedAt: { gte: yesterday },
              relatedPeCodes: { hasSome: peCodes },
            },
            orderBy: [{ severity: 'desc' }, { detectedAt: 'desc' }],
            take: 100,
          })
        : Promise.resolve([]),
      peCodes.length
        ? this.prisma.congressBill.findMany({
            where: {
              peCodes: { hasSome: peCodes },
              latestActionText: {
                contains: 'markup',
                mode: 'insensitive',
              },
            },
            orderBy: { latestActionDate: 'desc' },
            take: 50,
            select: {
              id: true,
              title: true,
              latestActionText: true,
              latestActionDate: true,
              peCodes: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const contextParts: string[] = [];
    contextParts.push(`CLIENT: ${client.name}`);
    if (client.description) contextParts.push(`DESCRIPTION: ${client.description}`);

    const capabilities = (client.capabilities ?? []).map((c) => c.name).filter(Boolean);
    if (capabilities.length) contextParts.push(`CAPABILITIES: ${capabilities.join(', ')}`);

    const tracks = (client.submissionTracks ?? []) as SubmissionTrack[];
    if (tracks.length) {
      const trackLabels = tracks.map((t) => SUBMISSION_TRACK_LABELS[t] ?? t).join(', ');
      contextParts.push(
        `SUBMISSION TRACKS: ${trackLabels} (weight upcoming events on these legislative vehicles)`,
      );
    }

    if (ldaMatch.length) {
      const m = ldaMatch[0]!;
      contextParts.push(`LDA MATCH: ${m.name} (${Math.round(m.similarity * 100)}% confidence)`);
      contextParts.push(
        `  Total filings: ${m.total_filings}, Spending: ${m.total_spending ? `$${(m.total_spending / 1e6).toFixed(1)}M` : 'unknown'}`,
      );
      if (m.issue_codes.length)
        contextParts.push(`  Active issue areas: ${m.issue_codes.join(', ')}`);
    }

    if (spendCtx?.matchedContractor) {
      const mc = spendCtx.matchedContractor;
      contextParts.push(
        `CONTRACTOR: ${mc.name}, Contracts: ${mc.totalContracts ? `$${(mc.totalContracts / 1e9).toFixed(1)}B` : 'unknown'}, Rank: #${mc.rankByContracts ?? 'unknown'}`,
      );
      if (mc.topAgencies?.length) {
        contextParts.push(
          `  Top agencies: ${mc.topAgencies
            .slice(0, 5)
            .map((a: { name: string }) => a.name)
            .join(', ')}`,
        );
      }
    }

    if (lobbyCtx?.surgingIssues.length) {
      const surges = lobbyCtx.surgingIssues
        .slice(0, 5)
        .map((s) => `${s.code} (${s.name}): +${Math.round(s.surgePct ?? 0)}%`)
        .join('; ');
      contextParts.push(`MARKET SURGES: ${surges}`);
    }

    // Section: What's New (24h)
    if (recentChanges.length) {
      const changeList = recentChanges
        .map((c) => `[${c.source}/${c.changeType}] ${c.title}: ${c.description}`)
        .join('\n  ');
      contextParts.push(`WHAT'S NEW (last 24h):\n  ${changeList}`);
    } else {
      contextParts.push(`WHAT'S NEW (last 24h): No significant changes detected`);
    }

    // Section: What's Coming (14 days)
    if (upcomingHearings.length) {
      const hearingList = upcomingHearings
        .map((h) => {
          const daysOut = Math.ceil(
            (new Date(h.date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
          );
          return `${h.committeeName}, "${h.title.slice(0, 80)}" (in ${daysOut}d, ${h.chamber})`;
        })
        .join('\n  ');
      contextParts.push(`UPCOMING HEARINGS (14d):\n  ${hearingList}`);
    }

    if (commentDeadlines.length) {
      const deadlineList = commentDeadlines
        .map((r) => {
          const daysLeft = Math.ceil(
            (r.commentEndDate!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
          );
          return `"${r.title.slice(0, 70)}" (${r.type}, ${daysLeft}d left, ${(r.agencyNames as string[]).join('/')})`;
        })
        .join('\n  ');
      contextParts.push(`COMMENT DEADLINES (14d):\n  ${deadlineList}`);
    }

    const peContextByCode = new Map<string, PeNarrativeContext>();

    if (
      isDefenseProfile({ profileType: client.profileType, sectorTag: client.sectorTag }) &&
      peCodes.length
    ) {
      const peChangeByCode = new Map<string, Array<(typeof peRecentChanges)[number]>>();
      for (const change of peRecentChanges) {
        for (const code of change.relatedPeCodes) {
          if (!clientPeCodes.has(code)) continue;
          const existing = peChangeByCode.get(code);
          if (existing) {
            existing.push(change);
          } else {
            peChangeByCode.set(code, [change]);
          }
        }
      }

      const billByCode = new Map<string, Array<(typeof peMarkupBills)[number]>>();
      for (const bill of peMarkupBills) {
        for (const code of bill.peCodes) {
          if (!clientPeCodes.has(code)) continue;
          const existing = billByCode.get(code);
          if (existing) {
            existing.push(bill);
          } else {
            billByCode.set(code, [bill]);
          }
        }
      }

      for (const pe of peDetails) {
        const peChanges = (peChangeByCode.get(pe.peCode) ?? []).map((change) => ({
          id: change.id,
          severity: sanitizePeChangeSeverity(change.severity),
          source: change.source,
          changeType: change.changeType,
          title: change.title,
          detectedAt: change.detectedAt.toISOString(),
          citation: buildPeCitation(pe.peCode, change.data),
        }));
        if (!peChanges.length) continue;

        const topSeverity = toPeTopSeverity(peChanges);
        const bills = (billByCode.get(pe.peCode) ?? []).slice(0, 5).map((bill) => ({
          billId: bill.id,
          title: bill.title,
          latestActionText: bill.latestActionText,
          latestActionDate: toIsoOrNull(bill.latestActionDate),
          citation: `[${bill.id}]`,
        }));

        const latestYear = pe.years[0] ?? null;
        const latestProbability = pe.conferenceProbabilities[0] ?? null;
        const decOrNull = (v: Prisma.Decimal | null | undefined): number | null =>
          v == null ? null : Number(v);
        const fundingYears: ModelFundingYear[] = latestYear
          ? [
              {
                fy: latestYear.fy,
                request: decOrNull(latestYear.request),
                hascMark: decOrNull(latestYear.hascMark),
                sascMark: decOrNull(latestYear.sascMark),
                hacDMark: decOrNull(latestYear.hacDMark),
                sacDMark: decOrNull(latestYear.sacDMark),
                conference: decOrNull(latestYear.conference),
                ndaaConference: decOrNull(latestYear.ndaaConference),
                enacted: decOrNull(latestYear.enacted),
              },
            ]
          : [];
        peContextByCode.set(pe.peCode, {
          peCode: pe.peCode,
          title: pe.title,
          service: pe.service ?? null,
          fy: latestYear?.fy ?? latestProbability?.fy ?? null,
          request: formatDecimalValue(latestYear?.request),
          hascMark: formatDecimalValue(latestYear?.hascMark),
          sascMark: formatDecimalValue(latestYear?.sascMark),
          hacDMark: formatDecimalValue(latestYear?.hacDMark),
          sacDMark: formatDecimalValue(latestYear?.sacDMark),
          conferenceProbability: formatDecimalValue(latestProbability?.predicted),
          fundingBlock: renderPeFundingForModel({
            peCode: pe.peCode,
            title: pe.title,
            service: pe.service ?? null,
            currentCycleFy: currentCycleFyOf(fundingYears),
            years: fundingYears,
          }),
          changes: peChanges,
          billsInMarkup: bills,
          suggestedActions: buildPeSuggestedActions({
            title: pe.title,
            topSeverity,
            billsInMarkupCount: bills.length,
          }),
          topSeverity,
        });
      }

      const peContexts = sortBySeverityDesc(Array.from(peContextByCode.values()));
      if (peContexts.length) {
        const peBlocks = peContexts.map((pe) => {
          const changeLines = pe.changes
            .slice(0, 8)
            .map(
              (change) =>
                `- [${change.severity.toUpperCase()}] ${change.source}/${change.changeType}: ${change.title} ${change.citation}`,
            )
            .join('\n');
          const billLines = pe.billsInMarkup.length
            ? pe.billsInMarkup
                .map(
                  (bill) =>
                    `- ${bill.billId}: ${bill.title} (${bill.latestActionText ?? 'markup activity'}) ${bill.citation}`,
                )
                .join('\n')
            : '- none';
          const actionLines = pe.suggestedActions.map((action) => `- ${action}`).join('\n');
          return `PE ${pe.peCode}, ${pe.title}\nservice=${pe.service ?? 'unknown'} fy=${pe.fy ?? 'unknown'} conference_probability=${pe.conferenceProbability ?? 'n/a'}\n${pe.fundingBlock}\n24H_CHANGES:\n${changeLines}\nBILLS_IN_MARKUP:\n${billLines}\nSUGGESTED_ACTIONS:\n${actionLines}`;
        });
        contextParts.push(
          `PROGRAM ELEMENT STATUS (include only these PEs):\n${peBlocks.join('\n\n')}`,
        );
      }
    }

    const prompt = `You are a senior federal government affairs analyst. Generate a structured daily intelligence briefing for the client below.

${contextParts.join('\n')}

Structure your response as:
- heroSummary: 2-3 sentence executive summary of the most critical developments
- whatsNew: Items from WHAT'S NEW section above (leave empty array if no changes)
- whatsComing: Upcoming hearings and comment deadlines from the UPCOMING sections above
- suggestedActions: 2-4 concrete recommended actions with urgency ratings (high/medium/low)
- programElementStatus: Array of PE narrative objects only for PEs that have 24h changes in PROGRAM ELEMENT STATUS block. For each PE provide:
  - peCode
  - title
  - severity (critical/notable/info)
  - narrative: Generate a 2-3 sentence state-of-the-PE narrative grounded in the data above. Cite sources inline using [pe_code] [bill_id] [docket_id] markers. Do not invent facts.
If PROGRAM ELEMENT STATUS block is absent, return programElementStatus as [] only.`;

    const preferredProvider = this.resolveProvider();
    const peContexts = sortBySeverityDesc(Array.from(peContextByCode.values()));
    const aiProvider: 'openai' | 'anthropic' =
      preferredProvider === 'anthropic' ? 'anthropic' : 'openai';
    const aiModel = toCheapModel(
      aiProvider === 'openai' ? this.openaiModel : this.anthropicModel,
      aiProvider,
    );

    const result = await this.callAi(
      prompt,
      DAILY_BRIEFING_SCHEMA,
      'daily_briefing',
      aiProvider,
      aiModel,
    );
    const parsed = parseJsonObject(result.text);

    const programElementStatus = peContexts.length
      ? pickStructuredPeStatus(parsed, peContextByCode)
      : [];

    const base = {
      heroSummary: typeof parsed.heroSummary === 'string' ? parsed.heroSummary : '',
      whatsNew: Array.isArray(parsed.whatsNew) ? parsed.whatsNew : [],
      whatsComing: Array.isArray(parsed.whatsComing) ? parsed.whatsComing : [],
      suggestedActions: Array.isArray(parsed.suggestedActions) ? parsed.suggestedActions : [],
      generatedAt: new Date().toISOString(),
      provider: result.provider,
      model: result.model,
    };

    if (!programElementStatus.length) return base;

    return {
      ...base,
      heroSummary: `${base.heroSummary}\n\nProgram Element status:\n${programElementStatus
        .map((item) => `${item.peCode} (${item.severity}), ${item.narrative}`)
        .join('\n')}`.trim(),
      dataPoints: {
        programElementStatus,
      },
    };
  }

  /**
   * Tenant-wide Meri Brief for the home dashboard. Pulls upcoming hearings/
   * markups (next 7 days), the firm's own meetings scheduled for today, and
   * recent high-severity intel changes touching this tenant's clients, then
   * asks the LLM for a 3-4 sentence narrative pointing to today's
   * highest-leverage moves. Comment-period deadlines deliberately live in the
   * dashboard's Needs Attention surface, not here.
   */
  async generateDailyBrief(tenantId: string, userId?: string) {
    const now = new Date();
    // committee_hearing.date is a `@db.Date` column — Prisma returns it at UTC
    // midnight regardless of intended timezone, so it must be filtered with
    // UTC-midnight bounds (dateBoundsInZone), not ET-instant bounds, or
    // boundary-day rows get excluded.
    const { start: startOfDay } = dateBoundsInZone(now, 'America/New_York');
    const sevenDaysOut = addDateInZone(now, 7, 'America/New_York');
    // meeting.startsAt is `@db.Timestamptz` — use true ET-instant day bounds so
    // evening meetings (after 19:00 ET / 00:00 UTC) aren't dropped.
    const { start: todayStartEt, end: todayEndEt } = dayBoundsInZone(now, 'America/New_York');
    const last48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    const clients = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findMany({
        where: { status: { not: 'archived' } },
        select: { id: true, name: true, sectorTag: true, submissionTracks: true },
      }),
    );
    const tenantClientIds = new Set(clients.map((c) => c.id));
    const clientNameById = new Map(clients.map((c) => [c.id, c.name]));
    // Roll up submission tracks across the active portfolio with client counts
    // so the brief can lean on track-specific timing ("HASC markup is Thursday").
    const trackCounts = new Map<SubmissionTrack, number>();
    for (const c of clients) {
      for (const track of (c.submissionTracks ?? []) as SubmissionTrack[]) {
        trackCounts.set(track, (trackCounts.get(track) ?? 0) + 1);
      }
    }
    const tracksBlock = trackCounts.size
      ? [...trackCounts.entries()]
          .sort(([, a], [, b]) => b - a)
          .map(([t, n]) => `${SUBMISSION_TRACK_LABELS[t] ?? t} (${n})`)
          .join(', ')
      : '(none on file)';

    const [hearings, meetings, changes] = await Promise.all([
      this.prisma.committeeHearing.findMany({
        where: { date: { gte: startOfDay, lte: sevenDaysOut } },
        orderBy: { date: 'asc' },
        take: 12,
      }),
      // Today's meetings — scoped to the CURRENT USER (meetings they created or
      // that came from a calendar connection they own), NOT the whole firm. The
      // dashboard brief is a personal leverage brief; mirrors ownMeetingWhere()
      // used by the engagement meetings endpoint. Tenant-scoped via RLS as well.
      this.prisma.withTenant(tenantId, (tx) =>
        tx.meeting.findMany({
          where: {
            startsAt: { gte: todayStartEt, lte: todayEndEt },
            status: { not: 'cancelled' },
            ...(userId
              ? { OR: [{ createdByUserId: userId }, { connection: { createdByUserId: userId } }] }
              : {}),
          },
          orderBy: { startsAt: 'asc' },
          take: 12,
          select: {
            subject: true,
            startsAt: true,
            location: true,
            organizerName: true,
            clientId: true,
          },
        }),
      ),
      this.prisma.intelligenceChange.findMany({
        where: {
          detectedAt: { gte: last48h },
          severity: { in: ['critical', 'notable'] },
        },
        orderBy: { detectedAt: 'desc' },
        take: 20,
      }),
    ]);

    const tenantChanges = changes.filter(
      (c) =>
        c.relatedClientIds.length === 0 || c.relatedClientIds.some((id) => tenantClientIds.has(id)),
    );

    const todayLabel = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
    const tenantClientList = clients
      .slice(0, 30)
      .map((c) => c.name)
      .join(', ');

    const hearingsBlock =
      hearings
        .slice(0, 8)
        .map((h) => {
          const dayLabel =
            h.date.toDateString() === now.toDateString()
              ? 'TODAY'
              : h.date.toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                });
          return `- ${dayLabel} ${h.time ?? ''} ${h.chamber} ${h.committeeName}: ${h.title}`;
        })
        .join('\n') || '(none on schedule)';

    const meetingsBlock =
      meetings
        .slice(0, 8)
        .map((m) => {
          let timeLabel = '';
          try {
            timeLabel = m.startsAt.toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              timeZone: 'America/New_York',
            });
          } catch {
            timeLabel = '';
          }
          const clientHint =
            m.clientId && clientNameById.has(m.clientId)
              ? ` [client: ${clientNameById.get(m.clientId)}]`
              : '';
          const where = m.location ? ` @ ${m.location}` : '';
          const who = m.organizerName ? ` (${m.organizerName})` : '';
          return `- ${timeLabel} ${m.subject}${who}${where}${clientHint}`;
        })
        .join('\n') || '(no meetings on the calendar today)';

    const changesBlock =
      tenantChanges
        .slice(0, 10)
        .map((c) => {
          const tenantTouched = c.relatedClientIds.filter((id) => tenantClientIds.has(id));
          const clientHint = tenantTouched.length
            ? ` [touches: ${tenantTouched
                .map((id) => clientNameById.get(id) ?? id)
                .slice(0, 3)
                .join(', ')}]`
            : '';
          return `- [${c.severity.toUpperCase()}] ${c.source}: ${c.title}${clientHint}`;
        })
        .join('\n') || '(no high-severity changes detected in last 48h)';

    if (!hearings.length && !meetings.length && !tenantChanges.length) {
      return {
        brief: `${todayLabel}, quiet day. No hearings on the calendar, no client meetings booked, no high-severity changes in the last 48 hours. Use the window to advance long-running outreach.`,
        generatedAt: now.toISOString(),
        provider: null as string | null,
        model: null as string | null,
        empty: true as const,
      };
    }

    const prompt = `You are writing today's personal leverage brief for a federal lobbyist at a lobbying firm. Write 3-5 sentences in a punchy, voice-of-Capiro-Meri tone, concrete, specific, name names, and point to the single highest-leverage action for today. The meetings listed are THIS USER's own meetings, not the whole firm's — frame the day around what they personally have on. Do not list everything; pick the 1-2 things that actually matter. Reference active clients by name when the data supports it. Tie the user's meetings to the intel where it makes sense (e.g. a client whose program just moved is on their calendar). Avoid hedging.

TODAY: ${todayLabel}
ACTIVE CLIENTS: ${tenantClientList || '(no active clients)'}
ACTIVE SUBMISSION TRACKS: ${tracksBlock}

UPCOMING HEARINGS / MARKUPS (next 7 days):
${hearingsBlock}

YOUR MEETINGS TODAY:
${meetingsBlock}

HIGH-SEVERITY CHANGES (last 48h, tenant-relevant):
${changesBlock}

Write the brief now. Start with "Today's leverage is" or similar. Do not include headers, bullets, or markdown. Plain prose only.`;

    try {
      const text = await this.generateFreeText(prompt);
      return {
        brief: text.trim(),
        generatedAt: now.toISOString(),
        provider: this.resolveProvider(),
        model: this.preferredProvider === 'anthropic' ? this.anthropicModel : this.openaiModel,
        empty: false as const,
      };
    } catch (err) {
      this.logger.warn(`Daily brief generation failed: ${(err as Error).message}`);
      return {
        brief: `${todayLabel}, ${hearings.length} hearing(s), ${meetings.length} meeting(s) on the calendar, ${tenantChanges.length} high-severity change(s) in the last 48 hours. AI brief unavailable; review the timeline.`,
        generatedAt: now.toISOString(),
        provider: null as string | null,
        model: null as string | null,
        empty: true as const,
      };
    }
  }

  /** Generate insights from change events */
  async generateFromChanges(
    changes: Array<{ source: string; changeType: string; title: string; description: string }>,
  ) {
    if (!changes.length) return { insights: [], message: 'No changes to analyze' };

    const changeList = changes
      .slice(0, 20)
      .map((c) => `[${c.source}/${c.changeType}] ${c.title}: ${c.description}`)
      .join('\n');

    const prompt = `The following changes were detected in federal government data sources. Identify the 2-4 most actionable intelligence insights for government affairs professionals.\n\nCHANGES:\n${changeList}`;

    const result = await this.callAi(prompt, INSIGHTS_SCHEMA);
    const parsed = parseJsonObject(result.text);
    const insights = Array.isArray(parsed.insights) ? parsed.insights : [];

    const saved = [];
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days
    for (const ins of insights.slice(0, 5)) {
      const record = toRecord(ins);
      const row = await this.prisma.intelligenceInsight.create({
        data: {
          category: typeof record.category === 'string' ? record.category : 'market_shift',
          title: typeof record.title === 'string' ? record.title : 'Untitled',
          body: typeof record.body === 'string' ? record.body : '',
          severity: typeof record.severity === 'string' ? record.severity : 'info',
          dataPoints: record.dataPoints
            ? (record.dataPoints as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          expiresAt,
        },
      });
      saved.push(row);
    }

    return { insights: saved, provider: result.provider, model: result.model };
  }

  /** Fetch existing insights from the DB */
  async getInsights(category?: string, severity?: string, limit = 20) {
    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    if (severity) where.severity = severity;

    return this.prisma.intelligenceInsight.findMany({
      where: { ...where, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { generatedAt: 'desc' },
      take: Math.min(limit, 50),
    });
  }

  // ── Public free-text generation (no JSON schema) ──────────────────────

  async generateFreeText(prompt: string): Promise<string> {
    const result = await this.withProviderFallback('Free text generation', async (provider) => {
      if (provider === 'openai') {
        return this.callOpenAiFreeText(prompt);
      } else {
        return this.callAnthropicFreeText(prompt);
      }
    });
    return result.text;
  }

  private async callOpenAiFreeText(prompt: string) {
    if (!this.openaiKey) throw new ServiceUnavailableException('OPENAI_API_KEY not configured');
    const res = await fetchWithTimeout('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.openaiModel, instructions: SYSTEM_PROMPT, input: prompt }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok)
      throw new ServiceUnavailableException(`OpenAI failed: ${JSON.stringify(json).slice(0, 200)}`);
    return { text: extractOpenAiText(json), provider: 'openai' as const, model: this.openaiModel };
  }

  private async callAnthropicFreeText(prompt: string) {
    if (!this.anthropicKey)
      throw new ServiceUnavailableException('ANTHROPIC_API_KEY not configured');
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.anthropicModel,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok)
      throw new ServiceUnavailableException(
        `Anthropic failed: ${JSON.stringify(json).slice(0, 200)}`,
      );
    return {
      text: extractAnthropicText(json),
      provider: 'anthropic' as const,
      model: this.anthropicModel,
    };
  }

  // ── AI provider abstraction ────────────────────────────────────────────

  private async callAi(
    prompt: string,
    schema: Record<string, unknown>,
    schemaName = 'insights',
    forcedProvider?: 'openai' | 'anthropic',
    forcedModel?: string,
  ): Promise<{ text: string; provider: string; model: string }> {
    if (forcedProvider) {
      if (forcedProvider === 'openai') {
        return this.callOpenAi(prompt, schema, schemaName, forcedModel);
      }
      return this.callAnthropic(prompt, schema, forcedModel);
    }

    return this.withProviderFallback('Insight generation', async (provider) => {
      if (provider === 'openai') {
        return this.callOpenAi(prompt, schema, schemaName, forcedModel);
      } else {
        return this.callAnthropic(prompt, schema, forcedModel);
      }
    });
  }

  private async callOpenAi(
    prompt: string,
    schema: Record<string, unknown>,
    schemaName: string,
    modelOverride?: string,
  ) {
    if (!this.openaiKey) throw new ServiceUnavailableException('OPENAI_API_KEY not configured');
    const res = await fetchWithTimeout('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelOverride ?? this.openaiModel,
        instructions: SYSTEM_PROMPT,
        input: prompt,
        text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
      }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok)
      throw new ServiceUnavailableException(`OpenAI failed: ${JSON.stringify(json).slice(0, 200)}`);
    return {
      text: extractOpenAiText(json),
      provider: 'openai' as const,
      model: modelOverride ?? this.openaiModel,
    };
  }

  private async callAnthropic(
    prompt: string,
    schema: Record<string, unknown>,
    modelOverride?: string,
  ) {
    if (!this.anthropicKey)
      throw new ServiceUnavailableException('ANTHROPIC_API_KEY not configured');
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelOverride ?? this.anthropicModel,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `${prompt}\n\nReturn JSON matching this schema:\n${JSON.stringify(schema)}`,
          },
        ],
      }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok)
      throw new ServiceUnavailableException(
        `Anthropic failed: ${JSON.stringify(json).slice(0, 200)}`,
      );
    return {
      text: extractAnthropicText(json),
      provider: 'anthropic' as const,
      model: modelOverride ?? this.anthropicModel,
    };
  }

  private resolveProvider(): 'openai' | 'anthropic' | null {
    if (this.preferredProvider === 'openai' && this.openaiKey) return 'openai';
    if (this.preferredProvider === 'anthropic' && this.anthropicKey) return 'anthropic';
    if (this.openaiKey) return 'openai';
    if (this.anthropicKey) return 'anthropic';
    return null;
  }

  private providerOrder(): Array<'openai' | 'anthropic'> {
    const providers: Array<'openai' | 'anthropic'> = [];
    const add = (p: 'openai' | 'anthropic') => {
      if ((p === 'openai' ? this.openaiKey : this.anthropicKey) && !providers.includes(p))
        providers.push(p);
    };
    if (this.preferredProvider) add(this.preferredProvider);
    add('openai');
    add('anthropic');
    return providers;
  }

  private async withProviderFallback<T>(
    operation: string,
    invoke: (provider: 'openai' | 'anthropic') => Promise<T>,
  ): Promise<T> {
    const providers = this.providerOrder();
    if (!providers.length) {
      throw new ServiceUnavailableException(
        `${operation} not configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.`,
      );
    }
    const failures: string[] = [];
    for (const provider of providers) {
      try {
        return await invoke(provider);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'provider request failed';
        failures.push(`${provider}: ${message}`);
        if (provider !== providers[providers.length - 1]) {
          this.logger.warn(`${operation} failed with ${provider}; trying fallback. ${message}`);
        }
      }
    }
    throw new ServiceUnavailableException(
      `${operation} failed for all providers. ${failures.join(' | ')}`,
    );
  }
}
