import type { PrismaService } from '../prisma/prisma.service.js';
import { FEC_DISCLAIMER } from './fec-disclaimer.js';
import { fecCycles } from './fec-cycles.js';
import { pacCoverage } from './fec-pac-coverage.js';
import type {
  ClientPacGiving,
  ClientFinancialMoneyFlowPorts,
  ClientMoneyFlowRow,
  ClientMoneyFlowMemberRow,
  ClientMoneyFlowBillRow,
  ClientMoneyFlowMember,
  ClientMoneyFlowBill,
  ClientMoneyFlowCommittee,
  ClientMoneyFlowCommitteeWithBills,
} from './client-financial-v1.types.js';

/** Employer-linked individual contributions, candidate sponsors and associated bills. */
export class ClientFinancialV1MoneyFlow {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ClientFinancialMoneyFlowPorts,
  ) {}

  async getFecMoneyFlow(clientId: string, tenantId: string) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true, name: true } }),
    );
    if (!client) return this.missingClientFlow(clientId);
    const pacGiving = await this.ports.getPacGiving(clientId, tenantId);
    const fecMappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, source: 'fec_employer', confirmed: true },
        orderBy: { confidence: 'desc' },
      }),
    );
    const employers = Array.from(
      new Set(
        fecMappings
          .map((m) => m.externalName?.trim())
          .filter((e): e is string => Boolean(e && e.length > 0)),
      ),
    );
    const employersLower = employers.map((e) => e.toLowerCase());
    if (!employers.length) return this.unmappedEmployerFlow(clientId, client, pacGiving);
    const windowStart = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000);
    const flowRows = await this.readContributions(employersLower, windowStart);
    const candidateNames = Array.from(
      new Set(flowRows.map((r) => r.candidate_name).filter((v): v is string => Boolean(v))),
    );
    const candidateNamesLower = candidateNames.map((n) => n.toLowerCase());
    const memberRows = candidateNames.length ? await this.readSponsorMembers(candidateNames) : [];
    const sponsoredBillRows = candidateNamesLower.length
      ? await this.readSponsoredBills(candidateNamesLower)
      : [];
    const memberByCandidate = this.membersByCandidate(memberRows);
    const billsBySponsor = this.billsBySponsor(sponsoredBillRows);
    const committees = this.groupCommittees(flowRows, memberByCandidate, billsBySponsor);
    return this.flowResult(clientId, client, employers, committees, pacGiving);
  }

  private missingClientFlow(clientId: string) {
    return {
      clientId,
      clientName: null,
      mappedEmployer: null,
      summary: {
        totalContributions: 0,
        totalAmount: 0,
        committeeCount: 0,
        candidateCount: 0,
        memberCount: 0,
        billCount: 0,
      },
      contributionType: 'individual_employer_linked' as const,
      committees: [],
      pacGiving: {
        tracked: false as const,
        committees: [] as never[],
        summary: { totalAmount: 0, disbursementCount: 0, recipientCount: 0 },
        coverage: pacCoverage([], fecCycles(), [], false),
      },
      disclaimer: FEC_DISCLAIMER,
    };
  }

  private unmappedEmployerFlow(
    clientId: string,
    client: { name: string },
    pacGiving: ClientPacGiving,
  ) {
    return {
      clientId,
      clientName: client.name,
      mappedEmployer: null,
      summary: {
        totalContributions: 0,
        totalAmount: 0,
        committeeCount: 0,
        candidateCount: 0,
        memberCount: 0,
        billCount: 0,
      },
      contributionType: 'individual_employer_linked' as const,
      committees: [],
      pacGiving,
      disclaimer: FEC_DISCLAIMER,
    };
  }

  private readContributions(employersLower: string[], windowStart: Date) {
    return this.prisma.$queryRaw<ClientMoneyFlowRow[]>`
      SELECT
        fc.committee_id,
        MAX(fc.committee_name) AS committee_name,
        fc.candidate_id,
        fc.candidate_name,
        COUNT(*)::int AS contribution_count,
        COALESCE(SUM(fc.amount), 0)::float AS total_amount,
        MAX(fc.contribution_date) AS latest_contribution_date
      FROM fec_contribution fc
      WHERE LOWER(fc.contributor_employer) = ANY(${employersLower}::text[])
        AND fc.contribution_date >= ${windowStart}
      GROUP BY fc.committee_id, fc.candidate_id, fc.candidate_name
      ORDER BY total_amount DESC
      LIMIT 250
    `;
  }

  private readSponsorMembers(candidateNames: string[]) {
    return this.prisma.$queryRaw<ClientMoneyFlowMemberRow[]>`
          SELECT
            x.candidate_name,
            cb.sponsor_name AS member_name,
            COUNT(DISTINCT cb.id)::int AS bill_count
          FROM (
            SELECT UNNEST(${candidateNames}::text[]) AS candidate_name
          ) x
          JOIN congress_bill cb
            ON LOWER(cb.sponsor_name) = LOWER(x.candidate_name)
          GROUP BY x.candidate_name, cb.sponsor_name
        `;
  }

  private readSponsoredBills(candidateNamesLower: string[]) {
    return this.prisma.$queryRaw<ClientMoneyFlowBillRow[]>`
          SELECT cb.sponsor_name, cb.id AS bill_id, cb.title AS bill_title
          FROM congress_bill cb
          WHERE LOWER(cb.sponsor_name) = ANY(${candidateNamesLower}::text[])
          ORDER BY cb.latest_action_date DESC NULLS LAST
          LIMIT 500
        `;
  }

  private membersByCandidate(memberRows: ClientMoneyFlowMemberRow[]) {
    const memberByCandidate = new Map<string, ClientMoneyFlowMember[]>();
    for (const r of memberRows) {
      const key = r.candidate_name.toLowerCase();
      const arr = memberByCandidate.get(key) ?? [];
      arr.push({ memberName: r.member_name, billCount: r.bill_count });
      memberByCandidate.set(key, arr);
    }
    return memberByCandidate;
  }

  private billsBySponsor(sponsoredBillRows: ClientMoneyFlowBillRow[]) {
    const billsBySponsor = new Map<string, ClientMoneyFlowBill[]>();
    for (const r of sponsoredBillRows) {
      const key = (r.sponsor_name ?? '').toLowerCase();
      if (!key) continue;
      const arr = billsBySponsor.get(key) ?? [];
      arr.push({ billId: r.bill_id, billTitle: r.bill_title, sponsorName: r.sponsor_name });
      billsBySponsor.set(key, arr);
    }
    return billsBySponsor;
  }

  private groupCommittees(
    flowRows: ClientMoneyFlowRow[],
    memberByCandidate: Map<string, ClientMoneyFlowMember[]>,
    billsBySponsor: Map<string, ClientMoneyFlowBill[]>,
  ) {
    const grouped = new Map<string, ClientMoneyFlowCommittee>();
    for (const row of flowRows) {
      const committeeName = row.committee_name ?? row.committee_id;
      const candidateName = row.candidate_name ?? 'Unknown candidate';
      if (!grouped.has(row.committee_id)) {
        grouped.set(row.committee_id, {
          committeeId: row.committee_id,
          committeeName,
          totalAmount: 0,
          contributionCount: 0,
          latestContributionDate: row.latest_contribution_date,
          candidates: [],
        });
      }

      const g = grouped.get(row.committee_id)!;
      g.totalAmount += row.total_amount;
      g.contributionCount += row.contribution_count;
      if (
        row.latest_contribution_date &&
        (!g.latestContributionDate || row.latest_contribution_date > g.latestContributionDate)
      ) {
        g.latestContributionDate = row.latest_contribution_date;
      }

      g.candidates.push({
        candidateId: row.candidate_id,
        candidateName,
        totalAmount: row.total_amount,
        contributionCount: row.contribution_count,
        linkedMembers: memberByCandidate.get(candidateName.toLowerCase()) ?? [],
      });
    }
    const committees = Array.from(grouped.values())
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .map((g) => {
        // A committee's associated bills = the bills sponsored by the candidates
        // it funded (deduped across this committee's candidates).
        const billsForCommittee = new Map<string, ClientMoneyFlowBill>();
        for (const cand of g.candidates) {
          for (const b of billsBySponsor.get(cand.candidateName.toLowerCase()) ?? []) {
            billsForCommittee.set(b.billId, b);
          }
        }
        return {
          ...g,
          candidates: g.candidates.sort((a, b) => b.totalAmount - a.totalAmount),
          bills: Array.from(billsForCommittee.values()).slice(0, 15),
        };
      });
    return committees;
  }

  private flowResult(
    clientId: string,
    client: { name: string },
    employers: string[],
    committees: ClientMoneyFlowCommitteeWithBills[],
    pacGiving: ClientPacGiving,
  ) {
    const uniqueCandidates = new Set<string>();
    const uniqueMembers = new Set<string>();
    const uniqueBills = new Set<string>();
    for (const c of committees) {
      for (const cand of c.candidates) {
        uniqueCandidates.add(cand.candidateName.toLowerCase());
        for (const m of cand.linkedMembers) uniqueMembers.add(m.memberName.toLowerCase());
      }
      for (const b of c.bills) uniqueBills.add(b.billId);
    }
    const totalAmount = committees.reduce((sum, c) => sum + c.totalAmount, 0);
    const totalContributions = committees.reduce((sum, c) => sum + c.contributionCount, 0);
    return {
      clientId,
      clientName: client.name,
      mappedEmployer: employers.join(', '),
      // Everything in `committees` is Schedule A (received-by-committee) data keyed by
      // contributor EMPLOYER — i.e. individual filers who list this employer. It is
      // legally distinct from the organization's / its PAC's own giving.
      contributionType: 'individual_employer_linked' as const,
      summary: {
        totalContributions,
        totalAmount,
        committeeCount: committees.length,
        candidateCount: uniqueCandidates.size,
        memberCount: uniqueMembers.size,
        billCount: uniqueBills.size,
      },
      committees,
      // The client's OWN PAC giving (Schedule B committee → candidate disbursements),
      // ingested for committees mapped via confirmed ClientIntelMapping(fec_committee).
      // Kept strictly separate from the individual employer-linked data above.
      pacGiving,
      disclaimer: FEC_DISCLAIMER,
    };
  }
}
