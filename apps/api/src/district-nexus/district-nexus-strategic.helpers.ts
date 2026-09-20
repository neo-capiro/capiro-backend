import {
  districtCodeForHouseMatch,
  normalizeDistrictForCensus,
} from '../common/district-code.util.js';
import type { StrategicComponentInput } from './district-nexus-strategic-scoring.js';
import type { StrategicEvidence } from './district-nexus-strategic.types.js';
import {
  DEFENSE_BUDGET_COMMITTEE_CODES,
  type StrategicComponentKey,
} from './district-nexus-strategic-weights.js';

/** US state full name → 2-letter (congress_member.state stores full names). */
export const STATE_NAME_TO_CODE: Readonly<Record<string, string>> = Object.freeze({
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

export const STATE_CODE_TO_NAME: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(STATE_NAME_TO_CODE).map(([name, code]) => [code, name])),
);

export interface StrategicMemberRow {
  bioguideId: string;
  fullName: string;
  party: string | null;
  state: string | null;
  district: number | null;
  chamber: string;
}

export interface StrategicMembershipRow {
  bioguideId: string;
  systemCode: string;
  committeeName: string;
  parentSystemCode: string | null;
  title: string | null;
}

export interface StrategicClientPeRow {
  peCode: string;
  title: string | null;
  score: number;
  paths: Array<{ path: string; score: number; evidence: string[] }>;
}

export interface StrategicCapabilityTargetRow {
  targetSubcommittee: string | null;
  peNumbers: string[];
  peNumber: string | null;
}

export interface StrategicTrackedBillLink {
  billId: string;
  title: string | null;
  status: string | null;
  sponsorBioguideId: string | null;
  cosponsorBioguides: string[];
  committeeCodes: string[];
  latestActionDate: string | null;
  peCodes: string[];
}

export interface StrategicStrategyTargetRow {
  strategyId: string;
  strategyTitle: string;
  nodeId: string;
  nodeTitle: string;
  subject: string;
  memberId: string | null;
  systemCode: string | null;
}

export interface StrategicEngagementFact {
  kind: 'client_target' | 'report_target' | 'shared_meeting' | 'outreach';
  memberId: string;
  label: string;
  sourceRecordId: string;
  observedAt: string | null;
}

export interface StrategicHearingLink {
  hearingId: string;
  title: string;
  committeeCode: string | null;
  startsAt: string | null;
  billId: string | null;
}

export interface StrategicBuilderBundle {
  relevantPes: StrategicClientPeRow[];
  capabilityTargets: StrategicCapabilityTargetRow[];
  membershipsByBioguide: Map<string, StrategicMembershipRow[]>;
  trackedBills: StrategicTrackedBillLink[];
  strategyTargets: StrategicStrategyTargetRow[];
  engagements: StrategicEngagementFact[];
  hearings: StrategicHearingLink[];
  allMembers: StrategicMemberRow[];
  opportunityDistrictKeys: Set<string>;
}

export interface DistrictMemberIdentity {
  bioguides: Set<string>;
  stateCode: string | undefined;
  members: StrategicMemberRow[];
}

export function districtKeyOf(stateCode: string, districtCode: string): string {
  const district = normalizeDistrictForCensus(districtCode) || districtCode;
  const padded = district === 'AL' || district === '' ? '00' : district.padStart(2, '0');
  return `${stateCode.toUpperCase()}-${padded}`;
}

export function memberDistrictKeys(member: StrategicMemberRow): string[] {
  if (!member.state) return [];
  const code =
    STATE_NAME_TO_CODE[member.state] ??
    (member.state.length === 2 ? member.state.toUpperCase() : null);
  if (!code || member.chamber === 'senate') return [];
  const raw =
    member.district == null || member.district === 0
      ? '00'
      : String(member.district).padStart(2, '0');
  const houseCode = districtCodeForHouseMatch(raw);
  return houseCode ? [districtKeyOf(code, houseCode)] : [];
}

