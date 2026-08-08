import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  FederalContractMarketRow,
  FederalForecastMarketRow,
  FederalMarketDistrictRow,
  FederalMarketFutureSignal,
  FederalMarketGeographyResponse,
  FederalMarketPage,
  FederalMarketQuery,
  FederalSubawardMarketRow,
  FederalVehicleMarketRow,
} from './federal-market.types.js';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const VISIBLE_CLIENT_FILTER = { status: { not: 'archived' }, profileStatus: 'ACTIVE' } as const;

interface ClientFederalScope {
  ueis: string[];
  names: string[];
}

interface CountRow {
  count: bigint;
  asOf: Date | null;
}

function paging(query: FederalMarketQuery): { page: number; pageSize: number; offset: number } {
  const page = Math.max(Math.trunc(query.page ?? 1), 1);
  const pageSize = Math.min(
    Math.max(Math.trunc(query.pageSize ?? DEFAULT_PAGE_SIZE), 1),
    MAX_PAGE_SIZE,
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function districtKey(state: string | null, district: string | null): string | null {
  const s = state?.trim().toUpperCase();
  const raw = district?.trim().toUpperCase();
  if (!s || !/^[A-Z]{2}$/.test(s) || !raw) return null;
  if (raw === 'AL' || raw === 'AT LARGE' || raw === 'AT-LARGE' || raw === '0' || raw === '00') {
    return `${s}-00`;
  }
  if (!/^\d{1,2}$/.test(raw)) return null;
  return `${s}-${raw.padStart(2, '0')}`;
}

function lower(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)),
    ),
  ];
}

function isUei(value: string | null | undefined): value is string {
  return /^[A-Z0-9]{12}$/.test((value ?? '').trim().toUpperCase());
}

