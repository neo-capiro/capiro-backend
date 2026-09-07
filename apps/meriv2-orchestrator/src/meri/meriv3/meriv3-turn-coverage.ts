import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { meriToolCoverageCatalogEntry } from '../retrieval/meri-tool-catalog.js';

type InitialRetrieval = MeriGovernedTurnContext['retrieval'];
type Status = InitialRetrieval['coverage']['sourceHealth'][number]['status'];

/** A receipt describes one read, never the unique size of an entire data source. */
export interface MeriToolCoverageReceipt {
  source: string;
  tool: string;
  status: Status;
  recordsReturned: number | null;
  recordsEvaluated: number | null;
  paginationComplete: boolean | null;
  truncated: boolean;
  lastSyncAt?: string;
  detail?: string;
}

export type MeriTurnRetrieval = InitialRetrieval & {
  coverage: InitialRetrieval['coverage'] & {
    phase: 'turn';
    initialContext: InitialRetrieval['coverage'];
    toolReads: MeriToolCoverageReceipt[];
    /** Source access recovered; original query completeness is still not proven. */
    restoredSources: string[];
  };
};

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const count = (...values: unknown[]): number | null =>
  values.find(
    (value): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
  ) ?? null;
const date = (value: unknown): string | undefined =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;

// Existing tool catalog names predate the shared Context Plane's domain names.
// Client document content is deliberately separate: reading a PDF cannot prove
// that the client profile, capabilities or relationship history was retrieved.
const aliases: Record<string, string> = {
  memory: 'institutional_knowledge',
  documents: 'client_documents',
  legislation: 'legiwatch_bills',
  budget: 'program_elements',
  awards: 'federal_awards',
  opportunities: 'contracts_opportunities',
  action_items: 'action_recommendations',
};

function domains(tool: string): string[] {
  if (tool === 'get_client_context') return ['clients'];
  if (tool === 'read_client_documents') return ['client_documents'];
  if (tool === 'search_procurement_forecasts') return ['procurement_forecasts'];
  if (tool === 'search_federal_contract_awards') return ['federal_awards'];
  if (tool === 'search_federal_subawards') return ['federal_subawards'];
  if (tool === 'search_contract_vehicles') return ['contract_vehicles'];
  if (tool === 'get_district_federal_market') return ['district_nexus'];
  return [
    ...new Set(
      meriToolCoverageCatalogEntry(tool).domains.map((domain) => aliases[domain] ?? domain),
    ),
  ];
}

function receipt(
  tool: string,
  source: string,
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
): MeriToolCoverageReceipt {
  const projection = object(payload.projection);
  const pagination = object(payload.pagination);
  const returned = count(
    raw.returned,
    raw.recordsReturned,
    payload.returned,
    ...['records', 'results', 'documents', 'data', 'items'].map((key) =>
      Array.isArray(payload[key]) ? payload[key].length : undefined,
    ),
  );
  const evaluated = count(raw.recordsEvaluated, raw.total, payload.total, payload.totalMatches);
  const hasMore =
    raw.hasMore === true ||
    raw.nextCursor != null ||
    pagination?.hasMore === true ||
    payload.hasMore === true ||
    payload.nextCursor != null;
  const truncated =
    raw.truncated === true ||
    payload.truncated === true ||
    payload.contentTruncated === true ||
    projection?.truncated === true;
  const paginationComplete =
    hasMore || raw.paginationComplete === false || pagination?.complete === false
      ? false
      : raw.paginationComplete === true || pagination?.complete === true
        ? true
        : null;
  const sourceStatus = String(raw.sourceStatus ?? raw.status ?? payload.status ?? '');
  const failed = Boolean(payload.error || payload.blocked || /^(error|failed)$/.test(sourceStatus));
  const unavailable = /^(unavailable|disabled|unsupported|not_configured)$/.test(sourceStatus);
  const fullyRead =
    (raw.coverageComplete === true || raw.complete === true) &&
    !truncated &&
    !hasMore &&
    paginationComplete !== false &&
    sourceStatus !== 'degraded';
  const status: Status = failed
    ? 'error'
    : unavailable
      ? 'unavailable'
      : fullyRead
        ? 'complete'
        : 'partial';
  return {
    source,
    tool,
    status,
    // A projected payload may expose fewer records than the source receipt.
    recordsReturned:
      projection?.truncated === true
        ? count(projection.shownRecordCount, payload.returned)
        : returned,
    recordsEvaluated: evaluated,
    paginationComplete,
    truncated,
    ...(date(raw.lastSyncAt) ? { lastSyncAt: date(raw.lastSyncAt) } : {}),
    ...(typeof raw.stopReason === 'string'
      ? { detail: raw.stopReason }
      : failed
        ? { detail: 'source_read_failed' }
        : {}),
  };
}

