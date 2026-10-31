import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { DirectoryService } from '../directory/directory.service.js';

/**
 * Office Recommender (v2) — replaces the legacy sponsor/FEC/ex-staffer scorer.
 *
 * Ranks congressional offices for a client by combining three honest, available
 * signals, each tied to a transparent tag:
 *
 *   • committee — the member sits on a committee with jurisdiction over one or
 *     more of the client's tracked bills. Highest-leverage signal: that
 *     committee controls whether those bills advance.
 *   • issue     — the member's stated focus areas / committee subject overlap the
 *     client's tracked-bill subjects and LDA issue-area names.
 *   • district  — constituent nexus: the client has a facility in the state the
 *     member represents (Senate) or the exact district the member holds (House).
 *     This is the meaningful "location proximity" for lobbying — a member whose
 *     constituents include the client's jobs/sites has a real stake — rather than
 *     raw lat/long distance (members have no geocoordinates and physical distance
 *     is not the relevant signal).
 *   • leadership — small tie-breaker when the member holds a leadership post.
 *
 * Score is a 0–1 relative priority WITHIN this client (not a probability).
 * Pure read path: cached S3 directory + Postgres committee/subject joins. No ML,
 * no embeddings, no mutation. Returns member-identified rows so the same result
 * powers both the Intelligence → Relationships panel and the Targets tab sidebar.
 */

export interface OfficeRecommendation {
  /** Directory member id (DirectoryContact.id / bioguide) — stable target key. */
  memberId: string;
  /** Full display name, e.g. "Sen. Cornyn, John". */
  office: string;
  party: 'R' | 'D' | 'I' | null;
  /** 2-letter state, House adds district e.g. "TX" / "NH-1". */
  state: string | null;
  chamber: 'House' | 'Senate' | null;
  committee: string | null;
  /** 0–1 relative priority within this client. */
  score: number;
  /** Transparent signal tags (committee | issue | district | leadership). */
  tags: string[];
  /** Count of the client's tracked bills this office has jurisdiction over. */
  billCount: number;
}

interface TrackedBillLite {
  identifier: string;
  subjectNames: string[];
}

interface RecommenderInput {
  clientId: string;
  tenantId: string;
  trackedBillIds: string[];
  trackedBills: TrackedBillLite[];
  /** LDA issue-area codes (e.g. "DEF"); resolved to readable names internally. */
  issueCodes: string[];
}

const MAX_RESULTS = 12;

/** Bare/zero-padded numeric districts and same-state directory prefixes share one key. */
function houseDistrictKey(state: string, raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toUpperCase();
  const match = /^(?:([A-Z]{2})-)?(\d{1,2})$/.exec(value);
  if (!match || (match[1] && match[1] !== state)) return null;
  return `${state}-${Number(match[2])}`;
}

@Injectable()
export class OfficeRecommenderService {
  private readonly logger = new Logger(OfficeRecommenderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly directory: DirectoryService,
  ) {}

