/**
 * Phase 8 Session 8 — Prisma-backed discovery audit store.
 *
 * Parameterised raw SQL, for the same reason as the Session 7 store: the Session
 * 8 tables are deliberately absent from the curated `defense-api` HTTP Prisma
 * subset, because nothing in the HTTP surface reads them. Adding them there is
 * part of the product cutover, not this session.
 *
 * Regression guard carried forward from Sessions 6 and 7: `$queryRawUnsafe` does
 * not know column types, so every uuid/timestamp/int/boolean placeholder is cast
 * explicitly. An uncast uuid parameter silently becomes text and the insert fails
 * at runtime rather than at review time.
 *
 * No statement here deletes. The crawl history is append-only by grant and by
 * construction.
 */

import { Injectable } from '@nestjs/common';

import type {
  DiscoveryAuditStore,
  NewDiscoveryCandidate,
  NewDiscoveryCrawl,
} from './discovery-audit.port.js';

/** Minimal surface actually used, so this store needs no generated client. */
export interface RawSqlExecutor {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

@Injectable()
export class PrismaDiscoveryAuditStore implements DiscoveryAuditStore {
  constructor(private readonly sql: RawSqlExecutor) {}

  async recordCrawl(crawl: NewDiscoveryCrawl): Promise<{ id: string }> {
    const rows = await this.sql.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO defense_budget_discovery_crawl (
         adapter_id, run_key, request_url, resource_kind, status_code, status,
         content_sha256, byte_size, items_seen, robots_unavailable,
         effective_interval_ms, started_at, finished_at, failure_reason
       ) VALUES (
         $1, $2, $3, $4, $5::int, $6,
         $7, $8::int, $9::int, $10::boolean,
         $11::int, $12::timestamptz, $13::timestamptz, $14
       )
       RETURNING id::text AS id`,
      crawl.adapterId,
      crawl.runKey,
      crawl.requestUrl,
      crawl.resourceKind,
      crawl.statusCode,
      crawl.status,
      crawl.contentSha256,
      crawl.byteSize,
      crawl.itemsSeen,
      crawl.robotsUnavailable,
      crawl.effectiveIntervalMs,
      crawl.startedAt,
      crawl.finishedAt,
      crawl.failureReason,
    );

    const id = rows[0]?.id;
    if (!id) throw new Error('recordCrawl did not return a crawl id');
    return { id };
  }

  async recordCandidates(input: {
    crawlId: string;
    candidates: readonly NewDiscoveryCandidate[];
  }): Promise<{ inserted: number }> {
    let inserted = 0;
    for (const candidate of input.candidates) {
      const rows = await this.sql.$queryRawUnsafe<{ inserted: boolean }[]>(
        `INSERT INTO defense_budget_discovery_candidate (
           crawl_id, adapter_id, run_key, candidate_url, package_id, title,
           resolution, expected_source_dedup_key, classified_fiscal_year,
           reason, emitted, observed_at
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6,
           $7, $8, $9::int,
           $10, $11::boolean, $12::timestamptz
         )
         -- A retried run must not duplicate the audit trail.
         ON CONFLICT (adapter_id, run_key, candidate_url) DO NOTHING
         RETURNING TRUE AS inserted`,
        input.crawlId,
        candidate.adapterId,
        candidate.runKey,
        candidate.candidateUrl,
        candidate.packageId,
        candidate.title,
        candidate.resolution,
        candidate.expectedSourceDedupKey,
        candidate.classifiedFiscalYear,
        candidate.reason,
        candidate.emitted,
        candidate.observedAt,
      );
      if (rows.length > 0) inserted += 1;
    }
    return { inserted };
  }

  /**
   * Reserve the next slot for a host in ONE atomic statement.
   *
   * `GREATEST(stored, now) + interval` both advances the reservation and reports
   * the previous value, so two concurrent workers crawling two adapters that
   * share a host serialise on the row rather than both deciding they may go now.
   * This is the same single-statement pattern as the Session 7 adapter lease.
   */
  async reserveHostSlot(input: {
    host: string;
    intervalMs: number;
    nowIso: string;
  }): Promise<{ waitMs: number; reservedAt: string }> {
    const rows = await this.sql.$queryRawUnsafe<
      { wait_ms: string | number; reserved_at: string }[]
    >(
      `INSERT INTO defense_budget_discovery_host_budget AS hb (
         host, next_request_allowed_at, last_reserved_at, reservation_count
       ) VALUES (
         $1,
         $2::timestamptz + make_interval(secs => $3::numeric / 1000.0),
         $2::timestamptz,
         1
       )
       ON CONFLICT (host) DO UPDATE SET
         next_request_allowed_at =
           GREATEST(hb.next_request_allowed_at, $2::timestamptz)
           + make_interval(secs => $3::numeric / 1000.0),
         last_reserved_at = $2::timestamptz,
         reservation_count = hb.reservation_count + 1,
         updated_at = CURRENT_TIMESTAMP
       RETURNING
         GREATEST(
           0,
           EXTRACT(EPOCH FROM (
             hb.next_request_allowed_at
             - make_interval(secs => $3::numeric / 1000.0)
             - $2::timestamptz
           )) * 1000
         )::bigint AS wait_ms,
         hb.next_request_allowed_at::text AS reserved_at`,
      input.host,
      input.nowIso,
      input.intervalMs,
    );

    const row = rows[0];
    if (!row) throw new Error(`reserveHostSlot returned no row for host ${input.host}`);
    return {
      waitMs: Math.max(0, Number(row.wait_ms)),
      reservedAt: row.reserved_at,
    };
  }

  async loadRegisteredExpectedSourceKeys(
    fiscalYears: readonly number[],
  ): Promise<ReadonlySet<string>> {
    if (fiscalYears.length === 0) return new Set<string>();

    const rows = await this.sql.$queryRawUnsafe<{ dedup_key: string }[]>(
      `SELECT es.dedup_key AS dedup_key
         FROM defense_budget_expected_source es
         JOIN defense_budget_cycle c ON c.id = es.cycle_id
        WHERE c.fiscal_year = ANY($1::int[])`,
      fiscalYears,
    );

    return new Set(rows.map((row) => row.dedup_key));
  }
}
