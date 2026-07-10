import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RepresentationResolverService } from '../clients/representation-resolver.service.js';

/**
 * Deterministic validator gate (Phase 1 M5.0, agentic doc §5.4's emit-path
 * contract, scoped to the M5.2 targeting-brief checklist named in the parent
 * plan): "every named member resolves via RepresentationResolverService/
 * get_committee_roster (M1/M2), every role claim matches
 * congress_committee_membership/state_committee_membership, every district
 * claim matches a geocoded facility." Runs as CODE, never an LLM judgment —
 * a claim that fails ANY check is dropped and logged; the underlying
 * deterministic alert/record this brief attaches to is NEVER blocked
 * (fail-open in both directions, per the doc).
 *
 * A federal member is looked up by bioguideId (congress_member); a state
 * member by their OpenStates person id (state_legislator) — the SAME two
 * id namespaces `get_committee_roster`/`get_representation` already use, so
 * a targeting brief can never assert an identity those tools wouldn't also
 * recognize.
 */
export interface TargetingMemberClaim {
  jurisdiction: 'federal' | 'state';
  /** bioguideId (federal) or state_legislator.id (state), as asserted by the model. */
  memberId: string;
  memberName: string;
  /** e.g. "Chair", "Ranking Member" — omit when the brief makes no role claim. */
  claimedRole?: string | null;
  /** A client facility id the brief claims this member represents — omit when no district claim is made. */
  claimedDistrictFacilityId?: string | null;
}

export type TargetingDropReason =
  | 'member_not_found'
  | 'role_not_confirmed'
  | 'district_not_confirmed'
  | 'facility_not_found';

export interface TargetingDroppedClaim {
  claim: TargetingMemberClaim;
  reason: TargetingDropReason;
}

export interface TargetingValidationResult {
  valid: TargetingMemberClaim[];
  dropped: TargetingDroppedClaim[];
}

const FEDERAL_ROLE_TITLE_ALIASES: Record<string, string[]> = {
  chair: ['Chair', 'Chairman'],
  chairman: ['Chair', 'Chairman'],
  'vice chair': ['Vice Chair', 'Vice Chairman'],
  'ranking member': ['Ranking Member'],
};

@Injectable()
export class TargetingValidatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly representation: RepresentationResolverService,
  ) {}

  /**
   * Validate every member claim in one targeting brief. `tenantId`/`clientId`
   * scope the district check to THIS caller's own client facilities (never a
   * cross-tenant lookup) — matching the "client/tenant references resolve
   * under the caller's scope" line of the §5.4 checklist.
   */
  async validateMemberClaims(
    tenantId: string,
    clientId: string,
    claims: TargetingMemberClaim[],
  ): Promise<TargetingValidationResult> {
    const valid: TargetingMemberClaim[] = [];
    const dropped: TargetingDroppedClaim[] = [];

    // District checks all read the SAME resolved footprint (one query, not
    // one per claim) — representationForClient is already the tenant-scoped,
    // RLS-correct read.
    const footprint = await this.representation.representationForClient(tenantId, clientId);

    for (const claim of claims) {
      const memberExists =
        claim.jurisdiction === 'federal'
          ? await this.federalMemberExists(claim.memberId)
          : await this.stateMemberExists(claim.memberId);
      if (!memberExists) {
        dropped.push({ claim, reason: 'member_not_found' });
        continue;
      }

      if (claim.claimedRole) {
        const roleConfirmed =
          claim.jurisdiction === 'federal'
            ? await this.federalRoleConfirmed(claim.memberId, claim.claimedRole)
            : await this.stateRoleConfirmed(claim.memberId, claim.claimedRole);
        if (!roleConfirmed) {
          dropped.push({ claim, reason: 'role_not_confirmed' });
          continue;
        }
      }

      if (claim.claimedDistrictFacilityId) {
        const districtOutcome = this.districtConfirmed(
          footprint,
          claim.claimedDistrictFacilityId,
          claim,
        );
        if (districtOutcome !== null) {
          dropped.push({ claim, reason: districtOutcome });
          continue;
        }
      }

      valid.push(claim);
    }

    return { valid, dropped };
  }

  private async federalMemberExists(bioguideId: string): Promise<boolean> {
    const m = await this.prisma.congressMember.findUnique({
      where: { bioguideId },
      select: { bioguideId: true },
    });
    return !!m;
  }

  private async stateMemberExists(legislatorId: string): Promise<boolean> {
    const m = await this.prisma.stateLegislator.findUnique({
      where: { id: legislatorId },
      select: { id: true },
    });
    return !!m;
  }

  /** Matches congress_committee_membership.title, normalizing common aliases (Chair/Chairman, etc.) — never a fuzzy/partial match. */
  private async federalRoleConfirmed(bioguideId: string, claimedRole: string): Promise<boolean> {
    const aliases = FEDERAL_ROLE_TITLE_ALIASES[claimedRole.trim().toLowerCase()] ?? [claimedRole];
    const row = await this.prisma.congressCommitteeMembership.findFirst({
      where: { bioguideId, title: { in: aliases } },
      select: { id: true },
    });
    return !!row;
  }

  /** Matches state_committee_membership.role case-insensitively (state chambers have no shared role vocabulary to alias). */
  private async stateRoleConfirmed(legislatorId: string, claimedRole: string): Promise<boolean> {
    const row = await this.prisma.stateCommitteeMembership.findFirst({
      where: { legislatorId, role: { equals: claimedRole, mode: 'insensitive' } },
      select: { id: true },
    });
    return !!row;
  }

  /**
   * Confirm the claimed member is among the REAL resolved representatives for
   * the claimed facility (the SAME District Impact Engine join
   * get_representation exposes) — never a district-number string match,
   * which is exactly the class of error PD2 exists to rule out.
   */
  private districtConfirmed(
    footprint: Awaited<ReturnType<RepresentationResolverService['representationForClient']>>,
    facilityId: string,
    claim: TargetingMemberClaim,
  ): TargetingDropReason | null {
    const entry = footprint.find((f) => f.facility.id === facilityId);
    if (!entry) return 'facility_not_found';
    const rep = entry.representation;
    if (rep.unresolved) return 'district_not_confirmed';
    const ids =
      claim.jurisdiction === 'federal'
        ? [rep.federal.house?.bioguideId, ...rep.federal.senate.map((s) => s.bioguideId)]
        : [rep.state.lower?.id, rep.state.upper?.id];
    return ids.includes(claim.memberId) ? null : 'district_not_confirmed';
  }
}