  private norm(value: string | null | undefined): string {
    return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /** Last name from a "Sen. Cornyn, John" / "Cornyn, John" display name. */
  private lastName(name: string): string {
    const head = name.includes(', ') ? name.split(', ')[0]! : name;
    return (head.split(' ').pop() ?? head).toLowerCase();
  }

  /**
   * Rank offices for a client. Returns up to 12 member-identified rows sorted by
   * descending score. Never throws — on any data failure it logs and returns
   * whatever partial ranking it could compute (possibly empty).
   */
  async recommend(input: RecommenderInput): Promise<OfficeRecommendation[]> {
    const { clientId, tenantId, trackedBillIds } = input;

    // ── 1. Committees of jurisdiction over the client's tracked bills, with a
    //        per-committee tracked-bill count. Same join the hearings scope uses.
    const committeeBillCount = new Map<string, number>();
    if (trackedBillIds.length > 0) {
      try {
        const rows = await this.prisma.$queryRaw<
          Array<{ committee_name: string; bill_count: number }>
        >`
          SELECT cbc.committee_name, COUNT(DISTINCT cbc.bill_id)::int AS bill_count
          FROM congress_bill_committee cbc
          WHERE cbc.bill_id = ANY(${trackedBillIds}::text[])
            AND cbc.committee_name IS NOT NULL
            AND cbc.committee_name <> ''
          GROUP BY cbc.committee_name
        `;
        for (const row of rows) {
          const key = this.norm(row.committee_name);
          if (key) committeeBillCount.set(key, Number(row.bill_count));
        }
      } catch (err) {
        this.logger.warn(
          `office-recommender committee join failed for client ${clientId}: ${(err as Error).message}`,
        );
      }
    }
    const maxCommitteeBills = Math.max(0, ...committeeBillCount.values());

    // ── 2. Issue vocabulary: tracked-bill subjects + LDA issue-area names.
    //        Used for a softer "issue" overlap against member focus areas.
    const issueTerms = new Set<string>();
    if (input.issueCodes.length > 0) {
      try {
        const nameRows = await this.prisma.$queryRaw<Array<{ name: string }>>`
          SELECT name FROM lda_issue_code WHERE code = ANY(${input.issueCodes}::text[])
        `;
        for (const row of nameRows) {
          const n = this.norm(row.name);
          if (n.length >= 4) issueTerms.add(n);
        }
      } catch (err) {
        this.logger.warn(
          `office-recommender issue-name resolve failed for client ${clientId}: ${(err as Error).message}`,
        );
      }
    }
    for (const bill of input.trackedBills) {
      for (const subject of bill.subjectNames ?? []) {
        const n = this.norm(subject);
        if (n.length >= 4) issueTerms.add(n);
      }
    }

    // ── 3. Client facility geography: states (Senate nexus) + ST-district
    //        (House nexus). Tenant-scoped read.
    const facilityStates = new Set<string>();
    const facilityDistricts = new Set<string>();
    try {
      const facilities = await this.prisma.withTenant(tenantId, (tx) =>
        tx.clientFacility.findMany({
          where: { clientId },
          select: { state: true, congressionalDistrict: true },
        }),
      );
      for (const f of facilities) {
        const st = (f.state ?? '').toUpperCase().trim();
        if (st) {
          facilityStates.add(st);
          const district = houseDistrictKey(st, f.congressionalDistrict);
          if (district) facilityDistricts.add(district);
        }
      }
    } catch (err) {
      this.logger.warn(
        `office-recommender facility read failed for client ${clientId}: ${(err as Error).message}`,
      );
    }

    // ── 4. Score every directory member.
    let members;
    try {
      members = await this.directory.getAllContacts();
    } catch (err) {
      this.logger.warn(
        `office-recommender directory load failed for client ${clientId}: ${(err as Error).message}`,
      );
      return [];
    }

    const scored: OfficeRecommendation[] = [];
    for (const m of members) {
      // Only sitting House/Senate offices are actionable targets.
      if (m.chamber !== 'House' && m.chamber !== 'Senate') continue;

      const memberCommittees = (m.committees ?? []).map((c) => this.norm(c));
      const memberFocus = (m.focusAreas ?? []).map((f) => this.norm(f));

      // committee signal: does this member sit on a committee of jurisdiction?
      let committeeBills = 0;
      let jurisdictionCommittee: string | null = null;
      for (const mc of memberCommittees) {
        for (const [jc, count] of committeeBillCount) {
          // Substring either direction handles "Committee on Armed Services"
          // vs "House Committee on Armed Services" / "Armed Services Committee".
          if (mc && (mc.includes(jc) || jc.includes(mc))) {
            if (count > committeeBills) {
              committeeBills = count;
              jurisdictionCommittee = jc;
            }
          }
        }
      }
      const committeeWeight =
        committeeBills > 0 && maxCommitteeBills > 0 ? committeeBills / maxCommitteeBills : 0;

      // issue signal: focus-area / committee text overlaps client issue vocab.
      let issueHit = false;
      if (issueTerms.size > 0) {
        const haystack = [...memberFocus, ...memberCommittees];
        issueHit = haystack.some((h) =>
          [...issueTerms].some((t) => h.includes(t) || t.includes(h)),
        );
      }

      // district signal: constituent nexus to a client facility.
      const st = (m.state ?? '').toUpperCase().trim();
      let districtHit = false;
      if (st) {
        if (m.chamber === 'Senate') {
          districtHit = facilityStates.has(st);
        } else {
          // A state proves Senate constituency, not which House office represents a facility.
          const key = houseDistrictKey(st, m.district);
          districtHit = key !== null && facilityDistricts.has(key);
        }
      }

      const leadershipHit = (m.leadershipPositions ?? []).length > 0;

      // Require at least one substantive signal (committee/issue/district) — a
      // bare leadership tie-breaker alone is not a recommendation.
      if (committeeWeight === 0 && !issueHit && !districtHit) continue;

      // Weighted blend. Committee jurisdiction dominates; geography and issue
      // overlap layer in; leadership only nudges. Clamped to [0,1].
      const score = Math.min(
        1,
        0.3 +
          committeeWeight * 0.4 +
          (districtHit ? 0.18 : 0) +
          (issueHit ? 0.1 : 0) +
          (leadershipHit ? 0.05 : 0),
      );

      const tags = [
        { key: 'committee', on: committeeWeight > 0 },
        { key: 'district', on: districtHit },
        { key: 'issue', on: issueHit },
        { key: 'leadership', on: leadershipHit },
      ]
        .filter((t) => t.on)
        .map((t) => t.key);

      const stateDisplay =
        m.chamber === 'House' && m.district
          ? m.district.includes('-')
            ? m.district
            : `${st}-${m.district}`
          : st || null;

      scored.push({
        memberId: m.id,
        office: m.fullName,
        party: m.party,
        state: stateDisplay,
        chamber: m.chamber,
        committee: jurisdictionCommittee
          ? ((m.committees ?? []).find((c) => this.norm(c) === jurisdictionCommittee) ??
            m.committees?.[0] ??
            null)
          : (m.committees?.[0] ?? null),
        score,
        tags,
        billCount: committeeBills,
      });
    }

    scored.sort((a, b) => b.score - a.score || b.billCount - a.billCount);
    return scored.slice(0, MAX_RESULTS);
  }
}
