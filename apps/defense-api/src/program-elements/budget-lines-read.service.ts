import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { DefenseTenantContext, num, requirePeCode } from './program-elements.shared.js';

/**
 * Budget Lines / money-graph read service. Real DB logic against the
 * defense-api Prisma client. Preserves the native identity boundary: a
 * BudgetLineRelationship row's fromPeCode/toPeCode are Program Element
 * identities ONLY; this service performs no BLIN/O&M-BLI resolution.
 */
@Injectable()
export class BudgetLinesReadService {
  constructor(private readonly prisma: PrismaService) {}

  async getActions(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    // No budget_action table is modeled in Session 3's curated schema yet
    // (it is a job-owned derivation table, not part of the frozen PE
    // read contract's own persisted identity). Return an explicit empty set
    // rather than fabricate rows or reach into apps/api code.
    return { data: [], peCode };
  }

  async getRelationships(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const edges = await this.prisma.budgetLineRelationship.findMany({
      where: { OR: [{ fromPeCode: peCode }, { toPeCode: peCode }] },
      orderBy: [{ status: 'asc' }],
    });
    const otherCodes = [...new Set(edges.map((e) => (e.fromPeCode === peCode ? e.toPeCode : e.fromPeCode)))];
    const others = await this.prisma.programElement.findMany({
      where: { peCode: { in: otherCodes } },
      select: { peCode: true, title: true, service: true },
    });
    const lineByCode = new Map(others.map((o) => [o.peCode, o]));
    return edges
      .map((e) => {
        const dir = e.fromPeCode === peCode ? 'out' : 'in';
        const otherCode = dir === 'out' ? e.toPeCode : e.fromPeCode;
        const other = lineByCode.get(otherCode);
        if (!other) return null;
        return {
          id: e.id,
          direction: dir,
          relType: e.relType,
          confidence: e.confidence,
          status: e.status,
          line: { peCode: other.peCode, title: other.title, service: other.service },
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
  }

  async getIncumbents(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const [awards, performers] = await Promise.all([
      this.prisma.federalAward.findMany({
        where: { peCode },
        select: { contractorName: true, amount: true, peCodeSource: true, peCodeConfidence: true, awardingSubTier: true },
      }),
      this.prisma.programElementPerformer.findMany({ where: { peCode, isNamedCompany: true } }),
    ]);

    const byContractor = new Map<string, { name: string; total: number; count: number; strong: boolean }>();
    for (const a of awards) {
      const name = (a.contractorName ?? '').trim();
      if (!name) continue;
      const key = name.toUpperCase();
      const strong = a.peCodeSource === 'uei_confirmed_r3_prime' || (a.peCodeConfidence ?? 0) >= 0.8;
      const g = byContractor.get(key) ?? { name, total: 0, count: 0, strong: false };
      g.total += num(a.amount) ?? 0;
      g.count += 1;
      g.strong = g.strong || strong;
      byContractor.set(key, g);
    }

    const rows = [...byContractor.values()].map((g) => ({
      company: g.name,
      tier: g.strong ? ('incumbent' as const) : ('candidate' as const),
      awardsTotal: g.total || null,
      awardCount: g.count,
    }));
    for (const p of performers) {
      const key = p.performerNormalized.toUpperCase();
      if (byContractor.has(key)) continue;
      rows.push({ company: p.performer, tier: 'candidate', awardsTotal: null, awardCount: 0 });
    }
    rows.sort((a, b) => (b.awardsTotal ?? 0) - (a.awardsTotal ?? 0));
    return { data: rows };
  }

  async getMovement() {
    // Budget-action derived movement feed is job-owned (not in Session 3's
    // curated read schema). Explicit empty payload — no cross-domain
    // coupling reintroduced to satisfy this route.
    return { data: [] };
  }

  async getGraph() {
    const edges = await this.prisma.budgetLineRelationship.findMany({ take: 500 });
    const codes = [...new Set(edges.flatMap((e) => [e.fromPeCode, e.toPeCode]))];
    const nodes = await this.prisma.programElement.findMany({
      where: { peCode: { in: codes } },
      select: { peCode: true, title: true, service: true },
    });
    return { nodes, edges };
  }

  async getWatchSignals(ctx: DefenseTenantContext) {
    const watches = await this.prisma.programElementWatch.findMany({
      where: { tenantId: ctx.tenantId, userId: ctx.userId },
      select: { peCode: true },
    });
    return { data: [], watchedCount: watches.length };
  }

  async listCapabilities() {
    return { data: [] };
  }

  async getCapabilityRecommendations(_slug: string) {
    return { data: [] };
  }

  async searchCapabilityLines(_q: string) {
    return { data: [] };
  }
}
