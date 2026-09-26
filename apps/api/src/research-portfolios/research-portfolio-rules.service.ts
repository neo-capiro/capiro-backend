import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateResearchPortfolioTemplateDto,
  CreateResearchPortfolioTemplateVersionDto,
  PreviewResearchPortfolioRuleDto,
  PublishResearchPortfolioRuleDto,
  ResearchPortfolioRulePreviewDto,
  ResearchPortfolioRulePreviewItemDto,
  ResearchPortfolioRuleVersionDto,
  ResearchPortfolioTemplateDto,
  ResearchPortfolioTemplateVersionDto,
  ResearchTaxonomyVersionDto,
  TenantContext,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { evaluateRule, hashRule, parseRule, stableJson, type CandidateFact, type RuleNode } from './research-portfolio-rules.js';
import { materializeRuleCandidate } from './research-portfolio-targets.js';

type Tx = Prisma.TransactionClient;

@Injectable()
export class ResearchPortfolioRulesService {
  constructor(private readonly prisma: PrismaService) {}

  async taxonomy(ctx: TenantContext, version?: number): Promise<readonly ResearchTaxonomyVersionDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.researchTaxonomyVersion.findMany({
        where: { tenantId: ctx.tenantId, ...(version ? { version } : {}) },
        include: { concepts: { orderBy: [{ parentKey: 'asc' }, { name: 'asc' }] } },
        orderBy: { version: 'desc' },
        take: version ? 1 : 20,
      });
      return rows.map((row) => ({
        id: row.id,
        version: row.version,
        label: row.label,
        vocabulary: row.vocabulary as ResearchTaxonomyVersionDto['vocabulary'],
        source: row.source,
        provenance: row.provenance as Readonly<Record<string, unknown>>,
        publishedAt: row.publishedAt.toISOString(),
        concepts: row.concepts.map((concept) => ({
          id: concept.id,
          stableKey: concept.stableKey,
          name: concept.name,
          kind: concept.kind,
          parentKey: concept.parentKey,
          aliases: concept.aliases,
          provenance: concept.provenance as Readonly<Record<string, unknown>>,
          qualification: concept.qualification,
        })),
      }));
    });
  }

  async listTemplates(ctx: TenantContext): Promise<readonly ResearchPortfolioTemplateDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.researchPortfolioTemplate.findMany({
        where: { tenantId: ctx.tenantId },
        include: { versions: { orderBy: { version: 'desc' } } },
        orderBy: { name: 'asc' },
      });
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        versions: row.versions.map((version) => this.templateVersionDto(version)),
      }));
    });
  }

  async createTemplate(ctx: TenantContext, input: CreateResearchPortfolioTemplateDto): Promise<ResearchPortfolioTemplateDto> {
    if (ctx.role !== 'user_admin' && ctx.role !== 'capiro_admin') throw new ForbiddenException('Firm templates require administrator access');
    this.validateRuleEnvelope(input);
    const expression = parseRule(input.expression) as RuleNode;
    const name = input.name?.trim();
    if (!name || name.length > 200) throw new BadRequestException('Template name must be between 1 and 200 characters');
    const readableExpression = this.readableExpression(input.readableExpression);
    this.requireIdempotencyKey(input.idempotencyKey);
    const payloadFingerprint = createHash('sha256').update(stableJson({ operation: 'template.create', name, description: input.description?.trim() || null, expression, readableExpression, mode: input.mode, qualificationPolicy: input.qualificationPolicy, taxonomyVersionId: input.taxonomyVersionId ?? null })).digest('hex');
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const replay = await tx.researchPortfolioTemplateVersion.findFirst({ where: { tenantId: ctx.tenantId, operationKey: input.idempotencyKey }, include: { template: { include: { versions: { orderBy: { version: 'desc' } } } } } });
      if (replay) {
        if (replay.payloadFingerprint !== payloadFingerprint) throw new ConflictException('Idempotency key was already used with different content');
        return { id: replay.template.id, name: replay.template.name, description: replay.template.description, archivedAt: replay.template.archivedAt?.toISOString() ?? null, versions: replay.template.versions.map((item) => this.templateVersionDto(item)) };
      }
      await this.requireTaxonomyVersion(tx, ctx.tenantId, input.taxonomyVersionId ?? null);
      const existing = await tx.researchPortfolioTemplate.findUnique({ where: { tenantId_name: { tenantId: ctx.tenantId, name } }, include: { versions: { orderBy: { version: 'desc' } } } });
      if (existing) throw new ConflictException('A template with this name already exists; append an immutable version instead');
      const template = await tx.researchPortfolioTemplate.create({ data: { tenantId: ctx.tenantId, name, description: input.description?.trim() || null } });
      const version = await tx.researchPortfolioTemplateVersion.create({
        data: {
          tenantId: ctx.tenantId,
          templateId: template.id,
          version: 1,
          schemaVersion: 1,
          expression: expression as unknown as Prisma.InputJsonValue,
          readableExpression,
          mode: input.mode,
          qualificationPolicy: input.qualificationPolicy as Prisma.InputJsonValue,
          taxonomyVersionId: input.taxonomyVersionId ?? null,
          authorUserId: ctx.userId,
          operationKey: input.idempotencyKey,
          payloadFingerprint,
        },
      });
      return { id: template.id, name: template.name, description: template.description, archivedAt: null, versions: [this.templateVersionDto(version)] };
    });
  }

  async createTemplateVersion(ctx: TenantContext, templateId: string, input: CreateResearchPortfolioTemplateVersionDto): Promise<ResearchPortfolioTemplateVersionDto> {
    if (ctx.role !== 'user_admin' && ctx.role !== 'capiro_admin') throw new ForbiddenException('Firm templates require administrator access');
    this.validateRuleEnvelope(input);
    this.requireIdempotencyKey(input.idempotencyKey);
    const expression = parseRule(input.expression) as RuleNode;
    const readableExpression = this.readableExpression(input.readableExpression);
    const payloadFingerprint = createHash('sha256').update(stableJson({ operation: 'template.version.create', templateId, expression, readableExpression, mode: input.mode, qualificationPolicy: input.qualificationPolicy, taxonomyVersionId: input.taxonomyVersionId ?? null })).digest('hex');
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const replay = await tx.researchPortfolioTemplateVersion.findFirst({ where: { tenantId: ctx.tenantId, operationKey: input.idempotencyKey } });
      if (replay) {
        if (replay.payloadFingerprint !== payloadFingerprint) throw new ConflictException('Idempotency key was already used with different content');
        return this.templateVersionDto(replay);
      }
      await this.requireTaxonomyVersion(tx, ctx.tenantId, input.taxonomyVersionId ?? null);
      const template = await tx.researchPortfolioTemplate.findFirst({ where: { id: templateId, tenantId: ctx.tenantId, archivedAt: null }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
      if (!template) throw new NotFoundException('Template not found');
      const previous = template.versions[0] ?? null;
      const version = await tx.researchPortfolioTemplateVersion.create({ data: {
        tenantId: ctx.tenantId, templateId, version: (previous?.version ?? 0) + 1, schemaVersion: 1,
        expression: expression as unknown as Prisma.InputJsonValue, readableExpression, mode: input.mode,
        qualificationPolicy: input.qualificationPolicy as Prisma.InputJsonValue,
        taxonomyVersionId: input.taxonomyVersionId ?? null, authorUserId: ctx.userId,
        predecessorId: previous?.id ?? null, operationKey: input.idempotencyKey, payloadFingerprint,
      } });
      return this.templateVersionDto(version);
    });
  }

  async templateVersion(ctx: TenantContext, templateId: string, versionId: string): Promise<ResearchPortfolioTemplateVersionDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.researchPortfolioTemplateVersion.findFirst({ where: { id: versionId, tenantId: ctx.tenantId, templateId } });
      if (!row) throw new NotFoundException('Template version not found');
      return this.templateVersionDto(row);
    });
  }

  async listRules(ctx: TenantContext, portfolioId: string): Promise<readonly ResearchPortfolioRuleVersionDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.authorize(tx, ctx, portfolioId, 'viewer');
      const rows = await tx.researchPortfolioRuleVersion.findMany({
        where: { tenantId: ctx.tenantId, portfolioId },
        include: { jobs: { orderBy: { createdAt: 'desc' }, take: 1 } },
        orderBy: { version: 'desc' },
      });
      return rows.map((row) => this.ruleVersionDto(row, row.jobs[0] ?? null));
    });
  }

  async preview(ctx: TenantContext, portfolioId: string, input: PreviewResearchPortfolioRuleDto): Promise<ResearchPortfolioRulePreviewDto> {
    this.validateRuleEnvelope(input, false);
    if (!Array.isArray(input.candidates)) throw new BadRequestException('Rule candidates must be an array');
    if (input.candidates.length > 200) throw new BadRequestException('Rule preview is limited to 200 candidates');
    const candidateKeys = input.candidates.map((candidate) => {
      if (!['program', 'program_element', 'project', 'budget_line', 'award'].includes(candidate.targetKind) || typeof candidate.targetId !== 'string' || !candidate.targetId.trim()) throw new BadRequestException('Each rule candidate requires a supported targetKind and targetId');
      return `${candidate.targetKind}:${candidate.targetId}`;
    });
    if (new Set(candidateKeys).size !== candidateKeys.length) throw new BadRequestException('Rule candidates must be unique by typed target');
    const expression = parseRule(input.expression) as RuleNode;
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const access = await this.authorize(tx, ctx, portfolioId, 'editor');
      if (access.portfolio.lifecycle !== 'active') throw new ConflictException('Archived portfolios are read-only');
      if (access.portfolio.revision !== input.expectedRevision) throw new ConflictException('Portfolio revision is stale');
      const members = await tx.researchPortfolioMember.findMany({ where: { tenantId: ctx.tenantId, portfolioId } });
      const memberByTarget = new Map(members.map((member) => [`${member.targetKind}:${member.targetId}`, member]));
      const candidates = await Promise.all(input.candidates.map((candidate) => materializeRuleCandidate(tx, candidate)));
      const items = candidates.map((candidate): ResearchPortfolioRulePreviewItemDto => {
        const existing = memberByTarget.get(`${candidate.targetKind}:${candidate.targetId}`);
        const evaluation = evaluateRule(expression, {
          ...candidate.facts,
          _completeness: candidate.completeness ?? 'complete',
          _unknownReasons: candidate.unknownReasons ?? [],
        } as CandidateFact);
        let disposition: ResearchPortfolioRulePreviewItemDto['disposition'];
        if (evaluation.result === 'unknown') disposition = 'unknown';
        else if (evaluation.result === 'match') {
          if (existing?.disposition === 'excluded') disposition = 'manual_override';
          else if (existing?.disposition === 'included') disposition = 'retained';
          else if (existing?.disposition === 'withdrawn' && existing.origin === 'rule') disposition = input.qualificationPolicy.autoAdd === true ? 'added' : 'candidate';
          else disposition = input.qualificationPolicy.autoAdd === true ? 'added' : 'candidate';
        } else if (existing?.disposition === 'included') disposition = existing.origin === 'manual' ? 'manual_override' : 'accepted_nonmatch';
        else if (existing?.disposition === 'candidate' && existing.origin === 'rule') disposition = 'withdrawn';
        else disposition = 'not_evaluated';
        return { targetKind: candidate.targetKind, targetId: candidate.targetId, label: candidate.label ?? null, result: evaluation.result, disposition, reasons: evaluation.reasons };
      });
      const complete = candidates.every((candidate) => (candidate.completeness ?? 'complete') === 'complete') && items.every((item) => item.result !== 'unknown');
      const counts = this.countPreview(items);
      const canonicalInput = { ...input, candidates };
      const context = { portfolioId, portfolioRevision: input.expectedRevision, expression, input: canonicalInput, items, complete };
      const previewHash = hashRule(expression, context);
      const requestFingerprint = createHash('sha256').update(stableJson(canonicalInput)).digest('hex');
      const expiresAt = new Date(Date.now() + 30 * 60_000);
      const row = await tx.researchPortfolioRulePreview.upsert({
        where: { tenantId_portfolioId_previewHash: { tenantId: ctx.tenantId, portfolioId, previewHash } },
        create: { tenantId: ctx.tenantId, portfolioId, portfolioRevision: input.expectedRevision, previewHash, requestFingerprint, expression: expression as unknown as Prisma.InputJsonValue, manifest: { items, counts, complete, request: canonicalInput } as unknown as Prisma.InputJsonValue, createdByUserId: ctx.userId, expiresAt },
        update: { expiresAt },
      });
      return { previewId: row.id, previewHash, portfolioRevision: input.expectedRevision, expiresAt: row.expiresAt.toISOString(), complete, counts, items };
    });
  }

  async publish(ctx: TenantContext, portfolioId: string, input: PublishResearchPortfolioRuleDto): Promise<ResearchPortfolioRuleVersionDto> {
    this.requireIdempotencyKey(input.idempotencyKey);
    const payloadFingerprint = createHash('sha256').update(stableJson({ operation: 'rule.publish', portfolioId, input })).digest('hex');
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const replay = await tx.researchPortfolioEvent.findFirst({ where: { tenantId: ctx.tenantId, idempotencyKey: input.idempotencyKey } });
      if (replay) {
        if (replay.payloadFingerprint !== payloadFingerprint) throw new ConflictException('Idempotency key was already used with different content');
        const payload = replay.payload as { ruleVersionId?: string };
        const row = payload.ruleVersionId ? await tx.researchPortfolioRuleVersion.findFirst({ where: { id: payload.ruleVersionId, tenantId: ctx.tenantId }, include: { jobs: { orderBy: { createdAt: 'desc' }, take: 1 } } }) : null;
        if (!row) throw new ConflictException('The prior rule operation cannot be reconstructed');
        return this.ruleVersionDto(row, row.jobs[0] ?? null);
      }
      const access = await this.authorize(tx, ctx, portfolioId, 'editor');
      if (access.portfolio.lifecycle !== 'active') throw new ConflictException('Archived portfolios are read-only');
      if (access.portfolio.revision !== input.expectedRevision) throw new ConflictException('Portfolio revision is stale');
      const preview = await tx.researchPortfolioRulePreview.findFirst({ where: { id: input.previewId, tenantId: ctx.tenantId, portfolioId } });
      if (!preview || preview.previewHash !== input.previewHash || preview.expiresAt <= new Date()) throw new ConflictException('Rule preview is missing, expired, or changed');
      if (preview.portfolioRevision !== input.expectedRevision) throw new ConflictException('Rule preview was created for a stale portfolio revision');
      const manifest = preview.manifest as unknown as { items: ResearchPortfolioRulePreviewItemDto[]; complete: boolean; request: PreviewResearchPortfolioRuleDto };
      const previous = await tx.researchPortfolioRuleVersion.findFirst({ where: { tenantId: ctx.tenantId, portfolioId }, orderBy: { version: 'desc' } });
      const request = manifest.request;
      const rule = await tx.researchPortfolioRuleVersion.create({
        data: {
          tenantId: ctx.tenantId, portfolioId, version: (previous?.version ?? 0) + 1, schemaVersion: 1,
          expression: preview.expression as Prisma.InputJsonValue, readableExpression: request.readableExpression,
          mode: request.mode, qualificationPolicy: request.qualificationPolicy as Prisma.InputJsonValue,
          taxonomyVersionId: request.taxonomyVersionId ?? null, templateVersionId: request.templateVersionId ?? null,
          previewHash: preview.previewHash, authorUserId: ctx.userId, predecessorId: previous?.id ?? null,
        },
      });
      const job = await tx.researchPortfolioRecomputeJob.create({ data: { tenantId: ctx.tenantId, portfolioId, ruleVersionId: rule.id, operationKey: input.idempotencyKey, status: 'running', attempt: 1, leaseOwner: 'inline-bounded-v1', leaseUntil: new Date(Date.now() + 60_000) } });
      const recompute = await this.applyBoundedPreview(tx, ctx, portfolioId, rule.id, manifest.items, manifest.complete);
      const finishedJob = await tx.researchPortfolioRecomputeJob.update({ where: { id: job.id }, data: { status: recompute.partial ? 'partial' : 'completed', processedCount: manifest.items.length, matchedCount: recompute.matched, unknownCount: recompute.unknown, leaseOwner: null, leaseUntil: null, result: recompute as unknown as Prisma.InputJsonValue } });
      const updated = await tx.researchPortfolio.updateMany({ where: { id: portfolioId, tenantId: ctx.tenantId, revision: input.expectedRevision, lifecycle: 'active' }, data: { revision: { increment: 1 }, mode: request.mode } });
      if (updated.count !== 1) throw new ConflictException('Portfolio revision changed during rule publication');
      const resultingRevision = input.expectedRevision + 1;
      await tx.researchPortfolioEvent.create({ data: { tenantId: ctx.tenantId, portfolioId, eventKind: 'rule_published', aggregateRevision: resultingRevision, actorUserId: ctx.userId, idempotencyKey: input.idempotencyKey, payloadFingerprint, payload: { ruleVersionId: rule.id, operationId: job.id, resultingRevision, recompute } as unknown as Prisma.InputJsonValue } });
      return this.ruleVersionDto(rule, finishedJob);
    });
  }

  private async applyBoundedPreview(tx: Tx, ctx: TenantContext, portfolioId: string, ruleVersionId: string, items: ResearchPortfolioRulePreviewItemDto[], complete: boolean) {
    let matched = 0; let unknown = 0; let added = 0; let withdrawn = 0;
    for (const item of items) {
      if (item.result === 'unknown') unknown += 1;
      if (item.result === 'match') matched += 1;
      const existing = await tx.researchPortfolioMember.findUnique({ where: { tenantId_portfolioId_targetKind_targetId: { tenantId: ctx.tenantId, portfolioId, targetKind: item.targetKind, targetId: item.targetId } } });
      if (item.disposition === 'added' || item.disposition === 'candidate') {
        const disposition = item.disposition === 'added' ? 'included' : 'candidate';
        if (!existing) {
          await tx.researchPortfolioMember.create({ data: { tenantId: ctx.tenantId, portfolioId, targetKind: item.targetKind, targetId: item.targetId, label: item.label, disposition, origin: 'rule', reason: item.reasons.join('; ') || 'Matched published rule', ruleVersionId, qualification: item.result === 'match' ? 'qualified' : 'unknown', createdByUserId: ctx.userId, updatedByUserId: ctx.userId } });
          added += 1;
        } else if (existing.origin === 'rule' && existing.disposition === 'withdrawn') {
          await tx.researchPortfolioMember.update({ where: { id: existing.id }, data: { disposition, ruleVersionId, label: item.label ?? existing.label, reason: item.reasons.join('; ') || 'Matched published rule', qualification: item.result === 'match' ? 'qualified' : 'unknown', revision: { increment: 1 }, updatedByUserId: ctx.userId } });
          added += 1;
        }
      } else if (item.disposition === 'withdrawn' && complete && existing?.origin === 'rule' && existing.disposition === 'candidate') {
        await tx.researchPortfolioMember.update({ where: { id: existing.id }, data: { disposition: 'withdrawn', ruleVersionId, reason: item.reasons.join('; ') || 'No longer matches the published rule', revision: { increment: 1 }, updatedByUserId: ctx.userId } });
        withdrawn += 1;
      } else if (existing?.origin === 'rule' && existing.disposition === 'candidate' && item.result === 'match') {
        await tx.researchPortfolioMember.update({ where: { id: existing.id }, data: { ruleVersionId, label: item.label ?? existing.label, reason: item.reasons.join('; ') || existing.reason, revision: { increment: 1 }, updatedByUserId: ctx.userId } });
      }
    }
    return { matched, unknown, added, withdrawn, partial: !complete };
  }

  private async authorize(tx: Tx, ctx: TenantContext, portfolioId: string, required: 'viewer' | 'editor') {
    const grant = await tx.researchPortfolioGrant.findUnique({ where: { tenantId_portfolioId_principalUserId: { tenantId: ctx.tenantId, portfolioId, principalUserId: ctx.userId } }, include: { portfolio: true } });
    if (!grant) throw new NotFoundException('Research portfolio not found');
    if (required === 'editor' && grant.role === 'viewer') throw new ForbiddenException('Editor access is required');
    return grant;
  }

  private countPreview(items: readonly ResearchPortfolioRulePreviewItemDto[]): ResearchPortfolioRulePreviewDto['counts'] {
    const counts = { added: 0, retained: 0, withdrawn: 0, accepted_nonmatch: 0, manual_override: 0, candidate: 0, unknown: 0, not_evaluated: 0 };
    for (const item of items) counts[item.disposition] += 1;
    return counts;
  }
  private templateVersionDto(row: any): ResearchPortfolioTemplateVersionDto {
    return { id: row.id, version: row.version, schemaVersion: 1, expression: row.expression, readableExpression: row.readableExpression, mode: row.mode, qualificationPolicy: row.qualificationPolicy, taxonomyVersionId: row.taxonomyVersionId, publishedAt: row.publishedAt.toISOString() };
  }
  private ruleVersionDto(row: any, job: any | null): ResearchPortfolioRuleVersionDto {
    return { id: row.id, version: row.version, schemaVersion: 1, expression: row.expression, readableExpression: row.readableExpression, mode: row.mode, qualificationPolicy: row.qualificationPolicy, taxonomyVersionId: row.taxonomyVersionId, templateVersionId: row.templateVersionId, previewHash: row.previewHash, authorUserId: row.authorUserId, predecessorId: row.predecessorId, publishedAt: row.publishedAt.toISOString(), recompute: job ? { operationId: job.id, status: job.status } : null };
  }
  private async requireTaxonomyVersion(tx: Tx, tenantId: string, taxonomyVersionId: string | null): Promise<void> {
    if (!taxonomyVersionId) return;
    const row = await tx.researchTaxonomyVersion.findFirst({ where: { id: taxonomyVersionId, tenantId }, select: { id: true } });
    if (!row) throw new BadRequestException('Taxonomy version is unavailable to this tenant');
  }
  private validateRuleEnvelope(input: { schemaVersion: number; mode: string; qualificationPolicy: Readonly<Record<string, unknown>> }, allowManual = true): void {
    if (input.schemaVersion !== 1) throw new BadRequestException('Unsupported rule schema version');
    const modes = allowManual ? ['manual', 'rules', 'hybrid'] : ['rules', 'hybrid'];
    if (!modes.includes(input.mode)) throw new BadRequestException('Unsupported rule mode');
    if (!input.qualificationPolicy || typeof input.qualificationPolicy !== 'object' || Array.isArray(input.qualificationPolicy)) throw new BadRequestException('qualificationPolicy must be an object');
  }
  private readableExpression(value: string): string { const readable = value?.trim(); if (!readable || readable.length > 10_000) throw new BadRequestException('readableExpression must be between 1 and 10000 characters'); return readable; }
  private requireIdempotencyKey(value: string) { if (!value || value.length > 128) throw new BadRequestException('idempotencyKey must be between 1 and 128 characters'); }
}
