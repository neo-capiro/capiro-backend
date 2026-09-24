/**
 * District Nexus Release 4 — Priority Intelligence read model service.
 *
 * Compute-on-read presentation over EXISTING rails:
 *   - CPF/CDS canonical tables (government-data/community-funding) — no new
 *     CPF/CDS table or parser. District read is a keyed query + ONE occurrences
 *     batch query — never N+1 per request.
 *   - GSA FRPP facts (priority-intelligence-gsa-ingest).
 *   - district_economic_fact metrics mapped deterministically into sector
 *     signals (priority-intelligence-sector).
 *   - district_nexus_change deterministic ledger.
 *
 * Nexus Strength / Strategic Relevance / Data Coverage are ECHOED from the
 * existing R1/R2 owners — never recomputed or blended here. Public context
 * (CPF/CDS, GSA, sector) has NO pathway into Nexus Strength.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DistrictNexusService } from '../district-nexus.service.js';
import { stateFipsForAbbr } from '../../common/us-states.js';
import { loadPriorityMemberDirectory } from './priority-intelligence-member-directory.js';

/**
 * GSA FRPP stores congressional districts in the source form produced by the
 * parser's `normalizeCongressionalDistrict` — leading zeros stripped, so
 * Florida's 8th district is stored as '8'. The API boundary accepts the padded
 * CPF/CDS convention ('08'). Translate at the query boundary, mirroring the
 * state USPS→FIPS translation: stored records and source identities are never
 * rewritten. Sentinel codes (00/90/98/ZZ) are rejected before this point, so
 * the input here is always a padded 2-digit district '01'–'89'.
 */
