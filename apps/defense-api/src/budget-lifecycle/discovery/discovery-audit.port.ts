/**
 * Phase 8 Session 8 — discovery audit port.
 *
 * A live crawl makes decisions about documents it then declines to emit. On the
 * real `BILLS_2023` sitemap that is 13,354 packages examined for a handful that
 * resolve. If those decisions were not recorded, "discovery found nothing" and
 * "discovery threw everything away" would look identical, and the guarantee that
 * nothing is silently dropped would be unverifiable.
 *
 * So every crawl request and every candidate decision is persisted, append-only.
 * The job role has INSERT and UPDATE but no DELETE on these tables, exactly as
 * for the Session 7 control-plane tables, so the crawl history is auditable
 * after the fact.
 *
 * These rows are provenance, not facts about money. No table reachable from here
 * has a monetary column, and the rehearsal asserts that against
 * `information_schema` rather than trusting the claim.
 */

import type { CandidateResolutionOutcome } from '@capiro/defense-domain';

export type DiscoveryCrawlStatus =
  | 'succeeded'
  | 'blocked_by_publisher'
  | 'blocked_by_robots'
  | 'unreachable'
  | 'budget_exhausted';

export interface NewDiscoveryCrawl {
  readonly adapterId: string;
  readonly runKey: string;
  readonly requestUrl: string;
  readonly resourceKind: 'robots' | 'sitemap_index' | 'sitemap' | 'listing' | 'feed' | 'metadata';
  readonly statusCode: number | null;
  readonly status: DiscoveryCrawlStatus;
  /** SHA-256 of the retrieved listing bytes; the crawl's own content identity. */
  readonly contentSha256: string | null;
  readonly byteSize: number | null;
  readonly itemsSeen: number;
  readonly robotsUnavailable: boolean;
  readonly effectiveIntervalMs: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly failureReason: string | null;
}

export interface NewDiscoveryCandidate {
  readonly adapterId: string;
  readonly runKey: string;
  readonly candidateUrl: string;
  readonly packageId: string | null;
  readonly title: string | null;
  readonly resolution: CandidateResolutionOutcome;
  /** Non-null only for a resolved candidate. Enforced by a database CHECK. */
  readonly expectedSourceDedupKey: string | null;
  readonly classifiedFiscalYear: number | null;
  readonly reason: string;
  readonly emitted: boolean;
  readonly observedAt: string;
}

export interface DiscoveryAuditStore {
  /** Returns the crawl row id so candidates can be attributed to their crawl. */
  recordCrawl(crawl: NewDiscoveryCrawl): Promise<{ id: string }>;

  /**
   * Idempotent by `(adapter, run key, candidate url)`. A retried run must not
   * duplicate the audit trail.
   */
  recordCandidates(input: {
    crawlId: string;
    candidates: readonly NewDiscoveryCandidate[];
  }): Promise<{ inserted: number }>;

  /**
   * Atomically reserve the next request slot for a host and report how long the
   * caller must wait. One statement, so two concurrent workers crawling two
   * adapters that share a host cannot both decide they may go now.
   */
  reserveHostSlot(input: {
    host: string;
    intervalMs: number;
    nowIso: string;
  }): Promise<{ waitMs: number; reservedAt: string }>;

  /** Expected-source dedup keys registered for the given fiscal years. */
  loadRegisteredExpectedSourceKeys(fiscalYears: readonly number[]): Promise<ReadonlySet<string>>;
}

export const DISCOVERY_AUDIT_STORE = Symbol('DISCOVERY_AUDIT_STORE');
