/**
 * Phase 10B-5 — Prisma-backed expected-source catalog.
 *
 * Same raw-SQL posture as PrismaDiscoveryAuditStore: read-only SELECT against
 * the existing `defense_budget_expected_source` / `defense_budget_cycle`
 * tables. No write statement exists in this file.
 */

import { Injectable } from '@nestjs/common';

import type { CatalogExpectedSource, ExpectedSourceCatalogPort } from './expected-source-catalog.port.js';

export interface RawSqlExecutor {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

@Injectable()
export class PrismaExpectedSourceCatalog implements ExpectedSourceCatalogPort {
  constructor(private readonly sql: RawSqlExecutor) {}

  async listExpectedSourcesForAdapter(input: {
    adapterId: string;
    fiscalYears: readonly number[];
  }): Promise<readonly CatalogExpectedSource[]> {
    if (input.fiscalYears.length === 0) return [];

    const rows = await this.sql.$queryRawUnsafe<
      {
        id: string;
        dedup_key: string;
        fiscal_year: number;
        authority_track: string;
        source_family: string;
        stage: string;
        chamber: string | null;
        committee: string | null;
        component: string | null;
        adapter_id: string;
      }[]
    >(
      `SELECT es.id::text AS id, es.dedup_key, es.fiscal_year, es.authority_track,
              es.source_family, es.stage, es.chamber, es.committee, es.component,
              es.adapter_id
         FROM defense_budget_expected_source es
        WHERE es.adapter_id = $1
          AND es.fiscal_year = ANY($2::int[])
        ORDER BY es.dedup_key`,
      input.adapterId,
      input.fiscalYears,
    );

    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          expectedSourceId: row.id,
          dedupKey: row.dedup_key,
          fiscalYear: row.fiscal_year,
          authorityTrack: row.authority_track as CatalogExpectedSource['authorityTrack'],
          sourceFamily: row.source_family as CatalogExpectedSource['sourceFamily'],
          stage: row.stage as CatalogExpectedSource['stage'],
          chamber: row.chamber as CatalogExpectedSource['chamber'],
          committee: row.committee,
          component: row.component as CatalogExpectedSource['component'],
          adapterId: row.adapter_id,
        }),
      ),
    );
  }
}