function gsaDistrictKey(paddedDistrict: string): string {
  return String(Number(paddedDistrict));
}
import {
  normalizeCpfCdsDistrict,
  filterForDistrict,
  projectRequest,
  aggregateMemberPriorities,
  type CommunityFundingRequestRow,
  type CommunityFundingSourceOccurrence,
  type ProjectedCpfCdsSignal,
  type CommunityFundingAvailability,
  type MemberPrioritySummary,
  type CommunityFundingClientLink,
} from './priority-intelligence-cpf-cds.js';
import {
  projectSectorMetric,
  isStale,
  type SectorMetricProjection,
  type SectorSignalAvailability,
} from './priority-intelligence-sector.js';
import type {
  ClientPriorityIntelligenceResponse,
  GsaFederalPresence,
  GsaPropertySummary,
  PriorityIntelligenceFreshnessEntry,
  PriorityIntelligenceAvailability,
  RecentChangeRecord,
} from './priority-intelligence.types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 2-letter code → full state name. congress_member.state stores the full
 * name ("Florida"), never the code — mirrors
 * district-nexus-strategic.service.ts's STATE_NAME_TO_CODE/STATE_CODE_TO_NAME
 * (kept local here rather than shared, matching that file's own precedent).
 */
const STATE_CODE_TO_NAME: Readonly<Record<string, string>> = Object.freeze({
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  DC: 'District of Columbia',
  PR: 'Puerto Rico',
  GU: 'Guam',
  AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
  VI: 'Virgin Islands',
});

@Injectable()
export class DistrictNexusPriorityIntelligenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly nexus: DistrictNexusService,
  ) {}

  async getClientDistrictPriorityIntelligence(
    tenantId: string,
    clientId: string,
    state: string,
    district: string,
  ): Promise<ClientPriorityIntelligenceResponse> {
    if (!UUID_RE.test(clientId) || !UUID_RE.test(tenantId)) {
      throw new NotFoundException('Client not found');
    }
    const stateCode = state.trim().toUpperCase();
    const districtPadded = normalizeCpfCdsDistrict(district) ?? district.trim();
    if (!stateFipsForAbbr(stateCode)) {
      throw new NotFoundException(`Unknown state "${state}"`);
    }
    if (['90', '98', 'ZZ'].includes(district.trim().toUpperCase())) {
      throw new NotFoundException(
        `"${district}" is not a congressional district code. Statewide, delegate and undefined award geographies cannot be resolved to a single district.`,
      );
    }
    const districtKey = `${stateCode}-${districtPadded}`;

    // 1) Tenant-owned client resolution INSIDE withTenant (tenant isolation).
    const client = await this.prisma.withTenant(tenantId, async (tx) => {
      return tx.client.findFirst({
        where: { id: clientId, tenantId },
        select: { id: true, name: true, status: true },
      });
    });
    if (!client || client.status === 'archived') {
      throw new NotFoundException('Client not found');
    }

    const warnings: string[] = [];

    // 2) Echo the existing R1 Nexus Strength for the client — read-only. The
    //    response's district detail gives this district's score/coverage.
    //    R4 adds nothing to it: public context has no scoring pathway.
    let nexusStrength: ClientPriorityIntelligenceResponse['nexusStrength'] = null;
    try {
      const nexusResponse: Awaited<ReturnType<DistrictNexusService['getClientDistrictNexus']>> =
        await this.nexus.getClientDistrictNexus(clientId, tenantId);
      const districtSummary = nexusResponse.districts.find((d) => d.districtKey === districtKey);
      if (districtSummary) {
        // ClientDistrictNexusResponse has no scoreVersion — the R1 payload's
        // score is the echo; version is reported by the strategic rail only.
        nexusStrength = {
          score: districtSummary.score,
          coveragePercent: districtSummary.coveragePercent,
          scoreVersion: 'district-nexus-v2',
        };
      }
    } catch (error) {
      warnings.push('Nexus Strength could not be loaded; shown as unavailable rather than zero.');
      this.logEchoFailure('nexus', error);
    }

    // 3) Members for the district + state senators (tenant-scoped directory).
    //    Defensively isolated like the Nexus Strength echo above: a failure
    //    here must degrade this one rail, not 500 the whole endpoint.
    let memberBioguides: ClientPriorityIntelligenceResponse['member'] = {
      houseMemberBioguideIds: [],
      senatorBioguideIds: [],
      representation: 'Representation unavailable',
    };
    try {
      memberBioguides = await this.loadMembers(tenantId, stateCode, districtPadded);
    } catch (error) {
      warnings.push('Representation could not be loaded; shown as unavailable rather than zero.');
      this.logEchoFailure('members', error);
    }

    // 4) CPF/CDS — bounded queries + single occurrences batch.
    const cpfCds = await this.loadCpfCds(
      stateCode,
      districtPadded,
      memberBioguides,
      clientId,
      tenantId,
      warnings,
    );

    // 5) GSA federal presence — indexed per-district query.
    const federalProperty = await this.loadGsaPresence(stateCode, districtPadded);

    // 6) Sector signals — deterministic mapping over district_economic_fact.
    const sectorSignals = await this.loadSectorSignals(stateCode, districtPadded);

    // 7) Recent deterministic changes (public ledger, district-scoped).
    const recentChanges = await this.loadChanges(stateCode, districtPadded);

    const freshness = this.buildFreshness(
      cpfCds.availability,
      federalProperty,
      sectorSignals,
      recentChanges.length > 0,
    );

    return {
      clientId,
      clientName: client.name,
      districtKey,
      state: stateCode,
      district: districtPadded,
      member: memberBioguides,
      nexusStrength,
      // Strategic Relevance echo is delivered by the existing strategic endpoint;
      // the drawer already renders it. Carrying a duplicate score here would
      // create two sources of truth, so it stays null until R2 exposes a
      // per-district echo hook — coverage data is echoed via dataCoverage.
      strategicRelevance: null,
      dataCoverage: null,
      priorityIntelligence: {
        cpfCds: {
          availability: cpfCds.availability,
          districtRequests: cpfCds.districtRequests,
          clientRequests: cpfCds.clientRequests,
          memberHistoricalPriorities: cpfCds.memberPriorities,
          warnings: cpfCds.warnings,
        },
        federalProperty,
        sectorSignals,
        recentChanges,
      },
      strongestPrioritySignals: this.buildStrongestSignals(cpfCds, federalProperty, sectorSignals),
      missingPrioritySources: this.buildMissingSources(
        { availability: cpfCds.availability },
        federalProperty,
        sectorSignals,
      ),
      freshness,
      geographyVintage: await this.resolveGeographyVintage(stateCode, districtPadded, warnings),
      warnings,
      computedAt: new Date().toISOString(),
    };
  }

  // ── Members ───────────────────────────────────────────────────────────────

  private async loadMembers(
    tenantId: string,
    stateCode: string,
    districtPadded: string,
  ): Promise<ClientPriorityIntelligenceResponse['member']> {
    // congress_member.state stores the full state name ("Florida"), never the
    // 2-letter code this method receives — confirmed live against production
    // (e.g. district-nexus-strategic.service.ts's own STATE_CODE_TO_NAME
    // comment: "congress_member.state stores full names"). Comparing the raw
    // code against this column always returns zero rows silently (no error,
    // so this was invisible until checked against real data).
    const stateName = STATE_CODE_TO_NAME[stateCode] ?? stateCode;
    const houseRows = await this.prisma.withTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<Array<{ bioguide_id: string | null }>>`
        SELECT cm.bioguide_id::text AS bioguide_id
        FROM congress_member cm
        WHERE cm.state = ${stateName}
          AND cm.chamber = 'house'
          AND cm.is_current = true
          AND LPAD(COALESCE(cm.district::text, ''), 2, '0') = ${districtPadded}
        ORDER BY cm.bioguide_id
        LIMIT 8`,
    );
    const senateRows = await this.prisma.withTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<Array<{ bioguide_id: string | null }>>`
        SELECT cm.bioguide_id::text AS bioguide_id
        FROM congress_member cm
        WHERE cm.state = ${stateName}
          AND cm.chamber = 'senate'
          AND cm.is_current = true
        ORDER BY cm.bioguide_id
        LIMIT 4`,
    );
    const house = houseRows.map((r) => r.bioguide_id).filter((b): b is string => Boolean(b));
    const senators = senateRows.map((r) => r.bioguide_id).filter((b): b is string => Boolean(b));
    return {
      houseMemberBioguideIds: house,
      senatorBioguideIds: senators,
      representation: `${stateCode}-${districtPadded}${house.length ? '' : ' · vacant'} · ${senators.length} senator(s)`,
    };
  }

  // ── CPF/CDS ───────────────────────────────────────────────────────────────

  private async loadCpfCds(
    stateCode: string,
    districtPadded: string,
    memberBioguides: ClientPriorityIntelligenceResponse['member'],
    clientId: string,
    tenantId: string,
    globalWarnings: string[],
  ): Promise<{
    availability: CommunityFundingAvailability;
    districtRequests: ProjectedCpfCdsSignal[];
    clientRequests: ProjectedCpfCdsSignal[];
    memberPriorities: MemberPrioritySummary[];
    memberRequestedTotalUsd: number;
    warnings: string[];
  }> {
    const warnings: string[] = [];

    // Availability: ingest-run history + corpus presence is the honest state.
    const runs = await this.prisma.communityFundingIngestRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { createdAt: true, status: true },
    });
    const loadedFiscalYears = await this.prisma.communityFundingRequest.findMany({
      select: { fiscalYear: true },
      distinct: ['fiscalYear'],
      orderBy: { fiscalYear: 'asc' },
    });
    const corpusLoaded = loadedFiscalYears.length > 0 || runs.length > 0;
    const availability: CommunityFundingAvailability = {
      status: corpusLoaded ? 'loaded' : 'unavailable',
      reason: corpusLoaded ? null : 'corpus_not_loaded',
      lastIngestRunAt: runs[0]?.createdAt?.toISOString() ?? null,
      loadedFiscalYears: loadedFiscalYears.map((r) => r.fiscalYear),
    };
    if (!corpusLoaded) {
      warnings.push(
        'CPF/CDS corpus is not loaded in this environment — this is not an empty result.',
      );
      globalWarnings.push('CPF/CDS corpus is not loaded in this environment.');
      return {
        availability,
        districtRequests: [],
        clientRequests: [],
        memberPriorities: [],
        memberRequestedTotalUsd: 0,
        warnings,
      };
    }

    // Apply geography in the DATABASE before either bounded display slice.
    // House rows are district-keyed; Senate rows are state-keyed and remain
    // statewide. Keeping the two queries separate prevents a large statewide
    // Senate corpus from pushing a matching House request beyond the limit.
    const sourceStdd = `${stateCode}${districtPadded}`;
    const districtKeys =
      districtPadded === '00'
        ? ['00', '0', sourceStdd, 'AL', 'AT LARGE', `${stateCode}AL`]
        : [districtPadded, String(Number(districtPadded)), sourceStdd];
    const select = {
      id: true,
      chamber: true,
      fiscalYear: true,
      requesterName: true,
      requesterState: true,
      requesterDistrict: true,
      recipientName: true,
      recipientNormalized: true,
      city: true,
      state: true,
      projectTitle: true,
      requestedAmountUsd: true,
      finalAmountUsd: true,
      amountStageRaw: true,
      appropriationsAccountRaw: true,
      _count: { select: { sources: true } },
    } as const;
    const orderBy = [
      { fiscalYear: 'desc' as const },
      { requesterName: 'asc' as const },
      { id: 'asc' as const },
    ];
    const [houseRows, senateRows] = await Promise.all([
      this.prisma.communityFundingRequest.findMany({
        where: {
          chamber: 'house',
          requesterDistrict: { in: districtKeys, mode: 'insensitive' },
          OR: [
            { requesterState: { equals: stateCode, mode: 'insensitive' } },
            { AND: [ { requesterState: null }, { state: { equals: stateCode, mode: 'insensitive' } } ] },
            { requesterDistrict: { equals: sourceStdd, mode: 'insensitive' } },
          ],
        },
        orderBy,
        take: 400,
        select,
      }),
      this.prisma.communityFundingRequest.findMany({
        where: {
          chamber: 'senate',
          OR: [
            { requesterState: { equals: stateCode, mode: 'insensitive' } },
            { AND: [ { requesterState: null }, { state: { equals: stateCode, mode: 'insensitive' } } ] },
          ],
        },
        orderBy,
        take: 400,
        select,
      }),
    ]);
    const requestRows = [
      ...new Map([...houseRows, ...senateRows].map((row) => [row.id, row])).values(),
    ];

    const rows: CommunityFundingRequestRow[] = requestRows.map((r) => ({
      requestId: r.id,
      chamber: r.chamber === 'house' ? 'house' : 'senate',
      fiscalYear: r.fiscalYear,
      requesterName: r.requesterName,
      requesterState: r.requesterState,
      requesterDistrict: r.requesterDistrict,
      recipientName: r.recipientName,
      recipientNormalized: r.recipientNormalized,
      city: r.city,
      state: r.state,
      projectTitle: r.projectTitle,
      requestedAmountUsd: r.requestedAmountUsd.toString(),
      finalAmountUsd: r.finalAmountUsd ? r.finalAmountUsd.toString() : null,
      amountStageRaw: r.amountStageRaw,
      appropriationsAccountRaw: r.appropriationsAccountRaw,
      sourceOccurrenceCount: r._count.sources,
    }));

    // Source occurrences — ONE batch query for every request (no N+1).
    const requestIds = rows.map((r) => r.requestId);
    const occurrenceRows = requestIds.length
      ? await this.prisma.communityFundingRequestSource.findMany({
          where: { requestId: { in: requestIds } },
          orderBy: [{ requestId: 'asc' }, { sourceRow: 'asc' }],
          select: {
            requestId: true,
            sourceDocumentId: true,
            sourcePage: true,
            sourceRow: true,
            requesterNameRaw: true,
            amountStageRaw: true,
            requestedAmountUsd: true,
            finalAmountUsd: true,
            retrievedAt: true,
          },
        })
      : [];
    const occurrencesByRequest = new Map<string, CommunityFundingSourceOccurrence[]>();
    for (const o of occurrenceRows) {
      const list = occurrencesByRequest.get(o.requestId) ?? [];
      list.push({
        sourceDocumentId: o.sourceDocumentId,
        sourcePage: o.sourcePage,
        sourceRow: o.sourceRow,
        requesterNameRaw: o.requesterNameRaw,
        amountStageRaw: o.amountStageRaw,
        requestedAmountUsd: o.requestedAmountUsd.toString(),
        finalAmountUsd: o.finalAmountUsd ? o.finalAmountUsd.toString() : null,
        retrievedAt: o.retrievedAt.toISOString(),
      });
      occurrencesByRequest.set(o.requestId, list);
    }

    // Deterministic client attribution — reviewed/confirmed mappings ONLY.
    const confirmedRequestIds = await this.loadConfirmedClientRequestIds(tenantId, clientId);
    const clientRecipientNames = await this.loadClientRecipientNames(tenantId, clientId);

    const projections = rows.map((row) => {
      const link = resolveClientLink(row, confirmedRequestIds, clientRecipientNames);
      return projectRequest(row, occurrencesByRequest.get(row.requestId) ?? [], link);
    });

    const districtRequests = filterForDistrict(projections, stateCode, districtPadded, {
      // Senate statewide requests join the state and are labeled statewide in
      // their geography projection — the UI renders them distinctly.
      includeSenateStatewide: true,
    });

    const eligibleMembers = new Set([
      ...memberBioguides.houseMemberBioguideIds,
      ...memberBioguides.senatorBioguideIds,
    ]);
    let memberPriorities: MemberPrioritySummary[] = [];
    let memberRequestedTotalUsd = 0;
    try {
      const directory = await loadPriorityMemberDirectory(this.prisma, stateCode);
      const aggregation = aggregateMemberPriorities(districtRequests, directory, eligibleMembers);
      memberPriorities = aggregation.byMember;
      memberRequestedTotalUsd = aggregation.requestedTotalUsd;
      if (aggregation.unattributedRequestIds.length) {
        warnings.push(
          `${aggregation.unattributedRequestIds.length} request(s) could not be uniquely attributed to a current member from the source requester name. They remain public district/state context.`,
        );
      }
    } catch (error) {
      warnings.push(
        'Individual member attribution is unavailable; public CPF/CDS requests remain visible.',
      );
      this.logEchoFailure('member requester identities', error);
    }
    if (houseRows.length === 400 || senateRows.length === 400) {
      warnings.push(
        'This view is limited to the 400 most recent state requests; member totals cover those records only.',
      );
    }

    const clientRequests = projections.filter((p) => p.clientAttribution != null);

    return {
      availability,
      districtRequests,
      clientRequests,
      memberPriorities,
      memberRequestedTotalUsd,
      warnings,
    };
  }

  private async loadConfirmedClientRequestIds(
    tenantId: string,
    clientId: string,
  ): Promise<ReadonlySet<string>> {
    // Confirmed contracting mappings are the deterministic client-identity rail
    // (same source vocabulary as the R1 linkage: 'contracting'). externalId
    // carries the UEI-style external identifier; the row's id is the evidence
    // id for clientAttribution provenance.
    const confirmedMappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: {
          clientId,
          source: 'contracting',
          reviewStatus: 'confirmed',
          rollUpAwards: true,
        },
        select: { id: true, externalId: true },
      }),
    );
    return new Set(confirmedMappings.map((m) => m.externalId).filter((v) => Boolean(v)));
  }

  private async loadClientRecipientNames(
    tenantId: string,
    clientId: string,
  ): Promise<ReadonlySet<string>> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, reviewStatus: 'confirmed' },
        select: { externalName: true },
      }),
    );
    return new Set(
      rows.map((r) => r.externalName?.trim().toLowerCase()).filter((v): v is string => Boolean(v)),
    );
  }

  // ── GSA federal presence ──────────────────────────────────────────────────

  private async loadGsaPresence(state: string, district: string): Promise<GsaFederalPresence> {
    const stateFips = stateFipsForAbbr(state);
    if (!stateFips) throw new NotFoundException(`Unknown state "${state}"`);
    const runs = await this.prisma.gsaRealPropertySourceRun.findMany({
      where: { dryRun: false },
      orderBy: { attemptedAt: 'desc' },
      take: 5,
    });
    const lastSuccess = runs.find(
      (r) => r.status === 'success' || r.status === 'success_with_errors',
    );
    const lastFailure = runs.find((r) => r.status === 'failed');
    const anyRun = runs.length > 0;

    // Resolve the latest local vintage and aggregate ALL assets. A preview cap
    // must not silently turn a district's property totals into a 500-row sample.
    // GSA stores district keys in the FRPP source form (leading zeros stripped,
    // e.g. '8'), while the API accepts the padded CPF/CDS convention ('08').
    // Translate at the query boundary — never rewrite stored records.
    const geography = {
      stateCode: stateFips,
      congressionalDistrict: gsaDistrictKey(district),
    };
    const years = await this.prisma.gsaRealProperty.findMany({
      where: geography,
      select: { fiscalYear: true },
      distinct: ['fiscalYear'],
      orderBy: { fiscalYear: 'desc' },
    });
    const latestFy = years[0]?.fiscalYear ?? null;
    const groups =
      latestFy == null
        ? []
        : await this.prisma.gsaRealProperty.groupBy({
            by: ['grain', 'reportingAgency', 'legalInterest', 'boundaryCongress'],
            where: { ...geography, fiscalYear: latestFy },
            _count: { _all: true },
            _sum: { squareFeet: true },
          });
    const latestDetailed =
      latestFy == null
        ? []
        : await this.prisma.gsaRealProperty.findMany({
            where: {
              ...geography,
              fiscalYear: latestFy,
              grain: 'detailed_asset',
            },
            orderBy: [{ reportingAgency: 'asc' }, { rpUid: 'asc' }],
            take: 10,
          });
    const detailedGroups = groups.filter((r) => r.grain === 'detailed_asset');

    const gsaAvailability: PriorityIntelligenceAvailability = !anyRun
      ? {
          status: 'not_loaded',
          reason: 'No committed GSA FRPP source run has been executed in this environment',
          lastSuccessAt: null,
          lastFailureAt: null,
          lastError: null,
        }
      : {
          status: lastSuccess == null ? 'error' : 'loaded',
          reason:
            lastSuccess == null
              ? 'Latest GSA FRPP source run failed'
              : groups.length === 0
                ? `No FRPP assets recorded for ${state}-${district}`
                : null,
          lastSuccessAt: lastSuccess?.attemptedAt?.toISOString() ?? null,
          lastFailureAt: lastFailure?.attemptedAt?.toISOString() ?? null,
          lastError: lastFailure?.error ?? null,
        };

    const sqftGroups = detailedGroups.filter((r) => r._sum.squareFeet != null);
    const squareFeetTotal = sqftGroups.length
      ? sqftGroups.reduce((total, r) => total + Number(r._sum.squareFeet), 0)
      : null;
    const agencyCounts = new Map<string, number>();
    for (const r of detailedGroups) {
      agencyCounts.set(
        r.reportingAgency,
        (agencyCounts.get(r.reportingAgency) ?? 0) + r._count._all,
      );
    }
    const agenciesByAssetCount = [...agencyCounts.entries()]
      .map(([agency, assetCount]) => ({ agency, assetCount }))
      .sort((a, b) => b.assetCount - a.assetCount)
      .slice(0, 8);

    // Use the entire aggregate, not the bounded asset preview or economic rail.
    const boundaryCongresses = [...new Set(groups.map((r) => r.boundaryCongress))].sort((a, b) =>
      a === b ? 0 : a == null ? 1 : b == null ? -1 : a - b,
    );
    const warnings: string[] = [];
    if (boundaryCongresses.includes(null)) {
      warnings.push(
        'FRPP rows with no source boundary Congress are present — district vintage is source-unknown (not inferred).',
      );
    }

    const topAssets: GsaPropertySummary[] = latestDetailed.slice(0, 10).map((r) => ({
      rpUid: r.rpUid,
      reportingAgency: r.reportingAgency,
      usingAgency: r.usingAgency,
      installationName: r.installationName,
      legalInterest: r.legalInterest,
      realPropertyType: r.realPropertyType,
      realPropertyUse: r.realPropertyUse,
      assetStatus: r.assetStatus,
      squareFeet: r.squareFeet == null ? null : Number(r.squareFeet),
      squareFeetUom: r.squareFeetUom,
      city: r.cityName,
      state,
      congressionalDistrict: r.congressionalDistrict,
      boundaryCongress: r.boundaryCongress,
      isDefense: r.isDefense,
      grain: r.grain as 'detailed_asset' | 'summarized_installation',
      sourceDataset: r.sourceDataset,
      fiscalYear: r.fiscalYear,
      sourceUrl: r.congressionalDistrictSourceUrl,
      geographyBasis: r.geographyBasis as GsaPropertySummary['geographyBasis'],
    }));

    const fiscalYears = years.map((r) => r.fiscalYear).sort((a, b) => a - b);

    return {
      availability: gsaAvailability,
      detailedAssetCount: detailedGroups.reduce((n, r) => n + r._count._all, 0),
      detailedSquareFeetTotal: squareFeetTotal,
      summarizedInstallationCount: groups
        .filter((r) => r.grain === 'summarized_installation')
        .reduce((n, r) => n + r._count._all, 0),
      ownedCount: detailedGroups
        .filter((r) => /owned/i.test(r.legalInterest ?? ''))
        .reduce((n, r) => n + r._count._all, 0),
      leasedCount: detailedGroups
        .filter((r) => /leased/i.test(r.legalInterest ?? ''))
        .reduce((n, r) => n + r._count._all, 0),
      agenciesByAssetCount,
      topAssets,
      fiscalYears,
      boundaryCongresses,
      warnings,
    };
  }

  // ── Sector signals ────────────────────────────────────────────────────────

  private async loadSectorSignals(
    state: string,
    district: string,
  ): Promise<ClientPriorityIntelligenceResponse['priorityIntelligence']['sectorSignals']> {
    const metricRows = await this.prisma.$queryRaw<
      Array<{
        source: string;
        dataset: string;
        source_year: number | null;
        boundary_congress: number | null;
        naics_code: string | null;
        metric_key: string;
        metric_value: string | null;
        unit: string | null;
        source_record_id: string | null;
        source_url: string | null;
        observed_at: Date | null;
        last_synced_at: Date;
      }>
    >`
      SELECT d.source::text AS source, d.dataset, d.source_year, d.boundary_congress,
             d.naics_code, d.metric_key, d.metric_value::text AS metric_value, d.unit,
             d.source_record_id, d.source_url, d.observed_at, d.last_synced_at
      FROM district_economic_fact d
      WHERE d.state = ${state} AND d.district_code = ${district}
        AND d.source_year = (
          SELECT max(d2.source_year) FROM district_economic_fact d2
          WHERE d2.state = d.state AND d2.district_code = d.district_code AND d2.source = d.source
        )
      LIMIT 200
    `;

    const runStatusRows = await this.prisma.$queryRaw<Array<{ source: string; status: string }>>`
      SELECT DISTINCT ON (source) source::text AS source, status::text AS status
      FROM district_economic_source_run
      ORDER BY source, attempted_at DESC
    `;
    const runStatusBySource = new Map(
      runStatusRows.map(
        (r) =>
          [
            r.source,
            r.status as SectorSignalAvailability['sources'][number]['lastRunStatus'],
          ] as const,
      ),
    );

    const now = new Date();
    const projections: SectorMetricProjection[] = [];
    for (const m of metricRows) {
      const projection = projectSectorMetric({
        source: m.source as SectorSignalAvailability['sources'][number]['source'],
        dataset: m.dataset,
        sourceYear: m.source_year,
        boundaryCongress: m.boundary_congress,
        naicsCode: m.naics_code,
        metricKey: m.metric_key,
        metricValue: m.metric_value == null ? null : Number(m.metric_value),
        unit: m.unit,
        sourceRecordId: m.source_record_id,
        sourceUrl: m.source_url,
        observedAt: m.observed_at?.toISOString() ?? null,
        lastSyncedAt: m.last_synced_at?.toISOString() ?? null,
      });
      if (projection) projections.push(projection);
    }

    const sourceList: SectorSignalAvailability['sources'] = (['acs', 'cbp', 'lodes'] as const).map(
      (source) => {
        const latest = metricRows.find((m) => m.source === source);
        return {
          source: source as SectorSignalAvailability['sources'][number]['source'],
          dataset: latest?.dataset ?? source,
          sourceYear: latest?.source_year ?? null,
          lastSyncedAt: latest?.last_synced_at?.toISOString() ?? null,
          lastRunStatus: runStatusRows.some((r) => r.source === source)
            ? (runStatusRows.find((r) => r.source === source)
                ?.status as SectorSignalAvailability['sources'][number]['lastRunStatus'])
            : 'no_run',
        };
      },
    );

    const staleBySource = sourceList.some(
      (s) =>
        s.lastRunStatus === 'no_run' ||
        (s.lastSyncedAt != null && isStale(s.sourceYear, s.lastSyncedAt, now)),
    );

    const availability: SectorSignalAvailability = {
      status: sourceList.every((s) => s.lastRunStatus === 'no_run')
        ? 'not_loaded'
        : staleBySource
          ? 'stale'
          : 'loaded',
      sources: sourceList,
    };

    const warnings: string[] = [];
    if (availability.status === 'not_loaded') {
      warnings.push('Public economic metrics have never been ingested for this district.');
    }
    if (availability.status === 'stale') {
      warnings.push('Some public economic sources are stale — see freshness.');
    }

    return { availability, metrics: projections, warnings };
  }

  // ── Recent deterministic changes ──────────────────────────────────────────

  private async loadChanges(state: string, district: string): Promise<RecentChangeRecord[]> {
    const rows = await this.prisma.districtNexusChange.findMany({
      // observationKind: 'change' excludes baseline rows (a source/year's
      // first-ever bulk population, e.g. GSA's initial FY load) from this
      // "recent changes" rail — they are real and still queryable directly
      // against district_nexus_change for audit, but are not "recent
      // intelligence" a user should see, and would otherwise crowd out
      // genuine later additions/removals/corrections within `take: 20`.
      where: {
        observationKind: 'change',
        // GSA ledger geography mirrors the source: FIPS state and the FRPP
        // district form (leading zeros stripped). Other rails use USPS state
        // and the padded district convention. Translate per source at the
        // query boundary — stored ledger rows are never rewritten. Keep the
        // district predicate inside each branch: an outer padded predicate
        // would AND with the GSA source key and exclude single-digit districts.
        OR: [
          {
            source: 'gsa',
            stateCode: stateFipsForAbbr(state),
            districtCode: gsaDistrictKey(district),
          },
          { source: { not: 'gsa' }, stateCode: state, districtCode: district },
        ],
      },
      orderBy: { observedAt: 'desc' },
      take: 20,
    });
    return rows.map((c) => ({
      changeKind: c.changeKind,
      source: c.source,
      sourceRecordId: c.sourceRecordId,
      state: c.source === 'gsa' ? state : c.stateCode,
      district: c.districtCode,
      boundaryCongress: c.boundaryCongress,
      oldValue: c.oldValue ?? null,
      newValue: c.newValue ?? null,
      oldState: c.oldState,
      newState: c.newState,
      observedAt: c.observedAt.toISOString(),
      effectiveAt: c.effectiveAt?.toISOString() ?? null,
      sourceYear: c.sourceYear,
      geographyVintage: c.geographyVintage,
      severity: c.severity as RecentChangeRecord['severity'],
      provenance: (c.provenance ?? {}) as Record<string, unknown>,
    }));
  }

  // ── Geography vintage ─────────────────────────────────────────────────────

  private async resolveGeographyVintage(
    state: string,
    district: string,
    warnings: string[],
  ): Promise<ClientPriorityIntelligenceResponse['geographyVintage']> {
    const vintages = await this.prisma.$queryRaw<Array<{ boundary_congress: number | null }>>`
      SELECT DISTINCT boundary_congress
      FROM district_economic_fact
      WHERE state = ${state} AND district_code = ${district}
    `;
    const distinct = vintages.map((v) => v.boundary_congress);
    const nonNull = [...new Set(distinct.filter((v): v is number => v != null))];
    const conflict = (distinct.includes(null) && nonNull.length > 0) || nonNull.length > 1;
    if (conflict) {
      warnings.push(
        'Geography vintage conflict: sources attribute this district to different boundary Congresses.',
      );
    }
    const soleVintage = nonNull.length === 1 ? (nonNull[0] ?? null) : null;
    return {
      boundaryCongress: soleVintage,
      conflict,
      detail: conflict
        ? `economic facts carry mixed boundary congress values: ${JSON.stringify(distinct)}`
        : soleVintage != null
          ? `economic facts expressed against boundary congress ${soleVintage}`
          : 'no vintage-bearing sources loaded for this district',
    };
  }

  // ── Aggregation helpers ───────────────────────────────────────────────────

  private buildFreshness(
    cpfCdsAvailability: CommunityFundingAvailability,
    federalProperty: GsaFederalPresence,
    sectorSignals: { availability: SectorSignalAvailability },
    changesPresent: boolean,
  ): PriorityIntelligenceFreshnessEntry[] {
    const entries: PriorityIntelligenceFreshnessEntry[] = [];
    const now = new Date();

    entries.push({
      rail: 'cpf_cds',
      status:
        cpfCdsAvailability.status === 'unavailable'
          ? 'not_loaded'
          : cpfCdsAvailability.loadedFiscalYears.length
            ? 'current'
            : 'not_loaded',
      sourceYear: cpfCdsAvailability.loadedFiscalYears.at(-1) ?? null,
      lastSuccessAt: cpfCdsAvailability.lastIngestRunAt,
      lastAttemptAt: cpfCdsAvailability.lastIngestRunAt,
      stale: false,
    });

    const gsaStatus: PriorityIntelligenceFreshnessEntry['status'] =
      federalProperty.availability.status === 'loaded'
        ? 'current'
        : federalProperty.availability.status === 'not_loaded'
          ? 'not_loaded'
          : 'failed';
    entries.push({
      rail: 'gsa',
      status: gsaStatus,
      sourceYear: federalProperty.fiscalYears.at(-1) ?? null,
      lastSuccessAt: federalProperty.availability.lastSuccessAt,
      lastAttemptAt:
        federalProperty.availability.lastSuccessAt ?? federalProperty.availability.lastFailureAt,
      stale: gsaStatusNowStale(federalProperty.availability.lastSuccessAt),
    });

    for (const s of sectorSignals.availability.sources) {
      const rail = (
        s.source === 'cbp' ? 'sector_cbp' : s.source === 'acs' ? 'sector_acs' : 'sector_lodes'
      ) as PriorityIntelligenceFreshnessEntry['rail'];
      const stale =
        s.lastRunStatus === 'no_run' ||
        (s.lastSyncedAt != null && isStale(s.sourceYear, s.lastSyncedAt, new Date()));
      entries.push({
        rail,
        status:
          s.lastRunStatus === 'no_run'
            ? 'not_loaded'
            : s.lastRunStatus === 'failed'
              ? 'failed'
              : stale
                ? 'stale'
                : 'current',
        sourceYear: s.sourceYear,
        lastSuccessAt: s.lastSyncedAt,
        lastAttemptAt: s.lastSyncedAt,
        stale,
      });
    }

    entries.push({
      rail: 'changes',
      status: changesPresent ? 'current' : 'not_loaded',
      sourceYear: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      stale: false,
    });

    return entries;
  }

  private buildStrongestSignals(
    cpfCds: {
      districtRequests: ProjectedCpfCdsSignal[];
      clientRequests: ProjectedCpfCdsSignal[];
      memberPriorities: MemberPrioritySummary[];
      memberRequestedTotalUsd: number;
    },
    federalProperty: GsaFederalPresence,
    sectorSignals: {
      availability: SectorSignalAvailability;
      metrics: SectorMetricProjection[];
    },
  ): string[] {
    const signals: string[] = [];
    if (cpfCds.clientRequests.length) {
      signals.push(
        `${cpfCds.clientRequests.length} deterministically-linked CPF/CDS request(s) for this client`,
      );
    }
    if (cpfCds.districtRequests.length) {
      signals.push(
        `${cpfCds.districtRequests.length} community project request(s) attributed to this district/state`,
      );
    }
    if (cpfCds.memberPriorities.length) {
      const total = cpfCds.memberRequestedTotalUsd;
      signals.push(
        `member request history: $${Math.round(total).toLocaleString('en-US')} requested in source-attributed records for ${cpfCds.memberPriorities.length} current member(s); joint requests counted once`,
      );
    }
    if ((federalProperty.detailedAssetCount ?? 0) > 0) {
      signals.push(
        `${federalProperty.detailedAssetCount} federal property asset(s) in this district (FY${federalProperty.fiscalYears.at(-1) ?? '?'})`,
      );
    }
    const jobs = sectorSignals.metrics.find((m) => m.metricKey === 'jobs_total');
    if (jobs && jobs.metricValue != null) {
      signals.push(
        `${Math.round(jobs.metricValue).toLocaleString('en-US')} district jobs (public context, not client employment)`,
      );
    }
    return signals.slice(0, 6);
  }

  private buildMissingSources(
    cpfCds: { availability: CommunityFundingAvailability },
    federalProperty: GsaFederalPresence,
    sectorSignals: { availability: SectorSignalAvailability },
  ): string[] {
    const missing: string[] = [];
    if (cpfCds.availability.status === 'unavailable') missing.push('CPF/CDS corpus not ingested');
    if (federalProperty.availability.status === 'not_loaded')
      missing.push('GSA FRPP federal property data not ingested');
    if (sectorSignals.availability.status === 'not_loaded')
      missing.push('ACS/CBP/LODES district economic facts not ingested');
    if (sectorSignals.availability.status === 'stale')
      missing.push('refresh stale ACS/CBP/LODES economic facts');
    return missing;
  }

  private logEchoFailure(rail: string, error: unknown): void {
    // Swallowed by design — an echo failure degrades that echo to null and the
    // warning renders; it must not blank the R4 rails or throw.
    void rail;
    void error;
  }
}

/**
 * Deterministic client link resolution. Confirmed intel mapping wins; else an
 * exact normalized recipient-name match against confirmed mapping external
 * names. Fuzzy matching is deliberately NOT implemented here — fuzzy CPF/CDS
 * attribution belongs to the Advocacy History review queue, not District Nexus.
 */
function resolveClientLink(
  row: CommunityFundingRequestRow,
  confirmedRequestIds: ReadonlySet<string>,
  clientRecipientNames: ReadonlySet<string>,
): CommunityFundingClientLink | null {
  if (confirmedRequestIds.has(row.requestId)) {
    return { method: 'confirmed_client_intel_mapping', evidenceId: null };
  }
  if (clientRecipientNames.has(row.recipientNormalized.trim().toLowerCase())) {
    return { method: 'exact_recipient_normalized', evidenceId: null };
  }
  return null;
}

function gsaStatusNowStale(lastSuccessAt: string | null): boolean {
  // FRPP is an annual publication; a successful run older than 400 days is stale.
  if (lastSuccessAt == null) return true;
  const t = new Date(lastSuccessAt).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t > 400 * 86_400_000;
}
