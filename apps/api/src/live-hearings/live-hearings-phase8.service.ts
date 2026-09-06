import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 200;

interface InsightRow {
  id: string;
  hearingId: string;
  captureId: string;
  segmentId: string;
  sequence: number;
  startMs: number;
  endMs: number;
  insightType: string;
  title: string;
  summary: string;
  evidenceText: string | null;
  speakerName: string | null;
  confidence: number | null;
  preliminary: boolean;
  entities: unknown;
  extractor: string;
  extractorVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

interface RelevanceRow {
  id: string;
  clientId: string;
  clientName: string | null;
  insightId: string;
  score: number;
  matchedOn: unknown;
  rationale: string;
  createdAt: Date;
  updatedAt: Date;
}

interface QueueCountRow {
  status: string;
  count: number;
}

interface TypeCountRow {
  insightType: string;
  count: number;
}

export interface Phase8IntelligenceQuery {
  cursor?: string;
  limit?: number;
  clientId?: string;
  onlyRelevant?: boolean;
}

export interface Phase8PublicInsight {
  id: string;
  insightType: string;
  title: string;
  summary: string;
  speakerName: string | null;
  confidence: number | null;
  preliminary: boolean;
  entities: Array<{ entityType: string; label: string; canonicalId: string | null }>;
  evidence: {
    segmentId: string;
    sequence: number;
    startMs: number;
    endMs: number;
    text: string | null;
  };
  extractor: { name: string; version: string };
  createdAt: string;
  updatedAt: string;
  relevance: Phase8Relevance[];
}

export interface Phase8Relevance {
  id: string;
  clientId: string;
  clientName: string | null;
  insightId: string;
  score: number;
  matchedOn: Array<{ kind: string; value: string }>;
  rationale: string;
  createdAt: string;
  updatedAt: string;
}

export interface Phase8Recap {
  state: 'PRELIMINARY' | 'FINAL';
  overview: string;
  commitments: Phase8PublicInsight[];
  deadlines: Phase8PublicInsight[];
  funding: Phase8PublicInsight[];
  policyPositions: Phase8PublicInsight[];
  questions: Phase8PublicInsight[];
  keyQuotes: Phase8PublicInsight[];
  references: Phase8PublicInsight[];
}

@Injectable()
export class LiveHearingsPhase8Service {
  constructor(private readonly prisma: PrismaService) {}

