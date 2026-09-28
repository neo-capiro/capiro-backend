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
        JSON.stringify({
          contributionCount: total.contributionCount,
          ...(projection.calculationVersion === 'research-portfolio-analytics-v2'
            ? {
                availability: projection.availability,
                calculationVersion: projection.calculationVersion,
              }
            : {}),
        }),
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
        item.sourceDisposition === undefined
          ? ''
          : JSON.stringify({ sourceDisposition: item.sourceDisposition }),
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
    requiredRole: 'viewer' | 'editor' = 'viewer',
  ): Promise<ResearchPortfolioOutputJobDto> {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, requiredRole);
      const row = await tx.researchPortfolioOutputJob.findFirst({
        where: { id: jobId, portfolioId, tenantId: ctx.tenantId },
        include: {
          artifacts: { take: 1 },
          attempts: {
            where: {
              action: { in: ['process', 'retry'] },
              outcome: { in: ['completed', 'partial'] },
            },
            orderBy: { attemptNumber: 'desc' },
          },
        },
      });
      if (!row) throw new NotFoundException('Research portfolio output job not found');
      // Known outcomes and unstarted work do not become unknown or more qualified.
      if (['queued', 'completed', 'partial', 'failed', 'cancelled'].includes(row.status)) return;
      if (row.status === 'running' && row.leaseUntil && row.leaseUntil.getTime() > Date.now()) {
        throw new ConflictException('Output job still has an active worker lease');
      }
      const artifact = row.artifacts[0];
      const validBytes =
        artifact &&
        artifact.byteSize === artifact.bytes.length &&
        sha256(Buffer.from(artifact.bytes)) === artifact.contentHash;
      const proven =
        artifact && validBytes
          ? row.attempts.find((attempt) => {
              const receipt = attempt.receipt as Record<string, unknown> | null;
              const checkpoint = attempt.checkpoint as Record<string, unknown> | null;
              return (
                ['process', 'retry'].includes(attempt.action) &&
                ['completed', 'partial'].includes(attempt.outcome) &&
                attempt.completedAt &&
                checkpoint?.leaseFence === row.leaseFence &&
                receipt?.artifactId === artifact.id &&
                receipt.contentHash === artifact.contentHash &&
                receipt.byteSize === artifact.byteSize
              );
            })
          : undefined;
      const next = proven?.outcome ?? 'outcome_unknown';
      const updated = await tx.researchPortfolioOutputJob.updateMany({
        where: {
          id: row.id,
          tenantId: ctx.tenantId,
          portfolioId,
          status: row.status,
          leaseOwner: row.leaseOwner,
          leaseUntil: row.leaseUntil,
          leaseFence: row.leaseFence,
          attemptCount: row.attemptCount,
        },
        data: {
          status: next,
          attemptCount: { increment: 1 },
          leaseFence: { increment: 1 },
          leaseOwner: null,
          leaseUntil: null,
        },
      });
      if (updated.count !== 1)
        throw new ConflictException('Output job changed during reconciliation');
      await tx.researchPortfolioOutputRequest.update({
        where: { id: row.requestId, tenantId: ctx.tenantId },
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
          checkpoint: {
            artifactObserved: Boolean(artifact),
            validatedExecutionAttemptId: proven?.id ?? null,
            leaseFence: row.leaseFence,
            reconciliationFence: row.leaseFence + 1,
          },
          actorUserId: ctx.userId,
          completedAt: new Date(),
        },
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
    requiredRole: 'viewer' | 'editor' = 'viewer',
    reconciliationOnly = false,
  ): Promise<ResearchPortfolioClientFileReceiptDto> {
    if (!input.operationKey || input.operationKey.length > 128)
      throw new BadRequestException('operationKey must be between 1 and 128 characters');
    const unknown = (operationId: string) =>
      new ConflictException({
        code: 'RESEARCH_PORTFOLIO_CLIENT_FILING_OUTCOME_UNKNOWN',
        operationId,
        status: 'outcome_unknown',
        message:
          'The client-file outcome is uncertain. Retry this exact operation to reconcile its observed checkpoint; a second document write will not be started.',
      });
    const authorize = async (tx: Prisma.TransactionClient) => {
      const membership = await tx.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
        select: { id: true },
      });
      if (!membership) throw new NotFoundException('Active tenant membership required');
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, requiredRole);
      if (!portfolio.clientLinks.some((link: any) => link.clientId === input.clientId))
        throw new NotFoundException('Linked client not found');
      await assertResearchPortfolioClientAccess(tx, ctx, [input.clientId]);
    };
    const prepare = async () =>
      this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        await authorize(tx);
        const artifact = await tx.researchPortfolioOutputArtifact.findFirst({
          where: { id: outputId, portfolioId },
          include: { job: true },
        });
        if (!artifact || !['completed', 'partial'].includes(artifact.job.status))
          throw new NotFoundException('Research portfolio output not found');
        const bytes = Buffer.from(artifact.bytes);
        if (
          artifact.byteSize !== bytes.byteLength ||
          sha256(bytes) !== artifact.contentHash ||
          artifact.mediaType !== CSV_MEDIA_TYPE ||
          !artifact.fileName ||
          [
            String.fromCharCode(92),
            '/',
            String.fromCharCode(13),
            String.fromCharCode(10),
            String.fromCharCode(0),
          ].some((value) => artifact.fileName.includes(value))
        )
          throw new ConflictException(
            'Research portfolio output content does not match its immutable artifact',
          );
        const requestHash = sha256(
          stable({
            version: 1,
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            portfolioId,
            artifactId: artifact.id,
            clientId: input.clientId,
            contentHash: artifact.contentHash,
            byteSize: bytes.byteLength,
            fileName: artifact.fileName,
            mediaType: artifact.mediaType,
            source: 'research_portfolio_output',
            sourceVersion: 1,
            operationKey: input.operationKey,
          }),
        );
        const receiptOperationKey = 'rp-filing:' + requestHash;
        const existing = await tx.researchPortfolioClientFilingJob.findUnique({
          where: {
            tenantId_actorUserId_operationKey: {
              tenantId: ctx.tenantId,
              actorUserId: ctx.userId,
              operationKey: input.operationKey,
            },
          },
        });
        if (existing) {
          if (
            existing.requestHash !== requestHash ||
            existing.portfolioId !== portfolioId ||
            existing.artifactId !== outputId ||
            existing.clientId !== input.clientId
          )
            throw new ConflictException(
              'This client-file operation key was used for different content',
            );
          return { job: existing, artifact, ownsWriter: false };
        }
        if (reconciliationOnly)
          throw new NotFoundException('Original client-filing checkpoint not found');
        // Legacy receipts have no actor provenance. Preserve them and avoid a guessed new write.
        const legacy = await tx.researchPortfolioOutputClientFileReceipt.findUnique({
          where: {
            tenantId_operationKey: {
              tenantId: ctx.tenantId,
              operationKey: input.operationKey,
            },
          },
        });
        if (legacy)
          throw new ConflictException({
            code: 'RESEARCH_PORTFOLIO_CLIENT_FILING_LEGACY_RECEIPT',
            message:
              'This operation has a legacy filing receipt. Reconcile its actor provenance before starting another document write.',
          });
        const job = await tx.researchPortfolioClientFilingJob.create({
          data: {
            tenantId: ctx.tenantId,
            portfolioId,
            artifactId: artifact.id,
            clientId: input.clientId,
            actorUserId: ctx.userId,
            operationKey: input.operationKey,
            receiptOperationKey,
            requestHash,
            status: 'pending',
            writerFence: 1,
          },
        });
        return { job, artifact, ownsWriter: true };
      });
    // A concurrent insertion owns the writer. Re-read only after its transaction commits.
    const prepared = await prepare().catch(async (error: unknown) => {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      return prepare();
    });
    const { job, artifact } = prepared;
    if (prepared.ownsWriter) {
      let saved: Awaited<ReturnType<ClientDocumentWriterService['createAttachmentFromBuffer']>>;
      try {
        saved = await this.clientDocuments.createAttachmentFromBuffer(ctx, {
          clientId: input.clientId,
          fileName: artifact.fileName,
          contentType: artifact.mediaType,
          buffer: Buffer.from(artifact.bytes),
          source: 'research_portfolio_output',
          sourceEntityType: 'research_portfolio_output',
          sourceEntityId: artifact.id,
          sourceVersion: 1,
          sourceContentHash: artifact.contentHash,
          idempotencyKey: job.receiptOperationKey,
        });
      } catch {
        // A thrown port call can have committed externally. Never infer rejection or retry it.
        await this.prisma
          .withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
            await tx.researchPortfolioClientFilingJob.updateMany({
              where: {
                id: job.id,
                tenantId: ctx.tenantId,
                actorUserId: ctx.userId,
                requestHash: job.requestHash,
                writerFence: job.writerFence,
                status: 'pending',
              },
              data: {
                status: 'outcome_unknown',
                lastErrorCode: 'CANONICAL_WRITER_OUTCOME_UNKNOWN',
              },
            });
          })
          .catch(() => undefined);
        throw unknown(job.id);
      }
      try {
        // Actor-only storage records an observed side effect even if portfolio access was revoked.
        // This checkpoint is not a success receipt and is never exposed without current access.
        await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
          const recorded = await tx.researchPortfolioClientFilingJob.updateMany({
            where: {
              id: job.id,
              tenantId: ctx.tenantId,
              actorUserId: ctx.userId,
              requestHash: job.requestHash,
              writerFence: job.writerFence,
              status: 'pending',
            },
            data: {
              status: 'outcome_unknown',
              lastErrorCode: null,
              externalCheckpoint: {
                attachmentId: saved.id,
                attachmentName: saved.fileName,
                lifecycleStatus: saved.lifecycleStatus ?? null,
                scanStatus: saved.scanStatus ?? null,
                indexedAt: saved.indexedAt?.toISOString() ?? null,
              },
            },
          });
          if (recorded.count !== 1) throw unknown(job.id);
        });
      } catch {
        throw unknown(job.id);
      }
    }
    try {
      return await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        // The writer may have awaited external upload/scanning. Recheck all current access now.
        await authorize(tx);
        const current = await tx.researchPortfolioClientFilingJob.findUnique({
          where: {
            tenantId_actorUserId_operationKey: {
              tenantId: ctx.tenantId,
              actorUserId: ctx.userId,
              operationKey: input.operationKey,
            },
          },
        });
        if (!current || current.id !== job.id || current.requestHash !== job.requestHash)
          throw unknown(job.id);
        if (current.status === 'completed' && current.receiptId) {
          const receipt = await tx.researchPortfolioOutputClientFileReceipt.findUnique({
            where: {
              tenantId_id: {
                tenantId: ctx.tenantId,
                id: current.receiptId,
              },
            },
          });
          if (!receipt) throw unknown(job.id);
          return {
            ...this.receiptDto(receipt),
            operationKey: current.operationKey,
          };
        }
        const checkpoint = current.externalCheckpoint as Record<string, unknown>;
        if (
          current.status !== 'outcome_unknown' ||
          typeof checkpoint.attachmentId !== 'string' ||
          typeof checkpoint.attachmentName !== 'string'
        )
          throw unknown(job.id);
        // Claim finalization within this transaction; a competing reconciler rolls back rather
        // than publishing a second receipt. No path here invokes the canonical writer again.
        const claimed = await tx.researchPortfolioClientFilingJob.updateMany({
          where: {
            id: current.id,
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            status: 'outcome_unknown',
            writerFence: current.writerFence,
            receiptId: null,
          },
          data: { writerFence: { increment: 1 } },
        });
        if (claimed.count !== 1) throw unknown(job.id);
        const receipt = await tx.researchPortfolioOutputClientFileReceipt.create({
          data: {
            tenantId: ctx.tenantId,
            portfolioId,
            artifactId: outputId,
            clientId: input.clientId,
            operationKey: current.receiptOperationKey,
            attachmentId: checkpoint.attachmentId,
            attachmentName: checkpoint.attachmentName,
            lifecycleStatus:
              typeof checkpoint.lifecycleStatus === 'string' ? checkpoint.lifecycleStatus : null,
            scanStatus: typeof checkpoint.scanStatus === 'string' ? checkpoint.scanStatus : null,
            indexedAt:
              typeof checkpoint.indexedAt === 'string' ? new Date(checkpoint.indexedAt) : null,
            openPath:
              '/clients?clientId=' +
              encodeURIComponent(input.clientId) +
              '&tab=files&attachmentId=' +
              encodeURIComponent(checkpoint.attachmentId),
          },
        });
        await tx.researchPortfolioClientFilingJob.update({
          where: { tenantId_id: { tenantId: ctx.tenantId, id: current.id } },
          data: {
            status: 'completed',
            receiptId: receipt.id,
            completedAt: new Date(),
            lastErrorCode: null,
          },
        });
        return {
          ...this.receiptDto(receipt),
          operationKey: current.operationKey,
        };
      });
    } catch {
      throw unknown(job.id);
    }
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
        await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
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
            leaseUntil: { gt: new Date() },
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
        const failed = await tx.researchPortfolioOutputJob.updateMany({
          where: {
            id: jobId,
            tenantId: ctx.tenantId,
            portfolioId,
            leaseOwner: leaseToken,
            leaseFence: claimed.fence,
            status: 'running',
          },
          data: {
            status: 'failed',
            leaseOwner: null,
            leaseUntil: null,
            lastErrorCode: 'OUTPUT_FAILED',
            lastError: message,
          },
        });
        // A cancelled or superseded worker cannot rewrite the winning outcome.
        if (failed.count !== 1) return;
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
