import type {
  MeriRetrievalDomain,
  MeriRetrievalPlan,
} from './meri-retrieval-plan.js';
import { meriToolCoverageCatalogEntry } from './meri-tool-catalog.js';

export type MeriSourceHealthStatus = 'complete' | 'partial' | 'error' | 'unavailable';

export interface MeriSourceHealth {
  source: string;
  status: MeriSourceHealthStatus;
  lastSyncAt?: string;
  detail?: string;
}

export interface MeriToolCoverageObservation {
  tool: string;
  domains: MeriRetrievalDomain[];
  returned: number;
  total: number | null;
  hasMore: boolean;
  truncated: boolean;
  status: MeriSourceHealthStatus;
  sourceHealth: MeriSourceHealth[];
  requestedEntityCount?: number;
  searchedEntityCount?: number;
  detail?: string;
}

export interface MeriCoverageManifest {
  version: 1;
  complete: boolean;
  requestedDomains: MeriRetrievalDomain[];
  searchedDomains: MeriRetrievalDomain[];
  missingDomains: MeriRetrievalDomain[];
  partialDomains: MeriRetrievalDomain[];
  requestedEntityCount: number | null;
  searchedEntityCount: number | null;
  recordsEvaluated: number;
  recordsReturned: number;
  paginationComplete: boolean;
  truncated: boolean;
  sourceHealth: MeriSourceHealth[];
  unavailableSources: Array<{ source: string; reason: string }>;
  toolsInvoked: string[];
  stopReason: 'complete' | 'partial' | 'no-retrieval-required';
}

const ROW_KEYS = [
  'results',
  'data',
  'items',
  'messages',
  'threads',
  'meetings',
  'tasks',
  'actions',
  'campaigns',
  'debriefs',
  'bills',
  'contacts',
  'records',
  'filings',
  'opportunities',
  'grants',
  'awards',
  'matches',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

export function meriToolRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ROW_KEYS) {
    if (Array.isArray(payload[key])) return payload[key] as unknown[];
  }
  if (isRecord(payload.record)) return [payload.record];
  if (isRecord(payload.context)) return [payload.context];
  if (isRecord(payload.resolvedEntity)) return [payload.resolvedEntity];
  return [];
}

function sourceHealthFromMailboxes(record: Record<string, unknown>): MeriSourceHealth[] {
  const mailboxes = Array.isArray(record.searchedMailboxes) ? record.searchedMailboxes : [];
  const out: MeriSourceHealth[] = [];
  for (const raw of mailboxes) {
    if (!isRecord(raw)) continue;
    const provider =
      typeof raw.provider === 'string'
        ? raw.provider
        : typeof raw.source === 'string'
          ? raw.source
          : 'mailbox';
    const connectionStatus = typeof raw.status === 'string' ? raw.status.toLowerCase() : '';
    const synced =
      finiteNumber(raw.syncedMessages) ??
      finiteNumber(raw.messageCount) ??
      finiteNumber(raw.syncedCount) ??
      0;
    const status: MeriSourceHealthStatus =
      /error|failed/.test(connectionStatus)
        ? 'error'
        : /disabled|unavailable|needs_configuration/.test(connectionStatus)
          ? 'unavailable'
          : synced > 0
            ? 'complete'
            : 'partial';
    out.push({
      source: provider,
      status,
      ...(typeof raw.lastSyncAt === 'string' ? { lastSyncAt: raw.lastSyncAt } : {}),
      ...(typeof raw.note === 'string' ? { detail: raw.note } : {}),
    });
  }
  return out;
}

function explicitCoverage(record: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(record.coverage) ? record.coverage : null;
}

