import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';

type UnknownRecord = Record<string, unknown>;

export interface Phase8Entity {
  entityType: string;
  label: string;
  canonicalId?: string;
}

export interface Phase8Relevance {
  id: string;
  clientId: string;
  clientName?: string;
  insightId: string;
  score: number;
  matchedOn: Array<{ kind: string; value: string }>;
  rationale: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Phase8Insight {
  id: string;
  insightType: string;
  title: string;
  summary: string;
  speakerName?: string;
  confidence?: number;
  preliminary: boolean;
  entities: Phase8Entity[];
  evidence: {
    segmentId: string;
    sequence: number;
    startMs: number;
    endMs: number;
    text?: string;
  };
  extractor: { name: string; version: string };
  createdAt?: string;
  updatedAt?: string;
  relevance: Phase8Relevance[];
}

export interface Phase8ClientGroup {
  clientId: string;
  clientName?: string;
  maxScore: number;
  matchCount: number;
  insightIds: string[];
  matchedOn: Array<{ kind: string; value: string }>;
  rationales: string[];
}

export interface Phase8Recap {
  state: 'PRELIMINARY' | 'FINAL';
  overview: string;
  commitments: Phase8Insight[];
  deadlines: Phase8Insight[];
  funding: Phase8Insight[];
  policyPositions: Phase8Insight[];
  questions: Phase8Insight[];
  keyQuotes: Phase8Insight[];
  references: Phase8Insight[];
}

export interface Phase8IntelligenceResponse {
  hearingId: string;
  status: 'READY' | 'PROCESSING' | 'DEGRADED' | 'FAILED' | 'EMPTY';
  sourceBoundary: string;
  summary: {
    total: number;
    returned: number;
    preliminary: number;
    evidenceSegments: number;
    clientRelevant: number;
    byType: Record<string, number>;
  };
  recap: Phase8Recap;
  items: Phase8Insight[];
  clientGroups: Phase8ClientGroup[];
  jobs: {
    public: Record<string, number>;
    tenant: Record<string, number>;
  };
  nextCursor?: string;
  hasMore: boolean;
  asOf?: string;
  disclaimer: string;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function number(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function boolean(value: unknown): boolean {
  return value === true || value === 'true';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(string).filter((item): item is string => Boolean(item))
    : [];
}

function numberRecord(value: unknown): Record<string, number> {
  const input = record(value);
  return Object.fromEntries(
    Object.entries(input)
      .map(([key, item]) => [key, number(item)] as const)
      .filter(([, item]) => Number.isFinite(item)),
  );
}

function matchedOn(value: unknown): Array<{ kind: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = record(item);
      const kind = string(row.kind);
      const matchValue = string(row.value);
      return kind && matchValue ? { kind, value: matchValue } : null;
    })
    .filter((item): item is { kind: string; value: string } => Boolean(item));
}

function normalizeRelevance(value: unknown): Phase8Relevance | null {
  const row = record(value);
  const id = string(row.id);
  const clientId = string(row.clientId);
  const insightId = string(row.insightId);
  if (!id || !clientId || !insightId) return null;
  return {
    id,
    clientId,
    clientName: string(row.clientName),
    insightId,
    score: Math.max(0, Math.min(100, number(row.score))),
    matchedOn: matchedOn(row.matchedOn),
    rationale: string(row.rationale) ?? 'Matched client context.',
    createdAt: string(row.createdAt),
    updatedAt: string(row.updatedAt),
  };
}

function normalizeEntity(value: unknown): Phase8Entity | null {
  const row = record(value);
  const entityType = string(row.entityType);
  const label = string(row.label);
  if (!entityType || !label) return null;
  return { entityType, label, canonicalId: string(row.canonicalId) };
}

export function normalizePhase8Insight(value: unknown): Phase8Insight | null {
  const row = record(value);
  const evidence = record(row.evidence);
  const extractor = record(row.extractor);
  const id = string(row.id);
  const insightType = string(row.insightType);
  const title = string(row.title);
  const summary = string(row.summary);
  const segmentId = string(evidence.segmentId);
  if (!id || !insightType || !title || !summary || !segmentId) return null;
  return {
    id,
    insightType,
    title,
    summary,
    speakerName: string(row.speakerName),
    confidence:
      row.confidence == null ? undefined : Math.max(0, Math.min(1, number(row.confidence))),
    preliminary: boolean(row.preliminary),
    entities: Array.isArray(row.entities)
      ? row.entities
          .map(normalizeEntity)
          .filter((item): item is Phase8Entity => Boolean(item))
      : [],
    evidence: {
      segmentId,
      sequence: Math.max(0, Math.floor(number(evidence.sequence))),
      startMs: Math.max(0, Math.floor(number(evidence.startMs))),
      endMs: Math.max(0, Math.floor(number(evidence.endMs))),
      text: string(evidence.text),
    },
    extractor: {
      name: string(extractor.name) ?? 'unknown',
      version: string(extractor.version) ?? 'unknown',
    },
    createdAt: string(row.createdAt),
    updatedAt: string(row.updatedAt),
    relevance: Array.isArray(row.relevance)
      ? row.relevance
          .map(normalizeRelevance)
          .filter((item): item is Phase8Relevance => Boolean(item))
      : [],
  };
}

function normalizeInsightArray(value: unknown): Phase8Insight[] {
  return Array.isArray(value)
    ? value
        .map(normalizePhase8Insight)
        .filter((item): item is Phase8Insight => Boolean(item))
    : [];
}

function normalizeRecap(value: unknown): Phase8Recap {
  const row = record(value);
  return {
    state: row.state === 'FINAL' ? 'FINAL' : 'PRELIMINARY',
    overview: string(row.overview) ?? 'No source-grounded finding has been persisted yet.',
    commitments: normalizeInsightArray(row.commitments),
    deadlines: normalizeInsightArray(row.deadlines),
    funding: normalizeInsightArray(row.funding),
    policyPositions: normalizeInsightArray(row.policyPositions),
    questions: normalizeInsightArray(row.questions),
    keyQuotes: normalizeInsightArray(row.keyQuotes),
    references: normalizeInsightArray(row.references),
  };
}

function normalizeClientGroup(value: unknown): Phase8ClientGroup | null {
  const row = record(value);
  const clientId = string(row.clientId);
  if (!clientId) return null;
  return {
    clientId,
    clientName: string(row.clientName),
    maxScore: Math.max(0, Math.min(100, number(row.maxScore))),
    matchCount: Math.max(0, Math.floor(number(row.matchCount))),
    insightIds: stringArray(row.insightIds),
    matchedOn: matchedOn(row.matchedOn),
    rationales: stringArray(row.rationales),
  };
}

export function normalizePhase8Intelligence(value: unknown): Phase8IntelligenceResponse {
  const row = record(value);
  const summary = record(row.summary);
  const jobs = record(row.jobs);
  const status = ['READY', 'PROCESSING', 'DEGRADED', 'FAILED', 'EMPTY'].includes(
    String(row.status),
  )
    ? (String(row.status) as Phase8IntelligenceResponse['status'])
    : 'EMPTY';
  return {
    hearingId: string(row.hearingId) ?? '',
    status,
    sourceBoundary: string(row.sourceBoundary) ?? 'CANONICAL_PUBLIC_TRANSCRIPT_ONLY',
    summary: {
      total: Math.max(0, Math.floor(number(summary.total))),
      returned: Math.max(0, Math.floor(number(summary.returned))),
      preliminary: Math.max(0, Math.floor(number(summary.preliminary))),
      evidenceSegments: Math.max(0, Math.floor(number(summary.evidenceSegments))),
      clientRelevant: Math.max(0, Math.floor(number(summary.clientRelevant))),
      byType: numberRecord(summary.byType),
    },
    recap: normalizeRecap(row.recap),
    items: normalizeInsightArray(row.items),
    clientGroups: Array.isArray(row.clientGroups)
      ? row.clientGroups
          .map(normalizeClientGroup)
          .filter((item): item is Phase8ClientGroup => Boolean(item))
      : [],
    jobs: {
      public: numberRecord(record(jobs.public)),
      tenant: numberRecord(record(jobs.tenant)),
    },
    nextCursor: string(row.nextCursor),
    hasMore: boolean(row.hasMore),
    asOf: string(row.asOf),
    disclaimer:
      string(row.disclaimer) ??
      'Machine-derived intelligence from the canonical public transcript. Verify consequential quotations against the official recording or transcript.',
  };
}

export function usePhase8Intelligence(
  hearingId?: string,
  options: { clientId?: string; onlyRelevant?: boolean; limit?: number } = {},
) {
  const api = useApi();
  return useQuery<Phase8IntelligenceResponse>({
    queryKey: [
      'legiwatch',
      'live-hearings',
      'phase8-intelligence',
      hearingId,
      options.clientId ?? null,
      Boolean(options.onlyRelevant),
      options.limit ?? 500,
    ],
    enabled: Boolean(hearingId),
    queryFn: async () => {
      const query = new URLSearchParams({
        limit: String(Math.max(1, Math.min(500, options.limit ?? 500))),
      });
      if (options.clientId) query.set('clientId', options.clientId);
      if (options.onlyRelevant) query.set('onlyRelevant', 'true');
      const response = await api.get<unknown>(
        `/api/legiwatch/live-hearings/events/${encodeURIComponent(
          hearingId as string,
        )}/intelligence-v2?${query.toString()}`,
      );
      return normalizePhase8Intelligence(response.data);
    },
    retry: false,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 10_000;
      return data.status === 'PROCESSING' || data.status === 'DEGRADED' || data.recap.state === 'PRELIMINARY'
        ? 10_000
        : false;
    },
  });
}
