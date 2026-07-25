import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  buildClientNexusResponse,
  type AssistanceDistrictRow,
  type ContractDistrictRow,
  type FacilityRow,
  type OpportunityRow,
} from './district-nexus.aggregate.js';
import type { ClientDistrictNexusResponse, SourceFreshness } from './district-nexus.types.js';

/**
 * The source rails whose watermarks are surfaced to the UI, so it can say
 * "contracts current to 3 Jul" rather than implying everything is live.
 *
 * `id` is the ingestion verb (stable, what the UI keys on). `syncSource` is the
 * value that job actually writes to `sync_run.source` — these differ more often
 * than you would expect, and every one below was read off the job rather than
 * assumed:
 *
 *   sync-federal-award              -> 'usaspending_federal_award'   (:110)
 *   sync-federal-assistance-awards  -> 'sync-federal-assistance-awards'
 *   sync-grants                     -> 'sync-grants'
 *   sync-legistorm-districts        -> SYNC_SOURCE 'sync-legistorm-districts'
 *   geocode-facilities              -> 'geocode-facilities'
 *   build-district-boundary-artifacts -> SYNC_SOURCE (same string)
 *   sync-congress-members           -> 'sync-congress-members'
 *   sync-census                     -> NONE; the job records no SyncRun at all
 *
 * The eight rails and their labels are fixed by the UI prototype, which is the
 * binding spec for this strip (docs/district-nexus/prototype/sample-data.js).
 */
interface FreshnessRail {
  id: string;
  /** null when the job writes no SyncRun, so freshness is unknowable here. */
  syncSource: string | null;
  label: string;
}

const FRESHNESS_RAILS: readonly FreshnessRail[] = [
  {
    id: 'geocode-facilities',
    syncSource: 'geocode-facilities',
    label: 'Client facilities and geocoding',
  },
  {
    id: 'sync-federal-award',
    syncSource: 'usaspending_federal_award',
    label: 'Federal contract awards (DoD prime only)',
  },
  {
    id: 'sync-federal-assistance-awards',
    syncSource: 'sync-federal-assistance-awards',
    label: 'Federal assistance awards',
  },
  { id: 'sync-grants', syncSource: 'sync-grants', label: 'Grant opportunities' },
  {
    id: 'sync-legistorm-districts',
    syncSource: 'sync-legistorm-districts',
    label: 'District metadata (LegiStorm)',
  },
  { id: 'sync-census', syncSource: null, label: 'District demographics (ACS 5-year)' },
  {
    id: 'build-district-boundary-artifacts',
    syncSource: 'build-district-boundary-artifacts',
    label: 'Boundary artifact (Census cartographic, 119th)',
  },
  { id: 'sync-congress-members', syncSource: 'sync-congress-members', label: 'Members of Congress' },
];

/**
 * Both statuses that mean "the run completed and its watermark is real".
 * `runWithSyncRun` downgrades to success_with_errors on any per-row error
 * (statusFromCounts, ingestion/embed-watermark.ts:40), so filtering to 'success'
 * alone reports a rail that synced 40,000 rows and hit one bad record as though
 * it had never run.
 */
const FRESH_STATUSES = ['success', 'success_with_errors'] as const;

/**
 * District Nexus v2 aggregation (Rev 2 plan, Workstream E).
 *
 * ── Tenancy discipline (§6.6), which is the whole reason this is structured
 *    the way it is ─────────────────────────────────────────────────────────
 *
 * Client-scoped reads (mappings, facilities) happen INSIDE `withTenant`, in
 * short transactions. The global award tables are then aggregated OUTSIDE that
 * transaction, filtered to the identifiers those reads returned.
 *
 * That split is deliberate and load-bearing. federal_award and
 * federal_assistance_award are global, un-tenanted reference tables — running
 * a multi-second aggregate over them inside a tenant transaction would hold
 * the tenant GUC and a pooled connection open for the duration, which is
 * exactly the pattern that starved the Prisma pool during the graph-sync
 * incident. Resolving identifiers first and aggregating second keeps every
 * tenant-scoped transaction short.
 *
 * Batching: one aggregate query per rail. No per-district or per-client query,
 * following the getDistrictNexusSpend precedent whose spec explicitly pins the
 * single-query property.
 */
