import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { meriToolCoverageCatalogEntry } from '../retrieval/meri-tool-catalog.js';
import {
  completeDocumentPages,
  documentPageReceipt,
  type DocumentPageReceipt,
} from './meriv3-document-completion.js';
import {
  coalesceMeriMailPages,
  observeMeriToolCoverage,
  type MeriMailPageReceipt,
} from '../retrieval/meri-retrieval-coverage.js';

type InitialRetrieval = MeriGovernedTurnContext['retrieval'];
type Status = InitialRetrieval['coverage']['sourceHealth'][number]['status'];

/** A receipt describes one read, never the unique size of an entire data source. */
export interface MeriToolCoverageReceipt {
  source: string;
  tool: string;
  status: Status;
  recordsReturned: number | null;
  /** Records actually inspected by the source, only when explicitly reported. */
  recordsEvaluated: number | null;
  /** Matching records in this query/section, including records outside this page. */
  recordsMatched?: number | null;
  /** Returned records shown to the model after any evidence projection. */
  recordsDisplayed?: number | null;
  /** Returned records omitted from model evidence; never inferred from total matches. */
  recordsOmitted?: number | null;
  paginationComplete: boolean | null;
  truncated: boolean;
  lastSyncAt?: string;
  detail?: string;
  /** Bounded primitive route keys used to keep parallel reads distinct. */
  requestRoute?: Record<string, string | number | boolean>;
  mailPage?: MeriMailPageReceipt;
  documentPage?: DocumentPageReceipt;
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
  options: { isolated?: boolean; displayed?: number | null; projected?: boolean } = {},
): MeriToolCoverageReceipt {
  // Multi-source manifests and profile sections have independent count scopes.
  // A payload-wide total, array or projection must never fill a missing section count.
  const fallback = options.isolated ? {} : payload;
  const projection = object(fallback.projection);
  const pagination = object(raw.pagination) ?? object(fallback.pagination);
  const returned = count(
    raw.sourceReturned,
    projection?.sourceRecordCount,
    raw.returned,
    raw.recordsReturned,
    fallback.returned,
    fallback.recordsReturned,
    ...['records', 'results', 'documents', 'data', 'items', 'messages'].map((key) =>
      Array.isArray(fallback[key]) ? fallback[key].length : undefined,
    ),
  );
  const evaluated = count(raw.recordsEvaluated, fallback.recordsEvaluated);
  const matched = count(raw.totalMatches, raw.total, fallback.totalMatches, fallback.total);
  const displayed = count(
    options.displayed,
    raw.recordsDisplayed,
    projection?.shownRecordCount,
    fallback.recordsDisplayed,
    // A section projection preserves its original sourceReturned separately.
    raw.sourceReturned !== undefined ? raw.returned : undefined,
    ...['records', 'results', 'documents', 'data', 'items', 'messages'].map((key) =>
      Array.isArray(fallback[key]) ? fallback[key].length : undefined,
    ),
  );
  // A receipt-only returned count does not prove that any record body was
  // displayed. Keep that count unknown unless the visible payload establishes it.
  const omitted =
    returned !== null && displayed !== null && displayed <= returned ? returned - displayed : null;
  const hasMore =
    raw.hasMore === true ||
    raw.nextCursor != null ||
    pagination?.hasMore === true ||
    fallback.hasMore === true ||
    fallback.nextCursor != null;
  const truncated =
    (omitted !== null && omitted > 0) ||
    raw.truncated === true ||
    raw.truncatedByProjection === true ||
    options.projected === true ||
    fallback.truncated === true ||
    fallback.contentTruncated === true ||
    projection?.truncated === true;
  const paginationComplete =
    hasMore || raw.paginationComplete === false || pagination?.complete === false
      ? false
      : raw.paginationComplete === true || pagination?.complete === true
        ? true
        : null;
  const sourceStatus = String(
    raw.sourceStatus ?? raw.status ?? fallback.sourceStatus ?? fallback.status ?? '',
  );
  const unavailable = /^(unavailable|disabled|unsupported|not_configured|unauthorized)$/.test(
    sourceStatus,
  );
  const failed = Boolean(
    raw.error || fallback.error || fallback.blocked || /^(error|failed)$/.test(sourceStatus),
  );
  const fullyRead =
    (raw.coverageComplete === true || raw.complete === true) &&
    !truncated &&
    !hasMore &&
    paginationComplete !== false &&
    raw.partial !== true &&
    fallback.partial !== true &&
    !['partial', 'degraded', 'unknown'].includes(sourceStatus);
  const status: Status = unavailable
    ? 'unavailable'
    : failed
      ? 'error'
      : fullyRead
        ? 'complete'
        : 'partial';
  return {
    source,
    tool,
    status,
    recordsReturned: returned,
    recordsEvaluated: evaluated,
    recordsMatched: matched,
    recordsDisplayed: displayed,
    recordsOmitted: omitted,
    paginationComplete,
    truncated,
    ...(date(raw.lastSyncAt) ? { lastSyncAt: date(raw.lastSyncAt) } : {}),
    ...(typeof raw.stopReason === 'string'
      ? { detail: raw.stopReason }
      : typeof fallback.sourceReason === 'string'
        ? { detail: fallback.sourceReason }
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
  if (tool === 'list_emails' || tool === 'search_emails') {
    // Reuse the existing source observer; thread grouping is only a compatibility
    // view and must never replace canonical message totals or mail sync health.
    const observed = observeMeriToolCoverage(tool, {}, payload);
    const mailboxes = Array.isArray(payload.searchedMailboxes) ? payload.searchedMailboxes : [];
    const mailCoverageKnown =
      mailboxes.length > 0 && mailboxes.every((box) => object(object(box)?.mailCoverage));
    const unavailable = Array.isArray(payload.searchedMailboxes) && mailboxes.length === 0;
    return [
      {
        ...receipt(
          tool,
          'mail',
          {
            returned: observed.returned,
            recordsEvaluated: count(payload.recordsEvaluated),
            totalMatches: observed.total,
            hasMore: observed.hasMore,
            truncated: payload.truncated === true,
            complete: mailCoverageKnown && observed.status === 'complete',
            paginationComplete: !observed.hasMore && payload.hasMore === false,
            sourceStatus: unavailable ? 'unavailable' : observed.status,
            ...(unavailable
              ? { stopReason: 'no_connected_mailbox' }
              : observed.sourceHealth.find((source) => source.detail)?.detail
                ? { stopReason: observed.sourceHealth.find((source) => source.detail)!.detail }
                : {}),
          },
          payload,
        ),
        ...(observed.mailPage ? { mailPage: observed.mailPage } : {}),
      },
    ];
  }
  const coverage = object(payload.coverage);
  if (Array.isArray(coverage?.sources)) {
    const sources = coverage.sources;
    return sources.flatMap((value) => {
      const source = object(value);
      return source && typeof source.domain === 'string'
        ? [
            receipt(tool, source.domain, source, payload, {
              isolated: sources.length > 1,
              // Domain-bearing projected rows can be counted at the source scope.
              ...(Array.isArray(payload.records) &&
              payload.records.every((row) => typeof object(row)?.domain === 'string')
                ? {
                    displayed: payload.records.filter(
                      (row) => object(row)?.domain === source.domain,
                    ).length,
                  }
                : {}),
              projected: object(payload.projection)?.truncated === true,
            }),
          ]
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
        {},
        {
          isolated: true,
          displayed: Array.isArray(object(payload.profile)?.[name])
            ? (object(payload.profile)![name] as unknown[]).length
            : null,
          projected: section.truncatedByProjection === true,
        },
      );
      return [{ ...observed, detail: `profile_section:${name}` }];
    });
  }
  if (tool === 'search_sam_opportunities') {
    const freshness = Array.isArray(payload.sourceFreshness)
      ? payload.sourceFreshness.map(object).find((row) => row?.source === 'sam_gov')
      : null;
    return [
      receipt(
        tool,
        'contracts_opportunities',
        {
          ...(coverage ?? {}),
          lastSyncAt: freshness?.lastSyncedAt,
        },
        payload,
      ),
    ];
  }
  const coveredDomains = domains(tool);
  if (tool === 'read_client_documents') {
    const page = documentPageReceipt(payload);
    return coveredDomains.map((domain) => ({
      ...receipt(tool, domain, coverage ?? {}, payload),
      ...(page ? { documentPage: page } : {}),
    }));
  }
  if (coveredDomains.length <= 1)
    return coveredDomains.map((domain) => receipt(tool, domain, coverage ?? {}, payload));
  // The catalog records a tool's capabilities, not a per-source inventory. A
  // combined grants/contracts result cannot assign its entire count to both.
  const {
    returned: _returned,
    recordsReturned: _recordsReturned,
    sourceReturned: _sourceReturned,
    total: _total,
    totalMatches: _totalMatches,
    recordsEvaluated: _recordsEvaluated,
    recordsDisplayed: _recordsDisplayed,
    ...health
  } = coverage ?? {};
  return coveredDomains.map((domain) =>
    receipt(
      tool,
      domain,
      {
        ...health,
        complete: false,
        coverageComplete: false,
        sourceStatus: health.sourceStatus ?? payload.sourceStatus ?? payload.status,
        error: health.error ?? payload.error ?? payload.blocked,
        stopReason: health.stopReason ?? payload.sourceReason ?? 'per_source_counts_not_reported',
      },
      {},
      { isolated: true, projected: object(payload.projection)?.truncated === true },
    ),
  );
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
  const individualReads = reads;
  const documentIds = [
    ...new Set(reads.flatMap((read) => (read.documentPage ? [read.documentPage.documentId] : []))),
  ];
  reads = [
    ...reads.filter((read) => !read.documentPage),
    ...documentIds.map((id): MeriToolCoverageReceipt => {
      const pages = reads.filter((read) => read.documentPage?.documentId === id);
      const complete = completeDocumentPages(
        pages.map((read) => read.documentPage!).filter((page) => !page.query),
      );
      return {
        ...pages[0]!,
        status: complete ? 'complete' : 'partial',
        // Individual page counts/ranges remain on toolReads. Do not add pages
        // together as if they were distinct source documents.
        recordsReturned: null,
        recordsDisplayed: null,
        paginationComplete: complete,
        truncated: !complete,
        detail: complete ? 'selected_document_fully_read' : 'selected_document_read_incomplete',
      };
    }),
  ];

  const mailPages = reads.filter((read) => read.mailPage);
  reads = [
    ...reads.filter((read) => !read.mailPage),
    ...coalesceMeriMailPages(
      mailPages.map((read) => ({
        tool: read.tool,
        domains: ['mail'],
        returned: read.recordsDisplayed ?? read.recordsReturned ?? 0,
        total: read.recordsMatched ?? null,
        hasMore: read.paginationComplete === false,
        truncated: read.truncated,
        status:
          read.status === 'error'
            ? 'error'
            : read.status === 'unavailable'
              ? 'unavailable'
              : read.status === 'complete'
                ? 'complete'
                : 'partial',
        sourceHealth: [],
        mailPage: read.mailPage,
        detail: read.detail,
      })),
    ).map(
      (observed): MeriToolCoverageReceipt => ({
        source: 'mail',
        tool: observed.tool,
        status: observed.status,
        recordsReturned: observed.returned,
        recordsEvaluated: null,
        recordsMatched: observed.total,
        paginationComplete: !observed.hasMore,
        truncated: observed.truncated,
        ...(observed.detail ? { detail: observed.detail } : {}),
      }),
    ),
  ];
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
      toolReads: [...individualReads],
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