function whereSql(clauses: Prisma.Sql[]): Prisma.Sql {
  return clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}` : Prisma.empty;
}

const STATE_CODES = new Set([
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'DC',
  'PR',
  'VI',
  'GU',
  'AS',
  'MP',
]);

function stateFromText(value: string | null): string | null {
  if (!value) return null;
  for (const token of value.toUpperCase().split(/[^A-Z]+/)) {
    if (STATE_CODES.has(token)) return token;
  }
  return null;
}

function placeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

@Injectable()
export class FederalMarketService {
  constructor(private readonly prisma: PrismaService) {}

  async listContracts(
    tenantId: string,
    query: FederalMarketQuery,
  ): Promise<FederalMarketPage<FederalContractMarketRow>> {
    const scope = await this.clientScope(tenantId, query.clientId);
    const { page, pageSize, offset } = paging(query);
    const clauses = this.commonAwardClauses(query);
    if (scope) {
      const identity = this.contractScopeSql(scope);
      if (!identity) return this.emptyPage(page, pageSize, 'usaspending');
      clauses.push(identity);
    }
    const where = whereSql(clauses);
    const [countRows, rows] = await Promise.all([
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS count, MAX(last_synced_at) AS "asOf"
          FROM federal_award ${where}
      `),
      this.prisma.$queryRaw<
        Array<{
          id: string;
          awardId: string | null;
          recipientName: string | null;
          recipientUei: string | null;
          awardingAgency: string | null;
          amount: number | null;
          description: string | null;
          actionDate: Date | null;
          state: string | null;
          district: string | null;
          sourceUpdatedAt: Date | null;
        }>
      >(Prisma.sql`
        SELECT id::text AS id,
               award_unique_id AS "awardId",
               contractor_name AS "recipientName",
               recipient_uei AS "recipientUei",
               awarding_agency AS "awardingAgency",
               amount::float8 AS amount,
               description,
               action_date AS "actionDate",
               pop_state AS state,
               pop_congressional_district AS district,
               last_synced_at AS "sourceUpdatedAt"
          FROM federal_award ${where}
         ORDER BY action_date DESC NULLS LAST, id DESC
         LIMIT ${pageSize} OFFSET ${offset}
      `),
    ]);
    const count = countRows[0];
    return {
      items: rows.map((row) => ({
        ...row,
        actionDate: iso(row.actionDate),
        districtKey: districtKey(row.state, row.district),
        source: 'usaspending' as const,
        sourceUpdatedAt: iso(row.sourceUpdatedAt),
      })),
      total: Number(count?.count ?? 0n),
      page,
      pageSize,
      source: 'USAspending / Capiro first-party ingestion',
      asOf: iso(count?.asOf ?? null),
      generatedAt: new Date().toISOString(),
    };
  }

  async listSubawards(
    tenantId: string,
    query: FederalMarketQuery,
  ): Promise<FederalMarketPage<FederalSubawardMarketRow>> {
    const scope = await this.clientScope(tenantId, query.clientId);
    const { page, pageSize, offset } = paging(query);
    const clauses = this.commonSubawardClauses(query);
    if (scope) {
      const identity = this.subawardScopeSql(scope);
      if (!identity) return this.emptyPage(page, pageSize, 'tango');
      clauses.push(identity);
    }
    const where = whereSql(clauses);
    const [countRows, rows] = await Promise.all([
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS count, MAX(last_synced_at) AS "asOf"
          FROM tango_subaward ${where}
      `),
      this.prisma.$queryRaw<
        Array<{
          id: string;
          providerKey: string;
          awardKey: string | null;
          primeRecipientName: string | null;
          primeRecipientUei: string | null;
          subawardeeName: string | null;
          subawardeeUei: string | null;
          awardingAgency: string | null;
          awardingOffice: string | null;
          amount: number | null;
          description: string | null;
          actionDate: Date | null;
          fiscalYear: number | null;
          naicsCode: string | null;
          state: string | null;
          district: string | null;
          sourceUrl: string | null;
          sourceUpdatedAt: Date | null;
        }>
      >(Prisma.sql`
        SELECT id::text AS id,
               provider_key AS "providerKey",
               award_key AS "awardKey",
               prime_recipient_name AS "primeRecipientName",
               prime_recipient_uei AS "primeRecipientUei",
               subawardee_name AS "subawardeeName",
               subawardee_uei AS "subawardeeUei",
               awarding_agency AS "awardingAgency",
               awarding_office AS "awardingOffice",
               subaward_amount::float8 AS amount,
               description,
               action_date AS "actionDate",
               fiscal_year AS "fiscalYear",
               naics_code AS "naicsCode",
               pop_state AS state,
               pop_congressional_district AS district,
               source_url AS "sourceUrl",
               last_synced_at AS "sourceUpdatedAt"
          FROM tango_subaward ${where}
         ORDER BY action_date DESC NULLS LAST, provider_key DESC
         LIMIT ${pageSize} OFFSET ${offset}
      `),
    ]);
    const count = countRows[0];
    return {
      items: rows.map((row) => ({
        ...row,
        actionDate: iso(row.actionDate),
        districtKey: districtKey(row.state, row.district),
        source: 'tango' as const,
        sourceUpdatedAt: iso(row.sourceUpdatedAt),
      })),
      total: Number(count?.count ?? 0n),
      page,
      pageSize,
      source: 'MakeGov/Tango subaward intelligence',
      asOf: iso(count?.asOf ?? null),
      generatedAt: new Date().toISOString(),
    };
  }

  async listVehicles(
    tenantId: string,
    query: FederalMarketQuery,
  ): Promise<FederalMarketPage<FederalVehicleMarketRow>> {
    const { page, pageSize, offset } = paging(query);
    if (query.clientId) {
      await this.clientScope(tenantId, query.clientId);
      return this.prisma.withTenant(tenantId, async (tx) => {
        const where = {
          tenantId,
          clientId: query.clientId,
          ...(query.q
            ? {
                OR: [
                  { vehicleName: { contains: query.q, mode: 'insensitive' as const } },
                  { vehicleType: { contains: query.q, mode: 'insensitive' as const } },
                  { recipientUei: { contains: query.q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        };
        const [total, rows] = await Promise.all([
          tx.clientRelevantVehicle.count({ where }),
          tx.clientRelevantVehicle.findMany({
            where,
            orderBy: [{ lastSyncedAt: 'desc' }, { tangoVehicleId: 'asc' }],
            skip: offset,
            take: pageSize,
          }),
        ]);
        return {
          items: rows.map((row) => ({
            id: row.id,
            vehicleId: row.tangoVehicleId,
            name: row.vehicleName,
            solicitationIdentifier: null,
            vehicleType: row.vehicleType,
            agency: null,
            naicsCode: null,
            pscCode: null,
            setAside: null,
            lastDateToOrder: null,
            awardeeCount: null,
            orderCount: row.orderCount,
            totalObligated: row.idvObligations,
            relationship: row.relationship === 'self' ? 'self' : 'parent',
            recipientUei: row.recipientUei,
            source: 'tango' as const,
            sourceUpdatedAt: row.lastSyncedAt.toISOString(),
          })),
          total,
          page,
          pageSize,
          source: 'MakeGov/Tango vehicles matched to reviewed client identities',
          asOf: rows[0]?.lastSyncedAt.toISOString() ?? null,
          generatedAt: new Date().toISOString(),
        };
      });
    }

    const clauses: Prisma.Sql[] = [
      Prisma.sql`resource_type = 'vehicle'`,
      Prisma.sql`active = TRUE`,
    ];
    if (query.q) {
      const pattern = `%${query.q}%`;
      clauses.push(Prisma.sql`(
        normalized_jsonb->>'programAcronym' ILIKE ${pattern}
        OR normalized_jsonb->>'solicitationTitle' ILIKE ${pattern}
        OR normalized_jsonb->>'solicitationIdentifier' ILIKE ${pattern}
      )`);
    }
    if (query.agency)
      clauses.push(Prisma.sql`normalized_jsonb->>'agencyId' ILIKE ${`%${query.agency}%`}`);
    const where = whereSql(clauses);
    const [countRows, rows] = await Promise.all([
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS count, MAX(provider_fetched_at) AS "asOf"
          FROM tango_resource_snapshot ${where}
      `),
      this.prisma.$queryRaw<
        Array<{ id: string; externalId: string; data: unknown; sourceUpdatedAt: Date | null }>
      >(
        Prisma.sql`
          SELECT id::text AS id, external_id AS "externalId",
                 normalized_jsonb AS data,
                 COALESCE(source_updated_at, provider_fetched_at) AS "sourceUpdatedAt"
            FROM tango_resource_snapshot ${where}
           ORDER BY provider_fetched_at DESC, external_id
           LIMIT ${pageSize} OFFSET ${offset}
        `,
      ),
    ]);
    const count = countRows[0];
    return {
      items: rows.map((row) => this.vehicleFromSnapshot(row)),
      total: Number(count?.count ?? 0n),
      page,
      pageSize,
      source: 'MakeGov/Tango vehicle snapshots',
      asOf: iso(count?.asOf ?? null),
      generatedAt: new Date().toISOString(),
    };
  }

  async listForecasts(
    query: FederalMarketQuery,
  ): Promise<FederalMarketPage<FederalForecastMarketRow>> {
    const { page, pageSize, offset } = paging(query);
    const clauses: Prisma.Sql[] = [];
    if (query.q) {
      const pattern = `%${query.q}%`;
      clauses.push(
        Prisma.sql`(title ILIKE ${pattern} OR description ILIKE ${pattern} OR contract_vehicle ILIKE ${pattern})`,
      );
    }
    if (query.agency)
      clauses.push(
        Prisma.sql`COALESCE(organization_agency_name, agency, department_name) ILIKE ${`%${query.agency}%`}`,
      );
    if (query.state) clauses.push(Prisma.sql`place_of_performance ILIKE ${`%${query.state}%`}`);
    if (query.fiscalYear != null) clauses.push(Prisma.sql`fiscal_year = ${query.fiscalYear}`);
    const where = whereSql(clauses);
    const [countRows, rows] = await Promise.all([
      this.prisma.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS count, MAX(last_synced_at) AS "asOf"
          FROM tango_procurement_forecast ${where}
      `),
      this.prisma.$queryRaw<
        Array<{
          id: string;
          forecastId: string;
          title: string;
          description: string | null;
          agency: string | null;
          department: string | null;
          office: string | null;
          anticipatedAwardDate: Date | null;
          estimatedPeriod: string | null;
          fiscalYear: number | null;
          naicsCode: string | null;
          pscCode: string | null;
          setAside: string | null;
          contractVehicle: string | null;
          placeOfPerformance: string | null;
          contactName: string | null;
          contactEmail: string | null;
          status: string | null;
          active: boolean | null;
          sourceSystem: string | null;
          sourceUrl: string | null;
          sourceUpdatedAt: Date | null;
        }>
      >(Prisma.sql`
        SELECT id::text AS id,
               tango_forecast_id AS "forecastId",
               title, description,
               COALESCE(organization_agency_name, agency) AS agency,
               department_name AS department,
               office_name AS office,
               anticipated_award_date AS "anticipatedAwardDate",
               estimated_period AS "estimatedPeriod",
               fiscal_year AS "fiscalYear",
               naics_code AS "naicsCode",
               psc_code AS "pscCode",
               set_aside AS "setAside",
               contract_vehicle AS "contractVehicle",
               place_of_performance AS "placeOfPerformance",
               primary_contact_name AS "contactName",
               primary_contact_email AS "contactEmail",
               status, is_active AS active,
               source_system AS "sourceSystem",
               source_url AS "sourceUrl",
               COALESCE(provider_modified_at, last_synced_at) AS "sourceUpdatedAt"
          FROM tango_procurement_forecast ${where}
         ORDER BY anticipated_award_date ASC NULLS LAST, title, id
         LIMIT ${pageSize} OFFSET ${offset}
      `),
    ]);
    const count = countRows[0];
    return {
      items: rows.map((row) => ({
        ...row,
        anticipatedAwardDate: row.anticipatedAwardDate
          ? row.anticipatedAwardDate.toISOString().slice(0, 10)
          : null,
        source: 'tango' as const,
        sourceUpdatedAt: iso(row.sourceUpdatedAt),
      })),
      total: Number(count?.count ?? 0n),
      page,
      pageSize,
      source: 'MakeGov/Tango agency procurement forecasts',
      asOf: iso(count?.asOf ?? null),
      generatedAt: new Date().toISOString(),
    };
  }

  async geography(
    tenantId: string,
    query: FederalMarketQuery,
  ): Promise<FederalMarketGeographyResponse> {
    const scope = await this.clientScope(tenantId, query.clientId);
    const contractClauses = this.commonAwardClauses(query);
    const subawardClauses = this.commonSubawardClauses(query);
    if (scope) {
      const contractIdentity = this.contractScopeSql(scope);
      const subawardIdentity = this.subawardScopeSql(scope);
      if (contractIdentity) contractClauses.push(contractIdentity);
      else contractClauses.push(Prisma.sql`FALSE`);
      if (subawardIdentity) subawardClauses.push(subawardIdentity);
      else subawardClauses.push(Prisma.sql`FALSE`);
    }

    const [contracts, subawards, future] = await Promise.allSettled([
      this.aggregateContractGeography(whereSql(contractClauses)),
      this.aggregateSubawardGeography(whereSql(subawardClauses)),
      this.futureSignals(query),
    ]);

    const merged = new Map<string, FederalMarketDistrictRow>();
    if (contracts.status === 'fulfilled') {
      for (const row of contracts.value) merged.set(row.districtKey, row);
    }
    if (subawards.status === 'fulfilled') {
      for (const row of subawards.value) {
        const current = merged.get(row.districtKey);
        if (current) {
          current.subawardCount = row.subawardCount;
          current.subawardAmount = row.subawardAmount;
        } else merged.set(row.districtKey, row);
      }
    }
    const warnings: string[] = [];
    if (contracts.status === 'rejected') warnings.push('contract geography unavailable');
    if (subawards.status === 'rejected') warnings.push('subaward geography unavailable');
    if (future.status === 'rejected') warnings.push('future opportunity geography unavailable');

    return {
      districts: [...merged.values()].sort(
        (a, b) =>
          (b.contractAmount ?? 0) +
          (b.subawardAmount ?? 0) -
          ((a.contractAmount ?? 0) + (a.subawardAmount ?? 0)),
      ),
      futureSignals: future.status === 'fulfilled' ? future.value : [],
      awardedMoneyIncludesFutureOpportunities: false,
      warnings,
      generatedAt: new Date().toISOString(),
    };
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
          isUei(client.uei) ? client.uei.toUpperCase() : null,
          ...mappings.map((mapping) =>
            isUei(mapping.externalId) ? mapping.externalId.toUpperCase() : null,
          ),
        ]),
        names: lower(mappings.map((mapping) => mapping.externalName ?? '')),
      };
    });
  }

  private commonAwardClauses(query: FederalMarketQuery): Prisma.Sql[] {
    const clauses: Prisma.Sql[] = [];
    if (query.q) {
      const pattern = `%${query.q}%`;
      clauses.push(
        Prisma.sql`(contractor_name ILIKE ${pattern} OR awarding_agency ILIKE ${pattern} OR description ILIKE ${pattern} OR award_unique_id ILIKE ${pattern})`,
      );
    }
    if (query.agency) clauses.push(Prisma.sql`awarding_agency ILIKE ${`%${query.agency}%`}`);
    if (query.recipient) clauses.push(Prisma.sql`contractor_name ILIKE ${`%${query.recipient}%`}`);
    if (query.state) clauses.push(Prisma.sql`pop_state = ${query.state.toUpperCase()}`);
    if (query.district) clauses.push(Prisma.sql`pop_congressional_district = ${query.district}`);
    if (query.dateFrom) clauses.push(Prisma.sql`action_date >= ${new Date(query.dateFrom)}`);
    if (query.dateTo) clauses.push(Prisma.sql`action_date <= ${new Date(query.dateTo)}`);
    return clauses;
  }

  private commonSubawardClauses(query: FederalMarketQuery): Prisma.Sql[] {
    const clauses: Prisma.Sql[] = [Prisma.sql`active = TRUE`];
    if (query.q) {
      const pattern = `%${query.q}%`;
      clauses.push(
        Prisma.sql`(prime_recipient_name ILIKE ${pattern} OR subawardee_name ILIKE ${pattern} OR awarding_agency ILIKE ${pattern} OR description ILIKE ${pattern} OR provider_key ILIKE ${pattern})`,
      );
    }
    if (query.agency) clauses.push(Prisma.sql`awarding_agency ILIKE ${`%${query.agency}%`}`);
    if (query.recipient)
      clauses.push(
        Prisma.sql`(prime_recipient_name ILIKE ${`%${query.recipient}%`} OR subawardee_name ILIKE ${`%${query.recipient}%`})`,
      );
    if (query.state) clauses.push(Prisma.sql`pop_state = ${query.state.toUpperCase()}`);
    if (query.district) clauses.push(Prisma.sql`pop_congressional_district = ${query.district}`);
    if (query.fiscalYear != null) clauses.push(Prisma.sql`fiscal_year = ${query.fiscalYear}`);
    if (query.dateFrom) clauses.push(Prisma.sql`action_date >= ${new Date(query.dateFrom)}`);
    if (query.dateTo) clauses.push(Prisma.sql`action_date <= ${new Date(query.dateTo)}`);
    return clauses;
  }

  private contractScopeSql(scope: ClientFederalScope): Prisma.Sql | null {
    const options: Prisma.Sql[] = [];
    if (scope.ueis.length) options.push(Prisma.sql`recipient_uei = ANY(${scope.ueis}::text[])`);
    if (scope.names.length)
      options.push(Prisma.sql`lower(contractor_name) = ANY(${scope.names}::text[])`);
    return options.length ? Prisma.sql`(${Prisma.join(options, ' OR ')})` : null;
  }

  private subawardScopeSql(scope: ClientFederalScope): Prisma.Sql | null {
    const options: Prisma.Sql[] = [];
    if (scope.ueis.length) {
      options.push(
        Prisma.sql`(prime_recipient_uei = ANY(${scope.ueis}::text[]) OR subawardee_uei = ANY(${scope.ueis}::text[]))`,
      );
    }
    if (scope.names.length) {
      options.push(
        Prisma.sql`(lower(prime_recipient_name) = ANY(${scope.names}::text[]) OR lower(subawardee_name) = ANY(${scope.names}::text[]))`,
      );
    }
    return options.length ? Prisma.sql`(${Prisma.join(options, ' OR ')})` : null;
  }

  private emptyPage<T>(page: number, pageSize: number, source: string): FederalMarketPage<T> {
    return {
      items: [],
      total: 0,
      page,
      pageSize,
      source,
      asOf: null,
      generatedAt: new Date().toISOString(),
    };
  }

  private vehicleFromSnapshot(row: {
    id: string;
    externalId: string;
    data: unknown;
    sourceUpdatedAt: Date | null;
  }): FederalVehicleMarketRow {
    const data = placeRecord(row.data);
    const numberValue = (value: unknown): number | null => {
      const parsed = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    return {
      id: row.id,
      vehicleId: stringValue(data.vehicleId) ?? row.externalId,
      name: stringValue(data.programAcronym) ?? stringValue(data.solicitationTitle),
      solicitationIdentifier: stringValue(data.solicitationIdentifier),
      vehicleType: stringValue(data.vehicleType),
      agency: stringValue(data.agencyId),
      naicsCode: stringValue(data.naicsCode),
      pscCode: stringValue(data.pscCode),
      setAside: stringValue(data.setAside),
      lastDateToOrder: stringValue(data.lastDateToOrder),
      awardeeCount: numberValue(data.awardeeCount),
      orderCount: numberValue(data.orderCount),
      totalObligated: numberValue(data.totalObligated),
      relationship: null,
      recipientUei: null,
      source: 'tango',
      sourceUpdatedAt: iso(row.sourceUpdatedAt),
    };
  }

  private async aggregateContractGeography(where: Prisma.Sql): Promise<FederalMarketDistrictRow[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ state: string | null; district: string | null; count: bigint; amount: number | null }>
    >(Prisma.sql`
      SELECT pop_state AS state, pop_congressional_district AS district,
             COUNT(*)::bigint AS count, SUM(amount)::float8 AS amount
        FROM federal_award ${where}
       GROUP BY pop_state, pop_congressional_district
    `);
    return rows.flatMap((row) => {
      const key = districtKey(row.state, row.district);
      return key
        ? [
            {
              districtKey: key,
              state: row.state!.toUpperCase(),
              district: row.district!,
              contractCount: Number(row.count),
              contractAmount: row.amount,
              subawardCount: 0,
              subawardAmount: null,
            },
          ]
        : [];
    });
  }

  private async aggregateSubawardGeography(where: Prisma.Sql): Promise<FederalMarketDistrictRow[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ state: string | null; district: string | null; count: bigint; amount: number | null }>
    >(Prisma.sql`
      SELECT pop_state AS state, pop_congressional_district AS district,
             COUNT(*)::bigint AS count, SUM(subaward_amount)::float8 AS amount
        FROM tango_subaward ${where}
       GROUP BY pop_state, pop_congressional_district
    `);
    return rows.flatMap((row) => {
      const key = districtKey(row.state, row.district);
      return key
        ? [
            {
              districtKey: key,
              state: row.state!.toUpperCase(),
              district: row.district!,
              contractCount: 0,
              contractAmount: null,
              subawardCount: Number(row.count),
              subawardAmount: row.amount,
            },
          ]
        : [];
    });
  }

  private async futureSignals(query: FederalMarketQuery): Promise<FederalMarketFutureSignal[]> {
    const forecastClauses: Prisma.Sql[] = [];
    if (query.state)
      forecastClauses.push(Prisma.sql`place_of_performance ILIKE ${`%${query.state}%`}`);
    if (query.agency)
      forecastClauses.push(
        Prisma.sql`COALESCE(organization_agency_name, agency) ILIKE ${`%${query.agency}%`}`,
      );
    const forecasts = await this.prisma.$queryRaw<
      Array<{
        id: string;
        title: string;
        agency: string | null;
        place: string | null;
        date: Date | null;
        sourceUrl: string | null;
      }>
    >(Prisma.sql`
      SELECT id::text AS id, title,
             COALESCE(organization_agency_name, agency) AS agency,
             place_of_performance AS place,
             anticipated_award_date AS date,
             source_url AS "sourceUrl"
        FROM tango_procurement_forecast ${whereSql(forecastClauses)}
       ORDER BY anticipated_award_date ASC NULLS LAST
       LIMIT 50
    `);

    const samRows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        title: string;
        agency: string | null;
        responseDeadline: Date | null;
        place: unknown;
        sourceUrl: string | null;
      }>
    >(Prisma.sql`
      SELECT id::text AS id, title, agency,
             response_deadline AS "responseDeadline",
             place_of_performance AS place,
             source_url AS "sourceUrl"
        FROM sam_opportunity
       WHERE active = TRUE
         AND (response_deadline IS NULL OR response_deadline >= CURRENT_TIMESTAMP)
       ORDER BY response_deadline ASC NULLS LAST
       LIMIT 100
    `);

    const signals: FederalMarketFutureSignal[] = forecasts.map((row) => {
      const state = stateFromText(row.place);
      return {
        id: `forecast:${row.id}`,
        source: 'agency_forecast',
        title: row.title,
        agency: row.agency,
        state,
        districtKey: null,
        date: row.date ? row.date.toISOString().slice(0, 10) : null,
        geographyBasis: state ? 'state_text' : 'unresolved',
        sourceUrl: row.sourceUrl,
      };
    });
    for (const row of samRows) {
      const place = placeRecord(row.place);
      const state = stringValue(place.state ?? place.state_code)?.toUpperCase() ?? null;
      const district = stringValue(place.congressional_district ?? place.congressional_code);
      if (query.state && state !== query.state.toUpperCase()) continue;
      if (query.district && district !== query.district) continue;
      signals.push({
        id: `sam:${row.id}`,
        source: 'sam_gov',
        title: row.title,
        agency: row.agency,
        state,
        districtKey: districtKey(state, district),
        date: iso(row.responseDeadline),
        geographyBasis: state ? 'source_place_of_performance' : 'unresolved',
        sourceUrl: row.sourceUrl,
      });
    }
    return signals.slice(0, 100);
  }
}
