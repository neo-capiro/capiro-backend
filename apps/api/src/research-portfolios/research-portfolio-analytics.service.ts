import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type {
  CreateResearchPortfolioSnapshotDto,
  ResearchPortfolioAnalyticsDto,
  ResearchPortfolioContributionDto,
  ResearchPortfolioFinancialBasisDto,
  ResearchPortfolioMemberDto,
  ResearchPortfolioSnapshotDto,
  ResearchPortfolioSnapshotSummaryDto,
  TenantContext,
} from '@capiro/shared';
import type { DefenseFundingCellDto } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { DefenseResearchService } from '../defense-research/defense-research.service.js';
import { loadAuthorizedResearchPortfolio } from './research-portfolio-access.js';

const CALCULATION_VERSION = 'research-portfolio-analytics-v2' as const;
const SUPPORTED_KINDS = new Set(['program', 'program_element', 'project', 'budget_line']);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');

function basisKey(basis: ResearchPortfolioFinancialBasisDto): string {
  return stable(basis);
}

function sumDecimals(values: readonly string[]): string {
  const parsed = values.map((value) => {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
    if (!match) throw new BadRequestException(`Unsupported financial value ${value}`);
    return { negative: match[1] === '-', whole: match[2]!, fraction: match[3] ?? '' };
  });
  const scale = Math.max(0, ...parsed.map(({ fraction }) => fraction.length));
  const total = parsed.reduce((sum, item) => {
    const digits = BigInt(`${item.whole}${item.fraction.padEnd(scale, '0')}`);
    return sum + (item.negative ? -digits : digits);
  }, 0n);
  const negative = total < 0n;
  const raw = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const whole = scale ? raw.slice(0, -scale) : raw;
  const fraction = scale ? raw.slice(-scale).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

@Injectable()
export class ResearchPortfolioAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly defenseResearch: DefenseResearchService,
  ) {}

  async analytics(ctx: TenantContext, portfolioId: string): Promise<ResearchPortfolioAnalyticsDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const members = await tx.researchPortfolioMember.findMany({
        where: { tenantId: ctx.tenantId, portfolioId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return this.project(portfolioId, portfolio.revision, members);
    });
  }

  async listSnapshots(ctx: TenantContext, portfolioId: string): Promise<readonly ResearchPortfolioSnapshotSummaryDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const rows = await tx.researchPortfolioSnapshot.findMany({
        where: { tenantId: ctx.tenantId, portfolioId },
        orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
      });
      return rows.map((row: any) => this.snapshotSummary(row));
    });
  }

  async snapshot(ctx: TenantContext, portfolioId: string, snapshotId: string): Promise<ResearchPortfolioSnapshotDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const row = await tx.researchPortfolioSnapshot.findFirst({ where: { id: snapshotId, portfolioId } });
      if (!row) throw new NotFoundException('Research portfolio snapshot not found');
      return this.snapshotDto(row);
    });
  }

  async createSnapshot(
    ctx: TenantContext,
    portfolioId: string,
    input: CreateResearchPortfolioSnapshotDto,
  ): Promise<ResearchPortfolioSnapshotDto> {
    const name = input.name?.trim();
    if (!name || name.length > 200) throw new BadRequestException('Snapshot name must be between 1 and 200 characters');
    if (!input.operationKey || input.operationKey.length > 128) throw new BadRequestException('operationKey must be between 1 and 128 characters');
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'editor');
      const replay = await tx.researchPortfolioSnapshot.findUnique({
        where: { tenantId_operationKey: { tenantId: ctx.tenantId, operationKey: input.operationKey } },
      });
      if (replay) {
        if (replay.portfolioId !== portfolioId || replay.name !== name || replay.portfolioRevision !== input.expectedRevision) {
          throw new ConflictException('This snapshot operation key was used for different content');
        }
        return this.snapshotDto(replay);
      }
      if (portfolio.revision !== input.expectedRevision) throw new ConflictException('Research portfolio revision is stale');
      const [members, rules, decisions] = await Promise.all([
        tx.researchPortfolioMember.findMany({ where: { tenantId: ctx.tenantId, portfolioId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
        tx.researchPortfolioRuleVersion.findMany({ where: { tenantId: ctx.tenantId, portfolioId }, orderBy: { version: 'asc' } }),
        tx.researchPortfolioDecision.findMany({ where: { tenantId: ctx.tenantId, portfolioId }, orderBy: [{ decisionTime: 'asc' }, { id: 'asc' }] }),
      ]);
      const projection = await this.project(portfolioId, portfolio.revision, members);
      const membership = members.map((member: any) => this.memberDto(member));
      const sourceVersions = [...new Set(projection.contributions.flatMap((entry) => entry.sourceRevisionIds))].sort().map((id) => ({ id }));
      const ruleVersions = rules.map((rule: any) => ({ id: rule.id, version: rule.version, previewHash: rule.previewHash, publishedAt: rule.publishedAt.toISOString() }));
      const decisionVersions = decisions.map((decision: any) => ({ id: decision.id, targetKind: decision.targetKind, targetId: decision.targetId, decisionType: decision.decisionType, decisionTime: decision.decisionTime.toISOString() }));
      const templateVersions = rules.filter((rule: any) => rule.templateVersionId).map((rule: any) => ({ id: rule.templateVersionId }));
      const taxonomyVersions = rules.filter((rule: any) => rule.taxonomyVersionId).map((rule: any) => ({ id: rule.taxonomyVersionId }));
      const basis = input.basis ?? {};
      const capturedAt = new Date();
      const immutable = {
        portfolioId,
        portfolioRevision: portfolio.revision,
        name,
        basis,
        membership,
        projection,
        structureVersions: { portfolioRevision: portfolio.revision, memberRevisions: membership.map(({ id, revision }) => ({ id, revision })) },
        ruleVersions,
        decisionVersions,
        templateVersions,
        taxonomyVersions,
        labelVersions: membership.map(({ id, label }) => ({ id, label })),
        sourceVersions,
        calculationVersion: CALCULATION_VERSION,
        limitations: projection.limitations,
        // This projection contains public research only, with explicit source qualification.
        // Linking a client never makes every snapshot depend on that client's
        // memory wall or expose the linked-client identifiers in snapshot data.
        clientAccessRequirements: [],
        observedAt: projection.observedAt,
        readAt: projection.readAt,
      };
      const row = await tx.researchPortfolioSnapshot.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          operationKey: input.operationKey,
          contentHash: hash(immutable),
          name,
          portfolioRevision: portfolio.revision,
          createdByUserId: ctx.userId,
          basis: basis as Prisma.InputJsonValue,
          membership: membership as unknown as Prisma.InputJsonValue,
          projection: projection as unknown as Prisma.InputJsonValue,
          structureVersions: immutable.structureVersions as unknown as Prisma.InputJsonValue,
          ruleVersions: ruleVersions as unknown as Prisma.InputJsonValue,
          decisionVersions: decisionVersions as unknown as Prisma.InputJsonValue,
          templateVersions: templateVersions as unknown as Prisma.InputJsonValue,
          taxonomyVersions: taxonomyVersions as unknown as Prisma.InputJsonValue,
          labelVersions: immutable.labelVersions as unknown as Prisma.InputJsonValue,
          sourceVersions: sourceVersions as unknown as Prisma.InputJsonValue,
          calculationVersion: CALCULATION_VERSION,
          limitations: projection.limitations as unknown as Prisma.InputJsonValue,
          clientAccessRequirements: immutable.clientAccessRequirements as unknown as Prisma.InputJsonValue,
          capturedAt,
          observedAt: new Date(projection.observedAt),
          readAt: new Date(projection.readAt),
        },
      });
      return this.snapshotDto(row);
    });
  }

  private async project(portfolioId: string, revision: number, members: readonly any[]): Promise<ResearchPortfolioAnalyticsDto> {
    const observedAt = new Date().toISOString();
    const contributions: ResearchPortfolioContributionDto[] = [];
    const projectParents = new Map<string, string>();
    for (const member of members) {
      if (member.disposition !== 'included') {
        contributions.push(this.memberOnlyContribution(member, 'excluded', `Membership disposition is ${member.disposition}`));
        continue;
      }
      if (!SUPPORTED_KINDS.has(member.targetKind)) {
        contributions.push(this.memberOnlyContribution(member, 'unavailable', `${member.targetKind} has no qualified financial reader`));
        continue;
      }
      if (member.targetKind === 'project') {
        const project = await this.prisma.programElementProject.findFirst({
          where: this.projectWhere(member.targetId),
          select: { peCode: true },
        });
        if (project) projectParents.set(member.id, project.peCode);
      }
      try {
        const matrix = await this.defenseResearch.fundingMatrix(member.targetKind, member.targetId);
        if (!matrix.cells.length) {
          contributions.push(this.memberOnlyContribution(member, 'unavailable', 'No source-qualified financial cells are available'));
          continue;
        }
        for (const cell of matrix.cells) contributions.push(this.cellContribution(member, cell));
      } catch (error) {
        contributions.push(this.memberOnlyContribution(member, 'unavailable', error instanceof Error ? error.message : 'Financial projection unavailable'));
      }
    }

    // A unit cost is a per-subject rate, not an additive amount. Retain the
    // observed value/evidence without inventing a weighted aggregate.
    for (const contribution of contributions) {
      if (contribution.disposition === 'included' && contribution.basis?.metric === 'unit_cost') {
        contribution.disposition = 'incompatible';
        contribution.reason = 'Unit cost is nonadditive; no qualified compatible quantity weights are available';
      }
    }

    const seenObservation = new Map<string, string>();
    for (const contribution of contributions) {
      if (contribution.disposition !== 'included' || !contribution.sourceObservationId) continue;
      const key = `${basisKey(contribution.basis!)}:${contribution.sourceObservationId}`;
      const prior = seenObservation.get(key);
      if (prior) {
        contribution.disposition = 'overlap';
        contribution.reason = 'Repeated source observation is counted once';
        contribution.overlapsContributionId = prior;
      } else seenObservation.set(key, contribution.contributionId);
    }

    const projectBasis = new Map<string, string>();
    for (const contribution of contributions) {
      const parent = projectParents.get(contribution.memberId);
      if (parent && contribution.disposition === 'included' && contribution.basis) {
        projectBasis.set(`${parent}:${basisKey(contribution.basis)}`, contribution.contributionId);
      }
    }
    for (const contribution of contributions) {
      if (contribution.targetKind !== 'program_element' || contribution.disposition !== 'included' || !contribution.basis) continue;
      const child = projectBasis.get(`${contribution.targetId}:${basisKey(contribution.basis)}`);
      if (child) {
        contribution.disposition = 'overlap';
        contribution.reason = 'Parent program-element value overlaps an included project on the same compatible basis';
        contribution.overlapsContributionId = child;
      }
    }

    const totals = new Map<string, { basis: ResearchPortfolioFinancialBasisDto; values: string[] }>();
    for (const contribution of contributions) {
      if (contribution.disposition !== 'included' || contribution.value === null || !contribution.basis) continue;
      const key = basisKey(contribution.basis);
      const bucket = totals.get(key) ?? { basis: contribution.basis, values: [] };
      bucket.values.push(contribution.value);
      totals.set(key, bucket);
    }
    const totalDtos = [...totals.values()].map(({ basis, values }) => ({ basis, value: sumDecimals(values), contributionCount: values.length }));
    const supportedMemberIds = new Set(contributions.filter((item) => item.basis !== null && item.disposition !== 'unavailable').map((item) => item.memberId));
    const unavailableMemberIds = new Set(contributions.filter((item) => item.disposition === 'unavailable').map((item) => item.memberId));
    const hasObservedValues = contributions.some((item) => item.value !== null && ['included', 'incompatible'].includes(item.disposition));
    const hasPartialCoverage = unavailableMemberIds.size > 0 || contributions.some((item) =>
      ['missing', 'withheld', 'incompatible'].includes(item.disposition) || item.sourceDisposition === 'partial');
    const availability = totalDtos.length === 0
      ? hasObservedValues ? 'partial' : 'unavailable'
      : hasPartialCoverage ? 'partial' : 'available';
    const limitations = [
      'Totals are partitioned by request edition, fiscal year, stage, metric, unit, currency, price basis, and knowledge time.',
      'Missing, withheld, unsupported, and unpublished values are not converted to zero.',
      ...(contributions.some((item) => item.sourceDisposition === 'partial') ? ['Some retained values have partial source qualification.'] : []),
      ...(contributions.some((item) => item.basis?.metric === 'unit_cost' && item.disposition === 'incompatible') ? ['Unit costs remain per-subject values and are not summed without qualified quantity weights.'] : []),
      ...(contributions.some((item) => item.disposition === 'overlap') ? ['Repeated observations and parent/project overlap are excluded from totals.'] : []),
      ...(members.some((member) => member.targetKind === 'award') ? ['Award financial aggregation remains unsupported in this projection.'] : []),
    ];
    return {
      portfolioId,
      portfolioRevision: revision,
      calculationVersion: CALCULATION_VERSION,
      availability,
      totals: totalDtos,
      contributions,
      coverage: {
        eligibleMembers: members.length,
        supportedMembers: supportedMemberIds.size,
        includedContributions: contributions.filter((item) => item.disposition === 'included').length,
        excludedContributions: contributions.filter((item) => item.disposition === 'excluded').length,
        overlapContributions: contributions.filter((item) => item.disposition === 'overlap').length,
        unavailableMembers: unavailableMemberIds.size,
      },
      limitations,
      observedAt,
      readAt: new Date().toISOString(),
    };
  }

  private cellContribution(member: any, cell: DefenseFundingCellDto): ResearchPortfolioContributionDto {
    const basis: ResearchPortfolioFinancialBasisDto = {
      requestEdition: cell.basis.requestEdition,
      fundingFiscalYear: cell.basis.fundingFiscalYear,
      stage: cell.basis.stage,
      metric: cell.basis.metric,
      unit: cell.basis.unit,
      currency: cell.basis.currency,
      priceBasis: cell.basis.priceBasis,
      knownAt: cell.basis.knownAt,
    };
    const disposition = cell.value === null && ['observed', 'partial'].includes(cell.disposition)
      ? 'missing'
      : cell.disposition === 'observed' || (cell.disposition === 'partial' && cell.value !== null)
      ? 'included'
      : cell.disposition === 'missing' ? 'missing' : cell.disposition === 'withheld' ? 'withheld' : 'unavailable';
    const evidence = cell.evidence as unknown as readonly Readonly<Record<string, unknown>>[];
    const sourceRevisionIds = [...new Set(cell.evidence.map((item) => item.sourceRevisionId ?? item.contentHash).filter((item): item is string => Boolean(item)))];
    return {
      contributionId: hash([member.id, cell.sourceObservationId, basis]),
      memberId: member.id,
      targetKind: member.targetKind,
      targetId: member.targetId,
      label: member.label,
      basis,
      value: cell.value,
      disposition,
      sourceDisposition: cell.disposition,
      reason: disposition === 'included' ? (cell.disposition === 'partial' ? 'Included with partial evidence' : 'Source-qualified compatible contribution') : `Source cell is ${cell.disposition}`,
      sourceObservationId: cell.sourceObservationId,
      sourceRevisionIds,
      evidence,
      dedupKey: `${basisKey(basis)}:${cell.sourceObservationId}`,
      overlapsContributionId: null,
    };
  }

  private memberOnlyContribution(member: any, disposition: 'excluded' | 'unavailable', reason: string): ResearchPortfolioContributionDto {
    return {
      contributionId: hash([member.id, disposition, reason]),
      memberId: member.id,
      targetKind: member.targetKind,
      targetId: member.targetId,
      label: member.label,
      basis: null,
      value: null,
      disposition,
      sourceDisposition: null,
      reason,
      sourceObservationId: null,
      sourceRevisionIds: [],
      evidence: [],
      dedupKey: null,
      overlapsContributionId: null,
    };
  }

  private projectWhere(id: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ? { id }
      : id.includes(':')
        ? { peCode: id.split(':')[0], projectCode: id.split(':').slice(1).join(':') }
        : { id };
  }

  private snapshotSummary(row: any): ResearchPortfolioSnapshotSummaryDto {
    return {
      id: row.id,
      portfolioId: row.portfolioId,
      operationKey: row.operationKey,
      contentHash: row.contentHash,
      name: row.name,
      portfolioRevision: row.portfolioRevision,
      createdByUserId: row.createdByUserId,
      calculationVersion: row.calculationVersion,
      capturedAt: row.capturedAt.toISOString(),
    };
  }

  private snapshotDto(row: any): ResearchPortfolioSnapshotDto {
    return {
      ...this.snapshotSummary(row),
      basis: row.basis as Readonly<Record<string, unknown>>,
      membership: row.membership as readonly ResearchPortfolioMemberDto[],
      projection: row.projection as unknown as ResearchPortfolioAnalyticsDto,
      versions: {
        structure: row.structureVersions as Readonly<Record<string, unknown>>,
        rules: row.ruleVersions as readonly Readonly<Record<string, unknown>>[],
        decisions: row.decisionVersions as readonly Readonly<Record<string, unknown>>[],
        templates: row.templateVersions as readonly Readonly<Record<string, unknown>>[],
        taxonomy: row.taxonomyVersions as readonly Readonly<Record<string, unknown>>[],
        labels: row.labelVersions as readonly Readonly<Record<string, unknown>>[],
        sources: row.sourceVersions as readonly Readonly<Record<string, unknown>>[],
      },
      limitations: row.limitations as readonly string[],
      clientAccessRequirements: row.clientAccessRequirements as readonly string[],
      observedAt: row.observedAt.toISOString(),
      readAt: row.readAt.toISOString(),
    };
  }

  private memberDto(member: any): ResearchPortfolioMemberDto {
    return {
      id: member.id,
      targetKind: member.targetKind,
      targetId: member.targetId,
      label: member.label,
      disposition: member.disposition,
      origin: member.origin,
      reason: member.reason,
      unresolvedInput: member.unresolvedInput as Readonly<Record<string, unknown>> | null,
      resolvedAt: member.resolvedAt?.toISOString() ?? null,
      revision: member.revision,
      createdByUserId: member.createdByUserId,
      updatedByUserId: member.updatedByUserId,
      createdAt: member.createdAt.toISOString(),
      updatedAt: member.updatedAt.toISOString(),
    };
  }
}

export const researchPortfolioAnalyticsInternals = { stable, hash, basisKey, sumDecimals };
