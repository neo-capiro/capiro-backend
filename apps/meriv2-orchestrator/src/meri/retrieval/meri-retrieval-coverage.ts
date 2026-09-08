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
  /**
   * True only when a high-level recipe explicitly reconciled its underlying
   * pages/sources and is allowed to supersede earlier observations for the same
   * required domain. Ordinary composite results remain non-authoritative so
   * they cannot hide a real coverage gap by merely declaring themselves complete.
   */
  authoritativeCoverage?: boolean;
  detail?: string;
  mailPage?: MeriMailPageReceipt;
}

/** Exact canonical query identity and visible record ids, used only to reconcile
 * pages already read. This never chooses a query or retrieves more evidence. */
export interface MeriMailPageReceipt {
  key: string;
  offset: number;
  recordIds: string[];
  sourceComplete: boolean;
  contentTruncated: boolean;
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
    const mailCoverage = isRecord(raw.mailCoverage) ? raw.mailCoverage : null;
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
          : mailCoverage
            ? mailCoverage.sourceStatus === 'healthy'
              ? 'complete'
              : mailCoverage.sourceStatus === 'unavailable' ? 'unavailable' : 'partial'
            : synced > 0 ? 'complete' : 'partial';
    const syncedAt = mailCoverage ? mailCoverage.lastMailSyncAt : raw.lastSyncAt;
    out.push({
      source: provider,
      status,
      ...(syncedAt instanceof Date ? { lastSyncAt: syncedAt.toISOString() }
        : typeof syncedAt === 'string' ? { lastSyncAt: syncedAt } : {}),
      ...(typeof mailCoverage?.reason === 'string' ? { detail: mailCoverage.reason }
        : typeof raw.note === 'string' ? { detail: raw.note } : {}),
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
  const coverage = explicitCoverage(payload);
  const nestedTotal = firstNumber(coverage ?? {}, [
    'recordsEvaluated',
    'total',
    'totalMatches',
  ]);
  const nestedReturned = firstNumber(coverage ?? {}, [
    'recordsReturned',
    'returned',
    'returnedCount',
  ]);
  const total =
    firstNumber(payload, ['total', 'totalMatches', 'count', 'matchesFound']) ?? nestedTotal;
  const returned =
    firstNumber(payload, ['returned', 'returnedCount']) ??
    nestedReturned ??
    (rows.length ? rows.length : 0);
  const hasMore =
    (typeof payload.hasMore === 'boolean' ? payload.hasMore : total !== null && total > returned) ||
    payload.nextCursor != null ||
    coverage?.paginationComplete === false;
  const truncated = payload.truncated === true || coverage?.truncated === true || hasMore;
  const error = typeof payload.error === 'string' ? payload.error : null;
  const note = typeof payload.note === 'string' ? payload.note : null;
  const coverageComplete = coverage?.complete === true;
  const coveragePartial = coverage?.complete === false;
  const authoritativeCoverage = coverage?.authoritative === true;
  const explicitPaginationComplete =
    coverageComplete ||
    coverage?.paginationComplete === true ||
    payload.paginationComplete === true ||
    payload.exhausted === true ||
    (payload.hasMore === false && (total === null || total <= returned));
  const unavailable = Boolean(
    error ||
      /unavailable|not connected|not configured|could not be loaded|failed/i.test(note ?? ''),
  );
  const sourceHealth = sourceHealthFromMailboxes(payload);
  const sourceFailure = sourceHealth.some(
    (source) => source.status !== 'complete',
  );
  // During a mixed-version rollout, old list_emails returns only threads/count.
  // A count of the newest threads is not an exhaustion receipt for the inbox.
  const legacyMailListing = tool === 'list_emails' &&
    (finiteNumber(payload.totalMatches) === null || finiteNumber(payload.returned) === null || typeof payload.hasMore !== 'boolean');
  const status: MeriSourceHealthStatus = error
    ? 'error'
    : unavailable
      ? 'unavailable'
      : sourceFailure || legacyMailListing
        ? 'partial'
        : coverageComplete
        ? 'complete'
        : coveragePartial || truncated || sourceFailure
          ? 'partial'
          : !catalog.exhaustive && !explicitPaginationComplete
            ? 'partial'
            : 'complete';

  const mailPage = mailPageReceipt(tool, payload, rows, returned, total, sourceHealth, error);

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
    ...(authoritativeCoverage ? { authoritativeCoverage: true } : {}),
    ...(error || note ? { detail: error ?? note ?? undefined } : {}),
    ...(mailPage ? { mailPage } : {}),
  };
}

function mailPageReceipt(
  tool: string,
  payload: Record<string, unknown>,
  rows: unknown[],
  returned: number,
  total: number | null,
  sourceHealth: MeriSourceHealth[],
  error: string | null,
): MeriMailPageReceipt | null {
  if (tool !== 'list_emails' && tool !== 'search_emails') return null;
  if (!isRecord(payload.queryScope) || !Number.isSafeInteger(payload.offset) || Number(payload.offset) < 0 || total === null) return null;
  const scope = payload.queryScope;
  const keys = ['query', 'from', 'participant', 'clientId', 'folder', 'withinDays', 'asOf'] as const;
  if (keys.some((key) => !(key in scope)) || typeof scope.asOf !== 'string' || !Number.isFinite(Date.parse(scope.asOf))) return null;
  const recordIds = rows.flatMap((row) => isRecord(row) && typeof row.id === 'string' ? [row.id] : []);
  const mailboxes = Array.isArray(payload.searchedMailboxes) ? payload.searchedMailboxes : [];
  const sourceComplete = !error && mailboxes.length > 0 && mailboxes.every((box) =>
    isRecord(box) && isRecord(box.mailCoverage) && box.mailCoverage.sourceStatus === 'healthy',
  ) && sourceHealth.every((source) => source.status === 'complete');
  return {
    key: JSON.stringify(keys.map((key) => [key, scope[key]])),
    offset: Number(payload.offset), recordIds, sourceComplete,
    contentTruncated: (isRecord(payload.projection) && payload.projection.contentTruncated === false
      ? false : payload.truncated === true || (isRecord(payload.projection) && payload.projection.truncated === true)) ||
      recordIds.length !== returned,
  };
}

/** Reconcile only exact canonical mail query pages. Repeated totals and pages
 * are counted once; a missing range, changed filter, or degraded sync stays partial. */
export function coalesceMeriMailPages(
  observations: readonly MeriToolCoverageObservation[],
): MeriToolCoverageObservation[] {
  const groups = new Map<string, MeriToolCoverageObservation[]>();
  const output: MeriToolCoverageObservation[] = [];
  for (const observation of observations) {
    if (!observation.mailPage) output.push(observation);
    else groups.set(observation.mailPage.key, [...(groups.get(observation.mailPage.key) ?? []), observation]);
  }
  for (const pages of groups.values()) {
    const first = pages[0]!;
    const total = Math.max(...pages.map((page) => page.total ?? 0));
    const ids = new Set(pages.flatMap((page) => page.mailPage!.recordIds));
    let through = 0;
    for (const page of [...pages].sort((a, b) => a.mailPage!.offset - b.mailPage!.offset)) {
      if (page.mailPage!.offset > through) break;
      through = Math.max(through, page.mailPage!.offset + page.returned);
    }
    const exhausted = pages.every((page) => page.total === total) && through >= total && ids.size >= total &&
      pages.some((page) => !page.hasMore && page.mailPage!.offset + page.returned >= total);
    const contentTruncated = pages.some((page) => page.mailPage!.contentTruncated);
    const sourceComplete = pages.every((page) => page.mailPage!.sourceComplete);
    const status: MeriSourceHealthStatus = pages.some((page) => page.status === 'error') ? 'error'
      : pages.some((page) => page.status === 'unavailable') ? 'unavailable'
        : exhausted && !contentTruncated && sourceComplete ? 'complete' : 'partial';
    output.push({ ...first, returned: ids.size, total, hasMore: !exhausted,
      truncated: contentTruncated || !exhausted, status,
      sourceHealth: mergeSourceHealth(pages),
      detail: status === 'complete' ? undefined : pages.find((page) => page.detail)?.detail ?? 'mail_query_coverage_partial',
      mailPage: undefined,
    });
  }
  return output;
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

function authoritativeDomains(
  plan: MeriRetrievalPlan,
  observations: readonly MeriToolCoverageObservation[],
): Set<MeriRetrievalDomain> {
  return new Set(
    plan.requiredDomains.filter((domain) =>
      observations.some(
        (observation) =>
          observation.authoritativeCoverage === true &&
          observation.status === 'complete' &&
          observation.domains.includes(domain),
      ),
    ),
  );
}

function supersededByAuthoritativeCoverage(
  plan: MeriRetrievalPlan,
  observation: MeriToolCoverageObservation,
  authoritative: ReadonlySet<MeriRetrievalDomain>,
): boolean {
  if (observation.authoritativeCoverage) return false;
  const relevantDomains = observation.domains.filter((domain) =>
    plan.requiredDomains.includes(domain),
  );
  return relevantDomains.length > 0 && relevantDomains.every((domain) => authoritative.has(domain));
}

export function buildMeriCoverageManifest(
  plan: MeriRetrievalPlan,
  observations: readonly MeriToolCoverageObservation[],
): MeriCoverageManifest {
  const toolsInvoked = unique(observations.map((observation) => observation.tool));
  observations = coalesceMeriMailPages(observations);
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
  const requiredObservations = observations.filter((observation) =>
    observation.domains.some((domain) => plan.requiredDomains.includes(domain)),
  );
  const authoritative = authoritativeDomains(plan, observations);
  const rawCompletionObservations = requiredObservations.length ? requiredObservations : observations;
  const completionObservations = rawCompletionObservations.filter(
    (observation) =>
      !supersededByAuthoritativeCoverage(plan, observation, authoritative),
  );
  const missingDomains = plan.requiredDomains.filter((domain) => !searchedDomains.includes(domain));
  const partialDomains = plan.requiredDomains.filter((domain) => {
    const relevant = observations.filter(
      (observation) =>
        observation.domains.includes(domain) &&
        !supersededByAuthoritativeCoverage(plan, observation, authoritative),
    );
    return relevant.length > 0 && relevant.every((observation) => observation.status !== 'complete');
  });
  const requestedEntityCount = completionObservations.reduce<number | null>(
    (current, observation) =>
      observation.requestedEntityCount == null
        ? current
        : Math.max(current ?? 0, observation.requestedEntityCount),
    plan.subjectScope === 'portfolio' ? plan.activeClients.length : null,
  );
  const searchedEntityCount = completionObservations.reduce<number | null>(
    (current, observation) =>
      observation.searchedEntityCount == null
        ? current
        : Math.max(current ?? 0, observation.searchedEntityCount),
    null,
  );
  const paginationComplete = completionObservations.every((observation) => !observation.hasMore);
  const truncated = completionObservations.some((observation) => observation.truncated);
  const sourceHealth = mergeSourceHealth(completionObservations);
  const unavailableSources = [
    ...sourceHealth
      .filter((source) => source.status === 'error' || source.status === 'unavailable')
      .map((source) => ({ source: source.source, reason: source.detail ?? source.status })),
    ...completionObservations
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
    recordsEvaluated: completionObservations.reduce(
      (sum, observation) => sum + (observation.total ?? observation.returned),
      0,
    ),
    recordsReturned: completionObservations.reduce(
      (sum, observation) => sum + observation.returned,
      0,
    ),
    paginationComplete,
    truncated,
    sourceHealth,
    unavailableSources,
    toolsInvoked,
    stopReason: complete ? 'complete' : 'partial',
  };
}

export function appendMeriCoverageDisclosure(
  reply: string,
  plan: MeriRetrievalPlan,
  coverage: MeriCoverageManifest,
): string {
  if (coverage.complete) return reply;
  if (
    !plan.requireCompleteCoverage &&
    coverage.unavailableSources.length === 0 &&
    !coverage.truncated
  ) {
    return reply;
  }
  if (/\*\*Coverage note:\*\*/i.test(reply)) return reply;

  const mailRequired = plan.requiredDomains.includes('mail');
  const mailUnavailable =
    mailRequired &&
    coverage.unavailableSources.some((source) =>
      /mail|gmail|google|microsoft|outlook|search_emails/i.test(source.source),
    );
  const mailPartial =
    mailRequired &&
    (coverage.partialDomains.includes('mail') || !coverage.paginationComplete || coverage.truncated);

  let note: string;
  if (mailUnavailable) {
    note = 'Mailbox data was unavailable, so this relationship history may be incomplete.';
  } else if (mailPartial) {
    note =
      coverage.recordsEvaluated > coverage.recordsReturned
        ? `This summary covers ${coverage.recordsReturned} of ${coverage.recordsEvaluated} matching synchronized mailbox records; additional messages may exist.`
        : 'The synchronized mailbox returned additional or truncated results, so this relationship history may omit some messages.';
  } else if (coverage.missingDomains.length || coverage.partialDomains.length) {
    note = 'One or more evidence sources required for this request were incomplete, so exhaustive or negative claims should be treated as provisional.';
  } else {
    note = 'A required source was temporarily unavailable, so the answer may omit relevant records.';
  }

  return `${reply.trim()}\n\n> **Coverage note:** ${note}`.trim();
}
