import { federalHearingWhere } from '../hearing-discovery/hearing-geography.js';
/**
 * District Nexus Release 2 — Strategic Relevance service.
 *
 * Compute-on-read. Gathers structured PE / committee / LegiWatch / hearing /
 * strategy / engagement facts for a client, then scores each district without
 * N+1 per-district queries. Nexus Strength is loaded only for dual display and
 * gap analysis — never blended into Strategic Relevance.
 *
 * Tenant-owned tables: always filter tenant_id explicitly (apps/api role can
 * bypass RLS). Free-text name matches never earn component credit.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientPeRelevanceService } from '../intelligence/client-pe-relevance.service.js';
import { DistrictNexusService } from './district-nexus.service.js';
import {
  scoreStrategicRelevance,
  type StrategicComponentInput,
} from './district-nexus-strategic-scoring.js';
import { buildGapsResponse, type DistrictGapInput } from './district-nexus-strategic-gaps.js';
import {
  STRATEGIC_DEFAULT_MIN_COVERAGE_PERCENT,
  STRATEGIC_SCORE_VERSION,
} from './district-nexus-strategic-weights.js';
import type {
  ClientDistrictStrategicGapsResponse,
  ClientDistrictStrategicMapResponse,
  DistrictStrategicRelevanceResponse,
  StrategicConflictWarning,
  StrategicEvidence,
} from './district-nexus-strategic.types.js';
import type { SourceFreshness } from './district-nexus.types.js';
import { normalizeDistrictForCensus } from '../common/district-code.util.js';
import {
  STATE_CODE_TO_NAME,
  STATE_NAME_TO_CODE,
  assembleStrategicPostQuery,
  buildDistrictStrategicComponents,
  districtKeyOf,
  type StrategicBuilderBundle,
  type StrategicClientPeRow,
  type StrategicMemberRow,
} from './district-nexus-strategic.helpers.js';
import { currentCongressNumber } from '../common/congress.util.js';
import { loadPriorityMemberDirectory } from './priority-intelligence/priority-intelligence-member-directory.js';
import {
  attributeGeography,
  normalizeCpfCdsDistrict,
  createRequesterResolver,
} from './priority-intelligence/priority-intelligence-cpf-cds.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MemberRow = StrategicMemberRow;

interface ClientBundle extends StrategicBuilderBundle {
  clientId: string;
  clientName: string;
  archived: boolean;
  membersByDistrict: Map<string, MemberRow[]>;
  freshness: SourceFreshness[];
  conflicts: StrategicConflictWarning[];
  geographyVintageConflicts: Set<string>;
}

@Injectable()
export class DistrictNexusStrategicService {
  private readonly logger = new Logger(DistrictNexusStrategicService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly peRelevance: ClientPeRelevanceService,
    private readonly nexus: DistrictNexusService,
  ) {}

  async getClientStrategicMap(
    tenantId: string,
    clientId: string,
  ): Promise<ClientDistrictStrategicMapResponse> {
    const bundle = await this.loadClientBundle(tenantId, clientId);
    const nexusByKey = await this.loadNexusByDistrict(tenantId, clientId);
    const districts: ClientDistrictStrategicMapResponse['districts'] = [];

    for (const [districtKey, members] of bundle.membersByDistrict) {
      const scored = await this.scoreDistrict(bundle, districtKey, members);
      const nexus = nexusByKey.get(districtKey);
      const [state, district] = districtKey.split('-');
      districts.push({
        districtKey,
        state: state ?? '',
        district: district ?? '',
        strategicScore: scored.score,
        strategicCoveragePercent: scored.coveragePercent,
        strongestDrivers: scored.strongestDrivers.map((d) => d.label),
        missingComponents: scored.missingComponents,
        nexusScore: nexus?.score ?? null,
        nexusCoveragePercent: nexus?.coveragePercent ?? null,
      });
    }

    districts.sort((a, b) => {
      const as = a.strategicScore ?? -1;
      const bs = b.strategicScore ?? -1;
      return bs - as || a.districtKey.localeCompare(b.districtKey);
    });

    return {
      clientId,
      clientName: bundle.clientName,
      scoreVersion: STRATEGIC_SCORE_VERSION,
      weightsVersion: STRATEGIC_SCORE_VERSION,
      minCoveragePercent: STRATEGIC_DEFAULT_MIN_COVERAGE_PERCENT,
      computedAt: new Date().toISOString(),
      districts,
      incompleteCount: districts.filter(
        (d) => d.strategicScore == null || d.missingComponents.length > 0,
      ).length,
    };
  }

  async getDistrictStrategic(
    tenantId: string,
    state: string,
    district: string,
    clientId: string,
  ): Promise<DistrictStrategicRelevanceResponse> {
    const stateCode = state.trim().toUpperCase();
    const districtCode = normalizeDistrictForCensus(district.trim()) || district.trim();
    if (!stateCode || stateCode.length !== 2) {
      throw new NotFoundException(`Unknown state "${state}"`);
    }
    // Sentinels are not districts.
    if (
      ['90', '98', 'ZZ', 'AL'].includes(districtCode.toUpperCase()) &&
      districtCode !== '00' &&
      districtCode.toUpperCase() !== 'AL'
    ) {
      // allow AL/00 as at-large
    }
    if (['90', '98', 'ZZ'].includes(district.trim().toUpperCase())) {
      throw new NotFoundException(`"${district}" is not a congressional district code.`);
    }

    const districtKey = districtKeyOf(stateCode, districtCode === 'AL' ? '00' : districtCode);
    const bundle = await this.loadClientBundle(tenantId, clientId);
    const members =
      bundle.membersByDistrict.get(districtKey) ??
      (await this.loadMembersForDistrict(stateCode, districtCode));
    // Also attach senators for the state (strategy/engagement by bioguide).
    const senators = bundle.allMembers.filter(
      (m) =>
        m.chamber === 'senate' &&
        (STATE_NAME_TO_CODE[m.state ?? ''] === stateCode || m.state === stateCode),
    );
    const memberSet = new Map<string, MemberRow>();
    for (const m of [...members, ...senators]) memberSet.set(m.bioguideId, m);
    const all = [...memberSet.values()];

    const strategic = await this.scoreDistrict(bundle, districtKey, all);
    const nexusByKey = await this.loadNexusByDistrict(tenantId, clientId);
    const nexus = nexusByKey.get(districtKey) ?? null;

    return {
      districtKey,
      state: stateCode,
      district: districtKey.split('-')[1] ?? districtCode,
      clientId,
      clientName: bundle.clientName,
      memberBioguides: all.map((m) => m.bioguideId),
      strategic,
      nexusStrength: nexus ? { score: nexus.score, coveragePercent: nexus.coveragePercent } : null,
      strategicEnabled: true,
    };
  }

  async getClientStrategicGaps(
    tenantId: string,
    clientId: string,
  ): Promise<ClientDistrictStrategicGapsResponse> {
    const bundle = await this.loadClientBundle(tenantId, clientId);
    const nexusByKey = await this.loadNexusByDistrict(tenantId, clientId);
    const inputs: DistrictGapInput[] = [];

    for (const [districtKey, members] of bundle.membersByDistrict) {
      const strategic = await this.scoreDistrict(bundle, districtKey, members);
      const nexus = nexusByKey.get(districtKey);
      const [state, district] = districtKey.split('-');
      inputs.push({
        districtKey,
        state: state ?? '',
        district: district ?? '',
        strategic,
        nexusScore: nexus?.score ?? null,
        nexusCoveragePercent: nexus?.coveragePercent ?? null,
        geographyVintageConflict: bundle.geographyVintageConflicts.has(districtKey),
      });
    }

    return buildGapsResponse({
      clientId,
      clientName: bundle.clientName,
      districts: inputs,
    });
  }

  // ── Scoring (pure over bundle) ────────────────────────────────────────────

  private async scoreDistrict(bundle: ClientBundle, districtKey: string, members: MemberRow[]) {
    const { identity, components } = buildDistrictStrategicComponents(bundle, districtKey, members);
    const conflicts = [...bundle.conflicts];

    // Member-priority evidence is the only asynchronous component load. It
    // remains in the service, and requested dollars never enter Nexus Strength.
    components.memberHistoricalPriorities = await this.loadMemberPriorityEvidence(
      identity.bioguides,
      identity.stateCode ?? '',
      districtKey,
    );

    if (bundle.geographyVintageConflicts.has(districtKey)) {
      conflicts.push({
        code: 'geography_vintage_conflict',
        message: `Geography vintage conflict on ${districtKey} (CD session mismatch).`,
      });
    }

    // Strategic Relevance is scored here and remains separate from Nexus Strength.
    return scoreStrategicRelevance({
      components,
      freshness: bundle.freshness,
      conflicts,
      minCoveragePercent: STRATEGIC_DEFAULT_MIN_COVERAGE_PERCENT,
    });
  }

  // ── Bundle load (batched, no N+1) ─────────────────────────────────────────

  private async loadClientBundle(tenantId: string, clientId: string): Promise<ClientBundle> {
    if (!UUID_RE.test(clientId) || !UUID_RE.test(tenantId)) {
      throw new NotFoundException('Client not found');
    }

    // Tenant-owned client resolution inside withTenant.
    const client = await this.prisma.withTenant(tenantId, async (tx) => {
      return tx.client.findFirst({
        where: { id: clientId, tenantId },
        select: { id: true, name: true, status: true },
      });
    });
    if (!client || client.status === 'archived') {
      throw new NotFoundException('Client not found');
    }

    const conflicts: StrategicConflictWarning[] = [];

    // PE relevance — reuse existing service (tenant-scoped internally).
    // ClientPeRelevanceService only reads ctx.tenantId from TenantContext.
    const pePage = await this.peRelevance.getRelevantPesForClient(
      { tenantId, tenantSlug: '', userId: '', clerkUserId: '', role: 'standard_user' },
      clientId,
      { minScore: 0.5, page: 1, limit: 100 },
    );
    const relevantPes: StrategicClientPeRow[] = pePage.data.map((r) => ({
      peCode: r.peCode,
      title: r.title,
      score: r.score,
      paths: r.paths,
    }));

    // Tenant-owned signals in one withTenant block.
    const tenantOwned = await this.prisma.withTenant(tenantId, async (tx) => {
      const [capabilities, targets, reportTargets, tracked, sharedMeetings, outreach] =
        await Promise.all([
          tx.clientCapability.findMany({
            where: { clientId, tenantId },
            select: {
              targetSubcommittee: true,
              peNumbers: true,
              peNumber: true,
            },
          }),
          tx.clientTarget.findMany({
            where: { clientId, tenantId, sourceDirectory: 'congress' },
            select: {
              id: true,
              memberId: true,
              memberName: true,
              addedAt: true,
            },
          }),
          tx.engagementReportTargetOffice.findMany({
            where: { clientId, tenantId },
            select: {
              id: true,
              memberPrincipal: true,
              officeKey: true,
              updatedAt: true,
            },
          }),
          tx.trackedBill.findMany({
            where: { clientId, tenantId },
            select: { billId: true },
          }),
          // Shared meetings only — never private content.
          tx.meeting.findMany({
            where: {
              tenantId,
              clientId,
              visibility: 'shared',
              status: { not: 'cancelled' },
            },
            select: {
              id: true,
              subject: true,
              startsAt: true,
              attendees: {
                select: { contactId: true, name: true, email: true, metadata: true },
              },
            },
            take: 200,
            orderBy: { startsAt: 'desc' },
          }),
          tx.outreachRecord.findMany({
            where: {
              tenantId,
              clientId,
              deletedAt: null,
              status: { in: ['sent', 'opened', 'replied'] },
            },
            select: {
              id: true,
              title: true,
              sentAt: true,
              metadata: true,
              recipients: true,
            },
            take: 100,
            orderBy: { createdAt: 'desc' },
          }),
        ]);

      // Strategies — raw SQL with explicit tenant_id (api-strategy owned tables).
      const strategyRows = await tx.$queryRaw<
        Array<{
          strategyId: string;
          strategyTitle: string;
          nodeId: string;
          nodeTitle: string;
          subject: string;
          targetRef: unknown;
        }>
      >`
        SELECT s.id::text AS "strategyId",
               s.title AS "strategyTitle",
               n.id::text AS "nodeId",
               n.title AS "nodeTitle",
               n.subject::text AS subject,
               n.target_ref AS "targetRef"
        FROM sp_strategy s
        JOIN sp_node n
          ON n.strategy_id = s.id
         AND n.tenant_id = s.tenant_id
         AND n.archived_at IS NULL
        WHERE s.tenant_id = ${tenantId}::uuid
          AND s.client_id = ${clientId}::uuid
          AND s.archived_at IS NULL
          AND n.target_ref IS NOT NULL
          AND n.subject IN ('member', 'committee')
      `.catch((err) => {
        this.logger.warn(
          `sp_strategy/sp_node read failed for strategic relevance: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      });

      return {
        capabilities,
        targets,
        reportTargets,
        trackedBillIds: tracked.map((t) => t.billId),
        sharedMeetings,
        outreach,
        strategyRows,
      };
    });

    // Global public reads OUTSIDE long tenant transactions.
    const billIds = tenantOwned.trackedBillIds;
    const [bills, cosponsors, billCommittees, allCurrentMembers, memberships, hearingBills] =
      await Promise.all([
        billIds.length
          ? this.prisma.congressBill.findMany({
              where: { id: { in: billIds } },
              select: {
                id: true,
                title: true,
                status: true,
                sponsorBioguideId: true,
                latestActionDate: true,
                peCodes: true,
              },
            })
          : Promise.resolve([]),
        billIds.length
          ? this.prisma.congressBillCosponsor.findMany({
              where: { billId: { in: billIds }, withdrawnDate: null },
              select: { billId: true, bioguideId: true },
            })
          : Promise.resolve([]),
        billIds.length
          ? this.prisma.congressBillCommittee.findMany({
              where: { billId: { in: billIds } },
              select: { billId: true, committeeCode: true },
            })
          : Promise.resolve([]),
        this.prisma.congressMember.findMany({
          where: { isCurrent: true },
          select: {
            bioguideId: true,
            fullName: true,
            party: true,
            state: true,
            district: true,
            chamber: true,
          },
        }),
        this.prisma.congressCommitteeMembership.findMany({
          select: {
            bioguideId: true,
            systemCode: true,
            title: true,
            committee: {
              select: {
                name: true,
                parentSystemCode: true,
                isCurrent: true,
              },
            },
          },
        }),
        billIds.length
          ? this.prisma.committeeHearingBill.findMany({
              where: { billId: { in: billIds } },
              select: { hearingId: true, billId: true },
            })
          : Promise.resolve([]),
      ]);

    const hearingIds = [...new Set(hearingBills.map((h) => h.hearingId))];
    const hearings = hearingIds.length
      ? await this.prisma.committeeHearing.findMany({
          where: federalHearingWhere({ id: { in: hearingIds } }),
          select: {
            id: true,
            title: true,
            committeeCode: true,
            startsAt: true,
            date: true,
          },
        })
      : [];

    const {
      trackedBills,
      membershipsByBioguide,
      strategyTargets,
      engagements,
      hearingLinks,
      membersByDistrict,
    } = assembleStrategicPostQuery({
      bills,
      cosponsors,
      billCommittees,
      memberships,
      strategyRows: tenantOwned.strategyRows,
      targets: tenantOwned.targets,
      reportTargets: tenantOwned.reportTargets,
      sharedMeetings: tenantOwned.sharedMeetings,
      outreach: tenantOwned.outreach,
      hearingBills,
      hearings,
      allCurrentMembers,
    });

    // Ensure districts that appear only via nexus (facilities/awards) are present
    // even if we will attach senators at score time — house map is the primary set.
    // Also include any district from client facilities for gap completeness.
    const facilityDistricts = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientFacility.findMany({
        where: { clientId, tenantId },
        select: {
          state: true,
          congressionalDistrict: true,
          congressionalDistrictCongress: true,
        },
      }),
    );
    const currentCongress = currentCongressNumber(new Date());
    const geographyVintageConflicts = new Set<string>();
    for (const f of facilityDistricts) {
      if (!f.state || !f.congressionalDistrict) continue;
      const key = districtKeyOf(f.state, f.congressionalDistrict);
      if (!membersByDistrict.has(key)) {
        // Still register empty house list so senators + strategic signals can attach.
        membersByDistrict.set(key, []);
      }
      if (
        f.congressionalDistrictCongress != null &&
        f.congressionalDistrictCongress !== currentCongress
      ) {
        geographyVintageConflicts.add(key);
      }
    }

    // Opportunity district keys from existing nexus client payload (no second engine).
    let opportunityDistrictKeys = new Set<string>();
    try {
      const nexusClient = await this.nexus.getClientDistrictNexus(clientId, tenantId);
      for (const d of nexusClient.districts) {
        // Ensure facility/award districts appear even without a current house member row.
        if (!membersByDistrict.has(d.districtKey)) {
          membersByDistrict.set(d.districtKey, []);
        }
        const opp = d.opportunities;
        if (
          opp &&
          ((opp.opportunityEstimatedFunding != null && opp.opportunityEstimatedFunding > 0) ||
            (opp.opportunityAwardCeiling != null && opp.opportunityAwardCeiling > 0))
        ) {
          opportunityDistrictKeys.add(d.districtKey);
        }
      }
    } catch {
      // Nexus load failure must not kill strategic — opportunities stay absent.
      opportunityDistrictKeys = new Set();
    }

    const freshness: SourceFreshness[] = [
      {
        source: 'sync-congress-members',
        label: 'Members of Congress',
        lastSyncedAt: null,
        neverSynced: false,
        freshnessUnavailable: true,
      },
      {
        source: 'tracked_bill',
        label: 'Client tracked legislation',
        lastSyncedAt: null,
        neverSynced: billIds.length === 0,
      },
      {
        source: 'sp_strategy',
        label: 'Client strategies (live nodes)',
        lastSyncedAt: null,
        neverSynced: strategyTargets.length === 0,
      },
      {
        source: 'client_pe_relevance',
        label: 'Program Element relevance',
        lastSyncedAt: null,
        neverSynced: relevantPes.length === 0,
      },
    ];

    return {
      clientId: client.id,
      clientName: client.name,
      archived: false,
      relevantPes,
      capabilityTargets: tenantOwned.capabilities,
      membershipsByBioguide,
      trackedBills,
      strategyTargets,
      engagements,
      hearings: hearingLinks,
      membersByDistrict,
      allMembers: allCurrentMembers,
      opportunityDistrictKeys,
      freshness,
      conflicts,
      geographyVintageConflicts,
    };
  }

  /** Source-named requester evidence only; public geography alone earns no member credit. */
  private async loadMemberPriorityEvidence(
    bioguides: ReadonlySet<string>,
    stateCode: string,
    districtKey: string,
  ): Promise<StrategicComponentInput> {
    try {
      const hasAnyCorpus = await this.prisma.communityFundingRequest.findFirst({
        select: { id: true },
      });
      if (!hasAnyCorpus) {
        return {
          strength: 'unavailable',
          evidenceCount: 0,
          evidence: [],
          rationale: 'CPF/CDS corpus is not loaded; member history is unavailable, not zero.',
        };
      }
      if (!bioguides.size) {
        return {
          strength: 'absent',
          evidenceCount: 0,
          evidence: [],
          rationale: 'No current member resolved for this district.',
        };
      }
      const state = stateCode.trim().toUpperCase();
      const district = normalizeCpfCdsDistrict(districtKey.split('-')[1] ?? null);
      // One historical/current directory pull and two bounded canonical pulls,
      // regardless of the number of members. Historical names prevent a bare
      // surname from silently resolving to a different current member.
      const directory = await loadPriorityMemberDirectory(this.prisma, state);
      const resolveRequesters = createRequesterResolver(directory);
      const select = {
        id: true,
        fiscalYear: true,
        requesterName: true,
        requesterState: true,
        requesterDistrict: true,
        state: true,
        recipientName: true,
        requestedAmountUsd: true,
      } as const;
      const sourceStdd = `${state}${district ?? ''}`;
      const districtKeys =
        district === '00'
          ? ['00', '0', sourceStdd, 'AL', 'AT LARGE', `${state}AL`]
          : district
            ? [district, String(Number(district)), sourceStdd]
            : [];
      const [houseRows, senateRows] = await Promise.all([
        this.prisma.communityFundingRequest
          .findMany({
            where: {
              chamber: 'house',
              requesterDistrict: { in: districtKeys, mode: 'insensitive' },
              OR: [
                { requesterState: state },
                { state },
                ...(sourceStdd ? [{ requesterDistrict: sourceStdd }] : []),
              ],
            },
            orderBy: [{ fiscalYear: 'desc' }, { requesterName: 'asc' }, { id: 'asc' }],
            take: 5000,
            select,
          })
          .then((rows) => rows.map((row) => ({ ...row, chamber: 'house' as const }))),
        this.prisma.communityFundingRequest
          .findMany({
            where: { chamber: 'senate', OR: [{ requesterState: state }, { state }] },
            orderBy: [{ fiscalYear: 'desc' }, { requesterName: 'asc' }, { id: 'asc' }],
            take: 5000,
            select,
          })
          .then((rows) => rows.map((row) => ({ ...row, chamber: 'senate' as const }))),
      ]);
      const evidence: StrategicEvidence[] = [];
      const seen = new Set<string>();
      const scanLimited = houseRows!.length === 5000 || senateRows!.length === 5000;
      let total = 0;
      let unresolved = 0;
      let count = 0;
      for (const row of [...houseRows!, ...senateRows!]) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        const geography = attributeGeography(row);
        if (geography.basis === 'unresolved') continue;
        if (geography.state !== state) continue;
        if (
          (geography.basis === 'house_district' || geography.basis === 'senate_project_district') &&
          geography.district !== district
        )
          continue;
        const requesters = resolveRequesters({ ...row, geography });
        if (!requesters.length) {
          unresolved++;
          continue;
        }
        const currentRequesters = requesters.filter(
          (member) => member.isCurrent && bioguides.has(member.bioguideId),
        );
        if (!currentRequesters.length) continue;
        // One canonical request, even when two members jointly requested it.
        count++;
        total += Number(row.requestedAmountUsd);
        if (evidence.length < 10)
          evidence.push({
            component: 'memberHistoricalPriorities',
            sourceType: row.chamber === 'senate' ? 'cds_request' : 'cpf_request',
            sourceRecordId: row.id,
            label: `${row.fiscalYear} ${row.requesterName}: ${row.recipientName}`,
            observedAt: null,
            summary: `${geography.basis === 'senate_statewide' ? 'Senate statewide' : row.chamber === 'senate' ? 'Senate project district' : 'House district'} request, $${Math.round(Number(row.requestedAmountUsd)).toLocaleString('en-US')} requested (not awarded); requester identity matched to the source name.`,
            refs: {
              chamber: row.chamber,
              fiscalYear: row.fiscalYear,
              requesterBioguideIds: currentRequesters.map((m) => m.bioguideId).join(','),
              attributionMethod: 'source_requester_name',
            },
          });
      }
      if (!count)
        return {
          strength: unresolved || scanLimited ? 'unavailable' : 'absent',
          evidenceCount: 0,
          evidence: [],
          rationale: scanLimited
            ? 'The bounded CPF/CDS scan is incomplete; individual member history is unavailable, not zero.'
            : unresolved
              ? 'CPF/CDS requests exist, but requester names cannot be uniquely resolved to members; individual history is unavailable, not zero.'
              : 'No source-named CPF/CDS request history found for the current members of this district.',
        };
      return {
        strength: 'sourceAuthoritative',
        evidenceCount: count,
        evidence,
        rationale: `${count} distinct canonical CPF/CDS request(s), $${Math.round(total).toLocaleString('en-US')} requested in the records examined, matched by source requester name. Joint requests counted once; ${unresolved} unresolved request(s) excluded. Member-priority context only — never Nexus Strength.${scanLimited ? ' Source scan reached its per-chamber limit; coverage is partial.' : ''}`,
      };
    } catch (error) {
      this.logger.warn(
        `memberHistoricalPriorities evidence load failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        strength: 'unavailable',
        evidenceCount: 0,
        evidence: [],
        rationale: 'CPF/CDS evidence query failed; component marked unavailable rather than zero.',
      };
    }
  }

  private async loadMembersForDistrict(
    stateCode: string,
    districtCode: string,
  ): Promise<MemberRow[]> {
    const stateName = STATE_CODE_TO_NAME[stateCode] ?? stateCode;
    const houseCode = districtCode === 'AL' || districtCode === '00' ? null : Number(districtCode);
    const members = await this.prisma.congressMember.findMany({
      where: {
        isCurrent: true,
        OR: [
          {
            chamber: 'house',
            state: { in: [stateName, stateCode] },
            ...(houseCode == null || Number.isNaN(houseCode)
              ? { district: null }
              : { district: houseCode }),
          },
          {
            chamber: 'senate',
            state: { in: [stateName, stateCode] },
          },
        ],
      },
      select: {
        bioguideId: true,
        fullName: true,
        party: true,
        state: true,
        district: true,
        chamber: true,
      },
    });
    return members;
  }

  private async loadNexusByDistrict(
    tenantId: string,
    clientId: string,
  ): Promise<Map<string, { score: number | null; coveragePercent: number }>> {
    const map = new Map<string, { score: number | null; coveragePercent: number }>();
    try {
      const res = await this.nexus.getClientDistrictNexus(clientId, tenantId);
      for (const d of res.districts) {
        map.set(d.districtKey, {
          score: d.score,
          coveragePercent: d.coveragePercent,
        });
      }
    } catch (err) {
      this.logger.warn(
        `Nexus Strength load for strategic dual-display failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return map;
  }
}