@Injectable()
export class DistrictNexusService {
  private readonly logger = new Logger(DistrictNexusService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * WS-E Step E3 — the unified client endpoint's payload.
   *
   * Returns an honest empty shape rather than throwing when a client has no
   * confirmed mappings: "we have no identifiers for this client" is a real,
   * displayable answer, and the widget needs to render it rather than an error.
   */
  async getClientDistrictNexus(
    clientId: string,
    tenantId: string,
  ): Promise<ClientDistrictNexusResponse> {
    // ── Phase 1: tenant-scoped identity resolution, short transaction ───────
    const { contractorNames, recipientUeis, recipientNames, facilities } =
      await this.prisma.withTenant(tenantId, async (tx) => {
        const [mappings, facilityRows] = await Promise.all([
          tx.clientIntelMapping.findMany({
            where: {
              clientId,
              confirmed: true,
              source: { in: ['contracting', 'assistance_recipient'] },
            },
            select: { source: true, externalId: true, externalName: true },
          }),
          tx.clientFacility.findMany({
            where: { clientId },
            select: { state: true, congressionalDistrict: true, employeeCount: true },
          }),
        ]);

        const contracting = mappings.filter((m) => m.source === 'contracting');
        const assistance = mappings.filter((m) => m.source === 'assistance_recipient');

        return {
          contractorNames: dedupe(contracting.map((m) => m.externalName)),
          // externalId is the UEI when the recipient had one — see
          // searchAssistanceRecipients, which pins UEI-else-name as the id.
          recipientUeis: dedupe(assistance.map((m) => m.externalId)).filter(isUeiShaped),
          recipientNames: dedupe(assistance.map((m) => m.externalName)),
          facilities: facilityRows.map(
            (f): FacilityRow => ({
              state: f.state,
              districtCode: f.congressionalDistrict,
              employeeCount: f.employeeCount,
            }),
          ),
        };
      });

    // ── Phase 2: global aggregates, outside the tenant transaction ──────────
    const [contracts, assistance, opportunities, freshness] = await Promise.all([
      this.aggregateContracts(contractorNames),
      this.aggregateAssistance(recipientUeis, recipientNames),
      this.aggregateOpportunities(clientId, tenantId),
      this.readFreshness(),
    ]);

    return buildClientNexusResponse({
      clientId,
      contracts,
      assistance,
      opportunities,
      facilities,
      freshness,
      generatedAt: new Date().toISOString(),
    });
  }

  /**
   * Contract spend by place-of-performance district.
   *
   * Same shape as the legacy getDistrictNexusSpend query — deliberately, so the
   * v2 rail and the legacy rail cannot disagree about a client's contract
   * totals while both are live.
   */
  private async aggregateContracts(contractorNames: string[]): Promise<ContractDistrictRow[]> {
    if (!contractorNames.length) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{
        state: string | null;
        district: string | null;
        award_count: bigint;
        total_amount: number | null;
      }>
    >`
      SELECT pop_state AS state,
             pop_congressional_district AS district,
             COUNT(*)::bigint AS award_count,
             COALESCE(SUM(amount), 0)::float8 AS total_amount
      FROM federal_award
      WHERE contractor_name = ANY(${contractorNames}::text[])
      GROUP BY pop_state, pop_congressional_district
    `;
    return rows.map((r) => ({
      state: r.state,
      district: r.district,
      awardCount: Number(r.award_count),
      totalAmount: r.total_amount ?? 0,
    }));
  }

  /**
   * Assistance spend by district, carrying the basis each row was resolved on.
   *
   * Place of performance is preferred and recipient location is the fallback
   * (§5.3). The CASE below reports which one was used per group rather than
   * silently blending them — the aggregation layer downgrades a district's
   * evidence strength when any of its money came from recipient location.
   *
   * UEI is matched bare (not upper(...)) so the btree index applies; the same
   * reasoning as searchAssistanceRecipients.
   */
  private async aggregateAssistance(
    recipientUeis: string[],
    recipientNames: string[],
  ): Promise<AssistanceDistrictRow[]> {
    if (!recipientUeis.length && !recipientNames.length) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{
        state: string | null;
        district: string | null;
        basis: string;
        award_count: bigint;
        total_obligated: number | null;
        total_outlayed: number | null;
      }>
    >`
      SELECT COALESCE(pop_state, recipient_state) AS state,
             COALESCE(pop_congressional_district, recipient_congressional_district) AS district,
             CASE
               WHEN pop_state IS NOT NULL AND pop_congressional_district IS NOT NULL
               THEN 'place_of_performance'
               ELSE 'recipient_location'
             END AS basis,
             COUNT(*)::bigint AS award_count,
             COALESCE(SUM(total_obligated_amount), 0)::float8 AS total_obligated,
             COALESCE(SUM(total_outlayed_amount), 0)::float8 AS total_outlayed
      FROM federal_assistance_award
      WHERE recipient_uei = ANY(${recipientUeis}::text[])
         OR recipient_name = ANY(${recipientNames}::text[])
      GROUP BY 1, 2, 3
    `;
    return rows.map((r) => ({
      state: r.state,
      district: r.district,
      basis: r.basis === 'place_of_performance' ? 'place_of_performance' : 'recipient_location',
      awardCount: Number(r.award_count),
      totalObligated: r.total_obligated ?? 0,
      totalOutlayed: r.total_outlayed ?? 0,
    }));
  }

  /**
   * Grant opportunities this client has been explicitly linked to.
   *
   * Only ClientGrantNexus rows with relationshipType 'opportunity_candidate'
   * count. An opportunity nobody has linked to the client is market noise, not
   * a nexus, and must not appear in their numbers.
   */
  private async aggregateOpportunities(
    clientId: string,
    tenantId: string,
  ): Promise<OpportunityRow[]> {
    const links = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientGrantNexus.findMany({
        where: { clientId, relationshipType: 'opportunity_candidate' },
        select: { grantOpportunityId: true },
      }),
    );
    const ids = dedupe(links.map((l) => l.grantOpportunityId));
    if (!ids.length) return [];

    const grants = await this.prisma.federalGrant.findMany({
      where: { id: { in: ids } },
      select: { estimatedFunding: true, awardCeiling: true },
    });
    // Grants.gov opportunities carry no reliable district, so they attach to
    // the client rather than a district until someone links them to a site.
    return grants.map(
      (g): OpportunityRow => ({
        state: null,
        district: null,
        estimatedFunding: g.estimatedFunding,
        awardCeiling: g.awardCeiling,
      }),
    );
  }

