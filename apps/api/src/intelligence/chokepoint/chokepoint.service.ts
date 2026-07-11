import { Injectable, NotFoundException } from '@nestjs/common';
import {
  isStateBillKey,
  computeStateDeadlineRisk,
  resolveCommittee,
  normalizeCommitteeName,
  matchesRole,
  billStatusRank,
  type CommitteeCandidate,
} from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RepresentationResolverService } from '../../clients/representation-resolver.service.js';
import { normalizeLegiscanChamber } from '../../ingestion/legiscan-normalize.js';
import { computeSurvivalHeuristic } from './survival-heuristic.js';
import type {
  ChokepointResult,
  ChokepointMember,
  ChokepointCommittee,
  RuleGateOutcome,
} from './chokepoint.types.js';

function chamberFromCongressBillId(billId: string): 'house' | 'senate' | null {
  const type = billId.split('-')[1] ?? '';
  if (/^h/.test(type)) return 'house';
  if (/^s/.test(type)) return 'senate';
  return null;
}

/**
 * Committee Chokepoint chain (Phase 1 M2.4, PD3) — "who actually controls
 * this bill's fate," both rails. No LLM, no network — every node is a real
 * join or explicitly `null`. Reuses `RepresentationResolverService` (M1.3)
 * for footprintOverlap (PD2/PD7 — one deterministic resolver everywhere a
 * representation claim is made) and `@capiro/shared`'s `resolveCommittee`
 * (M2.2, lifted from apps/api's own committee-crosswalk.ts in M4.3 so the
 * meriv2-evals gate can pin it) for the federal committee-name-to-systemCode
 * resolution.
 */