export function parseTargetRef(raw: unknown): {
  memberId: string | null;
  systemCode: string | null;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { memberId: null, systemCode: null };
  }
  const target = raw as Record<string, unknown>;
  const memberId =
    typeof target.memberId === 'string' && target.memberId.trim()
      ? target.memberId.trim()
      : typeof target.bioguideId === 'string' && target.bioguideId.trim()
        ? target.bioguideId.trim()
        : null;
  const systemCode =
    typeof target.systemCode === 'string' && target.systemCode.trim()
      ? target.systemCode.trim().toLowerCase()
      : typeof target.committeeSystemCode === 'string' && target.committeeSystemCode.trim()
        ? target.committeeSystemCode.trim().toLowerCase()
        : null;
  return { memberId, systemCode };
}

export function buildDistrictMemberIdentity(
  bundle: Pick<StrategicBuilderBundle, 'allMembers'>,
  districtKey: string,
  members: StrategicMemberRow[],
): DistrictMemberIdentity {
  const bioguides = new Set(members.map((member) => member.bioguideId));
  const [stateCode] = districtKey.split('-');
  for (const member of bundle.allMembers) {
    if (
      member.chamber === 'senate' &&
      (STATE_NAME_TO_CODE[member.state ?? ''] === stateCode || member.state === stateCode)
    ) {
      bioguides.add(member.bioguideId);
    }
  }
  return { bioguides, stateCode, members };
}

export function buildCommitteeJurisdictionComponent(
  bundle: Pick<
    StrategicBuilderBundle,
    'capabilityTargets' | 'membershipsByBioguide' | 'relevantPes'
  >,
  identity: DistrictMemberIdentity,
): StrategicComponentInput {
  const evidence: StrategicEvidence[] = [];
  let strength: StrategicComponentInput['strength'] = 'absent';
  const targetSubs = new Set(
    bundle.capabilityTargets
      .map((capability) => capability.targetSubcommittee?.trim().toLowerCase())
      .filter((target): target is string => Boolean(target)),
  );
  const defenseCodes = new Set<string>(Object.values(DEFENSE_BUDGET_COMMITTEE_CODES));

  for (const bioguide of identity.bioguides) {
    for (const seat of bundle.membershipsByBioguide.get(bioguide) ?? []) {
      const code = seat.systemCode.toLowerCase();
      const parent = seat.parentSystemCode?.toLowerCase() ?? null;
      const explicitTarget = targetSubs.has(code) || (parent != null && targetSubs.has(parent));
      const peLinkedDefense =
        bundle.relevantPes.length > 0 &&
        (defenseCodes.has(code) || (parent != null && defenseCodes.has(parent)));
      if (!explicitTarget && !peLinkedDefense) continue;

      strength = explicitTarget
        ? 'verified'
        : strength === 'verified'
          ? 'verified'
          : 'sourceAuthoritative';
      const member = identity.members.find((candidate) => candidate.bioguideId === bioguide);
      evidence.push({
        component: 'committeeJurisdiction',
        sourceType: 'congress_committee_membership',
        label: `${member?.fullName ?? bioguide} · ${seat.committeeName}`,
        sourceRecordId: `${seat.systemCode}:${bioguide}`,
        observedAt: null,
        summary: explicitTarget
          ? `Member sits on client-targeted committee/subcommittee ${seat.systemCode}.`
          : `Member sits on defense budget committee ${seat.systemCode} with client PE relevance.`,
        refs: {
          bioguideId: bioguide,
          systemCode: seat.systemCode,
          committeeName: seat.committeeName,
          title: seat.title,
        },
      });
    }
  }

  return {
    strength,
    evidenceCount: evidence.length,
    evidence,
    rationale:
      strength === 'absent'
        ? 'No structured committee link to client PE relevance or capability targetSubcommittee.'
        : `Structured committee membership linked to client strategic targets (${evidence.length}).`,
  };
}

