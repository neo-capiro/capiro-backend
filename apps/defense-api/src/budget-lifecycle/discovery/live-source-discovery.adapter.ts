/**
 * Phase 8 Session 8 — live source discovery adapter.
 *
 * This is the Session 8 deliverable: a `SourceDiscoveryPort` that produces
 * candidates by actually crawling publishers, in place of Session 7's
 * version-pinned manifest.
 *
 * The port contract is unchanged on purpose. Session 7's design stated that
 * swapping the manifest for a live crawler "changes where candidates come from
 * and nothing about the decisions taken around them", so fingerprinting, revision
 * detection, classification, supersession, idempotency, concurrency and queueing
 * all remain exactly where they were. Nothing in this file writes an observation,
 * advances a stage, or asserts a dollar.
 *
 * What it adds, and enforces:
 *
 *  * the official-host rule, applied to every emitted candidate through the same
 *    `assertAuthoritativeHost` the manifest adapter used — a crawler is the case
 *    that rule exists for;
 *  * a bounded, resumable request budget, because the real `BILLS_2023` sitemap
 *    holds 13,354 packages;
 *  * an append-only audit row for every crawl and every candidate decision, so
 *    "found nothing" and "discarded everything" are distinguishable;
 *  * fail-closed resolution: a candidate that cannot be tied to a registered
 *    expected source is recorded with a reason and never given an invented key.
 *
 * The manifest adapter is deliberately left in place. It is what the Session 7
 * historical replay runs against, and a deterministic offline discovery source
 * stays useful for exactly that.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  assertFiscalYear,
  createRequestBudget,
  emptyDiscoveryCursor,
  hasPendingBackfill,
  parseDiscoveryCursor,
  rollingCycleHorizon,
  serialiseDiscoveryCursor,
  type DiscoveryCursor,
} from '@capiro/defense-domain';

import { SourceAdapterRegistry } from '../source-adapter.registry.js';
import type { DiscoveredCandidate, SourceDiscoveryPort } from '../lifecycle-ports.js';
import {
  DISCOVERY_AUDIT_STORE,
  type DiscoveryAuditStore,
  type NewDiscoveryCandidate,
  type NewDiscoveryCrawl,
} from './discovery-audit.port.js';
import { GovInfoSitemapCrawler } from './govinfo-sitemap.crawler.js';
import { IndexPageCrawler } from './index-page.crawler.js';
import {
  DEFAULT_DISCOVERY_REQUEST_BUDGET,
  type CrawlContext,
  type PublisherCrawler,
} from './publisher-crawler.js';

export interface LiveSourceDiscoveryOptions {
  /** Hard per-run request ceiling. Bounded so a cold backfill cannot run away. */
  readonly requestBudget?: number;
  /** Prior/upcoming fiscal years kept crawlable, mirroring the cycle horizon. */
  readonly priorYears?: number;
  readonly upcomingYears?: number;
  /**
   * Authoritative fiscal-year scope for an EXPLICIT bounded backfill (Phase 10),
   * as opposed to the ordinary rolling watch horizon. When set, discovery
   * resolves registered expected sources for exactly these years — never widened
   * with wall-clock years, never gap-filled. Omit for normal scheduled/live
   * discovery, which keeps the unchanged `rollingCycleHorizon` behavior below.
   */
  readonly horizonFiscalYears?: readonly number[];
}

export class InvalidHorizonFiscalYearsError extends Error {
  constructor(readonly value: unknown) {
    super(
      `an explicit horizonFiscalYears override must be a non-empty array of valid fiscal years, got: ${JSON.stringify(value)}`,
    );
    this.name = 'InvalidHorizonFiscalYearsError';
  }
}

/**
 * Resolve the discovery horizon: an explicit override is authoritative and used
 * EXACTLY as given (normalized — deduped, sorted, fiscal-year-bounds-checked —
 * but never widened with wall-clock years or gap-filled). Omitting the override
 * preserves the existing rolling prior/current/upcoming behavior unchanged, so
 * ordinary scheduled/live discovery (including any scheduler-owned tick) is
 * untouched by this function's existence.
 *
 * This is what closed the Phase 10 FY2024 defect: an explicit historical/future
 * backfill's requested fiscal years were previously discarded in favour of a
 * horizon recomputed from `nowIso`, so a year outside `current ± 1` (e.g. FY2024
 * from a 2026 execution) could never be crawled no matter how many times the job
 * was retried.
 */
export function resolveDiscoveryHorizon(
  nowIso: string,
  options: Pick<LiveSourceDiscoveryOptions, 'horizonFiscalYears' | 'priorYears' | 'upcomingYears'>,
): readonly number[] {
  if (options.horizonFiscalYears === undefined) {
    return rollingCycleHorizon(nowIso, {
      priorYears: options.priorYears ?? 1,
      upcomingYears: options.upcomingYears ?? 1,
    });
  }
  if (!Array.isArray(options.horizonFiscalYears) || options.horizonFiscalYears.length === 0) {
    throw new InvalidHorizonFiscalYearsError(options.horizonFiscalYears);
  }
  const validated = options.horizonFiscalYears.map((year) => assertFiscalYear(year));
  return Object.freeze([...new Set(validated)].sort((a, b) => a - b));
}

