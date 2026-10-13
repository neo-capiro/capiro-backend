import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientRoiQuarterInput, ClientRoiQuarterPoint } from './client-financial-v1.types.js';

/** Eight-quarter LDA spend and annual-obligation distributions. */
export class ClientFinancialV1Quarters {
  constructor(private readonly prisma: PrismaService) {}

  async buildRoiQuarterSeries({
    mappedLdaClientIds,
    lobbyingYearly,
    obligationsYearly,
    now,
  }: ClientRoiQuarterInput): Promise<ClientRoiQuarterPoint[]> {
    const quarters: Array<{ year: number; q: number; label: string }> = [];

    let y = now.getFullYear();

    let q = Math.floor(now.getMonth() / 3) + 1;

    for (let i = 7; i >= 0; i--) {
      let qy = y;
      let qq = q - i;
      while (qq < 1) {
        qq += 4;
        qy -= 1;
      }
      quarters.push({ year: qy, q: qq, label: `Q${qq}'${String(qy).slice(2)}` });
    }

    const PERIOD_MAP: Record<string, number> = {
      first_quarter: 1,
      second_quarter: 2,
      third_quarter: 3,
      fourth_quarter: 4,
      mid_year: 2,
      year_end: 4,
    };

    const lobbyByQuarter = new Map<string, number>();

    if (mappedLdaClientIds.length) {
      const rows = await this.prisma.$queryRaw<
        Array<{ filing_year: number; filing_period: string | null; amount: number }>
      >`
          SELECT filing_year,
                 filing_period,
                 COALESCE(SUM(income), 0)::float AS amount
          FROM lda_filing
          WHERE client_id = ANY(${mappedLdaClientIds}::int[])
            AND filing_period IS NOT NULL
          GROUP BY filing_year, filing_period
        `;
      for (const row of rows) {
        const qNum = PERIOD_MAP[row.filing_period ?? ''];
        if (!qNum) continue;
        // Same quarter across multiple registrants sums (rows are disjoint per client_id).
        lobbyByQuarter.set(
          `${row.filing_year}-Q${qNum}`,
          (lobbyByQuarter.get(`${row.filing_year}-Q${qNum}`) ?? 0) + row.amount,
        );
      }
    } else {
      // Fall back to distributing annual lobbying data evenly across quarters
      for (const { year, amount } of lobbyingYearly) {
        const qAmt = amount / 4;
        for (let q2 = 1; q2 <= 4; q2++) {
          lobbyByQuarter.set(`${year}-Q${q2}`, qAmt);
        }
      }
    }

    const obligByQuarter = new Map<string, number>();

    for (const { year, amount } of obligationsYearly) {
      const qAmt = amount / 4;
      for (let q2 = 1; q2 <= 4; q2++) {
        obligByQuarter.set(`${year}-Q${q2}`, qAmt);
      }
    }

    return quarters.map(({ year, q: qn, label }) => ({
      label,
      lobbying: lobbyByQuarter.get(`${year}-Q${qn}`) ?? 0,
      obligations: obligByQuarter.get(`${year}-Q${qn}`) ?? 0,
    }));
  }
}