@Injectable()
export class ChokepointService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly representation: RepresentationResolverService,
  ) {}

  async forBill(
    billKey: string,
    footprint?: { tenantId: string; clientId: string },
  ): Promise<ChokepointResult> {
    return isStateBillKey(billKey)
      ? this.forStateBill(billKey, footprint)
      : this.forFederalBill(billKey, footprint);
  }

  // ── Federal ────────────────────────────────────────────────────────────

  private async forFederalBill(
    billId: string,
    footprint?: { tenantId: string; clientId: string },
  ): Promise<ChokepointResult> {
    const bill = await this.prisma.congressBill.findUnique({
      where: { id: billId },
      select: { id: true, status: true, sponsorBioguideId: true },
    });
    if (!bill) throw new NotFoundException(`Bill ${billId} not found`);

    const [referrals, candidates, ruleLink, cosponsors] = await Promise.all([
      this.prisma.congressBillCommittee.findMany({
        where: { billId },
        select: { committeeName: true, committeeCode: true, chamber: true },
      }),
      this.prisma.congressCommittee.findMany({
        where: { isCurrent: true },
        select: { systemCode: true, name: true, chamber: true, parentSystemCode: true },
      }),
      this.prisma.billRuleLink.findFirst({
        where: { targetBillId: billId },
        select: { ruleBillId: true },
      }),
      this.prisma.congressBillCosponsor.findMany({
        where: { billId, withdrawnDate: null },
        select: { bioguideId: true },
      }),
    ]);

    const resolvedReferrals = referrals
      .map((r) => resolveCommittee(r, candidates as CommitteeCandidate[]))
      .filter((r): r is CommitteeCandidate & { matchedBy: 'code' | 'name' } => !!r);
    // Prefer the most specific (a subcommittee) referral, matching PD3's
    // "which committee actually holds it right now" framing.
    const referred =
      resolvedReferrals.find((r) => r.parentSystemCode != null) ?? resolvedReferrals[0] ?? null;

    const billChamber = chamberFromCongressBillId(billId);
    let leadershipCommittee: CommitteeCandidate | null = null;
    if (billChamber) {
      const rulesMatches = candidates.filter(
        (c) => c.chamber === billChamber && normalizeCommitteeName(c.name).includes('rules'),
      );
      if (rulesMatches.length === 1) leadershipCommittee = rulesMatches[0]!;
    }

    const systemCodes = [referred?.systemCode, leadershipCommittee?.systemCode].filter(
      (s): s is string => !!s,
    );
    const memberships = systemCodes.length
      ? await this.prisma.congressCommitteeMembership.findMany({
          where: { systemCode: { in: systemCodes } },
          select: { systemCode: true, bioguideId: true, title: true },
        })
      : [];

    const referredMemberships = memberships.filter((m) => m.systemCode === referred?.systemCode);
    const chairBioguide = referredMemberships.find((m) =>
      matchesRole(m.title, 'chair'),
    )?.bioguideId;
    const viceChairBioguide = referredMemberships.find((m) =>
      matchesRole(m.title, 'viceChair'),
    )?.bioguideId;
    const rankingBioguide = referredMemberships.find((m) =>
      matchesRole(m.title, 'rankingMember'),
    )?.bioguideId;
    const leadershipBioguide = memberships.find(
      (m) => m.systemCode === leadershipCommittee?.systemCode && matchesRole(m.title, 'chair'),
    )?.bioguideId;

    const neededBioguides = [
      chairBioguide,
      viceChairBioguide,
      rankingBioguide,
      leadershipBioguide,
      bill.sponsorBioguideId,
    ].filter((b): b is string => !!b);
    const members = neededBioguides.length
      ? await this.prisma.congressMember.findMany({
          where: { bioguideId: { in: neededBioguides } },
          select: {
            bioguideId: true,
            fullName: true,
            chamber: true,
            party: true,
            state: true,
            district: true,
          },
        })
      : [];
    const memberById = new Map(members.map((m) => [m.bioguideId, m]));
    const toChokepointMember = (
      bioguideId: string | undefined,
      role?: string,
    ): ChokepointMember | null => {
      if (!bioguideId) return null;
      const m = memberById.get(bioguideId);
      if (!m) return null;
      return {
        id: m.bioguideId,
        name: m.fullName,
        chamber: m.chamber,
        party: m.party,
        role: role ?? null,
        state: m.state,
        district: m.district,
      };
    };

    const chair = toChokepointMember(chairBioguide, 'Chair');
    const viceChair = toChokepointMember(viceChairBioguide, 'Vice Chair');
    const rankingMember = toChokepointMember(rankingBioguide, 'Ranking Member');
    const chamberLeadership = toChokepointMember(leadershipBioguide, 'Chair');
    const sponsor = toChokepointMember(bill.sponsorBioguideId ?? undefined);

    // Majority-party derivation — a live count, never a curated/staleness-prone fact.
    let sponsorInMajorityOrLeadership: boolean | null = null;
    if (sponsor && billChamber) {
      const chamberMembers = await this.prisma.congressMember.findMany({
        where: { chamber: billChamber, isCurrent: true },
        select: { party: true },
      });
      const counts = new Map<string, number>();
      for (const m of chamberMembers)
        counts.set(m.party ?? 'unknown', (counts.get(m.party ?? 'unknown') ?? 0) + 1);
      const majorityParty = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      // Fetch the sponsor's committee titles and apply the SHARED role matcher
      // (W4.1) rather than a Prisma `title IN (...)` against a hardcoded set —
      // so "Chairwoman"/"Co-Chair" count as chairs here too.
      const sponsorMemberships = await this.prisma.congressCommitteeMembership.findMany({
        where: { bioguideId: sponsor.id },
        select: { title: true },
      });
      const holdsChairAnywhere = sponsorMemberships.some((m) => matchesRole(m.title, 'chair'));
      sponsorInMajorityOrLeadership = sponsor.party === majorityParty || holdsChairAnywhere;
    }

    const chairIsSponsorOrCosponsor = chair
      ? chair.id === sponsor?.id || cosponsors.some((c) => c.bioguideId === chair.id)
      : null;

    let rulesGate: RuleGateOutcome | null = null;
    if (ruleLink) {
      if (bill.status === 'rule_pending') rulesGate = 'pending';
      else if (bill.status === 'rule_failed') rulesGate = 'failed';
      else rulesGate = 'adopted';
    }

    const survival = computeSurvivalHeuristic({
      sponsorInMajorityOrLeadership,
      chairIsSponsorOrCosponsor,
      companionAdvancing: null, // federal has no companion-link table (PD3 — state only)
      committeeAdvancement: bill.status ? federalCommitteeAdvancement(bill.status) : null,
      daysToCutoff: null, // federal has no deadline-death concept (PD5)
      isPastCutoff: false,
      passedChamberOrLater: false,
    });

    const footprintOverlap = await this.computeFootprintOverlap(
      footprint,
      [chair, viceChair, rankingMember, chamberLeadership, sponsor].filter(
        (m): m is ChokepointMember => !!m,
      ),
      'federal',
    );

    return {
      billKey: billId,
      jurisdiction: 'federal',
      referredCommittee: referred ? toChokepointCommittee(referred) : null,
      chair,
      viceChair,
      rankingMember,
      rulesGate,
      chamberLeadership,
      sponsor,
      companionStatus: null,
      deadlineRisk: null,
      survivalScore: survival.score,
      survivalBand: survival.band,
      survivalConfidence: survival.confidence,
      footprintOverlap,
    };
  }

  // ── State ──────────────────────────────────────────────────────────────

  private async forStateBill(
    billKey: string,
    footprint?: { tenantId: string; clientId: string },
  ): Promise<ChokepointResult> {
    const bill = await this.prisma.stateBill.findUnique({
      where: { id: billKey },
      select: {
        id: true,
        state: true,
        sessionKey: true,
        chamber: true,
        status: true,
        currentCommitteeId: true,
      },
    });
    if (!bill) throw new NotFoundException(`Bill ${billKey} not found`);

    const [committee, sponsorRow, links, session] = await Promise.all([
      bill.currentCommitteeId
        ? this.prisma.stateCommittee.findUnique({ where: { id: bill.currentCommitteeId } })
        : Promise.resolve(null),
      this.prisma.stateBillSponsor.findFirst({
        where: { billKey, sponsorType: 'primary' },
        select: { legislatorId: true, name: true, party: true },
      }),
      this.prisma.stateBillLink.findMany({
        where: { billKey, linkType: 'same_as', relatedBillKey: { not: null } },
        select: { relatedBillKey: true },
      }),
      this.prisma.stateSession.findFirst({
        where: { state: bill.state, sessionKey: bill.sessionKey },
        select: {
          committeeCutoffDate: true,
          crossoverDate: true,
          secondCommitteeCutoffDate: true,
          sineDie: true,
        },
      }),
    ]);

    let chair: ChokepointMember | null = null;
    let viceChair: ChokepointMember | null = null;
    if (committee) {
      const roster = await this.prisma.stateCommitteeMembership.findMany({
        where: { committeeId: committee.id },
        select: {
          role: true,
          legislator: {
            select: { id: true, name: true, chamber: true, party: true, district: true },
          },
        },
      });
      const chairRow = roster.find((r) => matchesRole(r.role, 'chair'));
      const viceChairRow = roster.find((r) => matchesRole(r.role, 'viceChair'));
      chair = chairRow ? toStateChokepointMember(chairRow.legislator, bill.state, 'Chair') : null;
      viceChair = viceChairRow
        ? toStateChokepointMember(viceChairRow.legislator, bill.state, 'Vice Chair')
        : null;
    }

    let sponsor: ChokepointMember | null = null;
    if (sponsorRow) {
      if (sponsorRow.legislatorId) {
        const leg = await this.prisma.stateLegislator.findUnique({
          where: { id: sponsorRow.legislatorId },
          select: { id: true, name: true, chamber: true, party: true, district: true },
        });
        sponsor = leg ? toStateChokepointMember(leg, bill.state) : null;
      }
      if (!sponsor) {
        // Crosswalk unresolved — the sponsor's name/party still came from a
        // real row (state_bill_sponsor), just not joinable to a legislator id
        // yet, so footprint overlap for this member is skipped (no id), but
        // the fact itself isn't a guess.
        sponsor = { id: '', name: sponsorRow.name, chamber: null, party: sponsorRow.party };
      }
    }

    let chamberLeadership: ChokepointMember | null = null;
    {
      // W4.1: the bill's Rules/Calendar committee must be in the bill's OWN
      // chamber. StateBill.chamber is LegiScan's raw current_body/body string,
      // so normalize it to StateCommittee.chamber's 'upper'/'lower' vocabulary
      // with the SAME normalizeLegiscanChamber the ingestion uses. When it
      // can't be normalized (unicameral 'L', unknown code) we return null and
      // skip chamberLeadership rather than guess a chamber (PD2). Within the
      // chamber-filtered set the `length === 1` uniqueness check still guards
      // against >=2 same-named committees.
      const billChamberNorm = normalizeLegiscanChamber(bill.chamber);
      const leadershipCommittees = billChamberNorm
        ? await this.prisma.stateCommittee.findMany({
            where: {
              state: bill.state,
              chamber: billChamberNorm,
              OR: [
                { name: { contains: 'Rules', mode: 'insensitive' } },
                { name: { contains: 'Calendar', mode: 'insensitive' } },
              ],
            },
            select: { id: true },
          })
        : [];
      if (leadershipCommittees.length === 1) {
        const roster = await this.prisma.stateCommitteeMembership.findMany({
          where: {
            committeeId: leadershipCommittees[0]!.id,
            role: { equals: 'Chair', mode: 'insensitive' },
          },
          select: {
            legislator: {
              select: { id: true, name: true, chamber: true, party: true, district: true },
            },
          },
        });
        const l = roster[0]?.legislator;
        chamberLeadership = l ? toStateChokepointMember(l, bill.state, 'Chair') : null;
      }
    }

    let companionStatus = null as ChokepointResult['companionStatus'];
    let companionAdvancing: boolean | null = false;
    if (links.length) {
      const related = await this.prisma.stateBill.findFirst({
        where: { id: links[0]!.relatedBillKey! },
        select: { id: true, identifier: true, status: true },
      });
      if (related) {
        companionStatus = {
          relatedBillKey: related.id,
          relatedDisplay: related.identifier,
          status: related.status,
          linkType: 'same_as',
        };
        companionAdvancing = stateStatusAtLeastReported(related.status);
      }
    }

    const deadlineRisk = session
      ? computeStateDeadlineRisk({
          status: bill.status,
          session: {
            committeeCutoffDate: toDateOnly(session.committeeCutoffDate),
            crossoverDate: toDateOnly(session.crossoverDate),
            secondCommitteeCutoffDate: toDateOnly(session.secondCommitteeCutoffDate),
            sineDie: toDateOnly(session.sineDie),
          },
          today: toDateOnly(new Date())!,
        })
      : null;

    const committeeAdvancement = stateStatusAtLeastReported(bill.status);
    const passedChamberOrLater = stateStatusAtLeastPassedChamber(bill.status);

    // "Chair sponsors or cosponsors" — state ingestion only carries the
    // PRIMARY sponsor deterministically (state_bill_sponsor also has
    // sponsorType='cosponsor' rows, so check those too).
    let chairIsSponsorOrCosponsor: boolean | null = null;
    if (chair) {
      const chairSponsored = await this.prisma.stateBillSponsor.findFirst({
        where: { billKey, legislatorId: chair.id },
        select: { id: true },
      });
      chairIsSponsorOrCosponsor = !!chairSponsored;
    }

    const survival = computeSurvivalHeuristic({
      sponsorInMajorityOrLeadership: null, // state majority-party control isn't modeled yet (deferred, never guessed)
      chairIsSponsorOrCosponsor,
      companionAdvancing,
      committeeAdvancement,
      daysToCutoff: deadlineRisk?.daysUntil ?? null,
      isPastCutoff: deadlineRisk?.isPastCutoff ?? false,
      passedChamberOrLater,
    });

    const footprintOverlap = await this.computeFootprintOverlap(
      footprint,
      [chair, viceChair, chamberLeadership, sponsor].filter(
        (m): m is ChokepointMember => !!m && !!m.id,
      ),
      'state',
    );

    return {
      billKey,
      jurisdiction: 'state',
      referredCommittee: committee ? { id: committee.id, name: committee.name } : null,
      chair,
      viceChair,
      rankingMember: null, // state chambers don't share a minority-leadership title (survival-heuristic.ts's own note)
      rulesGate: null, // federal-only (no House-rule mechanic in state legislatures)
      chamberLeadership,
      sponsor,
      companionStatus,
      deadlineRisk,
      survivalScore: survival.score,
      survivalBand: survival.band,
      survivalConfidence: survival.confidence,
      footprintOverlap,
    };
  }

  // ── Shared ─────────────────────────────────────────────────────────────

  private async computeFootprintOverlap(
    footprint: { tenantId: string; clientId: string } | undefined,
    candidateMembers: ChokepointMember[],
    jurisdiction: 'federal' | 'state',
  ) {
    if (!footprint || !candidateMembers.length) return [];
    const out: ChokepointResult['footprintOverlap'] = [];
    for (const m of candidateMembers) {
      // No id (state sponsor crosswalk unresolved) or no state on record —
      // facilitiesForMember can't resolve without a state; skip, never guess.
      if (!m.id || !m.state) continue;
      const facilities =
        jurisdiction === 'federal'
          ? await this.representation.facilitiesForMember(footprint.tenantId, footprint.clientId, {
              type: 'federal',
              chamber: m.chamber ?? '',
              state: m.state,
              district: typeof m.district === 'number' ? m.district : null,
            })
          : await this.representation.facilitiesForMember(footprint.tenantId, footprint.clientId, {
              type: 'state',
              chamber: m.chamber ?? '',
              state: m.state,
              district: m.district != null ? String(m.district) : null,
            });
      for (const f of facilities) {
        out.push({
          memberId: m.id,
          memberName: m.name,
          memberRole: m.role ?? 'Member',
          facilityId: f.id,
          facilityName: f.name,
        });
      }
    }
    return out;
  }
}

