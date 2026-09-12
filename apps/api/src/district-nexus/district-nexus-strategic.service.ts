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
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientPeRelevanceService } from '../intelligence/client-pe-relevance.service.js';
import { DistrictNexusService } from './district-nexus.service.js';
import {
  scoreStrategicRelevance,
  type StrategicComponentInput,
  type StrategicEvidenceStrength,
} from './district-nexus-strategic-scoring.js';
import { buildGapsResponse, type DistrictGapInput } from './district-nexus-strategic-gaps.js';
import {
  DEFENSE_BUDGET_COMMITTEE_CODES,
  STRATEGIC_DEFAULT_MIN_COVERAGE_PERCENT,
  STRATEGIC_SCORE_VERSION,
  type StrategicComponentKey,
} from './district-nexus-strategic-weights.js';
import type {
  ClientDistrictStrategicGapsResponse,
  ClientDistrictStrategicMapResponse,
  DistrictStrategicRelevanceResponse,
  StrategicConflictWarning,
  StrategicEvidence,
} from './district-nexus-strategic.types.js';
import type { SourceFreshness } from './district-nexus.types.js';
import {
  districtCodeForHouseMatch,
  normalizeDistrictForCensus,
} from '../common/district-code.util.js';
import { currentCongressNumber } from '../common/congress.util.js';
import { loadPriorityMemberDirectory } from './priority-intelligence/priority-intelligence-member-directory.js';
import {
  attributeGeography,
  normalizeCpfCdsDistrict,
  createRequesterResolver,
} from './priority-intelligence/priority-intelligence-cpf-cds.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** US state full name → 2-letter (congress_member.state stores full names). */
const STATE_NAME_TO_CODE: Readonly<Record<string, string>> = Object.freeze({
  Alabama: 'AL',
  Alaska: 'AK',
  Arizona: 'AZ',
  Arkansas: 'AR',
  California: 'CA',
  Colorado: 'CO',
  Connecticut: 'CT',
  Delaware: 'DE',
  Florida: 'FL',
  Georgia: 'GA',
  Hawaii: 'HI',
  Idaho: 'ID',
  Illinois: 'IL',
  Indiana: 'IN',
  Iowa: 'IA',
  Kansas: 'KS',
  Kentucky: 'KY',
  Louisiana: 'LA',
  Maine: 'ME',
  Maryland: 'MD',
  Massachusetts: 'MA',
  Michigan: 'MI',
  Minnesota: 'MN',
  Mississippi: 'MS',
  Missouri: 'MO',
  Montana: 'MT',
  Nebraska: 'NE',
  Nevada: 'NV',
  'New Hampshire': 'NH',
  'New Jersey': 'NJ',
  'New Mexico': 'NM',
  'New York': 'NY',
  'North Carolina': 'NC',
  'North Dakota': 'ND',
  Ohio: 'OH',
  Oklahoma: 'OK',
  Oregon: 'OR',
  Pennsylvania: 'PA',
  'Rhode Island': 'RI',
  'South Carolina': 'SC',
  'South Dakota': 'SD',
  Tennessee: 'TN',
  Texas: 'TX',
  Utah: 'UT',
  Vermont: 'VT',
  Virginia: 'VA',
  Washington: 'WA',
  'West Virginia': 'WV',
  Wisconsin: 'WI',
  Wyoming: 'WY',
  'District of Columbia': 'DC',
  'Puerto Rico': 'PR',
  Guam: 'GU',
  'American Samoa': 'AS',
  'Northern Mariana Islands': 'MP',
  'Virgin Islands': 'VI',
});

const STATE_CODE_TO_NAME: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(STATE_NAME_TO_CODE).map(([n, c]) => [c, n])),
);

interface MemberRow {
  bioguideId: string;
  fullName: string;
  party: string | null;
  state: string | null;
  district: number | null;
  chamber: string;
}

interface MembershipRow {
  bioguideId: string;
  systemCode: string;
  committeeName: string;
  parentSystemCode: string | null;
  title: string | null;
}

interface ClientPeRow {
  peCode: string;
  title: string | null;
  score: number;
  paths: Array<{ path: string; score: number; evidence: string[] }>;
}

interface CapabilityTargetRow {
  targetSubcommittee: string | null;
  peNumbers: string[];
  peNumber: string | null;
}

