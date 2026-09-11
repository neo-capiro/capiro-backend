import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { fundingPrioritiesFromIntake } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { RepresentationResolverService } from '../clients/representation-resolver.service.js';
import {
  buildClientNexusResponse,
  buildDistrictClientBreakdown,
  districtKeyFor,
  evidenceForDistrict,
  foldDistricts,
  type AssistanceDistrictRow,
  type ClientNexusInputs,
  type ContractDistrictRow,
  type FacilityRow,
  type OpportunityRow,
  type RelationshipNexusRow,
} from './district-nexus.aggregate.js';
import { scoreNexus } from './district-nexus-scoring.js';
import { buildFirmNexusResponse, expandFirmMapWithAllDistricts } from './district-nexus.firm-aggregate.js';
import { resolveDistrictNames, splitDistrictKey, statesForKeys } from './district-nexus.district-names.js';
import { parseView } from './district-nexus.view.js';
import { scoreOpportunityRelevance, type ClientRelevanceProfile } from './grant-opportunity-relevance.js';
import { shapeClientRelevanceProfile } from './grant-opportunity-candidates.js';
import {
  assistanceRowToEvidence,
  contractRowToEvidence,
  facilityRowToEvidence,
  relationshipRowToEvidence,
  EVIDENCE_CAP_PER_DISTRICT,
  type AssistanceEvidenceSourceRow,
  type ContractEvidenceSourceRow,
} from './district-nexus.evidence.js';
import { claimsFullAwardAmount, componentForRelationship, relationshipTier } from './district-nexus.verification.js';
import {
  districtCodeForHouseMatch,
  matchFacilityDistrictCode,
  normalizeDistrictForCensus,
} from '../common/district-code.util.js';
import { currentCongressNumber } from '../common/congress.util.js';
import {
  buildDistrictNexusIdentity,
  districtNexusContractorIdsToResolve,
  type DistrictNexusClientIdentity,
  type DistrictNexusIdentitySeed,
} from './district-nexus.identity.js';
import type {
  AwardIdentityRail,
  ContractorUeiIndex,
} from '../funding-opportunities/award-history-identity.js';
import type { FederalMemberSummary } from '../clients/representation-resolver.service.js';
import type {
  ClientDistrictNexusResponse,
  ClientOpportunity,
  ClientOpportunitySummary,
  DistrictDemographics,
  DistrictKey,
  DistrictNexusDistrictDetailResponse,
  DistrictNexusDistrictSummary,
  DistrictNexusMapResponse,
  EvidenceVerificationStatus,
  FacilityCoverageDiagnostic,
  GeographyBasis,
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
 * The ClientGrantNexus relationship types that speak to AWARDED money or a
 * partner/beneficiary claim (audit F4). 'opportunity_candidate' is
 * deliberately absent — it is a forecast and has its own client-level rail
 * (aggregateOpportunitySummary).
 */
const AWARD_RELATIONSHIP_TYPES = [
  'direct_recipient',
  'subrecipient',
  'project_site',
  'research_partner',
  'coalition_partner',
  'beneficiary',
  'matching_contributor',
] as const;

/**
 * Soft-archived ("deleted") clients must not contribute to any aggregate
 * (audit F6).
 *
 * Archiving sets `status='archived'` and leaves `profileStatus` untouched, so
 * filtering on `profileStatus` alone still surfaces a deleted client — see
 * apps/api/src/intelligence/intelligence.service.ts:4205, the precedent this
 * copies. Filtering only in the web selector (DistrictNexusFilters.tsx) was
 * insufficient: the firm-wide aggregate never consults the selector.
 *
 * `ClientFacility` and `ClientGrantNexus` both have a real `client` relation,
 * so this filters through it directly (`client: VISIBLE_CLIENT_FILTER`).
 * `ClientIntelMapping` has NO such relation (confirmed — only a bare
 * `clientId` column) — every read against it instead pre-resolves the
 * visible client id set and filters `clientId: { in: visibleClientIds }`.
 */
const VISIBLE_CLIENT_FILTER = { status: { not: 'archived' }, profileStatus: 'ACTIVE' } as const;

/**
 * Paired place-of-performance / recipient-location geography for
 * `federal_assistance_award` (§5). State and district are chosen TOGETHER —
 * never as two independent `COALESCE`s, which could pair one award's
 * place-of-performance state with a different award's recipient-location
 * district and fabricate a district that award never touched (the regression
 * fixture this fixes: pop_state=TX/pop_district=null, recipient_state=VA/
 * recipient_district=10 must resolve to VA-10, never TX-10).
 *
 * Defined once and reused everywhere this file selects assistance geography
 * (aggregateAssistance, aggregateAssistanceByIdentifier,
 * fetchAssistanceEvidenceRowsForClient, fetchAssistanceEvidenceRows,
 * clientScopedGrantAwards, topGrantAwards) so the pairing rule cannot drift
 * between call sites again. Unaliased — callers append `AS state` / `AS
 * district` / `AS basis`, or use the bare expression in a WHERE/PARTITION BY.
 */
const PAIRED_ASSISTANCE_STATE_EXPR = Prisma.sql`CASE
  WHEN pop_state IS NOT NULL AND pop_congressional_district IS NOT NULL
  THEN pop_state ELSE recipient_state
END`;
const PAIRED_ASSISTANCE_DISTRICT_EXPR = Prisma.sql`CASE
  WHEN pop_state IS NOT NULL AND pop_congressional_district IS NOT NULL
  THEN pop_congressional_district ELSE recipient_congressional_district
END`;
const PAIRED_ASSISTANCE_BASIS_EXPR = Prisma.sql`CASE
  WHEN pop_state IS NOT NULL AND pop_congressional_district IS NOT NULL
  THEN 'place_of_performance' ELSE 'recipient_location'
END`;

/** No identifiers at all — used where a client-scoped rail is only sometimes requested. */
const EMPTY_IDENTIFIER_SET: { ueis: string[]; fallbackNames: string[] } = { ueis: [], fallbackNames: [] };

/**
 * aggregateRelationshipNexus's row, shaped for BOTH of its consumers: the
 * scoring fold (the RelationshipNexusRow fields) and evidence (the rest).
 * Computed once so the two can never drift — the same principle
 * district-nexus.verification.ts applies to every other rail.
 */
interface RelationshipEvidenceRow extends RelationshipNexusRow {
  id: string;
  clientName: string;
  relationshipType: string;
  counterparty: string | null;
  status: EvidenceVerificationStatus;
  confidence: number | null;
  externalUseApproved: boolean;
  popCdVintage: string | null;
  sourceUpdatedAt: string | null;
  observedAt: string | null;
}

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
    const { client, mappings, facilities, facilityRows } = await this.prisma.withTenant(
      tenantId,
      async (tx) => {
        // Soft-archived clients contribute nothing (audit F6). ClientFacility
        // has a real `client` relation and filters through it directly;
        // ClientIntelMapping does not, so its visibility is resolved first —
        // an archived client's own profile request now returns the same
        // "honest empty" shape a client with no confirmed mappings gets.
        const [visibleClient, rows] = await Promise.all([
          tx.client.findFirst({
            where: { id: clientId, ...VISIBLE_CLIENT_FILTER },
            select: { id: true, uei: true },
          }),
          tx.clientFacility.findMany({
            where: { clientId, client: VISIBLE_CLIENT_FILTER },
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
              congressionalDistrictCongress: true,
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
        const rawMappings = visibleClient
          ? await tx.clientIntelMapping.findMany({
              where: {
                clientId,
                confirmed: true,
                reviewStatus: 'confirmed',
                rollUpAwards: true,
                source: { in: ['contracting', 'assistance_recipient'] },
              },
              select: { source: true, externalId: true, externalName: true, matchBasis: true, matchTier: true },
            })
          : [];

        return {
          client: visibleClient,
          mappings: rawMappings,
          facilities: rows.map(
            (f): FacilityRow => ({
              state: f.state,
              districtCode: f.congressionalDistrict,
              employeeCount: f.employeeCount,
              geocodeStatus: f.geocodeStatus,
              districtSource: f.districtSource,
              congressionalDistrictCongress: f.congressionalDistrictCongress,
            }),
          ),
          facilityRows: rows,
        };
      },
    );

    // Contractor UUID -> UEI resolution happens OUTSIDE the tenant transaction
    // (§4) — it reads the global `federal_contractor` reference table, not a
    // tenant-scoped one.
    const seed: DistrictNexusIdentitySeed = {
      clientId,
      clientName: '',
      uei: client?.uei ?? null,
      mappings,
    };
    const contractorUeis = await this.resolveContractorUeis(
      districtNexusContractorIdsToResolve([seed]),
    );
    const identity = buildDistrictNexusIdentity(seed, contractorUeis);

    // Raw, un-canonicalized facts for the "which rails have you mapped"
    // linkage widget (WS-H3) — deliberately independent of which basis the
    // canonical identity settled on: a client with a confirmed mapping whose
    // name got suppressed by their own UEI is still linked, not unlinked.
    const contracting = mappings.filter((m) => m.source === 'contracting');
    const assistanceMappings = mappings.filter((m) => m.source === 'assistance_recipient');
    const contractorNamesAll = dedupe(contracting.map((m) => m.externalName));
    const recipientUeisAll = dedupe(assistanceMappings.map((m) => m.externalId)).filter(isUeiShaped);
    const recipientNamesAll = dedupe(assistanceMappings.map((m) => m.externalName));

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
    const relevance = await this.buildClientRelevanceProfile(clientId, tenantId, {
      recipientUeis: recipientUeisAll,
      recipientNames: recipientNamesAll,
    });

    const currentCongress = currentCongressNumber(new Date());
    const [
      contracts,
      assistance,
      opportunityResult,
      freshness,
      representations,
      contractEvidence,
      assistanceEvidence,
      relationshipRows,
    ] = await Promise.all([
        this.aggregateContracts(identity.contract),
        this.aggregateAssistance(identity.assistance),
        this.aggregateOpportunitySummary(clientId, tenantId, relevance),
        this.readFreshness(),
        this.representation.representationForFacilities(facilityRows),
        this.fetchContractEvidenceRowsForClient(identity.contract),
        this.fetchAssistanceEvidenceRowsForClient(identity.assistance),
        this.aggregateRelationshipNexus(clientId, tenantId),
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
      const mapped = assistanceRowToEvidence(row);
      if (mapped) pushEvidence(mapped.districtKey, mapped.evidence);
    }
    for (const f of facilityRows) {
      // A facility geocoded against a not-yet-effective boundary is excluded
      // from current-view scoring (§12) — its evidence must agree with the
      // fold, which excludes it via the matching `currentCongress` check.
      if (f.congressionalDistrictCongress != null && f.congressionalDistrictCongress > currentCongress) {
        continue;
      }
      const mapped = facilityRowToEvidence({
        id: f.id,
        name: f.name,
        state: f.state,
        districtCode: f.congressionalDistrict,
        employeeCount: f.employeeCount,
        geocodeStatus: f.geocodeStatus,
        districtSource: f.districtSource,
        updatedAt: f.updatedAt ? f.updatedAt.toISOString() : null,
        congressionalDistrictCongress: f.congressionalDistrictCongress,
      });
      if (!mapped) continue;
      pushEvidence(mapped.districtKey, mapped.facility);
      if (mapped.employees) pushEvidence(mapped.districtKey, mapped.employees);
    }
    for (const row of relationshipRows) {
      const mapped = relationshipRowToEvidence(row);
      if (mapped) pushEvidence(mapped.districtKey, mapped.evidence);
    }

    return buildClientNexusResponse({
      clientId,
      linkage: {
        contractingLinked: contractorNamesAll.length > 0,
        contractorNames: contractorNamesAll,
        assistanceLinked: recipientNamesAll.length > 0 || recipientUeisAll.length > 0,
        recipientNames: recipientNamesAll,
        ueiConfirmedCount: recipientUeisAll.length,
      },
      contracts,
      assistance,
      opportunities: opportunityResult.districtRows,
      opportunitySummary: opportunityResult.summary,
      relationships: relationshipRows,
      evidenceByDistrict,
      facilities,
      freshness,
      currentCongress,
      representativesByFacility: facilityRows.map((f, i) => ({
        facility: { id: f.id, name: f.name, city: f.city, state: f.state },
        representation: representations[i]!,
      })),
      generatedAt: new Date().toISOString(),
    });
  }

  /**
   * Resolve `federal_contractor.id -> federal_contractor.uei`, outside any
   * tenant transaction (it reads a global reference table). Shared by the
   * single-client and firm-wide identity resolution paths.
   */
  private async resolveContractorUeis(contractorIds: string[]): Promise<ContractorUeiIndex> {
    if (!contractorIds.length) return new Map();
    const rows = await this.prisma.federalContractor.findMany({
      where: { id: { in: contractorIds } },
      select: { id: true, uei: true },
    });
    return new Map(rows.map((r) => [r.id, r.uei]));
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
    options: {
      view?: string | null;
      clientId?: string | null;
      state?: string | null;
      /** When true, include every House seat as a zero-nexus placeholder so the
       * map can show national public-intel coverage without inventing footprint. */
      includeAllDistricts?: boolean | null;
    } = {},
  ): Promise<DistrictNexusMapResponse> {
    parseView(options.view);

    const generatedAt = new Date().toISOString();
    const currentCongress = currentCongressNumber(new Date());

    // ── Phase 1: tenant-scoped, one short transaction for ALL clients ───────
    const { seeds, facilitiesByClient } = await this.prisma.withTenant(tenantId, async (tx) => {
      const clientWhere = options.clientId ? { clientId: options.clientId } : {};
      // Soft-archived clients contribute nothing (audit F6). ClientFacility
      // filters through its real `client` relation directly; ClientIntelMapping
      // has none, so the visible client id set is pre-resolved and used as an
      // explicit `clientId: { in: ... }` filter instead.
      const [visibleClients, facilityRows] = await Promise.all([
        tx.client.findMany({
          where: { ...VISIBLE_CLIENT_FILTER, ...(options.clientId ? { id: options.clientId } : {}) },
          select: { id: true, name: true, uei: true },
        }),
        tx.clientFacility.findMany({
          where: { ...clientWhere, ...(options.state ? { state: options.state } : {}), client: VISIBLE_CLIENT_FILTER },
          select: {
            clientId: true,
            state: true,
            congressionalDistrict: true,
            congressionalDistrictCongress: true,
            employeeCount: true,
            geocodeStatus: true,
            districtSource: true,
          },
        }),
      ]);
      const visibleClientIds = visibleClients.map((c) => c.id);
      const mappings = visibleClientIds.length
        ? await tx.clientIntelMapping.findMany({
            where: {
              clientId: { in: visibleClientIds },
              confirmed: true,
              reviewStatus: 'confirmed',
              rollUpAwards: true,
              source: { in: ['contracting', 'assistance_recipient'] },
            },
            select: {
              clientId: true,
              source: true,
              externalId: true,
              externalName: true,
              matchBasis: true,
              matchTier: true,
            },
          })
        : [];

      const mappingsByClient = new Map<string, DistrictNexusIdentitySeed['mappings']>();
      for (const m of mappings) {
        const bucket = mappingsByClient.get(m.clientId);
        const row = {
          source: m.source,
          externalId: m.externalId,
          externalName: m.externalName,
          matchBasis: m.matchBasis,
          matchTier: m.matchTier,
        };
        if (bucket) bucket.push(row);
        else mappingsByClient.set(m.clientId, [row]);
      }

      const seeds: DistrictNexusIdentitySeed[] = visibleClients.map((c) => ({
        clientId: c.id,
        clientName: c.name,
        uei: c.uei,
        mappings: mappingsByClient.get(c.id) ?? [],
      }));

      const facilitiesByClient = new Map<string, FacilityRow[]>();
      for (const f of facilityRows) {
        const bucket = facilitiesByClient.get(f.clientId);
        const row: FacilityRow = {
          state: f.state,
          districtCode: f.congressionalDistrict,
          employeeCount: f.employeeCount,
          geocodeStatus: f.geocodeStatus,
          districtSource: f.districtSource,
          congressionalDistrictCongress: f.congressionalDistrictCongress,
        };
        if (bucket) bucket.push(row);
        else facilitiesByClient.set(f.clientId, [row]);
      }

      return { seeds, facilitiesByClient };
    });

    // Contractor UUID -> UEI resolution happens OUTSIDE the tenant
    // transaction, ACROSS every visible client — one lookup, not one per
    // client (§4/§6).
    const contractorUeis = await this.resolveContractorUeis(districtNexusContractorIdsToResolve(seeds));
    const identities: DistrictNexusClientIdentity[] = seeds.map((seed) =>
      buildDistrictNexusIdentity(seed, contractorUeis),
    );

    // ── Phase 2: global aggregates, outside the tenant transaction ──────────
    //
    // ONE query per rail (per basis) across the union of every client's
    // identifiers, then the rows are attributed back to clients in memory. A
    // per-client query would be the N+1 this whole design exists to avoid.
    // The two bases are never unioned into one identifier set (§6) — each
    // basis gets its own branch, carried on the row as `matchBasis`, so a
    // client can only ever consume rows from ITS OWN rail's basis.
    const allContractUeis = dedupe(
      identities.flatMap((i) => (i.contract.basis === 'exact_uei' ? i.contract.ueis : [])),
    );
    const allContractFallbackNames = dedupe(
      identities.flatMap((i) => (i.contract.basis === 'reviewed_name_fallback' ? i.contract.fallbackNames : [])),
    );
    const allAssistanceUeis = dedupe(
      identities.flatMap((i) => (i.assistance.basis === 'exact_uei' ? i.assistance.ueis : [])),
    );
    const allAssistanceFallbackNames = dedupe(
      identities.flatMap((i) =>
        i.assistance.basis === 'reviewed_name_fallback' ? i.assistance.fallbackNames : [],
      ),
    );

    const [contractRows, assistanceRows, freshness, relationshipRows] = await Promise.all([
      this.aggregateContractsByIdentifier(allContractUeis, allContractFallbackNames),
      this.aggregateAssistanceByIdentifier(allAssistanceUeis, allAssistanceFallbackNames),
      this.readFreshness(),
      this.aggregateRelationshipNexus(options.clientId ?? null, tenantId),
    ]);

    // Attribute each aggregated row back to the clients that claim its
    // identifier UNDER THAT CLIENT'S OWN BASIS. A name or UEI can legitimately
    // belong to more than one client (shared parent, joint venture), so this
    // is a fan-out, not a lookup — but never a fan-out across bases: client B
    // never inherits client A's UEI-sourced rows just because a row happens to
    // carry a name B also holds (§6 regression case).
    const perClient: ClientNexusInputs[] = identities.map((identity) => {
      const contractUeis = new Set(identity.contract.ueis);
      const contractNames = new Set(identity.contract.fallbackNames);
      const assistanceUeis = new Set(identity.assistance.ueis);
      const assistanceNames = new Set(identity.assistance.fallbackNames);
      return {
        clientId: identity.clientId,
        contracts:
          identity.contract.basis === 'exact_uei'
            ? contractRows
                .filter((r) => r.matchBasis === 'uei' && r.identifier != null && contractUeis.has(r.identifier))
                .map(({ identifier: _identifier, ...row }) => row)
            : identity.contract.basis === 'reviewed_name_fallback'
              ? contractRows
                  .filter(
                    (r) => r.matchBasis === 'contractor_name' && r.identifier != null && contractNames.has(r.identifier),
                  )
                  .map(({ identifier: _identifier, ...row }) => row)
              : [],
        assistance:
          identity.assistance.basis === 'exact_uei'
            ? assistanceRows
                .filter((r) => r.matchBasis === 'uei' && r.uei != null && assistanceUeis.has(r.uei))
                .map(({ uei: _uei, nameLower: _nameLower, ...row }) => row)
            : identity.assistance.basis === 'reviewed_name_fallback'
              ? assistanceRows
                  .filter(
                    (r) => r.matchBasis === 'recipient_name' && r.nameLower != null && assistanceNames.has(r.nameLower),
                  )
                  .map(({ uei: _uei, nameLower: _nameLower, ...row }) => row)
              : [],
        // Opportunities are a CLIENT-level rail (see aggregateOpportunitySummary),
        // not district money — Grants.gov publishes applicant eligibility, not a
        // place of performance. The firm map omits them rather than issuing one
        // query per client for numbers it cannot colour a district by. The KPI
        // strip must therefore render this as UNAVAILABLE, never as $0.
        opportunities: [],
        relationships: relationshipRows.filter((r) => r.clientId === identity.clientId),
        facilities: facilitiesByClient.get(identity.clientId) ?? [],
        freshness,
        generatedAt,
        currentCongress,
      };
    });

    const response = buildFirmNexusResponse({ perClient, freshness, generatedAt });

    // District names/status: ONE query for every state on the map, matched in
    // memory. `districtNo` is a bare number string and a sole House seat is
    // reported as "1", so this must not be a string-equality join — see
    // district-nexus.district-names.ts.
    let finalResponse = response;
    if (options.includeAllDistricts) {
      // Expand FIRST so name resolution covers every seat, not only nexus keys.
      finalResponse = expandFirmMapWithAllDistricts(response, {
        state: options.state ?? null,
      });
    }

    const keys = finalResponse.districts.map((d) => d.districtKey);
    if (keys.length) {
      const rows = await this.prisma.legislativeDistrict.findMany({
        // status 'C' only — the only view the backend can answer
        // (district-nexus.view.ts). Without it a state's future ('F') row joins
        // the same candidate set as its current row, and
        // matchFacilityDistrictCode's at-large branch (which requires EXACTLY
        // one House row for the state) silently stops matching, while a
        // numbered district can non-deterministically pick up the F row's
        // name and status.
        where: { state: { in: statesForKeys(keys) }, chamber: 'house', status: 'C' },
        select: { state: true, districtNo: true, name: true, status: true },
      });
      const names = resolveDistrictNames(keys, rows);
      for (const district of finalResponse.districts) {
        const named = names.get(district.districtKey);
        if (!named) continue;
        district.name = named.name;
        district.status = named.status;
      }
    }

    return finalResponse;
  }

  /**
   * Contract spend by place-of-performance district.
   *
   * Release 1 identity rule: exactly one basis, never OR'd (§2/§4). `none`
   * issues no query — an unmapped/unidentifiable client contributes nothing,
   * rather than an empty-array predicate that happens to match zero rows for
   * the wrong reason.
   */
  private async aggregateContracts(rail: AwardIdentityRail): Promise<ContractDistrictRow[]> {
    if (rail.basis === 'none') return [];
    const matchBasis: 'uei' | 'contractor_name' = rail.basis === 'exact_uei' ? 'uei' : 'contractor_name';
    const rows = await this.prisma.$queryRaw<
      Array<{
        state: string | null;
        district: string | null;
        award_count: bigint;
        total_amount: number | null;
      }>
    >(
      rail.basis === 'exact_uei'
        ? Prisma.sql`
            SELECT pop_state AS state,
                   pop_congressional_district AS district,
                   COUNT(*)::bigint AS award_count,
                   COALESCE(SUM(amount), 0)::float8 AS total_amount
            FROM federal_award
            WHERE recipient_uei = ANY(${rail.ueis}::text[])
            GROUP BY pop_state, pop_congressional_district
          `
        : Prisma.sql`
            SELECT pop_state AS state,
                   pop_congressional_district AS district,
                   COUNT(*)::bigint AS award_count,
                   COALESCE(SUM(amount), 0)::float8 AS total_amount
            FROM federal_award
            WHERE lower(contractor_name) = ANY(${rail.fallbackNames}::text[])
            GROUP BY pop_state, pop_congressional_district
          `,
    );
    return rows.map((r) => ({
      state: r.state,
      district: r.district,
      awardCount: Number(r.award_count),
      totalAmount: r.total_amount ?? 0,
      matchBasis,
    }));
  }

  /**
   * Assistance spend by district, carrying the basis each row was resolved on.
   *
   * Release 1 identity rule: exactly one basis, never OR'd (§2/§4) — `none`
   * issues no query. The geography CASE pair below is repeated verbatim
   * everywhere this file selects assistance geography (§5): `state` and
   * `district` are chosen TOGETHER, never via two independent COALESCEs,
   * which could pair one award's place-of-performance state with a different
   * award's recipient-location district and fabricate a district that award
   * never touched.
   *
   * The name predicate is matched on lower(...) against
   * `faa_recipient_name_lower_idx` (20260801010000): the pre-existing index on
   * that column is a GIN trigram built for similarity search, which an
   * equality predicate cannot use. The lower() form also fixes a silent
   * recall bug — USAspending returns recipient names uppercase while
   * ClientIntelMapping.externalName is operator-entered, so a case-sensitive
   * join dropped real awards and read as "no assistance awards for this
   * client".
   */
  private async aggregateAssistance(rail: AwardIdentityRail): Promise<AssistanceDistrictRow[]> {
    if (rail.basis === 'none') return [];
    const matchBasis: 'uei' | 'recipient_name' = rail.basis === 'exact_uei' ? 'uei' : 'recipient_name';
    const rows = await this.prisma.$queryRaw<
      Array<{
        state: string | null;
        district: string | null;
        basis: string;
        award_count: bigint;
        total_obligated: number | null;
        total_outlayed: number | null;
      }>
    >(
      rail.basis === 'exact_uei'
        ? Prisma.sql`
            SELECT ${PAIRED_ASSISTANCE_STATE_EXPR} AS state,
                   ${PAIRED_ASSISTANCE_DISTRICT_EXPR} AS district,
                   ${PAIRED_ASSISTANCE_BASIS_EXPR} AS basis,
                   COUNT(*)::bigint AS award_count,
                   COALESCE(SUM(total_obligated_amount), 0)::float8 AS total_obligated,
                   COALESCE(SUM(total_outlayed_amount), 0)::float8 AS total_outlayed
            FROM federal_assistance_award
            WHERE recipient_uei = ANY(${rail.ueis}::text[])
            GROUP BY 1, 2, 3
          `
        : Prisma.sql`
            SELECT ${PAIRED_ASSISTANCE_STATE_EXPR} AS state,
                   ${PAIRED_ASSISTANCE_DISTRICT_EXPR} AS district,
                   ${PAIRED_ASSISTANCE_BASIS_EXPR} AS basis,
                   COUNT(*)::bigint AS award_count,
                   COALESCE(SUM(total_obligated_amount), 0)::float8 AS total_obligated,
                   COALESCE(SUM(total_outlayed_amount), 0)::float8 AS total_outlayed
            FROM federal_assistance_award
            WHERE lower(recipient_name) = ANY(${rail.fallbackNames}::text[])
            GROUP BY 1, 2, 3
          `,
    );
    return rows.map((r) => ({
      state: r.state,
      district: r.district,
      basis: r.basis === 'place_of_performance' ? 'place_of_performance' : 'recipient_location',
      matchBasis,
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
    rail: AwardIdentityRail,
  ): Promise<ContractEvidenceSourceRow[]> {
    if (rail.basis === 'none') return [];
    const matchBasis: 'uei' | 'contractor_name' = rail.basis === 'exact_uei' ? 'uei' : 'contractor_name';
    const predicate =
      rail.basis === 'exact_uei'
        ? Prisma.sql`recipient_uei = ANY(${rail.ueis}::text[])`
        : Prisma.sql`lower(contractor_name) = ANY(${rail.fallbackNames}::text[])`;
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
    >(Prisma.sql`
      SELECT id, contractor_name, pop_state, pop_congressional_district, amount, action_date, last_synced_at
      FROM (
        SELECT id::text AS id, contractor_name, pop_state, pop_congressional_district,
               amount::float8 AS amount, action_date, last_synced_at,
               ROW_NUMBER() OVER (
                 PARTITION BY pop_state, pop_congressional_district
                 ORDER BY amount DESC NULLS LAST
               ) AS rn
        FROM federal_award
        WHERE ${predicate}
      ) ranked
      WHERE rn <= ${EVIDENCE_CAP_PER_DISTRICT}
    `);
    return rows.map((r) => ({
      id: r.id,
      contractorName: r.contractor_name,
      state: r.pop_state,
      district: r.pop_congressional_district,
      amount: r.amount,
      actionDate: r.action_date ? r.action_date.toISOString() : null,
      lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
      matchBasis,
    }));
  }

  /** Record-level assistance rows for evidence (WS-E4). See fetchContractEvidenceRowsForClient. */
  private async fetchAssistanceEvidenceRowsForClient(
    rail: AwardIdentityRail,
  ): Promise<AssistanceEvidenceSourceRow[]> {
    if (rail.basis === 'none') return [];
    const matchBasis: 'uei' | 'recipient_name' = rail.basis === 'exact_uei' ? 'uei' : 'recipient_name';
    const predicate =
      rail.basis === 'exact_uei'
        ? Prisma.sql`recipient_uei = ANY(${rail.ueis}::text[])`
        : Prisma.sql`lower(recipient_name) = ANY(${rail.fallbackNames}::text[])`;
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
    >(Prisma.sql`
      SELECT id, recipient_uei, recipient_name, state, district, basis,
             total_obligated_amount, start_date, last_synced_at, pop_cd_vintage
      FROM (
        SELECT id::text AS id, recipient_uei, recipient_name,
               ${PAIRED_ASSISTANCE_STATE_EXPR} AS state,
               ${PAIRED_ASSISTANCE_DISTRICT_EXPR} AS district,
               ${PAIRED_ASSISTANCE_BASIS_EXPR} AS basis,
               total_obligated_amount::float8 AS total_obligated_amount,
               start_date, last_synced_at, pop_cd_vintage,
               ROW_NUMBER() OVER (
                 PARTITION BY ${PAIRED_ASSISTANCE_STATE_EXPR}, ${PAIRED_ASSISTANCE_DISTRICT_EXPR}
                 ORDER BY total_obligated_amount DESC NULLS LAST
               ) AS rn
        FROM federal_assistance_award
        WHERE ${predicate}
      ) ranked
      WHERE rn <= ${EVIDENCE_CAP_PER_DISTRICT}
    `);
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
      matchBasis,
    }));
  }

  /**
   * Record-level contract rows for evidence (WS-E4), already known to be in
   * ONE district — the plain-LIMIT counterpart of
   * fetchContractEvidenceRowsForClient's per-district window function, which
   * is unnecessary once state+district is fixed by the caller.
   *
   * Takes a union identifier set (§9) rather than a single client's rail: the
   * unscoped district-detail view legitimately spans every client with
   * activity here, so both bases may be non-empty at once — each branch is
   * still queried separately (never OR'd) and tagged with its own matchBasis.
   */
  private async fetchContractEvidenceRows(
    identifiers: { ueis: string[]; fallbackNames: string[] },
    stateCode: string,
    districtCode: string,
  ): Promise<ContractEvidenceSourceRow[]> {
    const branches: Prisma.Sql[] = [];
    if (identifiers.ueis.length) {
      branches.push(Prisma.sql`
        SELECT id::text AS id, contractor_name, amount::float8 AS amount, action_date, last_synced_at,
               'uei' AS match_basis
        FROM federal_award
        WHERE recipient_uei = ANY(${identifiers.ueis}::text[])
          AND pop_state = ${stateCode} AND pop_congressional_district = ${districtCode}
      `);
    }
    if (identifiers.fallbackNames.length) {
      branches.push(Prisma.sql`
        SELECT id::text AS id, contractor_name, amount::float8 AS amount, action_date, last_synced_at,
               'contractor_name' AS match_basis
        FROM federal_award
        WHERE lower(contractor_name) = ANY(${identifiers.fallbackNames}::text[])
          AND pop_state = ${stateCode} AND pop_congressional_district = ${districtCode}
      `);
    }
    if (!branches.length) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        contractor_name: string | null;
        amount: number | null;
        action_date: Date | null;
        last_synced_at: Date | null;
        match_basis: string;
      }>
    >(Prisma.sql`${Prisma.join(branches, ' UNION ALL ')} ORDER BY amount DESC NULLS LAST LIMIT ${EVIDENCE_CAP_PER_DISTRICT}`);
    return rows.map((r) => ({
      id: r.id,
      contractorName: r.contractor_name,
      state: stateCode,
      district: districtCode,
      amount: r.amount,
      actionDate: r.action_date ? r.action_date.toISOString() : null,
      lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
      matchBasis: r.match_basis === 'uei' ? 'uei' : 'contractor_name',
    }));
  }

  /** Record-level assistance rows for evidence (WS-E4), single-district. See fetchContractEvidenceRows. */
  private async fetchAssistanceEvidenceRows(
    identifiers: { ueis: string[]; fallbackNames: string[] },
    stateCode: string,
    districtCode: string,
  ): Promise<AssistanceEvidenceSourceRow[]> {
    const branches: Prisma.Sql[] = [];
    if (identifiers.ueis.length) {
      branches.push(Prisma.sql`
        SELECT id::text AS id, recipient_uei, recipient_name,
               ${PAIRED_ASSISTANCE_BASIS_EXPR} AS basis,
               total_obligated_amount::float8 AS total_obligated_amount,
               start_date, last_synced_at, pop_cd_vintage, 'uei' AS match_basis
        FROM federal_assistance_award
        WHERE recipient_uei = ANY(${identifiers.ueis}::text[])
          AND ${PAIRED_ASSISTANCE_STATE_EXPR} = ${stateCode}
          AND ${PAIRED_ASSISTANCE_DISTRICT_EXPR} = ${districtCode}
      `);
    }
    if (identifiers.fallbackNames.length) {
      branches.push(Prisma.sql`
        SELECT id::text AS id, recipient_uei, recipient_name,
               ${PAIRED_ASSISTANCE_BASIS_EXPR} AS basis,
               total_obligated_amount::float8 AS total_obligated_amount,
               start_date, last_synced_at, pop_cd_vintage, 'recipient_name' AS match_basis
        FROM federal_assistance_award
        WHERE lower(recipient_name) = ANY(${identifiers.fallbackNames}::text[])
          AND ${PAIRED_ASSISTANCE_STATE_EXPR} = ${stateCode}
          AND ${PAIRED_ASSISTANCE_DISTRICT_EXPR} = ${districtCode}
      `);
    }
    if (!branches.length) return [];
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
        match_basis: string;
      }>
    >(
      Prisma.sql`${Prisma.join(branches, ' UNION ALL ')} ORDER BY total_obligated_amount DESC NULLS LAST LIMIT ${EVIDENCE_CAP_PER_DISTRICT}`,
    );
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
      matchBasis: r.match_basis === 'uei' ? 'uei' : 'recipient_name',
    }));
  }

  /**
   * The client-side half of relevance scoring, assembled from data we already
   * hold. Fetches rows, then delegates the shaping to
   * `shapeClientRelevanceProfile` (grant-opportunity-candidates.ts) — the same
   * pure function the batch producer script uses, so a live client read and
   * the nightly candidate job can never quietly compute different profiles
   * for the same client.
   */
  private async buildClientRelevanceProfile(
    clientId: string,
    tenantId: string,
    identifiers: { recipientUeis: string[]; recipientNames: string[] },
  ): Promise<ClientRelevanceProfile> {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        // Soft-archived clients contribute nothing (audit F6) — same filter
        // every other client read in this file uses. The caller already
        // zeroes identifiers.recipientUeis/recipientNames for an archived
        // client, but without this, this call alone would still leak its
        // real sectorTag/capabilities/facilities into the relevance profile.
        where: { id: clientId, ...VISIBLE_CLIENT_FILTER },
        select: {
          sectorTag: true,
          applicantTypes: true,
          intakeData: true,
          capabilities: { select: { name: true, sector: true, tags: true, keywords: true } },
          facilities: { select: { state: true } },
        },
      }),
    );

    let priorAssistanceListings: Array<string | null> = [];
    let priorAgencies: Array<string | null> = [];
    if (identifiers.recipientUeis.length || identifiers.recipientNames.length) {
      const lowerNames = identifiers.recipientNames.map((n) => n.toLowerCase());
      const rows = await this.prisma.$queryRaw<
        Array<{ assistance_listing_number: string | null; awarding_agency: string | null }>
      >`
        SELECT DISTINCT assistance_listing_number, awarding_agency
        FROM federal_assistance_award
        WHERE recipient_uei = ANY(${identifiers.recipientUeis}::text[])
           OR lower(recipient_name) = ANY(${lowerNames}::text[])
      `;
      priorAssistanceListings = rows.map((r) => r.assistance_listing_number);
      priorAgencies = rows.map((r) => r.awarding_agency);
    }

    return shapeClientRelevanceProfile({
      sectorTag: client?.sectorTag ?? null,
      capabilities: client?.capabilities ?? [],
      facilityStates: (client?.facilities ?? []).map((f) => f.state),
      priorAssistanceListings,
      priorAgencies,
      // Archived client → `client` is null here, so this stays empty and F3
      // eligibility reports needs_review, matching every other field above.
      applicantTypes: client?.applicantTypes ?? [],
      fundingPriorities: fundingPrioritiesFromIntake(client?.intakeData),
    });
  }

  /**
   * Grant opportunities this client has been explicitly linked to.
   *
   * Only ClientGrantNexus rows with relationshipType 'opportunity_candidate'
   * count, and a 'rejected' one is excluded — it is not weak evidence, it is
   * not evidence. An opportunity nobody has linked to the client is market
   * noise, not a nexus, and must not appear in their numbers.
   *
   * Returns the CLIENT-level rail. Opportunities do not fold into districts:
   * Grants.gov publishes applicant eligibility, not a place of performance, so
   * the only honest district link is an explicit project site — carried on the
   * link row's facilityId and returned as `districtKey`, never inferred.
   *
   * NOTE: `ClientGrantNexus.facilityId` is a deliberately FK-less pointer (see
   * that model's schema comment, same rationale as `assistanceAwardId` and
   * `grantOpportunityId`) — there is no Prisma relation to nest a `select`
   * through, so the linked facility's state/district is resolved with a
   * second, batched lookup rather than a nested `select: { facility: {...} }`.
   */
  private async aggregateOpportunitySummary(
    clientId: string,
    tenantId: string,
    relevance: ClientRelevanceProfile,
  ): Promise<{ summary: ClientOpportunitySummary; districtRows: OpportunityRow[] }> {
    const { links, facilityRows } = await this.prisma.withTenant(tenantId, async (tx) => {
      const links = await tx.clientGrantNexus.findMany({
        where: {
          clientId,
          relationshipType: 'opportunity_candidate',
          // A rejected candidate is not weak evidence, it is not evidence.
          verificationStatus: { not: 'rejected' },
          grantOpportunityId: { not: null },
          // Soft-archived clients contribute nothing (audit F6).
          client: VISIBLE_CLIENT_FILTER,
        },
        select: { grantOpportunityId: true, facilityId: true },
      });
      const facilityIds = dedupe(links.map((l) => l.facilityId));
      const facilityRows = facilityIds.length
        ? await tx.clientFacility.findMany({
            where: { id: { in: facilityIds } },
            select: { id: true, state: true, congressionalDistrict: true },
          })
        : [];
      return { links, facilityRows };
    });

    const ids = dedupe(links.map((l) => l.grantOpportunityId));
    if (!ids.length) {
      return { summary: EMPTY_OPPORTUNITY_SUMMARY, districtRows: [] };
    }

    const grants = await this.prisma.federalGrant.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        title: true,
        agency: true,
        status: true,
        closeDate: true,
        responseDateDesc: true,
        estimatedFunding: true,
        awardCeiling: true,
        eligibility: true,
        cfdaNumbers: true,
        category: true,
        description: true,
      },
    });

    // Project-site district, when the link row named a facility. This is the ONLY
    // path from an opportunity to a district.
    const facilityById = new Map(facilityRows.map((f) => [f.id, f]));
    const districtByOpportunity = new Map<string, DistrictKey | null>();
    for (const l of links) {
      if (!l.grantOpportunityId) continue;
      const facility = l.facilityId ? facilityById.get(l.facilityId) : undefined;
      const key = facility ? districtKeyFor(facility.state, facility.congressionalDistrict) : null;
      // First non-null wins; a second site does not overwrite a resolved one.
      if (!districtByOpportunity.get(l.grantOpportunityId)) {
        districtByOpportunity.set(l.grantOpportunityId, key);
      }
    }

    const today = startOfUtcDay(new Date());
    const opportunities: ClientOpportunity[] = grants.map((g) => {
      const scored = scoreOpportunityRelevance(relevance, {
        assistanceListingNumber: g.cfdaNumbers[0] ?? null,
        agency: g.agency,
        fundingCategory: g.category,
        title: g.title,
        description: g.description,
        eligibleApplicantTypes: g.eligibility,
        // Grants.gov's search/detail payloads carry no geographic restriction
        // field, so this is honestly empty rather than a guess. computeEligibility
        // treats empty as unrestricted, which is correct: the notice did not
        // restrict geography.
        geographicRestrictions: [],
      });
      return {
        opportunityId: g.id,
        title: g.title,
        agency: g.agency,
        status: g.status,
        closeDate: g.closeDate ? g.closeDate.toISOString() : null,
        responseDateDesc: g.responseDateDesc,
        isActive: isOpportunityActive(g.status, g.closeDate, today),
        estimatedFunding: g.estimatedFunding,
        awardCeiling: g.awardCeiling,
        relevanceScore: scored.relevanceScore,
        eligibilityState: scored.eligibilityState,
        eligibilityReason: scored.reason,
        matchedSignals: scored.matchedSignals,
        districtKey: districtByOpportunity.get(g.id) ?? null,
      };
    });

    const active = opportunities.filter((o) => o.isActive);
    const estimates = active.map((o) => o.estimatedFunding).filter((v): v is number => v != null);
    const ceilings = active.map((o) => o.awardCeiling).filter((v): v is number => v != null);

    const summary: ClientOpportunitySummary = {
      activeOpportunityCount: active.length,
      closedOpportunityCount: opportunities.length - active.length,
      // null, not 0 — no opportunity stated an amount is not "$0 of funding".
      totalEstimatedFunding: estimates.length ? estimates.reduce((s, v) => s + v, 0) : null,
      maximumAwardCeiling: ceilings.length ? Math.max(...ceilings) : null,
      topOpportunities: [...active]
        .sort((a, b) => {
          const rel = (b.relevanceScore ?? -1) - (a.relevanceScore ?? -1);
          if (rel !== 0) return rel;
          // Soonest deadline first; no deadline sorts last.
          const at = a.closeDate ? Date.parse(a.closeDate) : Number.POSITIVE_INFINITY;
          const bt = b.closeDate ? Date.parse(b.closeDate) : Number.POSITIVE_INFINITY;
          return at - bt;
        })
        .slice(0, TOP_OPPORTUNITY_CAP),
    };

    // Only project-site-linked opportunities reach a district.
    const districtRows: OpportunityRow[] = active
      .filter((o) => o.districtKey != null)
      .map((o) => {
        const parts = splitDistrictKey(o.districtKey!);
        return {
          state: parts?.state ?? null,
          district: parts?.districtCode ?? null,
          estimatedFunding: o.estimatedFunding,
          awardCeiling: o.awardCeiling,
        };
      });

    return { summary, districtRows };
  }

  /**
   * Client-owned grant relationships that are NOT opportunity candidates —
   * subrecipient, project site, research/coalition partner, beneficiary,
   * matching contributor, and explicit direct-recipient assertions (audit F4).
   *
   * These existed in the schema (client_grant_nexus) and were read by
   * nothing: a verified subrecipient relationship had no effect on any number
   * a user saw, so `attributableAmount`, `facilityId`, verification status
   * and external-use approval were all inert. That is what this closes.
   *
   * Award geography precedence, in order:
   *   1. the link row's own facility (a stated project site is the strongest
   *      geographic claim available),
   *   2. the award's place of performance,
   *   3. the award's recipient location.
   *
   * Money precedence: `attributableAmount` when the reviewer supplied one
   * (as an obligated figure — there is no attributable-OUTLAY column, and
   * fabricating one by ratio is not on the table); else the award's full
   * obligation AND outlay, ONLY for `direct_recipient`. Every other role with
   * no stated share contributes PRESENCE, not dollars.
   *
   * NOTE: like aggregateOpportunitySummary, `facilityId` is a deliberately
   * FK-less pointer (schema comment on ClientGrantNexus) — resolved with a
   * second, batched lookup rather than a nested select. Unlike `facilityId`,
   * `clientId` IS a real Prisma relation here, so the client's name is read
   * directly off it rather than needing a third lookup.
   */
  private async aggregateRelationshipNexus(
    clientId: string | null,
    tenantId: string,
  ): Promise<RelationshipEvidenceRow[]> {
    const { links, facilityRows } = await this.prisma.withTenant(tenantId, async (tx) => {
      const links = await tx.clientGrantNexus.findMany({
        where: {
          ...(clientId ? { clientId } : {}),
          relationshipType: { in: [...AWARD_RELATIONSHIP_TYPES] },
          verificationStatus: { not: 'rejected' },
          assistanceAwardId: { not: null },
          // Soft-archived clients contribute nothing (audit F6).
          client: VISIBLE_CLIENT_FILTER,
        },
        select: {
          id: true,
          clientId: true,
          client: { select: { name: true } },
          relationshipType: true,
          assistanceAwardId: true,
          facilityId: true,
          attributableAmount: true,
          verificationStatus: true,
          externalUseApproved: true,
          effectiveStart: true,
          effectiveEnd: true,
          updatedAt: true,
        },
      });
      const facilityIds = dedupe(links.map((l) => l.facilityId));
      const facilityRows = facilityIds.length
        ? await tx.clientFacility.findMany({
            where: { id: { in: facilityIds } },
            select: { id: true, state: true, congressionalDistrict: true },
          })
        : [];
      return { links, facilityRows };
    });

    // Effective-window filter: a null bound is open-ended.
    const today = startOfUtcDay(new Date());
    const active = links.filter((l) => {
      if (l.effectiveStart && startOfUtcDay(l.effectiveStart).getTime() > today.getTime()) return false;
      if (l.effectiveEnd && startOfUtcDay(l.effectiveEnd).getTime() < today.getTime()) return false;
      return true;
    });
    if (!active.length) return [];

    // Global table, fetched OUTSIDE the tenant transaction — same discipline
    // as every other rail (see this class's docblock).
    const awardIds = dedupe(active.map((l) => l.assistanceAwardId));
    const awards = awardIds.length
      ? await this.prisma.federalAssistanceAward.findMany({
          where: { id: { in: awardIds } },
          select: {
            id: true,
            recipientName: true,
            popState: true,
            popCongressionalDistrict: true,
            recipientState: true,
            recipientCongressionalDistrict: true,
            totalObligatedAmount: true,
            totalOutlayedAmount: true,
            popCdVintage: true,
          },
        })
      : [];

    const facilityById = new Map(facilityRows.map((f) => [f.id, f]));
    const awardById = new Map(awards.map((a) => [a.id, a]));

    const rows: RelationshipEvidenceRow[] = [];
    for (const link of active) {
      const component = componentForRelationship(link.relationshipType);
      if (!component) continue; // an unrecognised relationshipType earns no score credit

      const award = link.assistanceAwardId ? awardById.get(link.assistanceAwardId) : undefined;
      const facility = link.facilityId ? facilityById.get(link.facilityId) : undefined;

      let state: string | null = null;
      let district: string | null = null;
      let geographyBasis: GeographyBasis = 'unknown';
      if (facility?.state) {
        state = facility.state;
        district = facility.congressionalDistrict;
        geographyBasis = 'project_site';
      } else if (award?.popState) {
        state = award.popState;
        district = award.popCongressionalDistrict;
        geographyBasis = 'place_of_performance';
      } else if (award?.recipientState) {
        state = award.recipientState;
        district = award.recipientCongressionalDistrict;
        geographyBasis = 'recipient_location';
      }

      const tier = relationshipTier(link.verificationStatus);
      const claimsFullAmount = claimsFullAwardAmount(link.relationshipType);
      // Decimal columns — Number() only after a null check, never arithmetic
      // on the Decimal instance directly (repo convention, see
      // budget-lines-read.service.ts's `num` helper).
      const obligatedAmount =
        link.attributableAmount != null
          ? Number(link.attributableAmount)
          : claimsFullAmount && award?.totalObligatedAmount != null
            ? Number(award.totalObligatedAmount)
            : null;
      const outlayedAmount =
        link.attributableAmount != null
          ? null // no attributable-outlay column exists; never fabricate a split.
          : claimsFullAmount && award?.totalOutlayedAmount != null
            ? Number(award.totalOutlayedAmount)
            : null;

      rows.push({
        clientId: link.clientId,
        state,
        district,
        component,
        obligatedAmount,
        outlayedAmount,
        strength: tier.strength,
        geographyBasis,
        id: link.id,
        clientName: link.client.name,
        relationshipType: link.relationshipType,
        counterparty: award?.recipientName ?? null,
        status: tier.status,
        confidence: tier.confidence,
        externalUseApproved: link.externalUseApproved,
        popCdVintage: award?.popCdVintage ?? null,
        sourceUpdatedAt: link.updatedAt.toISOString(),
        observedAt: link.effectiveStart ? link.effectiveStart.toISOString() : null,
      });
    }
    return rows;
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
  /**
   * The confirmed identifiers behind a score, resolved to canonical identity
   * rails (Release 1, §9) — never a flat name/UEI list. Contractor UUID -> UEI
   * resolution happens OUTSIDE the tenant transaction, across every relevant
   * client at once (§4/§6).
   */
  private async resolveConfirmedIdentifiers(
    tenantId: string,
    clientId: string | null,
  ): Promise<{
    contract: { ueis: string[]; fallbackNames: string[] };
    assistance: { ueis: string[]; fallbackNames: string[] };
    /** Each client's own rails — audit F5's per-client breakdown (§9). */
    byClient: Map<string, { clientName: string; contract: AwardIdentityRail; assistance: AwardIdentityRail }>;
  }> {
    const seeds = await this.prisma.withTenant(tenantId, async (tx) => {
      const mappings = await tx.clientIntelMapping.findMany({
        where: {
          ...(clientId ? { clientId } : {}),
          confirmed: true,
          reviewStatus: 'confirmed',
          rollUpAwards: true,
          source: { in: ['contracting', 'assistance_recipient'] },
        },
        select: {
          clientId: true,
          source: true,
          externalId: true,
          externalName: true,
          matchBasis: true,
          matchTier: true,
        },
      });

      // ClientIntelMapping carries no Prisma `client` relation (unlike
      // ClientFacility/ClientGrantNexus) — the name/UEI behind each clientId is
      // resolved with a second, batched lookup rather than a nested select.
      // The same lookup carries the visibility filter (audit F6): a
      // soft-archived client's mappings are excluded below by virtue of never
      // matching a row in `clients`.
      const mappedClientIds = dedupe(mappings.map((m) => m.clientId));
      const clients = mappedClientIds.length
        ? await tx.client.findMany({
            where: { id: { in: mappedClientIds }, ...VISIBLE_CLIENT_FILTER },
            select: { id: true, name: true, uei: true },
          })
        : [];

      const mappingsByClient = new Map<string, DistrictNexusIdentitySeed['mappings']>();
      for (const m of mappings) {
        const bucket = mappingsByClient.get(m.clientId);
        const row = {
          source: m.source,
          externalId: m.externalId,
          externalName: m.externalName,
          matchBasis: m.matchBasis,
          matchTier: m.matchTier,
        };
        if (bucket) bucket.push(row);
        else mappingsByClient.set(m.clientId, [row]);
      }

      return clients.map(
        (c): DistrictNexusIdentitySeed => ({
          clientId: c.id,
          clientName: c.name,
          uei: c.uei,
          mappings: mappingsByClient.get(c.id) ?? [],
        }),
      );
    });

    const contractorUeis = await this.resolveContractorUeis(districtNexusContractorIdsToResolve(seeds));
    const identities = seeds.map((seed) => buildDistrictNexusIdentity(seed, contractorUeis));

    const byClient = new Map(
      identities.map((i) => [i.clientId, { clientName: i.clientName, contract: i.contract, assistance: i.assistance }]),
    );

    return {
      contract: {
        ueis: dedupe(identities.flatMap((i) => (i.contract.basis === 'exact_uei' ? i.contract.ueis : []))),
        fallbackNames: dedupe(
          identities.flatMap((i) => (i.contract.basis === 'reviewed_name_fallback' ? i.contract.fallbackNames : [])),
        ),
      },
      assistance: {
        ueis: dedupe(identities.flatMap((i) => (i.assistance.basis === 'exact_uei' ? i.assistance.ueis : []))),
        fallbackNames: dedupe(
          identities.flatMap((i) =>
            i.assistance.basis === 'reviewed_name_fallback' ? i.assistance.fallbackNames : [],
          ),
        ),
      },
      byClient,
    };
  }

  /**
   * Same shape as topContractAwards, scoped to a client's confirmed
   * contractor names (audit F5). `[]` immediately when there is no
   * identifier to scope by, so an unscoped district view can never silently
   * reuse the firm-wide list under a client-scoped label.
   */
  private async clientScopedContractAwards(
    rail: { ueis: string[]; fallbackNames: string[] },
    stateCode: string,
    districtCode: string,
  ): Promise<TopAward[]> {
    const branches: Prisma.Sql[] = [];
    if (rail.ueis.length) {
      branches.push(Prisma.sql`
        SELECT id::text AS id, contractor_name, description,
               amount::float8 AS amount, action_date, award_unique_id
        FROM federal_award
        WHERE recipient_uei = ANY(${rail.ueis}::text[])
          AND pop_state = ${stateCode} AND pop_congressional_district = ${districtCode}
      `);
    }
    if (rail.fallbackNames.length) {
      branches.push(Prisma.sql`
        SELECT id::text AS id, contractor_name, description,
               amount::float8 AS amount, action_date, award_unique_id
        FROM federal_award
        WHERE lower(contractor_name) = ANY(${rail.fallbackNames}::text[])
          AND pop_state = ${stateCode} AND pop_congressional_district = ${districtCode}
      `);
    }
    if (!branches.length) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        contractor_name: string | null;
        description: string | null;
        amount: number | null;
        action_date: Date | null;
        award_unique_id: string | null;
      }>
    >(Prisma.sql`${Prisma.join(branches, ' UNION ALL ')} ORDER BY amount DESC NULLS LAST LIMIT 10`);
    return rows.map((r) => ({
      id: r.id,
      label: r.description ?? r.award_unique_id ?? 'Federal contract award',
      counterparty: r.contractor_name,
      amount: r.amount,
      awardedAt: r.action_date ? r.action_date.toISOString() : null,
      externalUrl: r.award_unique_id ? `https://www.usaspending.gov/award/${r.award_unique_id}` : null,
    }));
  }

  /** Same shape as topGrantAwards, scoped to a client's confirmed identity rail. See clientScopedContractAwards. */
  private async clientScopedGrantAwards(
    rail: { ueis: string[]; fallbackNames: string[] },
    stateCode: string,
    districtCode: string,
  ): Promise<TopAward[]> {
    const branches: Prisma.Sql[] = [];
    if (rail.ueis.length) {
      branches.push(Prisma.sql`
        SELECT id::text AS id, recipient_name, description,
               total_obligated_amount::float8 AS total_obligated_amount,
               start_date, award_unique_id
        FROM federal_assistance_award
        WHERE recipient_uei = ANY(${rail.ueis}::text[])
          AND ${PAIRED_ASSISTANCE_STATE_EXPR} = ${stateCode}
          AND ${PAIRED_ASSISTANCE_DISTRICT_EXPR} = ${districtCode}
      `);
    }
    if (rail.fallbackNames.length) {
      branches.push(Prisma.sql`
        SELECT id::text AS id, recipient_name, description,
               total_obligated_amount::float8 AS total_obligated_amount,
               start_date, award_unique_id
        FROM federal_assistance_award
        WHERE lower(recipient_name) = ANY(${rail.fallbackNames}::text[])
          AND ${PAIRED_ASSISTANCE_STATE_EXPR} = ${stateCode}
          AND ${PAIRED_ASSISTANCE_DISTRICT_EXPR} = ${districtCode}
      `);
    }
    if (!branches.length) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        recipient_name: string | null;
        description: string | null;
        total_obligated_amount: number | null;
        start_date: Date | null;
        award_unique_id: string | null;
      }>
    >(Prisma.sql`${Prisma.join(branches, ' UNION ALL ')} ORDER BY total_obligated_amount DESC NULLS LAST LIMIT 10`);
    return rows.map((r) => ({
      id: r.id,
      label: r.description ?? r.award_unique_id ?? 'Federal assistance award',
      counterparty: r.recipient_name,
      amount: r.total_obligated_amount,
      awardedAt: r.start_date ? r.start_date.toISOString() : null,
      externalUrl: r.award_unique_id ? `https://www.usaspending.gov/award/${r.award_unique_id}` : null,
    }));
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
    const currentCongress = currentCongressNumber(new Date());

    const map = await this.getFirmDistrictNexusMap(tenantId, {
      view: options.view,
      clientId: options.clientId,
      state: stateCode,
    });
    const summary = map.districts.find((d) => d.districtKey === districtKey);

    const generatedAt = new Date().toISOString();

    // Tenant-scoped: which clients and facilities actually sit here.
    // client: VISIBLE_CLIENT_FILTER — soft-archived clients contribute
    // nothing (audit F6).
    const facilityRows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientFacility.findMany({
        where: {
          state: stateCode,
          ...(options.clientId ? { clientId: options.clientId } : {}),
          client: VISIBLE_CLIENT_FILTER,
        },
        select: {
          id: true,
          name: true,
          city: true,
          state: true,
          congressionalDistrict: true,
          congressionalDistrictCongress: true,
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
      boundaryRows,
      contractEvidenceRows,
      assistanceEvidenceRows,
      contractRowsByIdentifier,
      assistanceRowsByIdentifier,
      relationshipRows,
      clientContractAwards,
      clientGrantAwards,
    ] = await Promise.all([
      this.resolveDistrictRepresentatives(stateCode, districtCode),
      this.readDemographics(stateCode, districtCode),
      this.topContractAwards(stateCode, districtCode),
      this.topGrantAwards(stateCode, districtCode),
      // boundaryAvailable must describe THIS district under the REQUESTED
      // status, not "some house row in this state" — the previous unconstrained
      // findFirst could report availability from an unrelated district or from
      // the wrong boundary vintage. districtNo is a bare number ("1", "25")
      // while districtCode is facility-style ("01", "25") and a sole House seat
      // is reported as "1", so matchFacilityDistrictCode does the join, never
      // string equality.
      this.prisma.legislativeDistrict.findMany({
        where: { state: stateCode, chamber: 'house', status: 'C' },
        select: { districtNo: true, geoJsonS3Key: true },
      }),
      this.fetchContractEvidenceRows(identifiers.contract, stateCode, districtCode),
      this.fetchAssistanceEvidenceRows(identifiers.assistance, stateCode, districtCode),
      // BY-IDENTIFIER, not the plain aggregate this replaced: the per-client
      // breakdown below (audit F5) attributes each row back to the client
      // whose confirmed mapping it matched, which needs the identifier
      // column a GROUP-BY-district-only aggregate discards.
      this.aggregateContractsByIdentifier(identifiers.contract.ueis, identifiers.contract.fallbackNames),
      this.aggregateAssistanceByIdentifier(identifiers.assistance.ueis, identifiers.assistance.fallbackNames),
      this.aggregateRelationshipNexus(options.clientId ?? null, tenantId),
      // Client-scoped award lists (audit F5) — [] rather than a silent
      // fallback to the unscoped lists when no client filter is applied.
      this.clientScopedContractAwards(
        options.clientId ? identifiers.contract : EMPTY_IDENTIFIER_SET,
        stateCode,
        districtCode,
      ),
      this.clientScopedGrantAwards(
        options.clientId ? identifiers.assistance : EMPTY_IDENTIFIER_SET,
        stateCode,
        districtCode,
      ),
    ]);

    // UNCAPPED totals for THIS district, to explain the score (breakdown) —
    // never the capped evidence rows above, which would understate a
    // district with more than EVIDENCE_CAP_PER_DISTRICT contributing awards.
    // The identifier column is dropped so districtFold's input shape is
    // unchanged; the per-client breakdown below reads the identifier-carrying
    // rows directly instead.
    const allContracts = contractRowsByIdentifier.map(({ identifier: _identifier, ...row }) => row);
    const allAssistance = assistanceRowsByIdentifier.map(({ uei: _uei, nameLower: _nameLower, ...row }) => row);

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
      relationships: relationshipRows,
      facilities: inDistrict.map((f) => ({
        state: f.state,
        districtCode: f.congressionalDistrict,
        employeeCount: f.employeeCount,
        geocodeStatus: f.geocodeStatus,
        districtSource: f.districtSource,
        congressionalDistrictCongress: f.congressionalDistrictCongress,
      })),
      freshness: [],
      generatedAt,
      currentCongress,
    });
    const districtAcc = districtFold.districts.find((d) => d.districtKey === districtKey);
    const breakdown = districtAcc
      ? scoreNexus({ components: evidenceForDistrict(districtAcc) }).breakdown
      : [];

    const evidence: NexusEvidence[] = [];
    for (const row of contractEvidenceRows) {
      const mapped = contractRowToEvidence(row);
      if (mapped) evidence.push(mapped.evidence);
    }
    for (const row of assistanceEvidenceRows) {
      const mapped = assistanceRowToEvidence(row);
      if (mapped) evidence.push(mapped.evidence);
    }
    for (const f of inDistrict) {
      // A future-boundary facility is excluded from current-view scoring
      // (§12) and must not appear as evidence for a score it did not
      // contribute to — see the matching exclusion in `districtFold` above.
      if (f.congressionalDistrictCongress != null && f.congressionalDistrictCongress > currentCongress) {
        continue;
      }
      const mapped = facilityRowToEvidence({
        id: f.id,
        name: f.name,
        state: f.state,
        districtCode: f.congressionalDistrict,
        employeeCount: f.employeeCount,
        geocodeStatus: f.geocodeStatus,
        districtSource: f.districtSource,
        updatedAt: f.updatedAt ? f.updatedAt.toISOString() : null,
        congressionalDistrictCongress: f.congressionalDistrictCongress,
      });
      if (!mapped) continue;
      evidence.push(mapped.facility);
      if (mapped.employees) evidence.push(mapped.employees);
    }
    for (const r of relationshipRows.filter((row) => districtKeyFor(row.state, row.district) === districtKey)) {
      const mapped = relationshipRowToEvidence(r);
      if (mapped) evidence.push(mapped.evidence);
    }

    // A client belongs here if ANYTHING creates nexus in this district — a
    // facility, a matched contract, a matched award, or a reviewed
    // relationship (audit F5). See buildDistrictClientBreakdown.
    const clients = buildDistrictClientBreakdown({
      districtKey,
      facilities: inDistrict.map((f) => ({
        clientId: f.clientId,
        clientName: f.client.name,
        employeeCount: f.employeeCount,
      })),
      byClient: identifiers.byClient,
      contractRows: contractRowsByIdentifier,
      assistanceRows: assistanceRowsByIdentifier,
      relationships: relationshipRows,
    });

    const base: DistrictNexusDistrictSummary = summary ?? {
      districtKey,
      state: stateCode,
      districtCode,
      status: 'C',
      name: null,
      awarded: { contractObligations: null, grantObligations: null, grantOutlays: null },
      opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
      clientCount: clients.length,
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
      clients,
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
      clientContractAwards,
      clientGrantAwards,
      clientScoped: options.clientId != null,
      demographics,
      boundaryAvailable: !!matchFacilityDistrictCode(boundaryRows, districtCode)?.geoJsonS3Key,
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
    >(Prisma.sql`
      SELECT id::text AS id, recipient_name, description,
             total_obligated_amount::float8 AS total_obligated_amount,
             start_date, award_unique_id
      FROM federal_assistance_award
      WHERE ${PAIRED_ASSISTANCE_STATE_EXPR} = ${stateCode}
        AND ${PAIRED_ASSISTANCE_DISTRICT_EXPR} = ${districtCode}
      ORDER BY total_obligated_amount DESC NULLS LAST
      LIMIT 10
    `);
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
   * Contracts by district, CARRYING the identifier AND the basis each group
   * matched on — one UNION ALL of the two disjoint bases (§6), never a single
   * OR predicate. The per-client rail (`aggregateContracts`) can query one
   * basis directly because it already knows which one the client's rail
   * settled on; the firm-wide rail queries the union of EVERY client's
   * identifiers across BOTH bases in one pass, so each group must carry which
   * basis (and therefore which identifier column) produced it, so attribution
   * can hand a row only to a client whose own rail uses that same basis.
   */
  private async aggregateContractsByIdentifier(
    ueis: string[],
    fallbackNames: string[],
  ): Promise<Array<ContractDistrictRow & { identifier: string | null }>> {
    if (!ueis.length && !fallbackNames.length) return [];
    const branches: Prisma.Sql[] = [];
    if (ueis.length) {
      branches.push(Prisma.sql`
        SELECT recipient_uei AS identifier, 'uei' AS match_basis,
               pop_state AS state, pop_congressional_district AS district,
               COUNT(*)::bigint AS award_count,
               COALESCE(SUM(amount), 0)::float8 AS total_amount
        FROM federal_award
        WHERE recipient_uei = ANY(${ueis}::text[])
        GROUP BY recipient_uei, pop_state, pop_congressional_district
      `);
    }
    if (fallbackNames.length) {
      branches.push(Prisma.sql`
        SELECT lower(contractor_name) AS identifier, 'contractor_name' AS match_basis,
               pop_state AS state, pop_congressional_district AS district,
               COUNT(*)::bigint AS award_count,
               COALESCE(SUM(amount), 0)::float8 AS total_amount
        FROM federal_award
        WHERE lower(contractor_name) = ANY(${fallbackNames}::text[])
        GROUP BY lower(contractor_name), pop_state, pop_congressional_district
      `);
    }
    const rows = await this.prisma.$queryRaw<
      Array<{
        identifier: string | null;
        match_basis: string;
        state: string | null;
        district: string | null;
        award_count: bigint;
        total_amount: number | null;
      }>
    >(Prisma.join(branches, ' UNION ALL '));
    return rows.map((r) => ({
      identifier: r.identifier,
      matchBasis: r.match_basis === 'uei' ? 'uei' : 'contractor_name',
      state: r.state,
      district: r.district,
      awardCount: Number(r.award_count),
      totalAmount: r.total_amount ?? 0,
    }));
  }

  /**
   * Assistance by district, carrying both the identifier AND the basis each
   * group matched on — a UNION ALL of the two disjoint bases (§6), never a
   * single OR predicate. See `aggregateContractsByIdentifier`'s docblock for
   * why the firm-wide rail needs this and the per-client rail does not.
   */
  private async aggregateAssistanceByIdentifier(
    ueis: string[],
    fallbackNames: string[],
  ): Promise<Array<AssistanceDistrictRow & { uei: string | null; nameLower: string | null }>> {
    if (!ueis.length && !fallbackNames.length) return [];
    const branches: Prisma.Sql[] = [];
    if (ueis.length) {
      branches.push(Prisma.sql`
        SELECT recipient_uei AS uei, NULL AS name_lower, 'uei' AS match_basis,
               ${PAIRED_ASSISTANCE_STATE_EXPR} AS state,
               ${PAIRED_ASSISTANCE_DISTRICT_EXPR} AS district,
               ${PAIRED_ASSISTANCE_BASIS_EXPR} AS basis,
               COUNT(*)::bigint AS award_count,
               COALESCE(SUM(total_obligated_amount), 0)::float8 AS total_obligated,
               COALESCE(SUM(total_outlayed_amount), 0)::float8 AS total_outlayed
        FROM federal_assistance_award
        WHERE recipient_uei = ANY(${ueis}::text[])
        GROUP BY 1, 4, 5, 6
      `);
    }
    if (fallbackNames.length) {
      branches.push(Prisma.sql`
        SELECT NULL AS uei, lower(recipient_name) AS name_lower, 'recipient_name' AS match_basis,
               ${PAIRED_ASSISTANCE_STATE_EXPR} AS state,
               ${PAIRED_ASSISTANCE_DISTRICT_EXPR} AS district,
               ${PAIRED_ASSISTANCE_BASIS_EXPR} AS basis,
               COUNT(*)::bigint AS award_count,
               COALESCE(SUM(total_obligated_amount), 0)::float8 AS total_obligated,
               COALESCE(SUM(total_outlayed_amount), 0)::float8 AS total_outlayed
        FROM federal_assistance_award
        WHERE lower(recipient_name) = ANY(${fallbackNames}::text[])
        GROUP BY 2, 4, 5, 6
      `);
    }
    const rows = await this.prisma.$queryRaw<
      Array<{
        uei: string | null;
        name_lower: string | null;
        match_basis: string;
        state: string | null;
        district: string | null;
        basis: string;
        award_count: bigint;
        total_obligated: number | null;
        total_outlayed: number | null;
      }>
    >(Prisma.join(branches, ' UNION ALL '));
    return rows.map((r) => ({
      uei: r.uei,
      nameLower: r.name_lower,
      matchBasis: r.match_basis === 'uei' ? 'uei' : 'recipient_name',
      state: r.state,
      district: r.district,
      basis: r.basis === 'place_of_performance' ? 'place_of_performance' : 'recipient_location',
      awardCount: Number(r.award_count),
      totalObligated: r.total_obligated ?? 0,
      totalOutlayed: r.total_outlayed ?? 0,
    }));
  }

  /**
   * Read-only facility geocode/Congress-provenance coverage diagnostic
   * (Release 1, §14) — not a dashboard, just the counts an operator needs.
   * Tenant-scoped to visible clients (audit F6).
   */
  async getFacilityCoverageDiagnostic(tenantId: string): Promise<FacilityCoverageDiagnostic> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientFacility.findMany({
        where: { client: VISIBLE_CLIENT_FILTER },
        select: {
          addressLine: true,
          city: true,
          state: true,
          congressionalDistrict: true,
          congressionalDistrictCongress: true,
          districtSource: true,
          geocodeStatus: true,
        },
      }),
    );

    let districtResolved = 0;
    let missingDistrict = 0;
    let geocodeMatched = 0;
    let geocodePending = 0;
    let geocodeNoMatch = 0;
    let geocodeAmbiguous = 0;
    let geocodeError = 0;
    let missingUsableAddress = 0;
    let geocodedDistrictMissingCongress = 0;
    let manualDistrict = 0;

    for (const f of rows) {
      if (f.congressionalDistrict) districtResolved += 1;
      else missingDistrict += 1;

      if (!(f.addressLine?.trim() && f.city?.trim() && f.state?.trim())) missingUsableAddress += 1;

      switch (f.geocodeStatus) {
        case 'matched':
          geocodeMatched += 1;
          break;
        case 'no_match':
          geocodeNoMatch += 1;
          break;
        case 'ambiguous':
          geocodeAmbiguous += 1;
          break;
        case 'error':
          geocodeError += 1;
          break;
        default:
          // null — never attempted, as distinct from a failed attempt.
          geocodePending += 1;
      }

      if (
        f.districtSource === 'geocoded' &&
        f.congressionalDistrict &&
        f.congressionalDistrictCongress == null
      ) {
        geocodedDistrictMissingCongress += 1;
      }
      if (f.districtSource === 'user') manualDistrict += 1;
    }

    return {
      totalFacilities: rows.length,
      districtResolved,
      missingDistrict,
      geocodeMatched,
      geocodePending,
      geocodeNoMatch,
      geocodeAmbiguous,
      geocodeError,
      missingUsableAddress,
      geocodedDistrictMissingCongress,
      manualDistrict,
      // Only the batch geocode-facilities run observes discrepancies, and only
      // logs them per-run — not persisted anywhere queryable.
      knownDiscrepancyCount: null,
    };
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