export function observeMeriToolCoverage(
  tool: string,
  _input: Record<string, unknown>,
  payload: unknown,
): MeriToolCoverageObservation {
  const catalog = meriToolCoverageCatalogEntry(tool);
  if (!isRecord(payload)) {
    return {
      tool,
      domains: catalog.domains,
      returned: Array.isArray(payload) ? payload.length : 0,
      total: Array.isArray(payload) ? payload.length : null,
      hasMore: false,
      truncated: false,
      status: payload == null ? 'partial' : 'complete',
      sourceHealth: [],
    };
  }

  const rows = meriToolRows(payload);
  const total = firstNumber(payload, ['total', 'totalMatches', 'count', 'matchesFound']);
  const returned =
    firstNumber(payload, ['returned', 'returnedCount']) ?? (rows.length ? rows.length : 0);
  const hasMore =
    payload.hasMore === true ||
    payload.nextCursor != null ||
    (total !== null && total > returned);
  const truncated = payload.truncated === true || hasMore;
  const error = typeof payload.error === 'string' ? payload.error : null;
  const note = typeof payload.note === 'string' ? payload.note : null;
  const coverage = explicitCoverage(payload);
  const coverageComplete = coverage?.complete === true;
  const coveragePartial = coverage?.complete === false;
  const unavailable = Boolean(
    error ||
      /unavailable|not connected|not configured|could not be loaded|failed/i.test(note ?? ''),
  );
  const sourceHealth = sourceHealthFromMailboxes(payload);
  const sourceFailure = sourceHealth.some(
    (source) => source.status === 'error' || source.status === 'unavailable',
  );
  const status: MeriSourceHealthStatus = error
    ? 'error'
    : unavailable
      ? 'unavailable'
      : coverageComplete
        ? 'complete'
        : coveragePartial || truncated || sourceFailure || !catalog.exhaustive
          ? 'partial'
          : 'complete';

  return {
    tool,
    domains: catalog.domains,
    returned,
    total,
    hasMore,
    truncated,
    status,
    sourceHealth,
    ...(firstNumber(coverage ?? {}, ['requestedEntityCount', 'requestedEntities']) !== null
      ? {
          requestedEntityCount: firstNumber(coverage ?? {}, [
            'requestedEntityCount',
            'requestedEntities',
          ])!,
        }
      : {}),
    ...(firstNumber(coverage ?? {}, ['searchedEntityCount', 'searchedEntities']) !== null
      ? {
          searchedEntityCount: firstNumber(coverage ?? {}, [
            'searchedEntityCount',
            'searchedEntities',
          ])!,
        }
      : {}),
    ...(error || note ? { detail: error ?? note ?? undefined } : {}),
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function mergeSourceHealth(observations: readonly MeriToolCoverageObservation[]): MeriSourceHealth[] {
  const rank: Record<MeriSourceHealthStatus, number> = {
    complete: 0,
    partial: 1,
    unavailable: 2,
    error: 3,
  };
  const bySource = new Map<string, MeriSourceHealth>();
  for (const observation of observations) {
    for (const source of observation.sourceHealth) {
      const current = bySource.get(source.source);
      if (!current || rank[source.status] > rank[current.status]) bySource.set(source.source, source);
    }
  }
  return [...bySource.values()].sort((a, b) => a.source.localeCompare(b.source));
}

export function buildMeriCoverageManifest(
  plan: MeriRetrievalPlan,
  observations: readonly MeriToolCoverageObservation[],
): MeriCoverageManifest {
  if (!plan.requiredDomains.length && !observations.length) {
    return {
      version: 1,
      complete: true,
      requestedDomains: [],
      searchedDomains: [],
      missingDomains: [],
      partialDomains: [],
      requestedEntityCount: null,
      searchedEntityCount: null,
      recordsEvaluated: 0,
      recordsReturned: 0,
      paginationComplete: true,
      truncated: false,
      sourceHealth: [],
      unavailableSources: [],
      toolsInvoked: [],
      stopReason: 'no-retrieval-required',
    };
  }

  const searchedDomains = unique(observations.flatMap((observation) => observation.domains));
  const missingDomains = plan.requiredDomains.filter((domain) => !searchedDomains.includes(domain));
  const partialDomains = plan.requiredDomains.filter((domain) => {
    const relevant = observations.filter((observation) => observation.domains.includes(domain));
    return relevant.length > 0 && relevant.every((observation) => observation.status !== 'complete');
  });
  const requestedEntityCount = observations.reduce<number | null>(
    (current, observation) =>
      observation.requestedEntityCount == null
        ? current
        : Math.max(current ?? 0, observation.requestedEntityCount),
    plan.subjectScope === 'portfolio' ? plan.activeClients.length : null,
  );
  const searchedEntityCount = observations.reduce<number | null>(
    (current, observation) =>
      observation.searchedEntityCount == null
        ? current
        : Math.max(current ?? 0, observation.searchedEntityCount),
    null,
  );
  const paginationComplete = observations.every((observation) => !observation.hasMore);
  const truncated = observations.some((observation) => observation.truncated);
  const sourceHealth = mergeSourceHealth(observations);
  const unavailableSources = [
    ...sourceHealth
      .filter((source) => source.status === 'error' || source.status === 'unavailable')
      .map((source) => ({ source: source.source, reason: source.detail ?? source.status })),
    ...observations
      .filter((observation) => observation.status === 'error' || observation.status === 'unavailable')
      .map((observation) => ({
        source: observation.tool,
        reason: observation.detail ?? observation.status,
      })),
  ].filter(
    (entry, index, all) =>
      all.findIndex((candidate) => candidate.source === entry.source && candidate.reason === entry.reason) ===
      index,
  );
  const entityCoverageComplete =
    requestedEntityCount == null ||
    (searchedEntityCount != null && searchedEntityCount >= requestedEntityCount);
  const complete =
    missingDomains.length === 0 &&
    partialDomains.length === 0 &&
    paginationComplete &&
    !truncated &&
    unavailableSources.length === 0 &&
    entityCoverageComplete;

  return {
    version: 1,
    complete,
    requestedDomains: [...plan.requiredDomains],
    searchedDomains,
    missingDomains,
    partialDomains,
    requestedEntityCount,
    searchedEntityCount,
    recordsEvaluated: observations.reduce(
      (sum, observation) => sum + (observation.total ?? observation.returned),
      0,
    ),
    recordsReturned: observations.reduce((sum, observation) => sum + observation.returned, 0),
    paginationComplete,
    truncated,
    sourceHealth,
    unavailableSources,
    toolsInvoked: unique(observations.map((observation) => observation.tool)),
    stopReason: complete ? 'complete' : 'partial',
  };
}

export function appendMeriCoverageDisclosure(
  reply: string,
  plan: MeriRetrievalPlan,
  coverage: MeriCoverageManifest,
): string {
  if (!plan.requireCompleteCoverage && coverage.unavailableSources.length === 0) return reply;
  if (/^### Retrieval coverage$/m.test(reply)) return reply;

  const lines = [
    '### Retrieval coverage',
    coverage.complete
      ? `Coverage is complete for the requested scope (${coverage.searchedDomains.join(', ') || 'no external retrieval required'}).`
      : 'Coverage is partial. Treat negative or exhaustive claims as provisional.',
  ];
  if (coverage.requestedEntityCount != null) {
    lines.push(
      coverage.complete
        ? `Entities searched: ${coverage.searchedEntityCount ?? 0} of ${coverage.requestedEntityCount}.`
        : `Entity fan-out attempted: ${coverage.searchedEntityCount ?? 0} of ${coverage.requestedEntityCount}; see the source/domain gaps below.`,
    );
  }
  if (coverage.missingDomains.length) {
    lines.push(`Not searched: ${coverage.missingDomains.join(', ')}.`);
  }
  if (coverage.partialDomains.length) {
    lines.push(`Partially searched: ${coverage.partialDomains.join(', ')}.`);
  }
  if (!coverage.paginationComplete || coverage.truncated) {
    lines.push('At least one source had additional or truncated results that were not fully enumerated.');
  }
  if (coverage.unavailableSources.length) {
    lines.push(
      `Unavailable sources: ${coverage.unavailableSources
        .map((source) => `${source.source} (${source.reason})`)
        .join('; ')}.`,
    );
  }
  return `${reply.trim()}\n\n${lines.join('\n')}`.trim();
}