@Injectable()
export class LiveSourceDiscoveryAdapter implements SourceDiscoveryPort {
  private readonly logger = new Logger(LiveSourceDiscoveryAdapter.name);

  constructor(
    private readonly registry: SourceAdapterRegistry,
    private readonly govinfo: GovInfoSitemapCrawler,
    private readonly indexPages: IndexPageCrawler,
    @Inject(DISCOVERY_AUDIT_STORE) private readonly audit: DiscoveryAuditStore,
    private readonly options: LiveSourceDiscoveryOptions = {},
  ) {}

  async discover(input: {
    adapterId: string;
    cursor: Record<string, unknown>;
    nowIso: string;
  }): Promise<{ candidates: readonly DiscoveredCandidate[]; cursor: Record<string, unknown> }> {
    const adapter = this.registry.get(input.adapterId);

    // A non-authoritative adapter could never satisfy an expected source, so
    // crawling one would be pure cost. Session 7 registers none; the flag exists
    // so adding one cannot silently promote a hint into evidence.
    if (!adapter.authoritative) {
      this.logger.warn(
        `${adapter.adapterId} is a discovery-hint adapter; live crawling is skipped because its ` +
          'bytes can never become authoritative funding evidence.',
      );
      return { candidates: Object.freeze([]), cursor: input.cursor };
    }

    const horizonFiscalYears = resolveDiscoveryHorizon(input.nowIso, this.options);

    const registeredExpectedSourceKeys =
      await this.audit.loadRegisteredExpectedSourceKeys(horizonFiscalYears);

    if (registeredExpectedSourceKeys.size === 0) {
      // Nothing is expected, so nothing could resolve. Crawling would spend a
      // publisher's bandwidth to discard every result.
      this.logger.warn(
        `${adapter.adapterId}: no expected sources are registered for FY ` +
          `${horizonFiscalYears.join('/')}; run the cycle controller before the watcher.`,
      );
      return { candidates: Object.freeze([]), cursor: input.cursor };
    }

    const context: CrawlContext = Object.freeze({
      adapter,
      nowIso: input.nowIso,
      runKey: `${adapter.adapterId}:${input.nowIso}`,
      cursor: parseDiscoveryCursor(input.cursor),
      horizonFiscalYears,
      registeredExpectedSourceKeys,
      budget: createRequestBudget(this.options.requestBudget ?? DEFAULT_DISCOVERY_REQUEST_BUDGET),
    });

    const crawler = this.crawlerFor(adapter.discoveryMode);
    const product = await crawler.crawl(context);

    await this.persistAudit(product.crawls, product.auditCandidates);

    // Same rule a manifest entry had to satisfy. A crawler is why it exists: if a
    // publisher page links off-host, or a redirect moved us, the candidate dies
    // here rather than becoming an observation.
    const emitted: DiscoveredCandidate[] = [];
    for (const candidate of product.candidates) {
      try {
        this.registry.assertAuthoritativeHost(candidate.adapterId, candidate.url);
        emitted.push(candidate);
      } catch (error) {
        this.logger.warn(
          `${adapter.adapterId}: refused non-official candidate ${candidate.url}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (hasPendingBackfill(product.cursor)) {
      this.logger.warn(
        `${adapter.adapterId}: backlog remains after this run (request budget ` +
          `${context.budget.limit}). The cursor was not advanced past unexamined work; ` +
          'the next run resumes there.',
      );
    }

    return {
      candidates: Object.freeze(emitted),
      cursor: serialiseDiscoveryCursor(product.cursor),
    };
  }

  private crawlerFor(mode: string): PublisherCrawler {
    switch (mode) {
      case 'api':
        // The GovInfo sitemap channel is the key-free API-mode implementation.
        // Both official JSON APIs answer an unauthenticated request with
        // API_KEY_MISSING, so a credential-free deployment uses sitemaps.
        return this.govinfo;
      case 'index_page':
      case 'feed':
      case 'conditional_http':
        return this.indexPages;
      default:
        throw new Error(`Unsupported discovery mode: ${mode}`);
    }
  }

  private async persistAudit(
    crawls: readonly NewDiscoveryCrawl[],
    candidates: readonly NewDiscoveryCandidate[],
  ): Promise<void> {
    // Candidates are attributed to the crawl that produced them where possible;
    // otherwise to the first crawl of the run, so no decision is orphaned.
    let primaryCrawlId: string | null = null;
    for (const crawl of crawls) {
      const stored = await this.audit.recordCrawl(crawl);
      primaryCrawlId ??= stored.id;
    }
    if (primaryCrawlId && candidates.length > 0) {
      await this.audit.recordCandidates({ crawlId: primaryCrawlId, candidates });
    }
  }
}

/** Exposed for tests that need a known-empty starting cursor. */
export function initialDiscoveryCursor(): DiscoveryCursor {
  return emptyDiscoveryCursor();
}