/** Cap on the opportunity list returned per client. Matches EVIDENCE_CAP_PER_DISTRICT's intent. */
const TOP_OPPORTUNITY_CAP = 10;

const EMPTY_OPPORTUNITY_SUMMARY: ClientOpportunitySummary = Object.freeze({
  activeOpportunityCount: 0,
  closedOpportunityCount: 0,
  totalEstimatedFunding: null,
  maximumAwardCeiling: null,
  topOpportunities: [],
});

/** UTC midnight, so a close date "today" is still open all day. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Active = Grants.gov still lists it as open AND its deadline has not passed.
 *
 * Both halves are required. `status` alone is stale between reconciliation runs;
 * `closeDate` alone would resurrect an archived notice. A null closeDate with an
 * open status IS active — "continuous" and "TBD" deadlines are real (see
 * FederalGrant.responseDateDesc), and treating them as expired would hide live
 * money.
 */
function isOpportunityActive(status: string | null, closeDate: Date | null, today: Date): boolean {
  const s = (status ?? '').trim().toLowerCase();
  if (s === 'closed' || s === 'archived') return false;
  if (s !== 'posted' && s !== 'forecasted') return false;
  if (closeDate == null) return true;
  return startOfUtcDay(closeDate).getTime() >= today.getTime();
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
