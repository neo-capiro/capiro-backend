/**
 * Committee Chokepoint (Phase 1 M2.4, PD3) — the deterministic "who actually
 * controls this bill's fate" map, both rails. Every node is either resolved
 * from a real join or explicitly `null` — never a fuzzy guess (PD2's
 * standard, applied here to committees/leadership instead of districts).
 * `appropriationsDependency` (parent §4 M2) is deferred past v1 — omitted
 * from this type entirely rather than a permanently-null field.
 */
export interface ChokepointMember {
  /** bioguideId (federal) or state_legislator.id (state) — the id `RepresentationResolverService.facilitiesForMember` needs for footprint overlap. */
  id: string;
  name: string;
  chamber: string | null;
  party: string | null;
  /** Committee role when this member is being described AS a committee officer (Chair/Vice Chair/Ranking Member/OpenStates role string). */
  role?: string | null;
  /** state + district carried ONLY for footprintOverlap's facilitiesForMember join — not meant for display. Federal district is a bare number (null = at-large); state district is OpenStates' raw string. */
  state?: string | null;
  district?: number | string | null;
}

export interface ChokepointCommittee {
  id: string;
  name: string;
  /** true for a federal subcommittee (has a parentSystemCode) — the more specific referral, when one exists. */
  isSubcommittee?: boolean;
}

export type RuleGateOutcome = 'pending' | 'adopted' | 'failed';

export interface CompanionStatus {
  relatedBillKey: string;
  relatedDisplay: string | null;
  status: string | null;
  linkType: string;
}

export interface FootprintOverlapEntry {
  memberId: string;
  memberName: string;
  memberRole: string;
  facilityId: string;
  facilityName: string;
}

export interface ChokepointResult {
  billKey: string;
  jurisdiction: 'federal' | 'state';
  referredCommittee: ChokepointCommittee | null;
  chair: ChokepointMember | null;
  viceChair: ChokepointMember | null;
  rankingMember: ChokepointMember | null;
  /** Federal only (a governing House rule) — null for state or when no rule was referred. */
  rulesGate: RuleGateOutcome | null;
  /** Best-effort: the bill's chamber's Rules/Calendars-named committee's chair. Omitted (null), never guessed, when not deterministically resolvable. */
  chamberLeadership: ChokepointMember | null;
  sponsor: ChokepointMember | null;
  /** State only (PD3) — federal has no companion-link table. */
  companionStatus: CompanionStatus | null;
  /** State only (PD5) — federal has no deadline-death concept. */
  deadlineRisk: import('@capiro/shared').StateDeadlineRisk | null;
  survivalScore: number | null;
  survivalBand: 'stalled' | 'at-risk' | 'likely-advances' | null;
  survivalConfidence: 'normal' | 'low' | null;
  /** Only populated when a client footprint is supplied (M1.3's RepresentationResolverService) — otherwise always []. */
  footprintOverlap: FootprintOverlapEntry[];
}