function toChokepointCommittee(c: CommitteeCandidate): ChokepointCommittee {
  return { id: c.systemCode, name: c.name, isSubcommittee: c.parentSystemCode != null };
}

function toStateChokepointMember(
  leg: {
    id: string;
    name: string;
    chamber: string | null;
    party: string | null;
    district: string | null;
  },
  state: string,
  role?: string,
): ChokepointMember {
  return {
    id: leg.id,
    name: leg.name,
    chamber: leg.chamber,
    party: leg.party,
    role: role ?? null,
    state,
    district: leg.district,
  };
}

function toDateOnly(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/** rank >= 2 ('reported' or later) using the SAME threshold `computeStateDeadlineRisk` stages on. */
function stateStatusAtLeastReported(status: string | null): boolean {
  return [
    'reported',
    'floor',
    'passed_chamber',
    'resolving',
    'to_governor',
    'enacted',
    'vetoed',
    'veto_overridden',
    'failed',
  ].includes(status ?? '');
}
/** rank >= 4 ('passed_chamber' or later). */
function stateStatusAtLeastPassedChamber(status: string | null): boolean {
  return [
    'passed_chamber',
    'resolving',
    'to_governor',
    'enacted',
    'vetoed',
    'veto_overridden',
    'failed',
  ].includes(status ?? '');
}

/**
 * Federal committee-advancement proxy: has the bill reached 'reported' or later?
 * W4.1: compares against the SHARED `billStatusRank` table (deriveBillStatus's
 * own rank knowledge) instead of a hardcoded status-string set that silently
 * rots when a new pre-'reported' status is added to the vocabulary.
 */
function federalCommitteeAdvancement(status: string): boolean {
  return billStatusRank(status) >= billStatusRank('reported');
}
