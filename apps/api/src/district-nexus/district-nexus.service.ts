import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RepresentationResolverService } from '../clients/representation-resolver.service.js';
import {
  buildClientNexusResponse,
  evidenceForDistrict,
  foldDistricts,
  type AssistanceDistrictRow,
  type ClientNexusInputs,
  type ContractDistrictRow,
  type FacilityRow,
  type OpportunityRow,
} from './district-nexus.aggregate.js';
import { scoreNexus } from './district-nexus-scoring.js';
import { buildFirmNexusResponse } from './district-nexus.firm-aggregate.js';
import { resolveDistrictNames, statesForKeys } from './district-nexus.district-names.js';
import { parseView } from './district-nexus.view.js';
import {
  assistanceRowToEvidence,
  contractRowToEvidence,
  facilityRowToEvidence,
  EVIDENCE_CAP_PER_DISTRICT,
  type AssistanceEvidenceSourceRow,
  type ContractEvidenceSourceRow,
} from './district-nexus.evidence.js';
import {
  districtCodeForHouseMatch,
  normalizeDistrictForCensus,
} from '../common/district-code.util.js';
import type { FederalMemberSummary } from '../clients/representation-resolver.service.js';
import type {
  ClientDistrictNexusResponse,
  DistrictClientSummary,
  DistrictDemographics,
  DistrictKey,
  DistrictNexusDistrictDetailResponse,
  DistrictNexusDistrictSummary,
  DistrictNexusMapResponse,
  NexusEvidence,
  SourceFreshness,
  TopAward,
} from './district-nexus.types.js';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly representation: RepresentationResolverService,
  ) {}

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
    const { contractorNames, recipientUeis, recipientNames, facilities, facilityRows } =
      await this.prisma.withTenant(tenantId, async (tx) => {
        const [mappings, rows] = await Promise.all([
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
            // Wider than the aggregation rail needs: the extra district columns
            // and geocodeStatus are what the representation resolver reads,
            // districtSource/updatedAt are what evidence-building (E4) reads,
            // and fetching them here keeps both out of their own queries.
            select: {
              id: true,
              name: true,
              city: true,
              state: true,
              congressionalDistrict: true,
              stateHouseDistrict: true,
              stateSenateDistrict: true,
              geocodeStatus: true,
              districtSource: true,
              employeeCount: true,
              updatedAt: true,
            },
            orderBy: { createdAt: 'asc' },
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
          facilities: rows.map(
            (f): FacilityRow => ({
              state: f.state,
              districtCode: f.congressionalDistrict,
              employeeCount: f.employeeCount,
            }),
          ),
          facilityRows: rows,
        };
      });

    // ── Phase 2: global aggregates, outside the tenant transaction ──────────
    //
    // Representation joins here too. It reads congress_member and
    // state_legislator, both global reference tables, and the BATCHED resolver
    // costs four queries for the whole client rather than four per facility.
    //
    // Evidence (WS-E4) fetches record-level rows for the SAME identifiers the
    // aggregate rails above use — never every award in a district, only the
    // ones matched to this client's confirmed mappings, per-district capped so
    // one client's large ingested footprint cannot blow out the response.
    const uppercasedUeis = new Set(recipientUeis.map((u) => u.toUpperCase()));
    const [contracts, assistance, opportunities, freshness, representations, contractEvidence, assistanceEvidence] =
      await Promise.all([
        this.aggregateContracts(contractorNames),
        this.aggregateAssistance(recipientUeis, recipientNames),
        this.aggregateOpportunities(clientId, tenantId),
        this.readFreshness(),
        this.representation.representationForFacilities(facilityRows),
        this.fetchContractEvidenceRowsForClient(contractorNames),
        this.fetchAssistanceEvidenceRowsForClient(recipientUeis, recipientNames),
      ]);

    const evidenceByDistrict = new Map<DistrictKey, NexusEvidence[]>();
    const pushEvidence = (key: DistrictKey, ev: NexusEvidence) => {
      const bucket = evidenceByDistrict.get(key);
      if (bucket) bucket.push(ev);
      else evidenceByDistrict.set(key, [ev]);
    };
    for (const row of contractEvidence) {
      const mapped = contractRowToEvidence(row);
      if (mapped) pushEvidence(mapped.districtKey, mapped.evidence);
    }
    for (const row of assistanceEvidence) {
      const mapped = assistanceRowToEvidence(row, uppercasedUeis);
      if (mapped) pushEvidence(mapped.districtKey, mapped.evidence);
    }
    for (const f of facilityRows) {
      const mapped = facilityRowToEvidence({
        id: f.id,
        name: f.name,
        state: f.state,
        districtCode: f.congressionalDistrict,
        employeeCount: f.employeeCount,
        geocodeStatus: f.geocodeStatus,
        districtSource: f.districtSource,
        updatedAt: f.updatedAt ? f.updatedAt.toISOString() : null,
      });
      if (!mapped) continue;
      pushEvidence(mapped.districtKey, mapped.facility);
      if (mapped.employees) pushEvidence(mapped.districtKey, mapped.employees);
    }

    return buildClientNexusResponse({
      clientId,
      // `recipientUeis` is already filtered by isUeiShaped above, so a confirmed
      // mapping whose externalId is a name and whose externalName is empty would
      // otherwise vanish. Both are checked so "a row exists" is never lost.
      linkage: {
        contractingLinked: contractorNames.length > 0,
        contractorNames,
        assistanceLinked: recipientNames.length > 0 || recipientUeis.length > 0,
        recipientNames,
        ueiConfirmedCount: recipientUeis.length,
      },
      contracts,
      assistance,
      opportunities,
      evidenceByDistrict,
      facilities,
      freshness,
      representativesByFacility: facilityRows.map((f, i) => ({
        facility: { id: f.id, name: f.name, city: f.city, state: f.state },
        representation: representations[i]!,
      })),
      generatedAt: new Date().toISOString(),
    });
  }

  /**
   * WS-E Step E1 — the firm-wide map aggregate.
   *
   * Same two-phase discipline as the client rail: tenant-scoped identity
   * resolution inside ONE short `withTenant`, global award aggregation outside
   * it. The difference is that identity is resolved for every visible client at
   * once, so the whole map costs a fixed number of queries regardless of how
   * many clients the tenant has.
   *
   * `view` is validated by `parseView`, which rejects `future` rather than
   * quietly returning the current map under a future label.
   */
  async getFirmDistrictNexusMap(
    tenantId: string,
    options: { view?: string | null; clientId?: string | null; state?: string | null } = {},
  ): Promise<DistrictNexusMapResponse> {
    parseView(options.view);

    const generatedAt = new Date().toISOString();

    // ── Phase 1: tenant-scoped, one short transaction for ALL clients ───────
    const { byClient } = await this.prisma.withTenant(tenantId, async (tx) => {
      const clientWhere = options.clientId ? { clientId: options.clientId } : {};
      const [mappings, facilityRows] = await Promise.all([
        tx.clientIntelMapping.findMany({
          where: {
            ...clientWhere,
            confirmed: true,
            source: { in: ['contracting', 'assistance_recipient'] },
          },
          select: { clientId: true, source: true, externalId: true, externalName: true },
        }),
        tx.clientFacility.findMany({
          where: { ...clientWhere, ...(options.state ? { state: options.state } : {}) },
          select: {
            clientId: true,
            state: true,
            congressionalDistrict: true,
            employeeCount: true,
          },
        }),
      ]);

      const clients = new Map<
        string,
        { contractorNames: string[]; recipientUeis: string[]; recipientNames: string[]; facilities: FacilityRow[] }
      >();
      const ensure = (id: string) => {
        const existing = clients.get(id);
        if (existing) return existing;
        const fresh = {
          contractorNames: [] as string[],
          recipientUeis: [] as string[],
          recipientNames: [] as string[],
          facilities: [] as FacilityRow[],
        };
        clients.set(id, fresh);
        return fresh;
      };

      for (const m of mappings) {
        const entry = ensure(m.clientId);
        if (m.source === 'contracting') {
          if (m.externalName) entry.contractorNames.push(m.externalName);
        } else {
          if (m.externalId && isUeiShaped(m.externalId)) entry.recipientUeis.push(m.externalId);
          if (m.externalName) entry.recipientNames.push(m.externalName);
        }
      }
      for (const f of facilityRows) {
        ensure(f.clientId).facilities.push({
          state: f.state,
          districtCode: f.congressionalDistrict,
          employeeCount: f.employeeCount,
        });
      }

      return { byClient: clients };
    });

    // ── Phase 2: global aggregates, outside the tenant transaction ──────────
    //
    // ONE query per rail across the union of every client's identifiers, then
    // the rows are attributed back to clients in memory. A per-client query
    // would be the N+1 this whole design exists to avoid.
    const allContractorNames = dedupe([...byClient.values()].flatMap((c) => c.contractorNames));
    const allRecipientUeis = dedupe([...byClient.values()].flatMap((c) => c.recipientUeis));
    const allRecipientNames = dedupe([...byClient.values()].flatMap((c) => c.recipientNames));

    const [contractRows, assistanceRows, freshness] = await Promise.all([
      this.aggregateContractsByIdentifier(allContractorNames),
      this.aggregateAssistanceByIdentifier(allRecipientUeis, allRecipientNames),
      this.readFreshness(),
    ]);

    // Attribute each aggregated row back to the clients that claim its
    // identifier. A name or UEI can legitimately belong to more than one client
    // (shared parent, joint venture), so this is a fan-out, not a lookup.
    const perClient: ClientNexusInputs[] = [...byClient.entries()].map(([clientId, ids]) => {
      const names = new Set(ids.contractorNames);
      const ueis = new Set(ids.recipientUeis);
      const lowerNames = new Set(ids.recipientNames.map((n) => n.toLowerCase()));
      return {
        clientId,
        contracts: contractRows
          .filter((r) => r.identifier != null && names.has(r.identifier))
          .map(({ identifier: _identifier, ...row }) => row),
        assistance: assistanceRows
          .filter(
            (r) =>
              (r.uei != null && ueis.has(r.uei)) ||
              (r.nameLower != null && lowerNames.has(r.nameLower)),
          )
          .map(({ uei: _uei, nameLower: _nameLower, ...row }) => row),
        // Opportunities are per-client and forecast-only; they contribute no
        // awarded credit, so the map omits them rather than issuing one query
        // per client to fetch numbers it would not colour by.
        opportunities: [],
        facilities: ids.facilities,
        freshness,
        generatedAt,
      };
    });

    const response = buildFirmNexusResponse({ perClient, freshness, generatedAt });

    // District names/status: ONE query for every state on the map, matched in
    // memory. `districtNo` is a bare number string and a sole House seat is
    // reported as "1", so this must not be a string-equality join — see
    // district-nexus.district-names.ts.
    const keys = response.districts.map((d) => d.districtKey);
    if (keys.length) {
      const rows = await this.prisma.legislativeDistrict.findMany({
        where: { state: { in: statesForKeys(keys) }, chamber: 'house' },
        select: { state: true, districtNo: true, name: true, status: true },
      });
      const names = resolveDistrictNames(keys, rows);
      for (const district of response.districts) {
        const named = names.get(district.districtKey);
        if (!named) continue;
        district.name = named.name;
        district.status = named.status;
      }
    }

    return response;
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
   * Both predicates are index-driven, which took a migration to make true.
   * UEI is matched bare (not upper(...)) so `faa_recipient_uei_idx` applies.
   * Names are matched on lower(...) against `faa_recipient_name_lower_idx`
   * (20260801010000): the pre-existing index on that column is a GIN trigram
   * built for similarity search, which an equality predicate cannot use, so a
   * bare `recipient_name = ANY(...)` seq-scanned the largest new table. The
   * lower() form also fixes a silent recall bug — USAspending returns recipient
   * names uppercase while ClientIntelMapping.externalName is operator-entered,
   * so a case-sensitive join dropped real awards and read as "no assistance
   * awards for this client".
   */
  private async aggregateAssistance(
    recipientUeis: string[],
    recipientNames: string[],
  ): Promise<AssistanceDistrictRow[]> {
    if (!recipientUeis.length && !recipientNames.length) return [];
    // Lowercased here so the predicate matches the expression the index is
    // built on; an unlowered value would silently fall back to a scan.
    const lowerNames = recipientNames.map((n) => n.toLowerCase());
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
         OR lower(recipient_name) = ANY(${lowerNames}::text[])
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
   * Record-level contract rows for evidence (WS-E4), across every district the
   * client has activity in — as distinct from `aggregateContracts`, which
   * GROUPs and loses per-record identity. Per-district capped via
   * ROW_NUMBER() so one client's large ingested footprint cannot blow out the
   * response; same cap `topContractAwards` already uses.
   */
  private async fetchContractEvidenceRowsForClient(
    contractorNames: string[],
  ): Promise<ContractEvidenceSourceRow[]> {
    if (!contractorNames.length) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        contractor_name: string | null;
        pop_state: string | null;
        pop_congressional_district: string | null;
        amount: number | null;
        action_date: Date | null;
        last_synced_at: Date | null;
      }>
    >`
      SELECT id, contractor_name, pop_state, pop_congressional_district, amount, action_date, last_synced_at
      FROM (
        SELECT id::text AS id, contractor_name, pop_state, pop_congressional_district,
               amount::float8 AS amount, action_date, last_synced_at,
               ROW_NUMBER() OVER (
                 PARTITION BY pop_state, pop_congressional_district
                 ORDER BY amount DESC NULLS LAST
               ) AS rn
        FROM federal_award
        WHERE contractor_name = ANY(${contractorNames}::text[])
      ) ranked
      WHERE rn <= ${EVIDENCE_CAP_PER_DISTRICT}
    `;
    return rows.map((r) => ({
      id: r.id,
      contractorName: r.contractor_name,
      state: r.pop_state,
      district: r.pop_congressional_district,
      amount: r.amount,
      actionDate: r.action_date ? r.action_date.toISOString() : null,
      lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
    }));
  }

  /** Record-level assistance rows for evidence (WS-E4). See fetchContractEvidenceRowsForClient. */
  private async fetchAssistanceEvidenceRowsForClient(
    recipientUeis: string[],
    recipientNames: string[],
  ): Promise<AssistanceEvidenceSourceRow[]> {
    if (!recipientUeis.length && !recipientNames.length) return [];
    const lowerNames = recipientNames.map((n) => n.toLowerCase());
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        recipient_uei: string | null;
        recipient_name: string | null;
        state: string | null;
        district: string | null;
        basis: string;
        total_obligated_amount: number | null;
        start_date: Date | null;
        last_synced_at: Date | null;
        pop_cd_vintage: string | null;
      }>
    >`
      SELECT id, recipient_uei, recipient_name, state, district, basis,
             total_obligated_amount, start_date, last_synced_at, pop_cd_vintage
      FROM (
        SELECT id::text AS id, recipient_uei, recipient_name,
               COALESCE(pop_state, recipient_state) AS state,
               COALESCE(pop_congressional_district, recipient_congressional_district) AS district,
               CASE
                 WHEN pop_state IS NOT NULL AND pop_congressional_district IS NOT NULL
                 THEN 'place_of_performance' ELSE 'recipient_location'
               END AS basis,
               total_obligated_amount::float8 AS total_obligated_amount,
               start_date, last_synced_at, pop_cd_vintage,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(pop_state, recipient_state),
                              COALESCE(pop_congressional_district, recipient_congressional_district)
                 ORDER BY total_obligated_amount DESC NULLS LAST
               ) AS rn
        FROM federal_assistance_award
        WHERE recipient_uei = ANY(${recipientUeis}::text[])
           OR lower(recipient_name) = ANY(${lowerNames}::text[])
      ) ranked
      WHERE rn <= ${EVIDENCE_CAP_PER_DISTRICT}
    `;
    return rows.map((r) => ({
      id: r.id,
      recipientUei: r.recipient_uei,
      recipientName: r.recipient_name,
      state: r.state,
      district: r.district,
      basis: r.basis === 'place_of_performance' ? 'place_of_performance' : 'recipient_location',
      totalObligated: r.total_obligated_amount,
      startDate: r.start_date ? r.start_date.toISOString() : null,
      lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
      popCdVintage: r.pop_cd_vintage,
    }));
  }

  /**
   * Record-level contract rows for evidence (WS-E4), already known to be in
   * ONE district — the plain-LIMIT counterpart of
   * fetchContractEvidenceRowsForClient's per-district window function, which
   * is unnecessary once state+district is fixed by the caller.
   */
  private async fetchContractEvidenceRows(
    contractorNames: string[],
    stateCode: string,
    districtCode: string,
  ): Promise<ContractEvidenceSourceRow[]> {
    if (!contractorNames.length) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        contractor_name: string | null;
        amount: number | null;
        action_date: Date | null;
        last_synced_at: Date | null;
      }>
    >`
      SELECT id::text AS id, contractor_name, amount::float8 AS amount, action_date, last_synced_at
      FROM federal_award
      WHERE contractor_name = ANY(${contractorNames}::text[])
        AND pop_state = ${stateCode} AND pop_congressional_district = ${districtCode}
      ORDER BY amount DESC NULLS LAST
      LIMIT ${EVIDENCE_CAP_PER_DISTRICT}
    `;
    return rows.map((r) => ({
      id: r.id,
      contractorName: r.contractor_name,
      state: stateCode,
      district: districtCode,
      amount: r.amount,
      actionDate: r.action_date ? r.action_date.toISOString() : null,
      lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
    }));
  }

  /** Record-level assistance rows for evidence (WS-E4), single-district. See fetchContractEvidenceRows. */
  private async fetchAssistanceEvidenceRows(
    recipientUeis: string[],
    recipientNames: string[],
    stateCode: string,
    districtCode: string,
  ): Promise<AssistanceEvidenceSourceRow[]> {
    if (!recipientUeis.length && !recipientNames.length) return [];
    const lowerNames = recipientNames.map((n) => n.toLowerCase());
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        recipient_uei: string | null;
        recipient_name: string | null;
        basis: string;
        total_obligated_amount: number | null;
        start_date: Date | null;
        last_synced_at: Date | null;
        pop_cd_vintage: string | null;
      }>
    >`
      SELECT id::text AS id, recipient_uei, recipient_name,
             CASE
               WHEN pop_state IS NOT NULL AND pop_congressional_district IS NOT NULL
               THEN 'place_of_performance' ELSE 'recipient_location'
             END AS basis,
             total_obligated_amount::float8 AS total_obligated_amount,
             start_date, last_synced_at, pop_cd_vintage
      FROM federal_assistance_award
      WHERE (recipient_uei = ANY(${recipientUeis}::text[]) OR lower(recipient_name) = ANY(${lowerNames}::text[]))
        AND COALESCE(pop_state, recipient_state) = ${stateCode}
        AND COALESCE(pop_congressional_district, recipient_congressional_district) = ${districtCode}
      ORDER BY total_obligated_amount DESC NULLS LAST
      LIMIT ${EVIDENCE_CAP_PER_DISTRICT}
    `;
    return rows.map((r) => ({
      id: r.id,
      recipientUei: r.recipient_uei,
      recipientName: r.recipient_name,
      state: stateCode,
      district: districtCode,
      basis: r.basis === 'place_of_performance' ? 'place_of_performance' : 'recipient_location',
      totalObligated: r.total_obligated_amount,
      startDate: r.start_date ? r.start_date.toISOString() : null,
      lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
      popCdVintage: r.pop_cd_vintage,
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
   * The confirmed contractor/recipient identifiers behind a score — same
   * mappings query `getFirmDistrictNexusMap`'s phase 1 runs, factored out so
   * `getDistrictDetail` can independently re-derive the identical identifier
   * set for evidence/breakdown without depending on that method exposing its
   * internal state. Deliberately duplicates a small, cheap, indexed,
   * tenant-scoped query rather than widening an already-shipped public
   * contract to carry it out.
   */
  private async resolveConfirmedIdentifiers(
    tenantId: string,
    clientId: string | null,
  ): Promise<{ contractorNames: string[]; recipientUeis: string[]; recipientNames: string[] }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const mappings = await tx.clientIntelMapping.findMany({
        where: {
          ...(clientId ? { clientId } : {}),
          confirmed: true,
          source: { in: ['contracting', 'assistance_recipient'] },
        },
        select: { source: true, externalId: true, externalName: true },
      });
      const contracting = mappings.filter((m) => m.source === 'contracting');
      const assistance = mappings.filter((m) => m.source === 'assistance_recipient');
      return {
        contractorNames: dedupe(contracting.map((m) => m.externalName)),
        recipientUeis: dedupe(assistance.map((m) => m.externalId)).filter(isUeiShaped),
        recipientNames: dedupe(assistance.map((m) => m.externalName)),
      };
    });
  }

  /**
   * WS-E Step E2 — everything behind one district, for the drawer.
   *
   * Built on the same firm-wide gather as E1 (so the drawer and the map can
   * never disagree about a district's totals), then enriched with the things
   * only a single district can afford: representatives, per-client breakdown,
   * facilities, top awards and demographics.
   */
  async getDistrictDetail(
    tenantId: string,
    state: string,
    district: string,
    options: { view?: string | null; clientId?: string | null } = {},
  ): Promise<DistrictNexusDistrictDetailResponse | null> {
    parseView(options.view);

    const stateCode = state.trim().toUpperCase();
    const districtCode = districtCodeForHouseMatch(district);
    // A sentinel ('90' multi-district, '98' delegate, 'ZZ') is not a district.
    // Returning an empty detail would imply it is one with no activity.
    if (!districtCode) return null;
    const districtKey = `${stateCode}-${districtCode}`;

    const map = await this.getFirmDistrictNexusMap(tenantId, {
      view: options.view,
      clientId: options.clientId,
      state: stateCode,
    });
    const summary = map.districts.find((d) => d.districtKey === districtKey);

    const generatedAt = new Date().toISOString();

    // Tenant-scoped: which clients and facilities actually sit here.
    const facilityRows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientFacility.findMany({
        where: {
          state: stateCode,
          ...(options.clientId ? { clientId: options.clientId } : {}),
        },
        select: {
          id: true,
          name: true,
          city: true,
          state: true,
          congressionalDistrict: true,
          employeeCount: true,
          clientId: true,
          client: { select: { id: true, name: true } },
          // Read for evidence (WS-E4) — see facilityRowToEvidence.
          geocodeStatus: true,
          districtSource: true,
          updatedAt: true,
        },
      }),
    );
    const inDistrict = facilityRows.filter(
      (f) => districtCodeForHouseMatch(f.congressionalDistrict) === districtCode,
    );

    // The SAME identifier resolution getFirmDistrictNexusMap used to produce
    // `summary` — evidence and breakdown must explain exactly that score, never
    // a differently-scoped one. See resolveConfirmedIdentifiers.
    const identifiers = await this.resolveConfirmedIdentifiers(tenantId, options.clientId ?? null);

    const [
      representatives,
      demographics,
      topContractAwards,
      topGrantAwards,
      boundaryRow,
      contractEvidenceRows,
      assistanceEvidenceRows,
      allContracts,
      allAssistance,
    ] = await Promise.all([
      this.resolveDistrictRepresentatives(stateCode, districtCode),
      this.readDemographics(stateCode, districtCode),
      this.topContractAwards(stateCode, districtCode),
      this.topGrantAwards(stateCode, districtCode),
      this.prisma.legislativeDistrict.findFirst({
        where: { state: stateCode, chamber: 'house' },
        select: { geoJsonS3Key: true },
      }),
      this.fetchContractEvidenceRows(identifiers.contractorNames, stateCode, districtCode),
      this.fetchAssistanceEvidenceRows(
        identifiers.recipientUeis,
        identifiers.recipientNames,
        stateCode,
        districtCode,
      ),
      // UNCAPPED totals for THIS district, to explain the score (breakdown) —
      // never the capped evidence rows above, which would understate a
      // district with more than EVIDENCE_CAP_PER_DISTRICT contributing awards.
      this.aggregateContracts(identifiers.contractorNames),
      this.aggregateAssistance(identifiers.recipientUeis, identifiers.recipientNames),
    ]);

    // Fold just this district's rows to compute the breakdown that explains
    // `summary.score` — foldDistricts/evidenceForDistrict are the SAME
    // functions the map used, so this cannot drift from that score by
    // construction (money is linear; weakest-basis-wins is associative
    // regardless of how the contributing rows are grouped beforehand).
    const districtFold = foldDistricts({
      clientId: options.clientId ?? 'firm-wide',
      contracts: allContracts,
      assistance: allAssistance,
      opportunities: [],
      facilities: inDistrict.map((f) => ({
        state: f.state,
        districtCode: f.congressionalDistrict,
        employeeCount: f.employeeCount,
      })),
      freshness: [],
      generatedAt,
    });
    const districtAcc = districtFold.districts.find((d) => d.districtKey === districtKey);
    const breakdown = districtAcc
      ? scoreNexus({ components: evidenceForDistrict(districtAcc) }).breakdown
      : [];

    const uppercasedUeis = new Set(identifiers.recipientUeis.map((u) => u.toUpperCase()));
    const evidence: NexusEvidence[] = [];
    for (const row of contractEvidenceRows) {
      const mapped = contractRowToEvidence(row);
      if (mapped) evidence.push(mapped.evidence);
    }
    for (const row of assistanceEvidenceRows) {
      const mapped = assistanceRowToEvidence(row, uppercasedUeis);
      if (mapped) evidence.push(mapped.evidence);
    }
    for (const f of inDistrict) {
      const mapped = facilityRowToEvidence({
        id: f.id,
        name: f.name,
        state: f.state,
        districtCode: f.congressionalDistrict,
        employeeCount: f.employeeCount,
        geocodeStatus: f.geocodeStatus,
        districtSource: f.districtSource,
        updatedAt: f.updatedAt ? f.updatedAt.toISOString() : null,
      });
      if (!mapped) continue;
      evidence.push(mapped.facility);
      if (mapped.employees) evidence.push(mapped.employees);
    }

    const clients = new Map<string, DistrictClientSummary>();
    for (const f of inDistrict) {
      const existing = clients.get(f.clientId) ?? {
        clientId: f.clientId,
        clientName: f.client.name,
        awarded: { contractObligations: null, grantObligations: null, grantOutlays: null },
        facilityCount: 0,
        employeeCount: null,
      };
      existing.facilityCount += 1;
      if (f.employeeCount != null) {
        existing.employeeCount = (existing.employeeCount ?? 0) + f.employeeCount;
      }
      clients.set(f.clientId, existing);
    }

    const base: DistrictNexusDistrictSummary = summary ?? {
      districtKey,
      state: stateCode,
      districtCode,
      status: 'C',
      name: null,
      awarded: { contractObligations: null, grantObligations: null, grantOutlays: null },
      opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
      clientCount: clients.size,
      // A district with no nexus is a real answer, not a 404. Coverage 0 with a
      // null score says "nothing here", which is different from "unknown".
      score: null,
      coveragePercent: 0,
      employeeCount: null,
      employeesUnreported: false,
      warnings: [],
    };

    return {
      ...base,
      evidence,
      breakdown,
      freshness: map.freshness,
      representatives,
      clients: [...clients.values()],
      facilities: inDistrict.map((f) => ({
        id: f.id,
        name: f.name,
        city: f.city,
        clientId: f.clientId,
        clientName: f.client.name,
        employeeCount: f.employeeCount,
      })),
      topContractAwards,
      topGrantAwards,
      demographics,
      boundaryAvailable: !!boundaryRow?.geoJsonS3Key,
      generatedAt,
    };
  }

  /**
   * House member + both senators for a district.
   *
   * Reuses the batched resolver by handing it a single synthetic facility. The
   * state-legislative chambers come back null, which is correct: a congressional
   * district does not determine state house/senate districts, and inventing one
   * would be a wrong answer rather than a missing one.
   */
  private async resolveDistrictRepresentatives(
    stateCode: string,
    districtCode: string,
  ): Promise<{ house: FederalMemberSummary | null; senate: FederalMemberSummary[] } | null> {
    const [result] = await this.representation.representationForFacilities([
      {
        state: stateCode,
        congressionalDistrict: districtCode,
        stateHouseDistrict: null,
        stateSenateDistrict: null,
        geocodeStatus: 'matched',
      },
    ]);
    if (!result || result.unresolved) return null;
    return { house: result.federal.house, senate: result.federal.senate };
  }

  /**
   * Latest-congress-wins ACS demographics.
   *
   * census_district keys districts in CENSUS style ('2', '11', 'AL') while every
   * other rail here uses FACILITY style ('02', '11', '00'), so the join needs a
   * second key built with normalizeDistrictForCensus. Using the districtKey code
   * directly silently matches nothing for single-digit districts.
   */
  private async readDemographics(
    stateCode: string,
    districtCode: string,
  ): Promise<DistrictDemographics | null> {
    const censusDistrict = normalizeDistrictForCensus(districtCode);
    const row = await this.prisma.censusDistrict.findFirst({
      where: { state: stateCode, district: censusDistrict },
      orderBy: { congress: 'desc' },
    });
    if (!row) return null;
    return {
      congress: row.congress,
      dataYear: row.dataYear,
      totalPopulation: row.totalPopulation,
      medianHouseholdIncome: row.medianHouseholdIncome,
      medianAge: row.medianAge,
      percentBachelorPlus: row.percentBachelorPlus,
      percentPoverty: row.percentPoverty,
      percentVeteran: row.percentVeteran,
      percentUninsured: row.percentUninsured,
      laborForceSize: row.laborForceSize,
      unemploymentRate: row.unemploymentRate,
    };
  }

  /**
   * Unscoped by client: "what's happening in this district" for browsing, not
   * evidence for a score. `federal_award`'s idempotency/display key is
   * `award_unique_id` — there is no `award_id` column on this table.
   */
  private async topContractAwards(stateCode: string, districtCode: string): Promise<TopAward[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        contractor_name: string | null;
        description: string | null;
        amount: number | null;
        action_date: Date | null;
        award_unique_id: string | null;
      }>
    >`
      SELECT id::text AS id, contractor_name, description,
             amount::float8 AS amount, action_date, award_unique_id
      FROM federal_award
      WHERE pop_state = ${stateCode} AND pop_congressional_district = ${districtCode}
      ORDER BY amount DESC NULLS LAST
      LIMIT 10
    `;
    return rows.map((r) => ({
      id: r.id,
      label: r.description ?? r.award_unique_id ?? 'Federal contract award',
      counterparty: r.contractor_name,
      amount: r.amount,
      awardedAt: r.action_date ? r.action_date.toISOString() : null,
      externalUrl: r.award_unique_id
        ? `https://www.usaspending.gov/award/${r.award_unique_id}`
        : null,
    }));
  }

  /** Unscoped by client, same as topContractAwards — browsing, not evidence. */
  private async topGrantAwards(stateCode: string, districtCode: string): Promise<TopAward[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        recipient_name: string | null;
        description: string | null;
        total_obligated_amount: number | null;
        start_date: Date | null;
        award_unique_id: string | null;
      }>
    >`
      SELECT id::text AS id, recipient_name, description,
             total_obligated_amount::float8 AS total_obligated_amount,
             start_date, award_unique_id
      FROM federal_assistance_award
      WHERE COALESCE(pop_state, recipient_state) = ${stateCode}
        AND COALESCE(pop_congressional_district, recipient_congressional_district) = ${districtCode}
      ORDER BY total_obligated_amount DESC NULLS LAST
      LIMIT 10
    `;
    return rows.map((r) => ({
      id: r.id,
      label: r.description ?? r.award_unique_id ?? 'Federal assistance award',
      counterparty: r.recipient_name,
      amount: r.total_obligated_amount,
      awardedAt: r.start_date ? r.start_date.toISOString() : null,
      externalUrl: r.award_unique_id
        ? `https://www.usaspending.gov/award/${r.award_unique_id}`
        : null,
    }));
  }

  /**
   * Contracts by district, CARRYING the identifier each group matched on.
   *
   * The per-client rail can group by district alone because every row already
   * belongs to the one client it queried for. The firm-wide rail cannot: it
   * queries the union of every client's identifiers in one pass, so it has to
   * know which identifier produced each group in order to attribute the money
   * back and count distinct clients per district. Same single query, one extra
   * grouping column.
   */
  private async aggregateContractsByIdentifier(
    contractorNames: string[],
  ): Promise<Array<ContractDistrictRow & { identifier: string | null }>> {
    if (!contractorNames.length) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{
        identifier: string | null;
        state: string | null;
        district: string | null;
        award_count: bigint;
        total_amount: number | null;
      }>
    >`
      SELECT contractor_name AS identifier,
             pop_state AS state,
             pop_congressional_district AS district,
             COUNT(*)::bigint AS award_count,
             COALESCE(SUM(amount), 0)::float8 AS total_amount
      FROM federal_award
      WHERE contractor_name = ANY(${contractorNames}::text[])
      GROUP BY contractor_name, pop_state, pop_congressional_district
    `;
    return rows.map((r) => ({
      identifier: r.identifier,
      state: r.state,
      district: r.district,
      awardCount: Number(r.award_count),
      totalAmount: r.total_amount ?? 0,
    }));
  }

  /** Assistance by district, carrying both identifiers a row could have matched. */
  private async aggregateAssistanceByIdentifier(
    recipientUeis: string[],
    recipientNames: string[],
  ): Promise<Array<AssistanceDistrictRow & { uei: string | null; nameLower: string | null }>> {
    if (!recipientUeis.length && !recipientNames.length) return [];
    const lowerNames = recipientNames.map((n) => n.toLowerCase());
    const rows = await this.prisma.$queryRaw<
      Array<{
        uei: string | null;
        name_lower: string | null;
        state: string | null;
        district: string | null;
        basis: string;
        award_count: bigint;
        total_obligated: number | null;
        total_outlayed: number | null;
      }>
    >`
      SELECT recipient_uei AS uei,
             lower(recipient_name) AS name_lower,
             COALESCE(pop_state, recipient_state) AS state,
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
         OR lower(recipient_name) = ANY(${lowerNames}::text[])
      GROUP BY 1, 2, 3, 4, 5
    `;
    return rows.map((r) => ({
      uei: r.uei,
      nameLower: r.name_lower,
      state: r.state,
      district: r.district,
      basis: r.basis === 'place_of_performance' ? 'place_of_performance' : 'recipient_location',
      awardCount: Number(r.award_count),
      totalObligated: r.total_obligated ?? 0,
      totalOutlayed: r.total_outlayed ?? 0,
    }));
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
