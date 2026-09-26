import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type {
  CreateResearchPortfolioOutputDto,
  ResearchPortfolioAnalyticsDto,
  ResearchPortfolioClientFileReceiptDto,
  ResearchPortfolioOutputArtifactDto,
  ResearchPortfolioOutputAttemptDto,
  ResearchPortfolioOutputJobDto,
  ResearchPortfolioOutputRequestDto,
  SaveResearchPortfolioOutputToClientDto,
  TenantContext,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientDocumentWriterService } from '../client-documents/client-document-writer.service.js';
import {
  assertResearchPortfolioClientAccess,
  loadAuthorizedResearchPortfolio,
} from './research-portfolio-access.js';
import { ResearchPortfolioAnalyticsService } from './research-portfolio-analytics.service.js';

const CSV_MEDIA_TYPE = 'text/csv';
const OUTPUT_SECTIONS = new Set(['analytics', 'totals', 'contributions', 'sources']);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function formulaSafe(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function projectionCsv(
  projection: ResearchPortfolioAnalyticsDto,
  selectedSections: readonly string[] = ['analytics', 'totals', 'contributions', 'sources'],
  includeSourceAppendix = true,
): Buffer {
  const selected = new Set(selectedSections);
  const headers = [
    'section',
    'record_key',
    'member_type',
    'member_id',
    'label',
    'request_edition',
    'funding_fiscal_year',
    'stage',
    'metric',
    'unit',
    'currency',
    'price_basis',
    'known_at',
    'value',
    'disposition',
    'reason',
    'source_observation_id',
    'source_revision_ids',
    'detail',
  ];
  const rows: unknown[][] = [];
  if (selected.has('analytics')) {
    rows.push([
      'analytics',
      'summary',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      projection.availability,
      '',
      '',
      '',
      JSON.stringify({
        portfolioRevision: projection.portfolioRevision,
        calculationVersion: projection.calculationVersion,
        coverage: projection.coverage,
        limitations: projection.limitations,
        observedAt: projection.observedAt,
        readAt: projection.readAt,
      }),
    ]);
  }
  if (selected.has('totals')) {
    for (const [index, total] of projection.totals.entries()) {
      rows.push([
        'totals',
        `total-${index + 1}`,
        '',
        '',
        '',
        total.basis.requestEdition,
        total.basis.fundingFiscalYear,
        total.basis.stage,
        total.basis.metric,
        total.basis.unit,
        total.basis.currency,
        total.basis.priceBasis,
        total.basis.knownAt,
        total.value,
        'included',
        '',
        '',
        '',
        JSON.stringify({ contributionCount: total.contributionCount }),
      ]);
    }
  }
  if (selected.has('contributions')) {
    for (const item of projection.contributions) {
      rows.push([
        'contributions',
        item.contributionId,
        item.targetKind,
        item.targetId,
        item.label,
        item.basis?.requestEdition,
        item.basis?.fundingFiscalYear,
        item.basis?.stage,
        item.basis?.metric,
        item.basis?.unit,
        item.basis?.currency,
        item.basis?.priceBasis,
        item.basis?.knownAt,
        item.value,
        item.disposition,
        item.reason,
        item.sourceObservationId,
        item.sourceRevisionIds.join('|'),
        '',
      ]);
    }
  }
  if (selected.has('sources') && includeSourceAppendix) {
    const sourceIds = [
      ...new Set(projection.contributions.flatMap((item) => item.sourceRevisionIds)),
    ].sort();
    for (const sourceId of sourceIds) {
      rows.push([
        'sources',
        sourceId,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        'source',
        '',
        '',
        sourceId,
        '',
      ]);
    }
  }
  return Buffer.from(
    `${[headers, ...rows].map((row) => row.map(formulaSafe).join(',')).join('\r\n')}\r\n`,
    'utf8',
  );
}

@Injectable()
export class ResearchPortfolioOutputService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: ResearchPortfolioAnalyticsService,
    private readonly clientDocuments: ClientDocumentWriterService,
  ) {}

  async create(
    ctx: TenantContext,
    portfolioId: string,
    input: CreateResearchPortfolioOutputDto,
  ): Promise<ResearchPortfolioOutputJobDto> {
    if (!input.operationKey || input.operationKey.length > 128)
      throw new BadRequestException('operationKey must be between 1 and 128 characters');
    if (input.format !== 'csv')
      throw new BadRequestException('Only CSV research outputs are configured');
    const selectedSections = [
      ...new Set(input.selectedSections ?? ['analytics', 'totals', 'contributions', 'sources']),
    ].sort();
    if (
      !selectedSections.length ||
      selectedSections.some((section) => !OUTPUT_SECTIONS.has(section))
    ) {
      throw new BadRequestException(
        'selectedSections must contain only analytics, totals, contributions, or sources',
      );
    }
    const normalized = {
      portfolioId,
      snapshotId: input.snapshotId ?? null,
      selectedSections,
      includeSourceAppendix: input.includeSourceAppendix ?? true,
      format: input.format,
      deadlineAt: input.deadlineAt ?? null,
    };
    const requestHash = sha256(stable(normalized));
    const identifiers = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const replay = await tx.researchPortfolioOutputRequest.findUnique({
        where: {
          tenantId_operationKey: { tenantId: ctx.tenantId, operationKey: input.operationKey },
        },
        include: { jobs: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      if (replay) {
        if (replay.requestHash !== requestHash || replay.portfolioId !== portfolioId)
          throw new ConflictException('This output operation key was used for different content');
        const job = replay.jobs[0];
        if (!job) throw new ConflictException('Output request has no durable job');
        return { jobId: job.id, replay: true };
      }
      if (normalized.snapshotId) {
        const snapshot = await tx.researchPortfolioSnapshot.findFirst({
          where: { id: normalized.snapshotId, portfolioId },
        });
        if (!snapshot) throw new NotFoundException('Research portfolio snapshot not found');
      }
      const request = await tx.researchPortfolioOutputRequest.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          snapshotId: normalized.snapshotId,
          operationKey: input.operationKey,
          requestHash,
          context: { portfolioRevision: portfolio.revision } as Prisma.InputJsonValue,
          selectedSections: normalized.selectedSections,
          includeSourceAppendix: normalized.includeSourceAppendix,
          format: 'csv',
          requestedByUserId: ctx.userId,
          deadlineAt: normalized.deadlineAt ? new Date(normalized.deadlineAt) : null,
        },
      });
      const job = await tx.researchPortfolioOutputJob.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          requestId: request.id,
          operationKey: `${input.operationKey}:job`,
          deadlineAt: request.deadlineAt,
        },
      });
      return { jobId: job.id, replay: false };
    });
    if (!identifiers.replay) await this.process(ctx, portfolioId, identifiers.jobId);
    return this.get(ctx, portfolioId, identifiers.jobId);
  }

  async get(
    ctx: TenantContext,
    portfolioId: string,
    jobId: string,
  ): Promise<ResearchPortfolioOutputJobDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const row = await tx.researchPortfolioOutputJob.findFirst({
        where: { id: jobId, portfolioId },
        include: {
          request: true,
          attempts: { orderBy: { attemptNumber: 'asc' } },
          artifacts: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      });
      if (!row) throw new NotFoundException('Research portfolio output job not found');
      return this.jobDto(row);
    });
  }

  async cancel(
    ctx: TenantContext,
    portfolioId: string,
    jobId: string,
  ): Promise<ResearchPortfolioOutputJobDto> {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const row = await tx.researchPortfolioOutputJob.findFirst({
        where: { id: jobId, portfolioId },
      });
      if (!row) throw new NotFoundException('Research portfolio output job not found');
      if (['completed', 'partial'].includes(row.status))
        throw new ConflictException('Completed output jobs cannot be cancelled');
      if (row.status !== 'cancelled') {
        await tx.researchPortfolioOutputJob.update({
          where: { id: row.id },
          data: { status: 'cancelled', leaseOwner: null, leaseUntil: null },
        });
        await tx.researchPortfolioOutputRequest.update({
          where: { id: row.requestId },
          data: { status: 'cancelled' },
        });
        await tx.researchPortfolioOutputAttempt.create({
          data: {
            tenantId: ctx.tenantId,
            portfolioId,
            jobId,
            attemptNumber: row.attemptCount + 1,
            operationKey: `${row.operationKey}:cancel:${row.attemptCount + 1}`,
            action: 'cancel',
            outcome: 'cancelled',
            actorUserId: ctx.userId,
            completedAt: new Date(),
          },
        });
      }
    });
    return this.get(ctx, portfolioId, jobId);
  }

  async retry(
    ctx: TenantContext,
    portfolioId: string,
    jobId: string,
  ): Promise<ResearchPortfolioOutputJobDto> {
    const retryable = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const row = await tx.researchPortfolioOutputJob.findFirst({
        where: { id: jobId, portfolioId },
      });
      if (!row) throw new NotFoundException('Research portfolio output job not found');
      if (!['failed', 'outcome_unknown', 'cancelled'].includes(row.status))
        throw new ConflictException(
          'Only failed, cancelled, or outcome-unknown jobs can be retried',
        );
      await tx.researchPortfolioOutputJob.update({
        where: { id: row.id },
        data: { status: 'queued', lastError: null, lastErrorCode: null },
      });
      await tx.researchPortfolioOutputRequest.update({
        where: { id: row.requestId },
        data: { status: 'queued' },
      });
      return true;
    });
    if (retryable) await this.process(ctx, portfolioId, jobId, 'retry');
    return this.get(ctx, portfolioId, jobId);
  }

  async reconcile(
    ctx: TenantContext,
    portfolioId: string,
    jobId: string,
  ): Promise<ResearchPortfolioOutputJobDto> {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const row = await tx.researchPortfolioOutputJob.findFirst({
        where: { id: jobId, portfolioId },
        include: { artifacts: { take: 1 } },
      });
      if (!row) throw new NotFoundException('Research portfolio output job not found');
      const next = row.artifacts.length ? 'completed' : 'outcome_unknown';
      await tx.researchPortfolioOutputJob.update({ where: { id: row.id }, data: { status: next } });
      await tx.researchPortfolioOutputRequest.update({
        where: { id: row.requestId },
        data: { status: next },
      });
      await tx.researchPortfolioOutputAttempt.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          jobId,
          attemptNumber: row.attemptCount + 1,
          operationKey: `${row.operationKey}:reconcile:${row.attemptCount + 1}`,
          action: 'reconcile',
          outcome: next,
          checkpoint: { artifactObserved: row.artifacts.length === 1 },
          actorUserId: ctx.userId,
          completedAt: new Date(),
        },
      });
      await tx.researchPortfolioOutputJob.update({
        where: { id: row.id },
        data: { attemptCount: { increment: 1 } },
      });
    });
    return this.get(ctx, portfolioId, jobId);
  }

  async download(ctx: TenantContext, portfolioId: string, outputId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const artifact = await tx.researchPortfolioOutputArtifact.findFirst({
        where: { id: outputId, portfolioId },
        include: { job: true },
      });
      if (!artifact || !['completed', 'partial'].includes(artifact.job.status))
        throw new NotFoundException('Research portfolio output not found');
      return {
        bytes: Buffer.from(artifact.bytes),
        mediaType: artifact.mediaType,
        fileName: artifact.fileName,
        contentHash: artifact.contentHash,
      };
    });
  }

  async saveToClient(
    ctx: TenantContext,
    portfolioId: string,
    outputId: string,
    input: SaveResearchPortfolioOutputToClientDto,
  ): Promise<ResearchPortfolioClientFileReceiptDto> {
    if (!input.operationKey || input.operationKey.length > 128)
      throw new BadRequestException('operationKey must be between 1 and 128 characters');
    const prepared = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      if (!portfolio.clientLinks.some((link: any) => link.clientId === input.clientId))
        throw new NotFoundException('Linked client not found');
      await assertResearchPortfolioClientAccess(tx, ctx, [input.clientId]);
      const replay = await tx.researchPortfolioOutputClientFileReceipt.findUnique({
        where: {
          tenantId_operationKey: { tenantId: ctx.tenantId, operationKey: input.operationKey },
        },
      });
      if (replay) {
        if (replay.artifactId !== outputId || replay.clientId !== input.clientId)
          throw new ConflictException(
            'This client-file operation key was used for different content',
          );
        return { replay };
      }
      const artifact = await tx.researchPortfolioOutputArtifact.findFirst({
        where: { id: outputId, portfolioId },
        include: { job: true },
      });
      if (!artifact || !['completed', 'partial'].includes(artifact.job.status))
        throw new NotFoundException('Research portfolio output not found');
      return { artifact };
    });
    if ('replay' in prepared) return this.receiptDto(prepared.replay);
    const artifact = prepared.artifact;
    const saved = await this.clientDocuments.createAttachmentFromBuffer(ctx, {
      clientId: input.clientId,
      fileName: artifact.fileName,
      contentType: artifact.mediaType,
      buffer: Buffer.from(artifact.bytes),
      source: 'research_portfolio_output',
      sourceEntityType: 'research_portfolio_output',
      sourceEntityId: artifact.id,
      sourceVersion: 1,
      sourceContentHash: artifact.contentHash,
      idempotencyKey: input.operationKey,
    });
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.researchPortfolioOutputClientFileReceipt.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          artifactId: artifact.id,
          clientId: input.clientId,
          operationKey: input.operationKey,
          attachmentId: saved.id,
          attachmentName: saved.fileName,
          lifecycleStatus: saved.lifecycleStatus ?? null,
          scanStatus: saved.scanStatus ?? null,
          indexedAt: saved.indexedAt ?? null,
          openPath: `/clients?clientId=${encodeURIComponent(input.clientId)}&tab=files&attachmentId=${encodeURIComponent(saved.id)}`,
        },
      });
      return this.receiptDto(row);
    });
  }

  private async process(
    ctx: TenantContext,
    portfolioId: string,
    jobId: string,
    action: 'process' | 'retry' = 'process',
  ): Promise<void> {
    const leaseToken = randomUUID();
    const claimed = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.researchPortfolioOutputJob.findFirst({
        where: { id: jobId, portfolioId },
        include: { request: true },
      });
      if (!row) throw new NotFoundException('Research portfolio output job not found');
      const result = await tx.researchPortfolioOutputJob.updateMany({
        where: { id: row.id, status: 'queued' },
        data: {
          status: 'running',
          leaseOwner: leaseToken,
          leaseUntil: new Date(Date.now() + 60_000),
          leaseFence: { increment: 1 },
          attemptCount: { increment: 1 },
        },
      });
      if (result.count !== 1) return null;
      await tx.researchPortfolioOutputRequest.update({
        where: { id: row.requestId },
        data: { status: 'running' },
      });
      return {
        request: row.request,
        attemptNumber: row.attemptCount + 1,
        fence: row.leaseFence + 1,
      };
    });
    if (!claimed) return;
    try {
      const projection = claimed.request.snapshotId
        ? await this.prisma.withTenant(ctx.tenantId, async (tx) => {
            await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
            const snapshot = await tx.researchPortfolioSnapshot.findFirst({
              where: { id: claimed.request.snapshotId!, portfolioId },
            });
            if (!snapshot) throw new NotFoundException('Research portfolio snapshot not found');
            return snapshot.projection as unknown as ResearchPortfolioAnalyticsDto;
          })
        : await this.analytics.analytics(ctx, portfolioId);
      const bytes = projectionCsv(
        projection,
        claimed.request.selectedSections,
        claimed.request.includeSourceAppendix,
      );
      const contentHash = sha256(bytes);
      const fileName = `research-portfolio-${portfolioId}-${claimed.request.snapshotId ?? 'current'}.csv`;
      const terminal = projection.availability === 'available' ? 'completed' : 'partial';
      await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const artifact = await tx.researchPortfolioOutputArtifact.create({
          data: {
            tenantId: ctx.tenantId,
            portfolioId,
            jobId,
            contentHash,
            byteSize: bytes.byteLength,
            mediaType: CSV_MEDIA_TYPE,
            fileName,
            bytes,
          },
        });
        await tx.researchPortfolioOutputAttempt.create({
          data: {
            tenantId: ctx.tenantId,
            portfolioId,
            jobId,
            attemptNumber: claimed.attemptNumber,
            operationKey: `${claimed.request.operationKey}:${action}:${claimed.attemptNumber}`,
            action,
            outcome: terminal,
            checkpoint: { leaseFence: claimed.fence },
            receipt: { artifactId: artifact.id, contentHash, byteSize: bytes.byteLength },
            actorUserId: ctx.userId,
            completedAt: new Date(),
          },
        });
        const updated = await tx.researchPortfolioOutputJob.updateMany({
          where: {
            id: jobId,
            leaseOwner: leaseToken,
            leaseFence: claimed.fence,
            status: 'running',
          },
          data: { status: terminal, leaseOwner: null, leaseUntil: null },
        });
        if (updated.count !== 1)
          throw new ConflictException('Output job lease was lost before finalization');
        await tx.researchPortfolioOutputRequest.update({
          where: { id: claimed.request.id },
          data: { status: terminal },
        });
      });
    } catch (error) {
      await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const message = error instanceof Error ? error.message : 'Output processing failed';
        await tx.researchPortfolioOutputJob.updateMany({
          where: { id: jobId, leaseOwner: leaseToken },
          data: {
            status: 'failed',
            leaseOwner: null,
            leaseUntil: null,
            lastErrorCode: 'OUTPUT_FAILED',
            lastError: message,
          },
        });
        await tx.researchPortfolioOutputRequest.update({
          where: { id: claimed.request.id },
          data: { status: 'failed' },
        });
        await tx.researchPortfolioOutputAttempt.create({
          data: {
            tenantId: ctx.tenantId,
            portfolioId,
            jobId,
            attemptNumber: claimed.attemptNumber,
            operationKey: `${claimed.request.operationKey}:${action}:${claimed.attemptNumber}`,
            action,
            outcome: 'failed',
            checkpoint: { leaseFence: claimed.fence },
            errorCode: 'OUTPUT_FAILED',
            receipt: { message },
            actorUserId: ctx.userId,
            completedAt: new Date(),
          },
        });
      });
    }
  }

  private jobDto(row: any): ResearchPortfolioOutputJobDto {
    const artifact = row.artifacts?.[0] ?? null;
    return {
      id: row.id,
      requestId: row.requestId,
      operationKey: row.operationKey,
      status: row.status,
      attemptCount: row.attemptCount,
      deadlineAt: row.deadlineAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      request: this.requestDto(row.request),
      attempts: (row.attempts ?? []).map((attempt: any) => this.attemptDto(attempt)),
      artifact: artifact ? this.artifactDto(artifact, row.portfolioId) : null,
    };
  }

  private requestDto(row: any): ResearchPortfolioOutputRequestDto {
    return {
      id: row.id,
      portfolioId: row.portfolioId,
      snapshotId: row.snapshotId,
      operationKey: row.operationKey,
      requestHash: row.requestHash,
      selectedSections: row.selectedSections,
      includeSourceAppendix: row.includeSourceAppendix,
      format: row.format,
      status: row.status,
      requestedByUserId: row.requestedByUserId,
      requestedAt: row.requestedAt.toISOString(),
      deadlineAt: row.deadlineAt?.toISOString() ?? null,
    } as ResearchPortfolioOutputRequestDto;
  }

  private attemptDto(row: any): ResearchPortfolioOutputAttemptDto {
    return {
      id: row.id,
      attemptNumber: row.attemptNumber,
      operationKey: row.operationKey,
      action: row.action,
      outcome: row.outcome,
      checkpoint: row.checkpoint as Readonly<Record<string, unknown>>,
      receipt: row.receipt as Readonly<Record<string, unknown>>,
      errorCode: row.errorCode,
      actorUserId: row.actorUserId,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  private artifactDto(row: any, portfolioId: string): ResearchPortfolioOutputArtifactDto {
    return {
      id: row.id,
      contentHash: row.contentHash,
      byteSize: row.byteSize,
      mediaType: row.mediaType,
      fileName: row.fileName,
      createdAt: row.createdAt.toISOString(),
      downloadPath: `/research-portfolios/${encodeURIComponent(portfolioId)}/outputs/${encodeURIComponent(row.id)}/download`,
    } as ResearchPortfolioOutputArtifactDto;
  }

  private receiptDto(row: any): ResearchPortfolioClientFileReceiptDto {
    return {
      id: row.id,
      artifactId: row.artifactId,
      clientId: row.clientId,
      attachmentId: row.attachmentId,
      attachmentName: row.attachmentName,
      lifecycleStatus: row.lifecycleStatus,
      scanStatus: row.scanStatus,
      indexedAt: row.indexedAt?.toISOString() ?? null,
      openPath: row.openPath,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export const researchPortfolioOutputInternals = { stable, sha256, formulaSafe, projectionCsv };
