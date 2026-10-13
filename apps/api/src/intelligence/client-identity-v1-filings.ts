import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  ClientIdentityFilingsPorts,
  ClientIdentityFilingRow,
} from './client-identity-v1.types.js';

/** Detailed visible LDA filings and their income/expense, year and registrant aggregates. */
export class ClientIdentityV1Filings {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ClientIdentityFilingsPorts,
  ) {}

  async getClientLdaFilings(clientId: string, tenantId: string) {
    const ldaClientIds = await this.ports.resolveLdaClientIds(clientId, tenantId);

    if (!ldaClientIds.length) {
      return {
        matched: false,
        ldaClientIds: [] as number[],
        totalFilings: 0,
        totalIncome: 0,
        totalExpenses: 0,
        firstFilingYear: null as number | null,
        latestFilingYear: null as number | null,
        registrants: [] as Array<{ name: string; filings: number; income: number }>,
        byYear: [] as Array<{ year: number; income: number; expenses: number; filings: number }>,
        filings: [] as unknown[],
      };
    }

    const rows = await this.prisma.ldaFiling.findMany({
      where: { clientId: { in: ldaClientIds } },
      orderBy: [{ filingYear: 'desc' }, { dtPosted: 'desc' }],
      take: 501,
      select: {
        filingUuid: true,
        registrantId: true,
        clientId: true,
        filingType: true,
        filingYear: true,
        filingPeriod: true,
        income: true,
        expenses: true,
        dtPosted: true,
        registrantName: true,
        clientName: true,
        issueCodes: true,
        governmentEntities: true,
        lobbyists: true,
        lobbyingActivities: true,
        filingDocumentUrl: true,
      },
    });
    return this.projectFilings(ldaClientIds, rows);
  }

  private projectFilings(ldaClientIds: number[], rows: ClientIdentityFilingRow[]) {
    let totalIncome = 0;

    let totalExpenses = 0;

    const byYear = new Map<
      number,
      { year: number; income: number; expenses: number; filings: number }
    >();

    const registrants = new Map<string, { name: string; filings: number; income: number }>();

    const truncated = rows.length > 500;

    const visibleRows = rows.slice(0, 500);

    const filings = visibleRows.map((r) => {
      const income = filingNumber(r.income);
      const expenses = filingNumber(r.expenses);
      totalIncome += income;
      totalExpenses += expenses;

      const y = byYear.get(r.filingYear) ?? {
        year: r.filingYear,
        income: 0,
        expenses: 0,
        filings: 0,
      };
      y.income += income;
      y.expenses += expenses;
      y.filings += 1;
      byYear.set(r.filingYear, y);

      const rn = (r.registrantName || '').trim() || 'Unknown registrant';
      const reg = registrants.get(rn) ?? { name: rn, filings: 0, income: 0 };
      reg.filings += 1;
      reg.income += income;
      registrants.set(rn, reg);

      return {
        filingUuid: r.filingUuid,
        registrantId: r.registrantId,
        ldaClientId: r.clientId,
        filingType: r.filingType,
        filingYear: r.filingYear,
        filingPeriod: r.filingPeriod,
        income,
        expenses,
        amount: income || expenses, // the headline number to show per row
        postedAt: r.dtPosted ? r.dtPosted.toISOString() : null,
        registrantName: rn,
        clientName: r.clientName,
        issueCodes: Array.isArray(r.issueCodes) ? r.issueCodes : [],
        governmentEntities: filingNameList(r.governmentEntities, 'name'),
        lobbyists: filingLobbyistNames(r.lobbyists),
        documentUrl: r.filingDocumentUrl ?? null,
      };
    });

    const years = visibleRows.map((r) => r.filingYear);

    return {
      matched: true,
      ldaClientIds,
      totalFilings: visibleRows.length,
      truncated,
      totalIncome,
      totalExpenses,
      firstFilingYear: years.length ? Math.min(...years) : null,
      latestFilingYear: years.length ? Math.max(...years) : null,
      registrants: Array.from(registrants.values())
        .sort((a, b) => b.income - a.income)
        .slice(0, 10),
      byYear: Array.from(byYear.values()).sort((a, b) => b.year - a.year),
      filings,
    };
  }
}

function filingNumber(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function filingNameList(json: unknown, key: string): string[] {
  if (!Array.isArray(json)) return [];
  const out: string[] = [];
  for (const item of json) {
    if (item && typeof item === 'object') {
      const v = (item as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.trim()) out.push(v.trim());
      else if (v && typeof v === 'object') {
        // government_entities arrive as { name } objects in some vintages
        const n = (v as Record<string, unknown>).name;
        if (typeof n === 'string' && n.trim()) out.push(n.trim());
      }
    } else if (typeof item === 'string' && item.trim()) {
      out.push(item.trim());
    }
  }
  return Array.from(new Set(out));
}

function filingLobbyistNames(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  const out: string[] = [];
  for (const item of json) {
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      // LDA lobbyist rows: { lobbyist: { first_name, last_name } } or flat.
      const inner = (o.lobbyist as Record<string, unknown>) ?? o;
      const first = typeof inner.first_name === 'string' ? inner.first_name : '';
      const last = typeof inner.last_name === 'string' ? inner.last_name : '';
      const full = `${first} ${last}`.trim();
      if (full) out.push(full);
    }
  }
  return Array.from(new Set(out));
}