export function buildProgramElementBudgetComponent(
  bundle: Pick<StrategicBuilderBundle, 'relevantPes'>,
  committeeJurisdiction: StrategicComponentInput,
): StrategicComponentInput {
  const evidence: StrategicEvidence[] = [];
  let strength: StrategicComponentInput['strength'] = 'absent';
  const hasRelevantCommittee = committeeJurisdiction.strength !== 'absent';

  if (bundle.relevantPes.length > 0 && hasRelevantCommittee) {
    for (const pe of bundle.relevantPes.slice(0, 5)) {
      const direct = pe.paths.some((path) => path.path === 'capability_pe_direct');
      strength = direct ? 'verified' : strength === 'verified' ? 'verified' : 'sourceAuthoritative';
      evidence.push({
        component: 'programElementBudget',
        sourceType: 'client_pe_relevance',
        label: `PE ${pe.peCode}${pe.title ? ` · ${pe.title}` : ''}`,
        sourceRecordId: pe.peCode,
        observedAt: null,
        summary: `Client PE relevance ${pe.score.toFixed(2)} via ${pe.paths.map((path) => path.path).join(', ')}; member holds related committee seat.`,
        refs: { peCode: pe.peCode, peScore: pe.score },
      });
    }
  }

  return {
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

export function buildActiveLegislationComponent(
  bundle: Pick<StrategicBuilderBundle, 'trackedBills' | 'membershipsByBioguide'>,
  identity: DistrictMemberIdentity,
): StrategicComponentInput {
  const evidence: StrategicEvidence[] = [];
  let strength: StrategicComponentInput['strength'] = 'absent';

  for (const bill of bundle.trackedBills) {
    const isSponsor =
      bill.sponsorBioguideId != null && identity.bioguides.has(bill.sponsorBioguideId);
    const isCosponsor = bill.cosponsorBioguides.some((bioguide) =>
      identity.bioguides.has(bioguide),
    );
    const committeeOverlap = bill.committeeCodes.some((committeeCode) => {
      for (const bioguide of identity.bioguides) {
        const seats = bundle.membershipsByBioguide.get(bioguide) ?? [];
        if (seats.some((seat) => seat.systemCode.toLowerCase() === committeeCode.toLowerCase())) {
          return true;
        }
      }
      return false;
    });
    if (!isSponsor && !isCosponsor && !committeeOverlap) continue;

    if (isSponsor) strength = 'verified';
    else if (strength !== 'verified') {
      strength = isCosponsor ? 'sourceAuthoritative' : 'partial';
    }
    const role = isSponsor ? 'sponsor' : isCosponsor ? 'cosponsor' : 'committee referral';
    evidence.push({
      component: 'activeLegislation',
      sourceType: 'tracked_bill',
      label: bill.title ? `${bill.billId} · ${bill.title}` : bill.billId,
      sourceRecordId: bill.billId,
      observedAt: bill.latestActionDate,
      summary: `Tracked bill linked as ${role}${bill.status ? ` (stage: ${bill.status})` : ''}.`,
      refs: { billId: bill.billId, role, status: bill.status },
    });
  }

  return {
    strength,
    evidenceCount: evidence.length,
    evidence,
    rationale:
      strength === 'absent'
        ? "No tracked bill with sponsor/cosponsor/committee referral link to this district's members."
        : `Tracked legislation with structured member links (${evidence.length}).`,
  };
}

export function buildActiveStrategyTargetComponent(
  bundle: Pick<StrategicBuilderBundle, 'strategyTargets' | 'membershipsByBioguide'>,
  identity: DistrictMemberIdentity,
): StrategicComponentInput {
  const evidence: StrategicEvidence[] = [];
  let strength: StrategicComponentInput['strength'] = 'absent';

  for (const target of bundle.strategyTargets) {
    const memberHit = target.memberId != null && identity.bioguides.has(target.memberId);
    let committeeHit = false;
    if (target.systemCode) {
      for (const bioguide of identity.bioguides) {
        const seats = bundle.membershipsByBioguide.get(bioguide) ?? [];
        if (seats.some((seat) => seat.systemCode.toLowerCase() === target.systemCode)) {
          committeeHit = true;
          break;
        }
      }
    }
    if (!memberHit && !committeeHit) continue;

    strength = memberHit ? 'verified' : 'sourceAuthoritative';
    evidence.push({
      component: 'activeStrategyTarget',
      sourceType: 'sp_node',
      label: `${target.strategyTitle} · ${target.nodeTitle}`,
      sourceRecordId: target.nodeId,
      observedAt: null,
      summary: memberHit
        ? `Live strategy node explicitly targets member ${target.memberId}.`
        : `Live strategy node explicitly targets committee ${target.systemCode}.`,
      refs: {
        strategyId: target.strategyId,
        nodeId: target.nodeId,
        subject: target.subject,
        memberId: target.memberId,
        systemCode: target.systemCode,
      },
    });
  }

  return {
    strength,
    evidenceCount: evidence.length,
    evidence,
    rationale:
      strength === 'absent'
        ? 'No live strategy/tactic node with structured target_ref to this member/committee.'
        : `Explicit strategy targets (${evidence.length}).`,
  };
}

export function buildRelationshipEngagementComponent(
  bundle: Pick<StrategicBuilderBundle, 'engagements'>,
  identity: DistrictMemberIdentity,
): StrategicComponentInput {
  const evidence: StrategicEvidence[] = [];
  let strength: StrategicComponentInput['strength'] = 'absent';

  for (const engagement of bundle.engagements) {
    if (!identity.bioguides.has(engagement.memberId)) continue;
    if (engagement.kind === 'client_target') {
      strength = strength === 'partial' ? 'sourceAuthoritative' : 'verified';
    } else if (strength === 'absent') {
      strength = engagement.kind === 'shared_meeting' ? 'sourceAuthoritative' : 'partial';
    } else if (strength === 'partial') {
      strength = 'sourceAuthoritative';
    }

    evidence.push({
      component: 'relationshipEngagement',
      sourceType: engagement.kind,
      label: engagement.label,
      sourceRecordId: engagement.sourceRecordId,
      observedAt: engagement.observedAt,
      summary:
        engagement.kind === 'shared_meeting'
          ? 'Shared meeting held with office (details redacted).'
          : engagement.kind === 'client_target'
            ? 'Client target saved for this member/office.'
            : `Structured ${engagement.kind} linked to member office.`,
      refs: { memberId: engagement.memberId, kind: engagement.kind },
    });
  }

  return {
    strength,
    evidenceCount: evidence.length,
    evidence,
    rationale:
      strength === 'absent'
        ? "No structured engagement/target tied to this district's member office."
        : `Relationship facts tied to member office (${evidence.length}).`,
  };
}

export function buildHearingTimingComponent(
  bundle: Pick<StrategicBuilderBundle, 'hearings' | 'trackedBills' | 'membershipsByBioguide'>,
  identity: DistrictMemberIdentity,
): StrategicComponentInput {
  const evidence: StrategicEvidence[] = [];
  let strength: StrategicComponentInput['strength'] = 'absent';
  const trackedBillIds = new Set(bundle.trackedBills.map((bill) => bill.billId));

  for (const hearing of bundle.hearings) {
    const billRelevant = hearing.billId != null && trackedBillIds.has(hearing.billId);
    let committeeMember = false;
    if (hearing.committeeCode) {
      const code = hearing.committeeCode.toLowerCase();
      for (const bioguide of identity.bioguides) {
        const seats = bundle.membershipsByBioguide.get(bioguide) ?? [];
        if (seats.some((seat) => seat.systemCode.toLowerCase() === code)) {
          committeeMember = true;
          break;
        }
      }
    }
    if (!billRelevant || !committeeMember) continue;

    strength = 'sourceAuthoritative';
    evidence.push({
      component: 'hearingTiming',
      sourceType: 'committee_hearing',
      label: hearing.title,
      sourceRecordId: hearing.hearingId,
      observedAt: hearing.startsAt,
      summary: `Hearing on tracked bill ${hearing.billId} before a committee this member sits on.`,
      refs: {
        hearingId: hearing.hearingId,
        billId: hearing.billId,
        committeeCode: hearing.committeeCode,
      },
    });
  }

  return {
    strength,
    evidenceCount: evidence.length,
    evidence,
    rationale:
      strength === 'absent'
        ? 'No hearing with both a client-tracked bill link and member committee participation.'
        : `Strategic hearing timing (${evidence.length}).`,
  };
}

export function buildOpportunityFundingComponent(
  opportunityDistrictKeys: ReadonlySet<string>,
  districtKey: string,
): StrategicComponentInput {
  const hasOpportunity = opportunityDistrictKeys.has(districtKey);
  return {
    strength: hasOpportunity ? 'partial' : 'absent',
    evidenceCount: hasOpportunity ? 1 : 0,
    evidence: hasOpportunity
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
    rationale: hasOpportunity
      ? 'Structured opportunity candidate present for this district.'
      : 'No structured opportunity candidate for this district.',
  };
}

export function buildDistrictStrategicComponents(
  bundle: StrategicBuilderBundle,
  districtKey: string,
  members: StrategicMemberRow[],
): {
  identity: DistrictMemberIdentity;
  components: Partial<Record<StrategicComponentKey, StrategicComponentInput>>;
} {
  const identity = buildDistrictMemberIdentity(bundle, districtKey, members);
  const committeeJurisdiction = buildCommitteeJurisdictionComponent(bundle, identity);
  const components: Partial<Record<StrategicComponentKey, StrategicComponentInput>> = {
    committeeJurisdiction,
    programElementBudget: buildProgramElementBudgetComponent(bundle, committeeJurisdiction),
    activeLegislation: buildActiveLegislationComponent(bundle, identity),
    activeStrategyTarget: buildActiveStrategyTargetComponent(bundle, identity),
    relationshipEngagement: buildRelationshipEngagementComponent(bundle, identity),
    hearingTiming: buildHearingTimingComponent(bundle, identity),
    opportunityFunding: buildOpportunityFundingComponent(
      bundle.opportunityDistrictKeys,
      districtKey,
    ),
  };
  return { identity, components };
}

interface BillSourceRow {
  id: string;
  title: string | null;
  status: string | null;
  sponsorBioguideId: string | null;
  latestActionDate: Date | null;
  peCodes: string[] | null;
}

interface MembershipSourceRow {
  bioguideId: string;
  systemCode: string;
  title: string | null;
  committee: {
    name: string;
    parentSystemCode: string | null;
    isCurrent: boolean | null;
  } | null;
}

export interface StrategicPostQueryAssemblyInput {
  bills: BillSourceRow[];
  cosponsors: Array<{ billId: string; bioguideId: string }>;
  billCommittees: Array<{ billId: string; committeeCode: string | null }>;
  memberships: MembershipSourceRow[];
  strategyRows: Array<{
    strategyId: string;
    strategyTitle: string;
    nodeId: string;
    nodeTitle: string;
    subject: string;
    targetRef: unknown;
  }>;
  targets: Array<{
    id: string;
    memberId: string;
    memberName: string | null;
    addedAt: Date;
  }>;
  reportTargets: Array<{
    id: string;
    memberPrincipal: string | null;
    officeKey: string;
    updatedAt: Date;
  }>;
  sharedMeetings: Array<{
    id: string;
    subject: string;
    startsAt: Date;
    attendees: Array<{
      contactId: string | null;
      name: string | null;
      email: string | null;
      metadata: unknown;
    }>;
  }>;
  outreach: Array<{
    id: string;
    title: string;
    sentAt: Date | null;
    metadata: unknown;
    recipients: unknown;
  }>;
  hearingBills: Array<{ hearingId: string; billId: string }>;
  hearings: Array<{
    id: string;
    title: string;
    committeeCode: string | null;
    startsAt: Date | null;
    date: Date | null;
  }>;
  allCurrentMembers: StrategicMemberRow[];
}

export interface StrategicPostQueryAssembly {
  trackedBills: StrategicTrackedBillLink[];
  membershipsByBioguide: Map<string, StrategicMembershipRow[]>;
  strategyTargets: StrategicStrategyTargetRow[];
  engagements: StrategicEngagementFact[];
  hearingLinks: StrategicHearingLink[];
  membersByDistrict: Map<string, StrategicMemberRow[]>;
}

export function assembleStrategicPostQuery(
  input: StrategicPostQueryAssemblyInput,
): StrategicPostQueryAssembly {
  const cosponsorsByBill = new Map<string, string[]>();
  for (const cosponsor of input.cosponsors) {
    const list = cosponsorsByBill.get(cosponsor.billId) ?? [];
    list.push(cosponsor.bioguideId);
    cosponsorsByBill.set(cosponsor.billId, list);
  }

  const committeesByBill = new Map<string, string[]>();
  for (const committee of input.billCommittees) {
    if (!committee.committeeCode) continue;
    const list = committeesByBill.get(committee.billId) ?? [];
    list.push(committee.committeeCode);
    committeesByBill.set(committee.billId, list);
  }

  const trackedBills = input.bills.map((bill) => ({
    billId: bill.id,
    title: bill.title,
    status: bill.status,
    sponsorBioguideId: bill.sponsorBioguideId,
    cosponsorBioguides: cosponsorsByBill.get(bill.id) ?? [],
    committeeCodes: committeesByBill.get(bill.id) ?? [],
    latestActionDate: bill.latestActionDate ? bill.latestActionDate.toISOString() : null,
    peCodes: bill.peCodes ?? [],
  }));

  const membershipsByBioguide = new Map<string, StrategicMembershipRow[]>();
  for (const membership of input.memberships) {
    if (membership.committee && membership.committee.isCurrent === false) continue;
    const row: StrategicMembershipRow = {
      bioguideId: membership.bioguideId,
      systemCode: membership.systemCode,
      committeeName: membership.committee?.name ?? membership.systemCode,
      parentSystemCode: membership.committee?.parentSystemCode ?? null,
      title: membership.title,
    };
    const list = membershipsByBioguide.get(membership.bioguideId) ?? [];
    list.push(row);
    membershipsByBioguide.set(membership.bioguideId, list);
  }

  const strategyTargets: StrategicStrategyTargetRow[] = [];
  for (const strategy of input.strategyRows) {
    const parsed = parseTargetRef(strategy.targetRef);
    if (!parsed.memberId && !parsed.systemCode) continue;
    strategyTargets.push({
      strategyId: strategy.strategyId,
      strategyTitle: strategy.strategyTitle,
      nodeId: strategy.nodeId,
      nodeTitle: strategy.nodeTitle,
      subject: strategy.subject,
      memberId: parsed.memberId,
      systemCode: parsed.systemCode,
    });
  }

  const engagements: StrategicEngagementFact[] = [];
  for (const target of input.targets) {
    engagements.push({
      kind: 'client_target',
      memberId: target.memberId,
      label: target.memberName ? `Target: ${target.memberName}` : `Target: ${target.memberId}`,
      sourceRecordId: target.id,
      observedAt: target.addedAt.toISOString(),
    });
  }
  for (const reportTarget of input.reportTargets) {
    if (!reportTarget.memberPrincipal?.trim()) continue;
    engagements.push({
      kind: 'report_target',
      memberId: reportTarget.memberPrincipal.trim(),
      label: `Engagement report office ${reportTarget.officeKey}`,
      sourceRecordId: reportTarget.id,
      observedAt: reportTarget.updatedAt.toISOString(),
    });
  }
  for (const meeting of input.sharedMeetings) {
    for (const attendee of meeting.attendees) {
      const metadata = (attendee.metadata ?? {}) as Record<string, unknown>;
      const memberId =
        typeof metadata.bioguideId === 'string'
          ? metadata.bioguideId
          : typeof metadata.memberId === 'string'
            ? metadata.memberId
            : null;
      if (!memberId) continue;
      engagements.push({
        kind: 'shared_meeting',
        memberId,
        label: 'Shared meeting with office',
        sourceRecordId: meeting.id,
        observedAt: meeting.startsAt.toISOString(),
      });
    }
  }
  for (const outreach of input.outreach) {
    const metadata = (outreach.metadata ?? {}) as Record<string, unknown>;
    const memberId =
      typeof metadata.bioguideId === 'string'
        ? metadata.bioguideId
        : typeof metadata.memberId === 'string'
          ? metadata.memberId
          : null;
    if (!memberId) continue;
    engagements.push({
      kind: 'outreach',
      memberId,
      label: outreach.title || 'Outreach to office',
      sourceRecordId: outreach.id,
      observedAt: outreach.sentAt ? outreach.sentAt.toISOString() : null,
    });
  }

  const hearingBillByHearing = new Map<string, string>();
  for (const hearingBill of input.hearingBills) {
    hearingBillByHearing.set(hearingBill.hearingId, hearingBill.billId);
  }
  const hearingLinks = input.hearings.map((hearing) => ({
    hearingId: hearing.id,
    title: hearing.title,
    committeeCode: hearing.committeeCode,
    startsAt: hearing.startsAt
      ? hearing.startsAt.toISOString()
      : hearing.date
        ? hearing.date.toISOString()
        : null,
    billId: hearingBillByHearing.get(hearing.id) ?? null,
  }));

  const membersByDistrict = new Map<string, StrategicMemberRow[]>();
  for (const member of input.allCurrentMembers) {
    for (const key of memberDistrictKeys(member)) {
      const list = membersByDistrict.get(key) ?? [];
      list.push(member);
      membersByDistrict.set(key, list);
    }
  }

  return {
    trackedBills,
    membershipsByBioguide,
    strategyTargets,
    engagements,
    hearingLinks,
    membersByDistrict,
  };
}
