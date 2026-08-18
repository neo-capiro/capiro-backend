import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  approveManualOverrideV1,
  canonicalTargetForLegacyPeYearV1,
  ManualOverrideRefusalError,
  proposeManualOverrideV1,
} from './promotion/manual-override-service-v1.js';
import { ManualOverrideRepositoryPrisma } from './promotion/manual-override-repository.prisma.js';
import { DefenseTenantContext, assertFound, normalizeLimit, normalizePage, num, requirePeCode } from './program-elements.shared.js';

export interface ProgramElementListQuery {
  service?: string;
  budgetActivity?: string;
  q?: string;
  page?: number;
  limit?: number;
  hasData?: string;
  watched?: string;
  lineType?: string;
  capability?: string;
}

export type ReconciliationDecision = 'keep_current' | 'accept_conflicting' | 'manual_value';

export interface ResolveReconciliationInput {
  decision: ReconciliationDecision;
  manualValue?: string | null;
  notes?: string | null;
}

/**
 * Session 3 Program Elements read/mutation service.
 *
 * Real DB logic against defense-api's own Prisma client (never importing
 * apps/api service code). Cross-domain reads (Congress bills, SAM notices,
 * USAspending awards) go through the bounded read-only projections defined
 * in this app's own Prisma schema, joined here — never through an
 * apps/api service import.
 *
 * Native identity boundaries preserved: peCode is a Program Element identity
 * only. No BLIN/O&M BLI resolver exists in this module; cross-family reads
 * (federal_award.peCode, sam_opportunity_match.peCode, bill peCodes) use only
 * the attribution the OWNING domain already computed and persisted — this
 * service never derives or coerces one identity into another.
 */
@Injectable()
export class ProgramElementReadService {
  private readonly logger = new Logger(ProgramElementReadService.name);
  private readonly overrides: ManualOverrideRepositoryPrisma;

  constructor(private readonly prisma: PrismaService) {
    this.overrides = new ManualOverrideRepositoryPrisma(prisma);
  }