/** Use the same projected evidence the model received, not hidden full results. */
export function observeMeriTurnToolCoverage(
  tool: string,
  value: unknown,
): MeriToolCoverageReceipt[] {
  const payload = object(value);
  if (!payload) return [];
  const coverage = object(payload.coverage);
  if (Array.isArray(coverage?.sources)) {
    return coverage.sources.flatMap((value) => {
      const source = object(value);
      return source && typeof source.domain === 'string'
        ? [receipt(tool, source.domain, source, payload)]
        : [];
    });
  }
  const sections = object(payload.profileSections);
  if (tool === 'get_client_context' && sections) {
    // Keep each bounded section visible. Never call an overview a full inventory.
    return Object.entries(sections).flatMap(([name, value]) => {
      const section = object(value);
      if (!section || section.status === 'not_requested') return [];
      const observed = receipt(
        tool,
        'clients',
        {
          ...section,
          complete: section.status === 'complete' && section.representation === 'full',
          paginationComplete: section.status === 'complete' && section.nextCursor == null,
        },
        payload,
      );
      return [{ ...observed, detail: `profile_section:${name}` }];
    });
  }
  return domains(tool).map((domain) => receipt(tool, domain, coverage ?? {}, payload));
}

/**
 * Reconcile source reach without manufacturing a second completeness engine.
 * Later reads can establish access to a source the initial packet could not
 * read. A narrower query, final page, or document does not prove that the
 * original Context Plane query was exhaustively covered. Preserve that gap.
 */
export function reconcileMeriTurnCoverage(
  initial: InitialRetrieval,
  reads: readonly MeriToolCoverageReceipt[],
): InitialRetrieval | MeriTurnRetrieval {
  if (!reads.length) return initial;
  const coverage = initial.coverage;
  const usable = new Set(
    reads
      .filter((read) => read.status === 'complete' || read.status === 'partial')
      .map((read) => read.source),
  );
  const initialMissing = new Set([
    ...coverage.missingDomains,
    ...coverage.unavailableSources.map((entry) => entry.source),
    ...coverage.sourceHealth
      .filter((source) => source.status === 'error' || source.status === 'unavailable')
      .map((source) => source.source),
  ]);
  const restoredSources = [...initialMissing].filter((source) => usable.has(source));
  const missingDomains = coverage.missingDomains.filter((source) => !usable.has(source));
  const partialDomains = [
    ...new Set([
      ...coverage.partialDomains,
      ...restoredSources.filter((source) => coverage.requestedDomains.includes(source)),
      ...reads.filter((read) => read.status === 'partial').map((read) => read.source),
    ]),
  ];
  const sourceHealth = coverage.sourceHealth.map((source) => {
    if (!restoredSources.includes(source.source)) return source;
    return {
      ...source,
      status: 'partial' as const,
      detail: 'source_access_restored_coverage_unproven',
    };
  });
  const unavailableSources = [
    ...coverage.unavailableSources.filter((entry) => !usable.has(entry.source)),
    // A successful people read does not repair an unavailable advocacy section.
    // Retain subsequent failures as read-level gaps, even when the source was
    // reachable for another record or query in this same turn.
    ...reads
      .filter((read) => read.status === 'error' || read.status === 'unavailable')
      .map((read) => ({
        source: read.source,
        reason: `subsequent_read:${read.detail ?? 'source_read_failed'}`,
      })),
  ].filter(
    (entry, i, all) =>
      all.findIndex((other) => entry.source === other.source && entry.reason === other.reason) ===
      i,
  );
  const complete =
    coverage.complete &&
    reads.every((read) => read.status === 'complete') &&
    missingDomains.length === 0 &&
    partialDomains.length === 0 &&
    unavailableSources.length === 0;
  return {
    ...initial,
    coverage: {
      ...coverage,
      phase: 'turn',
      initialContext: coverage,
      toolReads: [...reads],
      restoredSources,
      complete,
      // Counts stay attached to the initial packet; receipts have per-read
      // counts. Adding them would double count repeated and overlapping pages.
      searchedDomains: [
        ...new Set([...coverage.searchedDomains, ...reads.map((read) => read.source)]),
      ],
      missingDomains,
      partialDomains,
      sourceHealth,
      unavailableSources,
      toolsInvoked: [...new Set([...coverage.toolsInvoked, ...reads.map((read) => read.tool)])],
      paginationComplete:
        coverage.paginationComplete && reads.every((read) => read.paginationComplete !== false),
      truncated: coverage.truncated || reads.some((read) => read.truncated),
      stopReason: complete ? 'complete' : 'turn_coverage_partial',
    },
  };
}
