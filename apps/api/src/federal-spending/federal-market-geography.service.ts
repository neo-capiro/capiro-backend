import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  FederalMarketGeographyResponse,
  FederalMarketQuery,
  FederalMarketStateSubawardRow,
} from './federal-market.types.js';
import { FederalMarketService } from './federal-market.service.js';

const VISIBLE_CLIENT_FILTER = { status: { not: 'archived' }, profileStatus: 'ACTIVE' } as const;

interface ClientFederalScope {
  ueis: string[];
  names: string[];
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)),
    ),
  ];
}

function exactUei(value: string | null | undefined): string | null {
  const normalized = (value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{12}$/.test(normalized) ? normalized : null;
}

function whereSql(clauses: Prisma.Sql[]): Prisma.Sql {
  return clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}` : Prisma.sql``;
}

/**
 * Composes the existing district-safe federal-market response with a second,
 * explicitly state-only subaward rail.
 *
 * Tango's documented subaward shape normally provides city/state/ZIP but no
 * congressional district. Those rows remain useful geographic evidence, but
 * attributing them to a district would be invented. They therefore never enter
 * `districts`; they are returned separately as `stateSubawards`.
 */
@Injectable()
export class FederalMarketGeographyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly market: FederalMarketService,
  ) {}

  async geography(
    tenantId: string,
    query: FederalMarketQuery,
  ): Promise<FederalMarketGeographyResponse> {
    const base = await this.market.geography(tenantId, query);

    // Guard against the federal statewide/non-voting sentinel codes. The
    // canonical District Nexus rail already treats these as unmapped rather
    // than manufacturing districts 90/98.
    const districts = base.districts.filter(
      (row) => !['90', '98', 'ZZ'].includes(row.district.trim().toUpperCase()),
    );

    try {
      const scope = await this.clientScope(tenantId, query.clientId);
      const clauses = this.stateSubawardClauses(query);
      if (scope) {
        const identity = this.subawardScopeSql(scope);
        clauses.push(identity ?? Prisma.sql`FALSE`);
      }
      const where = whereSql(clauses);
      const rows = await this.prisma.$queryRaw<
        Array<{ state: string; count: bigint; amount: number | null }>
      >(Prisma.sql`
        WITH filtered AS (
          SELECT *
            FROM tango_subaward
            ${where}
        )
        SELECT UPPER(TRIM(pop_state)) AS state,
               COUNT(*)::bigint AS count,
               SUM(subaward_amount)::float8 AS amount
          FROM filtered
         WHERE pop_state IS NOT NULL
           AND TRIM(pop_state) <> ''
           AND (
             pop_congressional_district IS NULL
             OR TRIM(pop_congressional_district) = ''
             OR UPPER(TRIM(pop_congressional_district)) IN ('90', '98', 'ZZ')
             OR NOT (
               UPPER(TRIM(pop_congressional_district)) ~ '^[0-9]{1,2}$'
               OR UPPER(TRIM(pop_congressional_district)) IN ('AL', 'AT LARGE', 'AT-LARGE')
             )
           )
         GROUP BY UPPER(TRIM(pop_state))
      `);

      const stateSubawards: FederalMarketStateSubawardRow[] = rows
        .filter((row) => /^[A-Z]{2}$/.test(row.state))
        .map((row) => ({
          state: row.state,
          subawardCount: Number(row.count),
          subawardAmount: row.amount,
          geographyBasis: 'source_state_place_of_performance' as const,
        }))
        .sort(
          (a, b) =>
            (b.subawardAmount ?? 0) - (a.subawardAmount ?? 0) ||
            b.subawardCount - a.subawardCount ||
            a.state.localeCompare(b.state),
        );

      return { ...base, districts, stateSubawards };
    } catch {
      return {
        ...base,
        districts,
        stateSubawards: [],
        warnings: [...base.warnings, 'state-level subaward geography unavailable'],
      };
    }
  }

  private async clientScope(
    tenantId: string,
    clientId?: string,
  ): Promise<ClientFederalScope | null> {
    if (!clientId) return null;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, ...VISIBLE_CLIENT_FILTER },
        select: { id: true, uei: true },
      });
      if (!client) throw new NotFoundException('Client not found');
      const mappings = await tx.clientIntelMapping.findMany({
        where: {
          clientId,
          confirmed: true,
          reviewStatus: 'confirmed',
          rollUpAwards: true,
          source: { in: ['contracting', 'assistance_recipient'] },
        },
        select: { externalId: true, externalName: true },
      });
      return {
        ueis: dedupe([
          exactUei(client.uei),
          ...mappings.map((mapping) => exactUei(mapping.externalId)),
        ]),
        names: dedupe(mappings.map((mapping) => mapping.externalName)).map((name) =>
          name.toLowerCase(),
        ),
      };
    });
  }

  private stateSubawardClauses(query: FederalMarketQuery): Prisma.Sql[] {
    const clauses: Prisma.Sql[] = [Prisma.sql`active = TRUE`];
    if (query.q) {
      const pattern = `%${query.q}%`;
      clauses.push(Prisma.sql`(
        prime_recipient_name ILIKE ${pattern}
        OR subawardee_name ILIKE ${pattern}
        OR awarding_agency ILIKE ${pattern}
        OR description ILIKE ${pattern}
        OR provider_key ILIKE ${pattern}
      )`);
    }
    if (query.agency) {
      clauses.push(Prisma.sql`awarding_agency ILIKE ${`%${query.agency}%`}`);
    }
    if (query.recipient) {
      const pattern = `%${query.recipient}%`;
      clauses.push(
        Prisma.sql`(prime_recipient_name ILIKE ${pattern} OR subawardee_name ILIKE ${pattern})`,
      );
    }
    if (query.state) clauses.push(Prisma.sql`UPPER(pop_state) = ${query.state.toUpperCase()}`);
    if (query.fiscalYear != null) clauses.push(Prisma.sql`fiscal_year = ${query.fiscalYear}`);
    if (query.dateFrom) clauses.push(Prisma.sql`action_date >= ${new Date(query.dateFrom)}`);
    if (query.dateTo) clauses.push(Prisma.sql`action_date <= ${new Date(query.dateTo)}`);
    return clauses;
  }

  private subawardScopeSql(scope: ClientFederalScope): Prisma.Sql | null {
    const options: Prisma.Sql[] = [];
    if (scope.ueis.length) {
      options.push(
        Prisma.sql`(
          prime_recipient_uei = ANY(${scope.ueis}::text[])
          OR subawardee_uei = ANY(${scope.ueis}::text[])
        )`,
      );
    }
    if (scope.names.length) {
      options.push(
        Prisma.sql`(
          lower(prime_recipient_name) = ANY(${scope.names}::text[])
          OR lower(subawardee_name) = ANY(${scope.names}::text[])
        )`,
      );
    }
    return options.length ? Prisma.sql`(${Prisma.join(options, ' OR ')})` : null;
  }
}