  /**
   * Latest successful run per source. A source that has never completed is
   * reported as neverSynced rather than omitted — silence would read as
   * "fresh".
   */
  private async readFreshness(): Promise<SourceFreshness[]> {
    const uninstrumented = (rail: FreshnessRail): SourceFreshness => ({
      source: rail.id,
      label: rail.label,
      lastSyncedAt: null,
      neverSynced: false,
      freshnessUnavailable: true,
    });

    const queryable = FRESHNESS_RAILS.filter((r) => r.syncSource !== null);

    try {
      const rows = await this.prisma.$queryRaw<Array<{ source: string; finished_at: Date | null }>>`
        SELECT DISTINCT ON (source) source, finished_at
        FROM sync_run
        WHERE source = ANY(${queryable.map((r) => r.syncSource as string)}::text[])
          AND status = ANY(${[...FRESH_STATUSES]}::text[])
        ORDER BY source, started_at DESC
      `;
      const bySource = new Map(rows.map((r) => [r.source, r.finished_at]));
      return FRESHNESS_RAILS.map((rail) => {
        if (rail.syncSource === null) return uninstrumented(rail);
        const finishedAt = bySource.get(rail.syncSource) ?? null;
        return {
          source: rail.id,
          label: rail.label,
          lastSyncedAt: finishedAt ? finishedAt.toISOString() : null,
          neverSynced: !finishedAt,
        };
      });
    } catch (error) {
      // Freshness is decoration, not correctness. Losing it must not fail the
      // whole response — but it is reported as UNKNOWN, never as current, and
      // never as never-synced (which would be a claim we cannot support).
      this.logger.warn(
        `freshness read failed; reporting all rails as unknown: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return FRESHNESS_RAILS.map(uninstrumented);
    }
  }
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v && v.length > 0)),
  );
}

/** UEIs are 12 alphanumerics; anything else is a name masquerading as an id. */
function isUeiShaped(value: string): boolean {
  return /^[A-Z0-9]{12}$/.test(value.toUpperCase());
}