interface TrackedBillLink {
  billId: string;
  title: string | null;
  status: string | null;
  sponsorBioguideId: string | null;
  cosponsorBioguides: string[];
  committeeCodes: string[];
  latestActionDate: string | null;
  peCodes: string[];
}

interface StrategyTargetRow {
  strategyId: string;
  strategyTitle: string;
  nodeId: string;
  nodeTitle: string;
  subject: string;
  memberId: string | null;
  systemCode: string | null;
}

interface EngagementFact {
  kind: 'client_target' | 'report_target' | 'shared_meeting' | 'outreach';
  memberId: string;
  label: string;
  sourceRecordId: string;
  observedAt: string | null;
}

interface HearingLink {
  hearingId: string;
  title: string;
  committeeCode: string | null;
  startsAt: string | null;
  billId: string | null;
}

interface ClientBundle {
  clientId: string;
  clientName: string;
  archived: boolean;
  relevantPes: ClientPeRow[];
  capabilityTargets: CapabilityTargetRow[];
  membershipsByBioguide: Map<string, MembershipRow[]>;
  trackedBills: TrackedBillLink[];
  strategyTargets: StrategyTargetRow[];
  engagements: EngagementFact[];
  hearings: HearingLink[];
  membersByDistrict: Map<string, MemberRow[]>;
  allMembers: MemberRow[];
  opportunityDistrictKeys: Set<string>;
  freshness: SourceFreshness[];
  conflicts: StrategicConflictWarning[];
  geographyVintageConflicts: Set<string>;
}

function districtKeyOf(stateCode: string, districtCode: string): string {
  const d = normalizeDistrictForCensus(districtCode) || districtCode;
  const padded = d === 'AL' || d === '' ? '00' : d.padStart(2, '0');
  return `${stateCode.toUpperCase()}-${padded}`;
}

function memberDistrictKeys(m: MemberRow): string[] {
  if (!m.state) return [];
  const code = STATE_NAME_TO_CODE[m.state] ?? (m.state.length === 2 ? m.state.toUpperCase() : null);
  if (!code) return [];
  if (m.chamber === 'senate') {
    // Senate represents the whole state — attach via bioguide at score time;
    // district list is house-keyed.
    return [];
  }
  const raw = m.district == null || m.district === 0 ? '00' : String(m.district).padStart(2, '0');
  const houseCode = districtCodeForHouseMatch(raw);
  if (!houseCode) return [];
  return [districtKeyOf(code, houseCode)];
}

