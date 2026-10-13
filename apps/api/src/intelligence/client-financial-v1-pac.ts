import type { PrismaService } from '../prisma/prisma.service.js';
import { fecCycles } from './fec-cycles.js';
import { pacCoverage } from './fec-pac-coverage.js';
import type {
  ClientPacGiving,
  ClientPacCommittee,
  ClientPacGivingRow,
} from './client-financial-v1.types.js';

/** The client's mapped committees and their own Schedule B disbursements. */
export class ClientFinancialV1Pac {
  constructor(private readonly prisma: PrismaService) {}

  async getPacGiving(clientId: string, tenantId: string): Promise<ClientPacGiving> {
    const cycles = fecCycles();

    const committeeMappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, source: 'fec_committee', confirmed: true },
        select: { externalId: true },
      }),
    );

    const committeeIds = Array.from(
      new Set(committeeMappings.map((m) => m.externalId.trim()).filter(Boolean)),
    );

    if (committeeIds.length === 0) {
      return {
        tracked: false,
        coverage: pacCoverage([], cycles, [], false),
        committees: [],
        summary: { totalAmount: 0, disbursementCount: 0, recipientCount: 0 },
      };
    }

    const [catalog, syncStates] = await Promise.all([
      this.prisma.fecCommittee.findMany({
        where: { id: { in: committeeIds } },
        select: { id: true, name: true },
      }),
      this.prisma.fecPacSyncState.findMany({
        where: { committeeId: { in: committeeIds }, cycle: { in: cycles } },
        select: { committeeId: true, cycle: true, status: true, completedAt: true },
      }),
    ]);

    const names = new Map(catalog.map((committee) => [committee.id, committee.name]));

    const rows = await this.prisma.$queryRaw<ClientPacGivingRow[]>`
      SELECT
        committee_id,
        MAX(committee_name) AS committee_name,
        recipient_name,
        MAX(candidate_name) AS candidate_name,
        COALESCE(SUM(amount), 0)::float AS total_amount,
        COUNT(*)::int AS disbursement_count
      FROM fec_pac_contribution
      WHERE committee_id = ANY(${committeeIds}::text[])
        AND cycle = ANY(${cycles}::int[])
      GROUP BY committee_id, recipient_name
      ORDER BY total_amount DESC
    `;
    const committees = this.groupCommittees(committeeIds, names, rows);
    return {
      tracked: true,
      coverage: pacCoverage(committeeIds, cycles, syncStates, rows.length > 0),
      committees,
      summary: {
        totalAmount: committees.reduce((s, c) => s + c.totalAmount, 0),
        disbursementCount: committees.reduce((s, c) => s + c.disbursementCount, 0),
        recipientCount: committees.reduce((s, c) => s + c.recipients.length, 0),
      },
    };
  }

  private groupCommittees(
    committeeIds: string[],
    names: Map<string, string | null>,
    rows: ClientPacGivingRow[],
  ) {
    const grouped = new Map<string, ClientPacCommittee>();
    for (const committeeId of committeeIds) {
      grouped.set(committeeId, {
        committeeId,
        committeeName: names.get(committeeId) ?? null,
        totalAmount: 0,
        disbursementCount: 0,
        recipients: [],
      });
    }
    for (const r of rows) {
      const g = grouped.get(r.committee_id) ?? {
        committeeId: r.committee_id,
        committeeName: r.committee_name,
        totalAmount: 0,
        disbursementCount: 0,
        recipients: [],
      };
      g.committeeName ??= r.committee_name;
      g.totalAmount += Number(r.total_amount);
      g.disbursementCount += Number(r.disbursement_count);
      if (r.recipient_name) {
        g.recipients.push({
          recipientName: r.recipient_name,
          candidateName: r.candidate_name,
          totalAmount: r.total_amount,
        });
      }
      grouped.set(r.committee_id, g);
    }
    const committees = Array.from(grouped.values()).sort((a, b) => b.totalAmount - a.totalAmount);
    return committees;
  }
}