  async listProgramElements(query: ProgramElementListQuery, ctx?: DefenseTenantContext) {
    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const where: Prisma.ProgramElementWhereInput = { retiredAt: null };
    if (query.service) where.service = query.service;
    if (query.budgetActivity) where.budgetActivity = query.budgetActivity;
    if (query.q) {
      const q = query.q.trim();
      where.OR = [
        { peCode: { contains: q.toUpperCase() } },
        { title: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (query.lineType) {
      where.peCode = {
        in: (
          await this.prisma.programElementIntelligenceCache.findMany({
            where: { lineType: query.lineType },
            select: { peCode: true },
          })
        ).map((r) => r.peCode),
      };
    }
    if (query.hasData === 'true') {
      const withYears = await this.prisma.programElementYear.findMany({
        distinct: ['peCode'],
        select: { peCode: true },
      });
      where.peCode = { in: withYears.map((r) => r.peCode) };
    }
    if (query.watched === 'true' && ctx) {
      const watches = await this.prisma.programElementWatch.findMany({
        where: { tenantId: ctx.tenantId, userId: ctx.userId },
        select: { peCode: true },
      });
      where.peCode = { in: watches.map((w) => w.peCode) };
    } else if (query.watched === 'true' && !ctx) {
      return { data: [], total: 0, page, limit };
    }

    const [rows, total] = await Promise.all([
      this.prisma.programElement.findMany({
        where,
        orderBy: { peCode: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.programElement.count({ where }),
    ]);
    return { data: rows, total, page, limit };
  }

  async getSummary(query: { service?: string; hasData?: string }, ctx?: DefenseTenantContext) {
    const where: Prisma.ProgramElementWhereInput = { retiredAt: null };
    if (query.service) where.service = query.service;
    const total = await this.prisma.programElement.count({ where });
    const byService = await this.prisma.programElement.groupBy({
      by: ['service'],
      where,
      _count: { _all: true },
    });
    return {
      total,
      byService: byService.map((r) => ({ service: r.service, count: r._count._all })),
    };
  }

  async getProgramElement(peCodeRaw: string, ctx: DefenseTenantContext) {
    const peCode = requirePeCode(peCodeRaw);
    const pe = await this.prisma.programElement.findUnique({ where: { peCode } });
    assertFound(pe, `Program element ${peCode} not found`);

    const years = await this.prisma.programElementYear.findMany({
      where: { peCode },
      orderBy: { fy: 'asc' },
    });
    const [projectCount, sourceCount, watch] = await Promise.all([
      this.prisma.programElementProject.count({ where: { peCode } }),
      this.prisma.programElementSource.count({ where: { peCode } }),
      this.prisma.programElementWatch.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, peCode },
        select: { id: true },
      }),
    ]);

    return {
      ...pe!,
      years: years.map((y) => this.serializeYear(y)),
      projectCount,
      sourceCount,
      currentUserIsWatching: Boolean(watch),
    };
  }

  async getIntelligence(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const pe = await this.prisma.programElement.findUnique({ where: { peCode } });
    assertFound(pe, `Program element ${peCode} not found`);
    const [years, cache] = await Promise.all([
      this.prisma.programElementYear.findMany({ where: { peCode }, orderBy: { fy: 'asc' } }),
      this.prisma.programElementIntelligenceCache.findUnique({ where: { peCode } }),
    ]);
    return {
      peCode,
      appropriationType: pe!.appropriationType,
      budgetActivity: pe!.budgetActivity,
      years: years.map((y) => this.serializeYear(y)),
      lineType: cache?.lineType ?? null,
      maturity: cache?.maturity ?? null,
      appropTier: cache?.appropTier ?? null,
      appropScore: cache?.appropScore ?? null,
      signalType: cache?.signalType ?? null,
      signalTone: cache?.signalTone ?? null,
      valleyOfDeath: cache?.valleyOfDeath ?? false,
    };
  }

  async getTimeline(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const pe = await this.prisma.programElement.findUnique({ where: { peCode } });
    assertFound(pe, `Program element ${peCode} not found`);
    const [years, milestones] = await Promise.all([
      this.prisma.programElementYear.findMany({ where: { peCode }, orderBy: { fy: 'asc' } }),
      this.prisma.programElementMilestone.findMany({
        where: { peCode },
        orderBy: [{ plannedDate: 'asc' }],
      }),
    ]);
    return {
      peCode,
      years: years.map((y) => this.serializeYear(y)),
      milestones: milestones.map((m) => ({
        id: m.id,
        milestoneType: m.milestoneType,
        plannedDate: m.plannedDate,
        actualDate: m.actualDate,
        status: m.status,
        source: m.source,
        notes: m.notes,
      })),
    };
  }

  async getNarrative(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const pe = await this.prisma.programElement.findUnique({ where: { peCode } });
    assertFound(pe, `Program element ${peCode} not found`);
    const years = await this.prisma.programElementYear.findMany({
      where: { peCode },
      orderBy: { fy: 'desc' },
      take: 1,
    });
    const latest = years[0];
    const steps: Array<{ stage: string; label: string; amount: number | null }> = [];
    if (latest) {
      steps.push({ stage: 'request', label: "President's Request", amount: num(latest.request) });
      if (latest.hascMark != null) steps.push({ stage: 'hasc', label: 'HASC Mark', amount: num(latest.hascMark) });
      if (latest.sascMark != null) steps.push({ stage: 'sasc', label: 'SASC Mark', amount: num(latest.sascMark) });
      if (latest.conference != null) steps.push({ stage: 'conference', label: 'Conference', amount: num(latest.conference) });
      if (latest.enacted != null) steps.push({ stage: 'enacted', label: 'Enacted', amount: num(latest.enacted) });
    }
    return { peCode, fy: latest?.fy ?? null, steps };
  }

  async getBills(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const pe = await this.prisma.programElement.findUnique({ where: { peCode }, select: { peCode: true } });
    assertFound(pe, `Program element ${peCode} not found`);

    const bills = await this.prisma.congressBill.findMany({
      where: { peCodes: { has: peCode } },
      orderBy: [{ latestActionDate: 'desc' }],
      take: 100,
      select: {
        id: true,
        congress: true,
        billType: true,
        billNumber: true,
        title: true,
        policyArea: true,
        latestActionText: true,
        latestActionDate: true,
        url: true,
        sponsorName: true,
        peCodes: true,
        committeeRefs: { select: { committeeName: true }, take: 1 },
      },
    });

    const links = await this.prisma.billBudgetLineLink.findMany({
      where: { peCode, billId: { in: bills.map((b) => b.id) }, status: { not: 'rejected' } },
      select: { billId: true, linkType: true, confidence: true, evidence: true, status: true },
    });
    const linkByBill = new Map(links.map((l) => [l.billId, l]));

    const mapped = bills.map(({ committeeRefs, sponsorName, peCodes, ...bill }) => ({
      ...bill,
      sponsor: sponsorName,
      committee: committeeRefs[0]?.committeeName ?? null,
      peCodeCount: peCodes?.length ?? 0,
      link: linkByBill.get(bill.id)
        ? {
            type: linkByBill.get(bill.id)!.linkType,
            confidence: linkByBill.get(bill.id)!.confidence,
            evidence: linkByBill.get(bill.id)!.evidence,
            status: linkByBill.get(bill.id)!.status,
          }
        : null,
    }));
    mapped.sort((a, b) => {
      if (a.peCodeCount !== b.peCodeCount) return a.peCodeCount - b.peCodeCount;
      const at = a.latestActionDate ? new Date(a.latestActionDate).getTime() : 0;
      const bt = b.latestActionDate ? new Date(b.latestActionDate).getTime() : 0;
      return bt - at;
    });
    return mapped;
  }

  async getBillActions(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const pe = await this.prisma.programElement.findUnique({ where: { peCode }, select: { peCode: true } });
    assertFound(pe, `Program element ${peCode} not found`);

    const bills = await this.prisma.congressBill.findMany({
      where: { peCodes: { has: peCode } },
      orderBy: [{ latestActionDate: 'desc' }],
      take: 40,
      select: {
        id: true,
        congress: true,
        billType: true,
        billNumber: true,
        title: true,
        peCodes: true,
        actions: { orderBy: { date: 'desc' }, take: 60, select: { date: true, text: true, type: true, chamber: true } },
      },
    });

    const events = bills.flatMap((b) =>
      b.actions.map((a) => ({
        billId: b.id,
        congress: b.congress,
        billType: b.billType,
        billNumber: b.billNumber,
        billTitle: b.title,
        peCodeCount: b.peCodes?.length ?? 0,
        date: a.date,
        text: a.text,
        type: a.type,
        chamber: a.chamber,
      })),
    );
    events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return { data: events.slice(0, 200), billCount: bills.length };
  }

  async getContractors(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const pe = await this.prisma.programElement.findUnique({ where: { peCode }, select: { peCode: true } });
    assertFound(pe, `Program element ${peCode} not found`);
    const awards = await this.prisma.federalAward.findMany({
      where: { peCode },
      select: { contractorName: true, amount: true, peCodeSource: true, peCodeConfidence: true, awardingSubTier: true, fundingFy: true },
      take: 200,
    });
    return {
      data: awards.map((a) => ({
        contractorName: a.contractorName,
        amount: num(a.amount),
        peCodeSource: a.peCodeSource,
        peCodeConfidence: a.peCodeConfidence,
        office: a.awardingSubTier,
        fy: a.fundingFy,
      })),
    };
  }

  async getProjects(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const projects = await this.prisma.programElementProject.findMany({ where: { peCode } });
    return { data: projects };
  }

  async getProcurementLines(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const lines = await this.prisma.programElementProcurementLine.findMany({ where: { peCode }, orderBy: { fy: 'asc' } });
    return {
      data: lines.map((l) => ({
        id: l.id,
        lineDescription: l.lineDescription,
        fy: l.fy,
        quantity: num(l.quantity),
        dollars: num(l.dollars),
        unitCost: num(l.unitCost),
      })),
    };
  }

  async getSources(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const sources = await this.prisma.programElementSource.findMany({ where: { peCode }, orderBy: [{ fy: 'desc' }] });
    return { data: sources };
  }

  async getRelatedProgramElements(peCodeRaw: string, limit = 8) {
    const peCode = requirePeCode(peCodeRaw);
    const pe = await this.prisma.programElement.findUnique({ where: { peCode }, select: { service: true, budgetActivity: true } });
    if (!pe) return { data: [] };
    const related = await this.prisma.programElement.findMany({
      where: { peCode: { not: peCode }, service: pe.service, budgetActivity: pe.budgetActivity, retiredAt: null },
      take: limit,
      select: { peCode: true, title: true, service: true, budgetActivity: true },
    });
    return { data: related };
  }

  async getProgramsForPe(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    if (!peCode) return { peCode, acceptedMatches: [], candidateMatches: [] };
    const matches = await this.prisma.peProgramMatch.findMany({
      where: { peCode, status: { in: ['accepted', 'candidate'] } },
      orderBy: { score: 'desc' },
    });
    const programIds = [...new Set(matches.map((m) => m.programId))];
    const programs = await this.prisma.program.findMany({ where: { id: { in: programIds } } });
    const programById = new Map(programs.map((p) => [p.id, p]));
    const toRow = (m: (typeof matches)[number]) => ({
      programId: m.programId,
      program: programById.get(m.programId) ?? null,
      score: m.score,
      status: m.status,
      resolvedAt: m.resolvedAt,
    });
    return {
      peCode,
      acceptedMatches: matches.filter((m) => m.status === 'accepted').map(toRow),
      candidateMatches: matches.filter((m) => m.status === 'candidate').map(toRow),
    };
  }

  async getProvisionsForPe(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const provisionSelect = {
      id: true,
      committee: true,
      fy: true,
      heading: true,
      text: true,
      pageStart: true,
      pageEnd: true,
      actionType: true,
      sourceDocument: { select: { sourceUrl: true } },
    } as const;

    const programMatches = await this.prisma.peProgramMatch.findMany({
      where: { peCode, status: 'accepted' },
      select: { programId: true },
    });
    const programIds = [...new Set(programMatches.map((m) => m.programId))];

    const [directLinks, programLinks] = await Promise.all([
      this.prisma.provisionPeLink.findMany({
        where: { peCode, reviewStatus: { in: ['accepted', 'candidate'] } },
        select: { matchBasis: true, reviewStatus: true, confidence: true, provision: { select: provisionSelect } },
      }),
      programIds.length
        ? this.prisma.provisionPeLink.findMany({
            where: { programId: { in: programIds }, reviewStatus: { in: ['accepted', 'candidate'] } },
            select: { matchBasis: true, reviewStatus: true, confidence: true, provision: { select: provisionSelect } },
          })
        : Promise.resolve([]),
    ]);

    const byProvision = new Map<string, Record<string, unknown>>();
    const rank = (m: string) => (m === 'pe_code' ? 0 : m === 'project_title' ? 1 : 2);
    const scopeOf = (m: string): 'pe_specific' | 'program_level' =>
      m === 'pe_code' || m === 'project_title' ? 'pe_specific' : 'program_level';
    for (const l of [...directLinks, ...programLinks]) {
      const existing = byProvision.get(l.provision.id);
      if (existing && rank(existing.matchBasis as string) <= rank(l.matchBasis)) continue;
      const matchScope = scopeOf(l.matchBasis);
      byProvision.set(l.provision.id, {
        id: l.provision.id,
        committee: l.provision.committee,
        fy: l.provision.fy,
        heading: l.provision.heading,
        text: l.provision.text,
        pageStart: l.provision.pageStart,
        pageEnd: l.provision.pageEnd,
        actionType: l.provision.actionType,
        sourceUrl: l.provision.sourceDocument?.sourceUrl ?? null,
        matchBasis: l.matchBasis,
        reviewStatus: l.reviewStatus,
        confidence: l.confidence,
        matchScope,
        attributionCaveat:
          matchScope === 'program_level'
            ? 'Program-level match: this provision maps to this PE via a program alias, not directly. It may also apply to sibling PEs in the same program.'
            : null,
      });
    }
    const items = [...byProvision.values()];
    const statusRank = (s: unknown) => (s === 'accepted' ? 0 : 1);
    items.sort(
      (a: any, b: any) =>
        statusRank(a.reviewStatus) - statusRank(b.reviewStatus) ||
        rank(a.matchBasis) - rank(b.matchBasis) ||
        b.fy - a.fy ||
        b.confidence - a.confidence,
    );
    return items.slice(0, 50);
  }

  async listOpportunities(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const matches = await this.prisma.samOpportunityMatch.findMany({
      where: { peCode, reviewStatus: { in: ['accepted', 'candidate'] }, opportunity: { is: { active: true } } },
      select: {
        matchBasis: true,
        reviewStatus: true,
        confidence: true,
        opportunity: {
          select: {
            id: true,
            noticeId: true,
            title: true,
            noticeType: true,
            agency: true,
            office: true,
            pscCode: true,
            naicsCode: true,
            postedDate: true,
            responseDeadline: true,
            sourceUrl: true,
            pocName: true,
            pocEmail: true,
          },
        },
      },
    });
    const items = matches.map((m) => ({
      ...m.opportunity,
      matchBasis: m.matchBasis,
      reviewStatus: m.reviewStatus,
      confidence: m.confidence,
    }));
    items.sort((a, b) => {
      const at = a.responseDeadline ? new Date(a.responseDeadline).getTime() : null;
      const bt = b.responseDeadline ? new Date(b.responseDeadline).getTime() : null;
      if (at === null && bt === null) return 0;
      if (at === null) return 1;
      if (bt === null) return -1;
      return at - bt;
    });
    return items;
  }

  async getBudgetPositions(peCodeRaw: string, fy?: number) {
    const peCode = requirePeCode(peCodeRaw);
    const where: Prisma.ProgramElementBudgetPositionWhereInput = { peCode };
    if (fy !== undefined) where.assertedFy = fy;
    const rows = await this.prisma.programElementBudgetPosition.findMany({ where, orderBy: [{ assertedFy: 'asc' }] });
    return { data: rows.map((r) => ({ ...r, amount: num(r.amount) })) };
  }

  async getPbComparison(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const rows = await this.prisma.programElementBudgetPosition.findMany({
      where: { peCode, valueKind: 'total' },
      orderBy: [{ assertedFy: 'asc' }],
    });
    const pbRows = rows.filter((r) => /^pb_fy\d{4}$/i.test(r.positionCycle));
    const byCycle = new Map<string, typeof pbRows>();
    for (const r of pbRows) {
      const list = byCycle.get(r.positionCycle) ?? [];
      list.push(r);
      byCycle.set(r.positionCycle, list);
    }
    const cycles = [...byCycle.keys()].sort();
    if (cycles.length < 2) return { peCode, data: [] };
    const currentCycle = cycles[cycles.length - 1] as string;
    const priorCycle = cycles[cycles.length - 2] as string;
    const currentByFy = new Map((byCycle.get(currentCycle) ?? []).map((r) => [r.assertedFy, num(r.amount)]));
    const priorByFy = new Map((byCycle.get(priorCycle) ?? []).map((r) => [r.assertedFy, num(r.amount)]));
    const fys = new Set([...currentByFy.keys(), ...priorByFy.keys()]);
    // Rounding matches apps/api's computePbComparison (budget-position.ts)
    // exactly: deltaAbs to 2dp, deltaPct to 4dp — verified by
    // pb-comparison-parity.spec.ts against apps/api's actual pure helper.
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
    const data = [...fys].sort().map((fy) => {
      const pbCurrent = currentByFy.get(fy) ?? null;
      const pbPrior = priorByFy.get(fy) ?? null;
      const inCurrent = currentByFy.has(fy);
      const inPrior = priorByFy.has(fy);
      return {
        assertedFy: fy,
        pbCurrent,
        pbPrior,
        deltaAbs: pbCurrent !== null && pbPrior !== null ? round2(pbCurrent - pbPrior) : null,
        deltaPct: pbCurrent !== null && pbPrior !== null && pbPrior !== 0 ? round4((pbCurrent - pbPrior) / Math.abs(pbPrior)) : null,
        newInPb: inCurrent && pbCurrent !== null && (!inPrior || pbPrior === null),
        droppedFromPb: inPrior && pbPrior !== null && (!inCurrent || pbCurrent === null),
      };
    });
    return { peCode, data };
  }

  async getDeltas(peCodeRaw: string, query: { deltaType?: string; fy?: number; page?: number; limit?: number }) {
    const peCode = requirePeCode(peCodeRaw);
    const page = normalizePage(query.page);
    const limit = normalizeLimit(query.limit);
    const where: Prisma.ProgramElementDeltaWhereInput = { peCode, supersededAt: null };
    if (query.deltaType) where.deltaType = query.deltaType;
    if (query.fy !== undefined) where.assertedFy = query.fy;
    const [rows, total] = await Promise.all([
      this.prisma.programElementDelta.findMany({
        where,
        orderBy: [{ materialityScore: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.programElementDelta.count({ where }),
    ]);
    return { data: rows, total, page, limit };
  }

  async getNeedsAttention(ctx: DefenseTenantContext, query: { minScore?: number; fy?: number; limit?: number }) {
    const limit = normalizeLimit(query.limit, 200);
    const where: Prisma.ProgramElementDeltaWhereInput = { supersededAt: null };
    if (query.fy !== undefined) where.assertedFy = query.fy;
    if (query.minScore !== undefined) where.materialityScore = { gte: query.minScore };
    const rows = await this.prisma.programElementDelta.findMany({
      where,
      orderBy: [{ materialityScore: 'desc' }],
      take: limit,
    });
    return { data: rows };
  }

  async setWatching(peCodeRaw: string, watching: boolean, ctx: DefenseTenantContext) {
    const peCode = requirePeCode(peCodeRaw);
    const pe = await this.prisma.programElement.findUnique({ where: { peCode }, select: { peCode: true } });
    assertFound(pe, `Program element ${peCode} not found`);

    return this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      if (watching) {
        let inserted: Array<{ id: string }>;
        try {
          inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            INSERT INTO program_element_watch (id, tenant_id, user_id, pe_code, created_at)
            VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${ctx.userId}::uuid, ${peCode}, now())
            ON CONFLICT (tenant_id, user_id, pe_code)
            DO UPDATE SET pe_code = EXCLUDED.pe_code
            RETURNING id
          `);
        } catch (error) {
          throw new ConflictException({ code: 'PE_WATCH_CONFLICT', message: (error as Error).message });
        }
        await tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            action: 'program_element.watch.set',
            entityType: 'program_element_watch',
            entityId: inserted[0]?.id ?? null,
            after: { peCode, watching: true },
          },
        });
        return { peCode, watching: true };
      }

      const removed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        DELETE FROM program_element_watch
        WHERE tenant_id = ${ctx.tenantId}::uuid AND user_id = ${ctx.userId}::uuid AND pe_code = ${peCode}
        RETURNING id
      `);
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'program_element.watch.set',
          entityType: 'program_element_watch',
          entityId: removed[0]?.id ?? null,
          after: { peCode, watching: false },
        },
      });
      return { peCode, watching: false };
    });
  }

  async getPeAlertEmailPref(ctx: DefenseTenantContext) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.peAlertEmailPref.findFirst({ where: { userId: ctx.userId, tenantId: ctx.tenantId }, select: { mode: true } });
      return { mode: row?.mode ?? 'daily' };
    });
  }

  async setPeAlertEmailPref(mode: string, ctx: DefenseTenantContext) {
    return this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      await tx.peAlertEmailPref.upsert({
        where: { userId_tenantId: { userId: ctx.userId, tenantId: ctx.tenantId } },
        create: { userId: ctx.userId, tenantId: ctx.tenantId, mode, createdAt: new Date(), updatedAt: new Date() },
        update: { mode, updatedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'program_element.alert_email_pref.set',
          entityType: 'pe_alert_email_pref',
          after: { mode },
        },
      });
      return { mode };
    });
  }

  async listReconciliationQueue(status = 'open', page = 1, limit = 50) {
    const take = normalizeLimit(limit, 200);
    const skip = (normalizePage(page) - 1) * take;
    const where: Prisma.ReconciliationReviewQueueWhereInput = status === 'all' ? {} : { status };
    const [rows, total] = await Promise.all([
      this.prisma.reconciliationReviewQueue.findMany({ where, orderBy: { queuedAt: 'desc' }, skip, take }),
      this.prisma.reconciliationReviewQueue.count({ where }),
    ]);
    return { data: rows, total, page: normalizePage(page), limit: take };
  }

  async resolveReconciliation(id: string, input: ResolveReconciliationInput, ctx: DefenseTenantContext) {
    const entry = await this.prisma.reconciliationReviewQueue.findUnique({ where: { id } });
    assertFound(entry, `Reconciliation entry ${id} not found`);
    if (entry!.status !== 'open') {
      throw new BadRequestException(`Reconciliation entry ${id} is already ${entry!.status}`);
    }

    let proposedValue: string | null = null;
    let proposedOverrideId: string | null = null;
    if (input.decision === 'accept_conflicting' || input.decision === 'manual_value') {
      const rawSource = input.decision === 'accept_conflicting' ? entry!.conflictingValue : input.manualValue;
      if (rawSource === null || rawSource === undefined || String(rawSource).trim() === '') {
        throw new BadRequestException(
          input.decision === 'manual_value'
            ? 'manualValue (exact decimal string, in $ millions) is required for decision=manual_value'
            : `Conflicting value for entry ${id} is absent and cannot be accepted`,
        );
      }
      proposedValue = String(rawSource).trim();

      try {
        const record = await proposeManualOverrideV1(
          {
            overrideId: randomUUID(),
            target: canonicalTargetForLegacyPeYearV1({ peCode: entry!.peCode, fy: entry!.fy, fieldName: entry!.fieldName }),
            value: { originalValue: proposedValue, originalUnit: 'millions', valueMillions: proposedValue },
            authorActorId: ctx.userId,
            reason: input.notes?.trim() || 'reconciliation queue resolution',
            evidenceIds: [`reconciliation_review_queue:${id}`],
            effectiveFrom: new Date().toISOString(),
            proposedAt: new Date().toISOString(),
          },
          this.overrides,
        );
        proposedOverrideId = record.overrideId;
      } catch (error) {
        if (error instanceof ManualOverrideRefusalError) {
          throw new BadRequestException(`${error.reason}: ${error.message}`);
        }
        throw error;
      }
    }

    const nextStatus = proposedOverrideId == null ? 'resolved' : 'pending_approval';
    await this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      await tx.reconciliationReviewQueue.update({
        where: { id },
        data: {
          status: nextStatus,
          resolvedByUserId: nextStatus === 'resolved' ? ctx.userId : null,
          resolvedAt: nextStatus === 'resolved' ? new Date() : null,
          resolutionNotes: input.notes?.trim() || null,
          proposedOverrideId,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: nextStatus === 'resolved' ? 'program_element.reconciliation.resolve' : 'program_element.reconciliation.propose_override',
          entityType: 'reconciliation_review_queue',
          entityId: id,
          before: { status: entry!.status, conflictingValue: entry!.conflictingValue },
          after: { decision: input.decision, proposedValue, proposedOverrideId, status: nextStatus },
        },
      });
    });

    return {
      resolved: nextStatus === 'resolved',
      pendingApproval: nextStatus === 'pending_approval',
      id,
      decision: input.decision,
      peCode: entry!.peCode,
      fy: entry!.fy,
      fieldName: entry!.fieldName,
      proposedValue,
      proposedOverrideId,
    };
  }

  async approveReconciliation(id: string, ctx: DefenseTenantContext) {
    const entry = await this.prisma.reconciliationReviewQueue.findUnique({ where: { id } });
    assertFound(entry, `Reconciliation entry ${id} not found`);
    if (entry!.status !== 'pending_approval' || entry!.proposedOverrideId == null) {
      throw new BadRequestException(`Reconciliation entry ${id} is ${entry!.status} and has no correction awaiting approval`);
    }

    try {
      await approveManualOverrideV1(
        { overrideId: entry!.proposedOverrideId, approverActorId: ctx.userId, approverRole: ctx.role, approvedAt: new Date().toISOString() },
        this.overrides,
      );
    } catch (error) {
      if (error instanceof ManualOverrideRefusalError) {
        throw new BadRequestException(`${error.reason}: ${error.message}`);
      }
      throw error;
    }

    await this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      await tx.reconciliationReviewQueue.update({
        where: { id },
        data: { status: 'resolved', resolvedByUserId: ctx.userId, resolvedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'program_element.reconciliation.approve_override',
          entityType: 'reconciliation_review_queue',
          entityId: id,
          before: { status: entry!.status, proposedOverrideId: entry!.proposedOverrideId },
          after: { status: 'resolved', approvedOverrideId: entry!.proposedOverrideId },
        },
      });
    });

    return { approved: true as const, id, overrideId: entry!.proposedOverrideId, peCode: entry!.peCode, fy: entry!.fy, fieldName: entry!.fieldName };
  }

  private serializeYear(y: {
    fy: number;
    request: Prisma.Decimal | null;
    hascMark: Prisma.Decimal | null;
    sascMark: Prisma.Decimal | null;
    hacDMark: Prisma.Decimal | null;
    sacDMark: Prisma.Decimal | null;
    ndaaConference: Prisma.Decimal | null;
    conference: Prisma.Decimal | null;
    enacted: Prisma.Decimal | null;
  }) {
    return {
      fy: y.fy,
      request: num(y.request),
      hascMark: num(y.hascMark),
      sascMark: num(y.sascMark),
      hacDMark: num(y.hacDMark),
      sacDMark: num(y.sacDMark),
      ndaaConference: num(y.ndaaConference),
      conference: num(y.conference),
      enacted: num(y.enacted),
    };
  }
}