function parseTargetRef(raw: unknown): { memberId: string | null; systemCode: string | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { memberId: null, systemCode: null };
  }
  const o = raw as Record<string, unknown>;
  const memberId =
    typeof o.memberId === 'string' && o.memberId.trim()
      ? o.memberId.trim()
      : typeof o.bioguideId === 'string' && o.bioguideId.trim()
        ? o.bioguideId.trim()
        : null;
  const systemCode =
    typeof o.systemCode === 'string' && o.systemCode.trim()
      ? o.systemCode.trim().toLowerCase()
      : typeof o.committeeSystemCode === 'string' && o.committeeSystemCode.trim()
        ? o.committeeSystemCode.trim().toLowerCase()
        : null;
  return { memberId, systemCode };
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
    const bioguides = new Set(members.map((m) => m.bioguideId));
    // Senators for the state also count for bill/strategy/engagement links.
    const [stateCode] = districtKey.split('-');
    for (const m of bundle.allMembers) {
      if (
        m.chamber === 'senate' &&
        (STATE_NAME_TO_CODE[m.state ?? ''] === stateCode || m.state === stateCode)
      ) {
        bioguides.add(m.bioguideId);
      }
    }

    const components: Partial<Record<StrategicComponentKey, StrategicComponentInput>> = {};
    const conflicts = [...bundle.conflicts];

    // ── Committee jurisdiction ────────────────────────────────────────────
    {
      const evidence: StrategicEvidence[] = [];
      let strength: StrategicEvidenceStrength = 'absent';
      const targetSubs = new Set(
        bundle.capabilityTargets
          .map((c) => c.targetSubcommittee?.trim().toLowerCase())
          .filter((s): s is string => Boolean(s)),
      );
      const defenseCodes = new Set<string>(Object.values(DEFENSE_BUDGET_COMMITTEE_CODES));

      for (const bg of bioguides) {
        const seats = bundle.membershipsByBioguide.get(bg) ?? [];
        for (const seat of seats) {
          const code = seat.systemCode.toLowerCase();
          const parent = seat.parentSystemCode?.toLowerCase() ?? null;
          const explicitTarget = targetSubs.has(code) || (parent != null && targetSubs.has(parent));
          const peLinkedDefense =
            bundle.relevantPes.length > 0 &&
            (defenseCodes.has(code) || (parent != null && defenseCodes.has(parent)));

          if (explicitTarget || peLinkedDefense) {
            strength = explicitTarget
              ? 'verified'
              : strength === 'verified'
                ? 'verified'
                : 'sourceAuthoritative';
            const member = members.find((m) => m.bioguideId === bg);
            evidence.push({
              component: 'committeeJurisdiction',
              sourceType: 'congress_committee_membership',
              label: `${member?.fullName ?? bg} · ${seat.committeeName}`,
              sourceRecordId: `${seat.systemCode}:${bg}`,
              observedAt: null,
              summary: explicitTarget
                ? `Member sits on client-targeted committee/subcommittee ${seat.systemCode}.`
                : `Member sits on defense budget committee ${seat.systemCode} with client PE relevance.`,
              refs: {
                bioguideId: bg,
                systemCode: seat.systemCode,
                committeeName: seat.committeeName,
                title: seat.title,
              },
            });
          }
        }
      }

      // Membership alone with no PE/target link does NOT score (and does not create nexus).
      components.committeeJurisdiction = {
        strength,
        evidenceCount: evidence.length,
        evidence,
        rationale:
          strength === 'absent'
            ? 'No structured committee link to client PE relevance or capability targetSubcommittee.'
            : `Structured committee membership linked to client strategic targets (${evidence.length}).`,
      };
    }

    // ── Program Element / budget ──────────────────────────────────────────
    {
      const evidence: StrategicEvidence[] = [];
      let strength: StrategicEvidenceStrength = 'absent';
      const hasRelevantCommittee =
        (components.committeeJurisdiction?.strength ?? 'absent') !== 'absent';

      if (bundle.relevantPes.length === 0) {
        strength = 'absent';
      } else if (hasRelevantCommittee) {
        // PE relevance + member on jurisdiction committee.
        const top = bundle.relevantPes.slice(0, 5);
        for (const pe of top) {
          const direct = pe.paths.some((p) => p.path === 'capability_pe_direct');
          strength = direct
            ? 'verified'
            : strength === 'verified'
              ? 'verified'
              : 'sourceAuthoritative';
          evidence.push({
            component: 'programElementBudget',
            sourceType: 'client_pe_relevance',
            label: `PE ${pe.peCode}${pe.title ? ` · ${pe.title}` : ''}`,
            sourceRecordId: pe.peCode,
            observedAt: null,
            summary: `Client PE relevance ${pe.score.toFixed(2)} via ${pe.paths.map((p) => p.path).join(', ')}; member holds related committee seat.`,
            refs: { peCode: pe.peCode, peScore: pe.score },
          });
        }
      } else {
        // Relevant PEs exist but no committee bridge for this district — missing, not zero-from-irrelevant.
        strength = 'absent';
      }

      components.programElementBudget = {
        strength,
        evidenceCount: evidence.length,
        evidence,
        rationale:
          strength === 'absent'
            ? bundle.relevantPes.length === 0
              ? 'No client PE relevance at the configured floor.'
              : "Client has PE relevance, but this district's members lack a structured committee jurisdiction bridge."
            : `Client PE relevance bridged through committee membership (${evidence.length} PE(s)).`,
      };
    }

    // ── Active legislation (tracked bills) ────────────────────────────────
    {
      const evidence: StrategicEvidence[] = [];
      let strength: StrategicEvidenceStrength = 'absent';

      for (const bill of bundle.trackedBills) {
        const isSponsor = bill.sponsorBioguideId != null && bioguides.has(bill.sponsorBioguideId);
        const isCosponsor = bill.cosponsorBioguides.some((b) => bioguides.has(b));
        const committeeOverlap = bill.committeeCodes.some((code) => {
          for (const bg of bioguides) {
            const seats = bundle.membershipsByBioguide.get(bg) ?? [];
            if (seats.some((s) => s.systemCode.toLowerCase() === code.toLowerCase())) return true;
          }
          return false;
        });

        if (!isSponsor && !isCosponsor && !committeeOverlap) continue;

        if (isSponsor) strength = 'verified';
        else if (strength !== 'verified')
          strength = isCosponsor ? 'sourceAuthoritative' : 'partial';

        const role = isSponsor ? 'sponsor' : isCosponsor ? 'cosponsor' : 'committee referral';
        evidence.push({
          component: 'activeLegislation',
          sourceType: 'tracked_bill',
          label: bill.title ? `${bill.billId} · ${bill.title}` : bill.billId,
          sourceRecordId: bill.billId,
          observedAt: bill.latestActionDate,
          summary: `Tracked bill linked as ${role}${bill.status ? ` (stage: ${bill.status})` : ''}.`,
          refs: {
            billId: bill.billId,
            role,
            status: bill.status,
          },
        });
      }

      components.activeLegislation = {
        strength,
        evidenceCount: evidence.length,
        evidence,
        rationale:
          strength === 'absent'
            ? "No tracked bill with sponsor/cosponsor/committee referral link to this district's members."
            : `Tracked legislation with structured member links (${evidence.length}).`,
      };
    }

    // ── Strategy / tactic targets ─────────────────────────────────────────
    {
      const evidence: StrategicEvidence[] = [];
      let strength: StrategicEvidenceStrength = 'absent';

      for (const s of bundle.strategyTargets) {
        const memberHit = s.memberId != null && bioguides.has(s.memberId);
        let committeeHit = false;
        if (s.systemCode) {
          for (const bg of bioguides) {
            const seats = bundle.membershipsByBioguide.get(bg) ?? [];
            if (seats.some((seat) => seat.systemCode.toLowerCase() === s.systemCode)) {
              committeeHit = true;
              break;
            }
          }
        }
        // subject === 'member' | 'committee' alone is not enough without target_ref ids.
        if (!memberHit && !committeeHit) continue;

        strength = memberHit ? 'verified' : 'sourceAuthoritative';
        evidence.push({
          component: 'activeStrategyTarget',
          sourceType: 'sp_node',
          label: `${s.strategyTitle} · ${s.nodeTitle}`,
          sourceRecordId: s.nodeId,
          observedAt: null,
          summary: memberHit
            ? `Live strategy node explicitly targets member ${s.memberId}.`
            : `Live strategy node explicitly targets committee ${s.systemCode}.`,
          refs: {
            strategyId: s.strategyId,
            nodeId: s.nodeId,
            subject: s.subject,
            memberId: s.memberId,
            systemCode: s.systemCode,
          },
        });
      }

      components.activeStrategyTarget = {
        strength,
        evidenceCount: evidence.length,
        evidence,
        rationale:
          strength === 'absent'
            ? 'No live strategy/tactic node with structured target_ref to this member/committee.'
            : `Explicit strategy targets (${evidence.length}).`,
      };
    }

    // ── Engagement / relationship ─────────────────────────────────────────
    {
      const evidence: StrategicEvidence[] = [];
      let strength: StrategicEvidenceStrength = 'absent';

      for (const e of bundle.engagements) {
        if (!bioguides.has(e.memberId)) continue;
        if (e.kind === 'client_target')
          strength = strength === 'partial' ? 'sourceAuthoritative' : 'verified';
        else if (strength === 'absent')
          strength = e.kind === 'shared_meeting' ? 'sourceAuthoritative' : 'partial';
        else if (strength === 'partial') strength = 'sourceAuthoritative';

        evidence.push({
          component: 'relationshipEngagement',
          sourceType: e.kind,
          label: e.label,
          sourceRecordId: e.sourceRecordId,
          observedAt: e.observedAt,
          summary:
            e.kind === 'shared_meeting'
              ? 'Shared meeting held with office (details redacted).'
              : e.kind === 'client_target'
                ? 'Client target saved for this member/office.'
                : `Structured ${e.kind} linked to member office.`,
          refs: { memberId: e.memberId, kind: e.kind },
        });
      }

      components.relationshipEngagement = {
        strength,
        evidenceCount: evidence.length,
        evidence,
        rationale:
          strength === 'absent'
            ? "No structured engagement/target tied to this district's member office."
            : `Relationship facts tied to member office (${evidence.length}).`,
      };
    }

    // ── Hearings ──────────────────────────────────────────────────────────
    {
      const evidence: StrategicEvidence[] = [];
      let strength: StrategicEvidenceStrength = 'absent';
      const trackedBillIds = new Set(bundle.trackedBills.map((b) => b.billId));

      for (const h of bundle.hearings) {
        const billRelevant = h.billId != null && trackedBillIds.has(h.billId);
        let committeeMember = false;
        if (h.committeeCode) {
          const code = h.committeeCode.toLowerCase();
          for (const bg of bioguides) {
            const seats = bundle.membershipsByBioguide.get(bg) ?? [];
            if (seats.some((s) => s.systemCode.toLowerCase() === code)) {
              committeeMember = true;
              break;
            }
          }
        }
        // Hearing contributes only when tied to relevant tracked bill AND member committee link.
        if (!billRelevant || !committeeMember) continue;
        strength = 'sourceAuthoritative';
        evidence.push({
          component: 'hearingTiming',
          sourceType: 'committee_hearing',
          label: h.title,
          sourceRecordId: h.hearingId,
          observedAt: h.startsAt,
          summary: `Hearing on tracked bill ${h.billId} before a committee this member sits on.`,
          refs: {
            hearingId: h.hearingId,
            billId: h.billId,
            committeeCode: h.committeeCode,
          },
        });
      }

      components.hearingTiming = {
        strength,
        evidenceCount: evidence.length,
        evidence,
        rationale:
          strength === 'absent'
            ? 'No hearing with both a client-tracked bill link and member committee participation.'
            : `Strategic hearing timing (${evidence.length}).`,
      };
    }

    // ── Opportunity / funding (reuse nexus opportunity separation — district keys only) ──
    {
      const hasOpp = bundle.opportunityDistrictKeys.has(districtKey);
      components.opportunityFunding = {
        strength: hasOpp ? 'partial' : 'absent',
        evidenceCount: hasOpp ? 1 : 0,
        evidence: hasOpp
          ? [
              {
                component: 'opportunityFunding',
                sourceType: 'grant_opportunity_candidate',
                label: 'Client-linked grant opportunity in district',
                sourceRecordId: districtKey,
                observedAt: null,
                summary:
                  'Client has a structured opportunity candidate attributed to this district (forecast — not awarded).',
              },
            ]
          : [],
        rationale: hasOpp
          ? 'Structured opportunity candidate present for this district.'
          : 'No structured opportunity candidate for this district.',
      };
    }

    // ── Member historical priorities / CPF-CDS (Release 4 wiring) ──────────
    // Structured CPF/CDS evidence now exists in community_funding_request.
    // Qualifying, deterministic evidence feeds full credit; the corpus being
    // absent stays 'unavailable' (coverage gap, not zero). Requests attribute
    // to members only when the source requester name resolves uniquely and
    // the source geography is compatible with their representation. Requested dollars are
    // member-priority CONTEXT — they never enter Nexus Strength and never
    // count as awarded money.
    {
      const bundle3 = await this.loadMemberPriorityEvidence(
        bioguides,
        stateCode ?? '',
        districtKey,
      );
      components.memberHistoricalPriorities = bundle3;
    }

    if (bundle.geographyVintageConflicts.has(districtKey)) {
      conflicts.push({
        code: 'geography_vintage_conflict',
        message: `Geography vintage conflict on ${districtKey} (CD session mismatch).`,
      });
    }

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
    const relevantPes: ClientPeRow[] = pePage.data.map((r) => ({
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

    const cosponsorsByBill = new Map<string, string[]>();
    for (const c of cosponsors) {
      const list = cosponsorsByBill.get(c.billId) ?? [];
      list.push(c.bioguideId);
      cosponsorsByBill.set(c.billId, list);
    }
    const committeesByBill = new Map<string, string[]>();
    for (const c of billCommittees) {
      if (!c.committeeCode) continue;
      const list = committeesByBill.get(c.billId) ?? [];
      list.push(c.committeeCode);
      committeesByBill.set(c.billId, list);
    }

    const trackedBills: TrackedBillLink[] = bills.map((b) => ({
      billId: b.id,
      title: b.title,
      status: b.status,
      sponsorBioguideId: b.sponsorBioguideId,
      cosponsorBioguides: cosponsorsByBill.get(b.id) ?? [],
      committeeCodes: committeesByBill.get(b.id) ?? [],
      latestActionDate: b.latestActionDate ? b.latestActionDate.toISOString() : null,
      peCodes: b.peCodes ?? [],
    }));

    const membershipsByBioguide = new Map<string, MembershipRow[]>();
    for (const m of memberships) {
      if (m.committee && m.committee.isCurrent === false) continue;
      const row: MembershipRow = {
        bioguideId: m.bioguideId,
        systemCode: m.systemCode,
        committeeName: m.committee?.name ?? m.systemCode,
        parentSystemCode: m.committee?.parentSystemCode ?? null,
        title: m.title,
      };
      const list = membershipsByBioguide.get(m.bioguideId) ?? [];
      list.push(row);
      membershipsByBioguide.set(m.bioguideId, list);
    }

    const strategyTargets: StrategyTargetRow[] = [];
    for (const s of tenantOwned.strategyRows) {
      const parsed = parseTargetRef(s.targetRef);
      // Free-text-only rows (no memberId/systemCode) earn nothing.
      if (!parsed.memberId && !parsed.systemCode) continue;
      strategyTargets.push({
        strategyId: s.strategyId,
        strategyTitle: s.strategyTitle,
        nodeId: s.nodeId,
        nodeTitle: s.nodeTitle,
        subject: s.subject,
        memberId: parsed.memberId,
        systemCode: parsed.systemCode,
      });
    }

    const engagements: EngagementFact[] = [];
    for (const t of tenantOwned.targets) {
      engagements.push({
        kind: 'client_target',
        memberId: t.memberId,
        label: t.memberName ? `Target: ${t.memberName}` : `Target: ${t.memberId}`,
        sourceRecordId: t.id,
        observedAt: t.addedAt.toISOString(),
      });
    }
    for (const r of tenantOwned.reportTargets) {
      // memberPrincipal is the bioguide/directory id when structured.
      if (!r.memberPrincipal?.trim()) continue;
      engagements.push({
        kind: 'report_target',
        memberId: r.memberPrincipal.trim(),
        label: `Engagement report office ${r.officeKey}`,
        sourceRecordId: r.id,
        observedAt: r.updatedAt.toISOString(),
      });
    }
    // Shared meetings: only when attendee metadata carries a bioguide/member id.
    for (const mtg of tenantOwned.sharedMeetings) {
      for (const a of mtg.attendees) {
        const meta = (a.metadata ?? {}) as Record<string, unknown>;
        const memberId =
          typeof meta.bioguideId === 'string'
            ? meta.bioguideId
            : typeof meta.memberId === 'string'
              ? meta.memberId
              : null;
        if (!memberId) continue;
        engagements.push({
          kind: 'shared_meeting',
          memberId,
          label: 'Shared meeting with office',
          sourceRecordId: mtg.id,
          observedAt: mtg.startsAt.toISOString(),
        });
      }
    }
    for (const o of tenantOwned.outreach) {
      const meta = (o.metadata ?? {}) as Record<string, unknown>;
      const memberId =
        typeof meta.bioguideId === 'string'
          ? meta.bioguideId
          : typeof meta.memberId === 'string'
            ? meta.memberId
            : null;
      if (!memberId) continue;
      engagements.push({
        kind: 'outreach',
        memberId,
        label: o.title || 'Outreach to office',
        sourceRecordId: o.id,
        observedAt: o.sentAt ? o.sentAt.toISOString() : null,
      });
    }

    const hearingBillByHearing = new Map<string, string>();
    for (const hb of hearingBills) hearingBillByHearing.set(hb.hearingId, hb.billId);
    const hearingLinks: HearingLink[] = hearings.map((h) => ({
      hearingId: h.id,
      title: h.title,
      committeeCode: h.committeeCode,
      startsAt: h.startsAt ? h.startsAt.toISOString() : h.date ? h.date.toISOString() : null,
      billId: hearingBillByHearing.get(h.id) ?? null,
    }));

    const membersByDistrict = new Map<string, MemberRow[]>();
    for (const m of allCurrentMembers) {
      for (const key of memberDistrictKeys(m)) {
        const list = membersByDistrict.get(key) ?? [];
        list.push(m);
        membersByDistrict.set(key, list);
      }
    }

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
      const [houseRows, senateRows] = await Promise.all(
        (['house', 'senate'] as const).map((chamber) =>
          this.prisma.communityFundingRequest
            .findMany({
              where: { chamber, requesterState: state },
              orderBy: [{ fiscalYear: 'desc' }, { requesterName: 'asc' }, { id: 'asc' }],
              take: 5000,
              select,
            })
            .then((rows) => rows.map((row) => ({ ...row, chamber }))),
        ),
      );
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