  async intelligence(
    ctx: TenantContext,
    hearingId: string,
    input: Phase8IntelligenceQuery,
  ): Promise<Record<string, unknown>> {
    const hearing = await this.prisma.committeeHearing.findUnique({
      where: { id: hearingId },
      select: {
        id: true,
        title: true,
        eventStatus: true,
        visibility: true,
        startsAt: true,
        actualEnd: true,
      },
    });
    if (!hearing || hearing.visibility !== 'public') {
      throw new NotFoundException(`public hearing ${hearingId} not found`);
    }

    const cursor = decodePhase8Cursor(input.cursor);
    const limit = clamp(input.limit ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const clientId = input.clientId?.trim() || null;
    // Filter before paging: otherwise a page of unrelated public findings can
    // hide later client matches. Tenant predicates and the RLS context are both
    // required when a public-corpus query consults tenant relevance.
    const relevantPredicate = (tenantParameter: number, clientParameter: number) => input.onlyRelevant
      ? `AND EXISTS (
           SELECT 1 FROM tenant_hearing_relevance r
           WHERE r.tenant_id=$${tenantParameter}::uuid
             AND r.hearing_id=i.hearing_id AND r.insight_id=i.id
             AND ($${clientParameter}::uuid IS NULL OR r.client_id=$${clientParameter}::uuid)
         )`
      : '';
    const queryCorpus = <T>(sql: string, ...parameters: unknown[]): Promise<T> => input.onlyRelevant
      ? this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.$queryRawUnsafe<T>(sql, ...parameters, ctx.tenantId, clientId))
      : this.prisma.$queryRawUnsafe<T>(sql, ...parameters);

    const rows = await queryCorpus<InsightRow[]>(
      `SELECT id,
              hearing_id AS "hearingId",
              capture_id AS "captureId",
              segment_id AS "segmentId",
              sequence,
              start_ms AS "startMs",
              end_ms AS "endMs",
              insight_type AS "insightType",
              title,
              summary,
              evidence_text AS "evidenceText",
              speaker_name AS "speakerName",
              confidence,
              preliminary,
              entities,
              extractor,
              extractor_version AS "extractorVersion",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
       FROM public_hearing_insight i
       WHERE hearing_id=$1
         ${relevantPredicate(5, 6)}
         AND (
           $2::int IS NULL OR
           sequence > $2 OR
           (sequence=$2 AND id > $3)
         )
       ORDER BY sequence ASC, id ASC
       LIMIT $4`,
      hearingId,
      cursor?.sequence ?? null,
      cursor?.id ?? '',
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const insightIds = pageRows.map((row) => row.id);

    const [totals, typeCounts, publicQueue, tenantResult] = await Promise.all([
      queryCorpus<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
         FROM public_hearing_insight i
         WHERE hearing_id=$1
           ${relevantPredicate(2, 3)}`,
        hearingId,
      ),
      queryCorpus<TypeCountRow[]>(
        `SELECT insight_type AS "insightType", COUNT(*)::int AS count
         FROM public_hearing_insight i
         WHERE hearing_id=$1
           ${relevantPredicate(2, 3)}
         GROUP BY insight_type
         ORDER BY insight_type`,
        hearingId,
      ),
      this.prisma.$queryRawUnsafe<QueueCountRow[]>(
        `SELECT status, COUNT(*)::int AS count
         FROM public_hearing_intelligence_job
         WHERE hearing_id=$1
         GROUP BY status`,
        hearingId,
      ),
      this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const [relevance, tenantQueue] = await Promise.all([
          insightIds.length
            ? tx.$queryRawUnsafe<RelevanceRow[]>(
                `SELECT id,
                        client_id::text AS "clientId",
                        client_name AS "clientName",
                        insight_id AS "insightId",
                        score,
                        matched_on AS "matchedOn",
                        rationale,
                        created_at AS "createdAt",
                        updated_at AS "updatedAt"
                 FROM tenant_hearing_relevance
                 WHERE tenant_id=$1::uuid
                   AND hearing_id=$2
                   AND insight_id = ANY($3::text[])
                   AND ($4::uuid IS NULL OR client_id=$4::uuid)
                 ORDER BY score DESC, client_id, insight_id`,
                ctx.tenantId,
                hearingId,
                insightIds,
                clientId,
              )
            : Promise.resolve([] as RelevanceRow[]),
          tx.$queryRawUnsafe<QueueCountRow[]>(
            `SELECT status, COUNT(*)::int AS count
             FROM tenant_hearing_relevance_job
             WHERE tenant_id=$1::uuid AND hearing_id=$2
             GROUP BY status`,
            ctx.tenantId,
            hearingId,
          ),
        ]);
        return { relevance, tenantQueue };
      }),
    ]);

    const relevance = tenantResult.relevance.map(mapRelevance);
    const relevanceByInsight = new Map<string, Phase8Relevance[]>();
    for (const match of relevance) {
      const list = relevanceByInsight.get(match.insightId) ?? [];
      list.push(match);
      relevanceByInsight.set(match.insightId, list);
    }

    const items = pageRows.map((row) =>
      mapInsight(row, relevanceByInsight.get(row.id) ?? []),
    );

    const publicCounts = queueCounts(publicQueue);
    const tenantCounts = queueCounts(tenantResult.tenantQueue);
    const total = totals[0]?.count ?? 0;
    const status = derivePhase8Status({ total, publicCounts, tenantCounts });
    const last = pageRows.at(-1);
    const byType = Object.fromEntries(typeCounts.map((row) => [row.insightType, row.count]));
    const recap = buildPhase8Recap(items, {
      final: hearing.eventStatus === 'completed' || Boolean(hearing.actualEnd),
      total,
      byType,
    });
    const clientGroups = groupPhase8Relevance(items);

    return {
      hearingId,
      status,
      sourceBoundary: 'CANONICAL_PUBLIC_TRANSCRIPT_ONLY',
      summary: {
        total,
        returned: items.length,
        preliminary: items.filter((item) => item.preliminary).length,
        evidenceSegments: new Set(items.map((item) => item.evidence.segmentId)).size,
        clientRelevant: items.filter((item) => item.relevance.length > 0).length,
        byType,
      },
      recap,
      items,
      clientGroups,
      jobs: {
        public: publicCounts,
        tenant: tenantCounts,
      },
      nextCursor:
        hasMore && last ? encodePhase8Cursor({ sequence: last.sequence, id: last.id }) : null,
      hasMore,
      asOf: new Date().toISOString(),
      disclaimer:
        'Machine-derived intelligence from the canonical public transcript. Verify consequential quotations against the official recording or transcript.',
    };
  }
}

export function derivePhase8Status(input: {
  total: number;
  publicCounts: Record<string, number>;
  tenantCounts: Record<string, number>;
}): 'READY' | 'PROCESSING' | 'DEGRADED' | 'FAILED' | 'EMPTY' {
  const pending =
    (input.publicCounts.pending ?? 0) +
    (input.publicCounts.leased ?? 0) +
    (input.tenantCounts.pending ?? 0) +
    (input.tenantCounts.leased ?? 0);
  const failed = (input.publicCounts.failed ?? 0) + (input.tenantCounts.failed ?? 0);
  if (input.total === 0 && failed > 0 && pending === 0) return 'FAILED';
  if (pending > 0) return input.total > 0 && failed > 0 ? 'DEGRADED' : 'PROCESSING';
  if (failed > 0) return input.total > 0 ? 'DEGRADED' : 'FAILED';
  return input.total > 0 ? 'READY' : 'EMPTY';
}

export function buildPhase8Recap(
  items: readonly Phase8PublicInsight[],
  input: { final: boolean; total: number; byType: Record<string, number> },
): Phase8Recap {
  const take = (types: readonly string[], limit = 12) =>
    items.filter((item) => types.includes(item.insightType)).slice(0, limit);
  const phrases: string[] = [];
  for (const [type, label] of [
    ['COMMITMENT', 'commitments'],
    ['DEADLINE', 'deadlines'],
    ['FUNDING_AMOUNT', 'funding references'],
    ['POLICY_POSITION', 'policy positions'],
    ['QUESTION', 'questions'],
  ] as const) {
    const count = input.byType[type] ?? 0;
    if (count) phrases.push(`${count} ${label}`);
  }
  return {
    state: input.final ? 'FINAL' : 'PRELIMINARY',
    overview: input.total
      ? `${input.total} source-grounded finding${input.total === 1 ? '' : 's'}${
          phrases.length ? `, including ${phrases.join(', ')}` : ''
        }.`
      : 'No source-grounded finding has been persisted yet.',
    commitments: take(['COMMITMENT']),
    deadlines: take(['DEADLINE']),
    funding: take(['FUNDING_AMOUNT', 'PROGRAM_ELEMENT_REFERENCE']),
    policyPositions: take(['POLICY_POSITION']),
    questions: take(['QUESTION']),
    keyQuotes: take(['KEY_QUOTE']),
    references: take(['BILL_REFERENCE', 'AGENCY_REFERENCE', 'MENTION']),
  };
}

export function groupPhase8Relevance(items: readonly Phase8PublicInsight[]): Array<{
  clientId: string;
  clientName: string | null;
  maxScore: number;
  matchCount: number;
  insightIds: string[];
  matchedOn: Array<{ kind: string; value: string }>;
  rationales: string[];
}> {
  const groups = new Map<
    string,
    {
      clientId: string;
      clientName: string | null;
      maxScore: number;
      insightIds: Set<string>;
      matchedOn: Map<string, { kind: string; value: string }>;
      rationales: Set<string>;
    }
  >();
  for (const item of items) {
    for (const match of item.relevance) {
      const group = groups.get(match.clientId) ?? {
        clientId: match.clientId,
        clientName: match.clientName,
        maxScore: 0,
        insightIds: new Set<string>(),
        matchedOn: new Map<string, { kind: string; value: string }>(),
        rationales: new Set<string>(),
      };
      group.maxScore = Math.max(group.maxScore, match.score);
      group.insightIds.add(item.id);
      for (const fact of match.matchedOn) group.matchedOn.set(`${fact.kind}:${fact.value}`, fact);
      group.rationales.add(match.rationale);
      groups.set(match.clientId, group);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      clientId: group.clientId,
      clientName: group.clientName,
      maxScore: group.maxScore,
      matchCount: group.insightIds.size,
      insightIds: [...group.insightIds],
      matchedOn: [...group.matchedOn.values()],
      rationales: [...group.rationales],
    }))
    .sort((left, right) => right.maxScore - left.maxScore || left.clientId.localeCompare(right.clientId));
}

function mapInsight(row: InsightRow, relevance: Phase8Relevance[]): Phase8PublicInsight {
  return {
    id: row.id,
    insightType: row.insightType,
    title: row.title,
    summary: row.summary,
    speakerName: row.speakerName,
    confidence: row.confidence,
    preliminary: row.preliminary,
    entities: safeEntities(row.entities),
    evidence: {
      segmentId: row.segmentId,
      sequence: row.sequence,
      startMs: row.startMs,
      endMs: row.endMs,
      text: row.evidenceText,
    },
    extractor: { name: row.extractor, version: row.extractorVersion },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    relevance,
  };
}

function mapRelevance(row: RelevanceRow): Phase8Relevance {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName,
    insightId: row.insightId,
    score: row.score,
    matchedOn: safeMatchedOn(row.matchedOn),
    rationale: row.rationale,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function safeEntities(value: unknown): Phase8PublicInsight['entities'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      entityType: String(item.entityType ?? 'OTHER').slice(0, 64),
      label: String(item.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
      canonicalId:
        typeof item.canonicalId === 'string'
          ? item.canonicalId.replace(/\s+/g, ' ').trim().slice(0, 300) || null
          : null,
    }))
    .filter((item) => Boolean(item.label));
}

function safeMatchedOn(value: unknown): Array<{ kind: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      kind: String(item.kind ?? 'KEYWORD').slice(0, 40),
      value: String(item.value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    }))
    .filter((item) => Boolean(item.value));
}

function queueCounts(rows: QueueCountRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

export function encodePhase8Cursor(cursor: { sequence: number; id: string }): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodePhase8Cursor(value?: string): { sequence: number; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      sequence?: unknown;
      id?: unknown;
    };
    if (!Number.isInteger(parsed.sequence) || Number(parsed.sequence) < 0 || typeof parsed.id !== 'string') {
      return null;
    }
    return { sequence: Number(parsed.sequence), id: parsed.id };
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
