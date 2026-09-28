import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateResearchPortfolioImportDto,
  ResearchPortfolioImportActionDto,
  ResearchPortfolioImportDetailDto,
  ResearchPortfolioImportJobDto,
  ResearchPortfolioImportRowPreviewClassification,
  ResearchPortfolioImportWorksheetKind,
  ResearchPortfolioMemberKind,
  TenantContext,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  parseResearchPortfolioCsv,
  ResearchPortfolioCsvError,
} from './research-portfolio-import-csv.js';
import { readCanonicalResearchTarget } from './research-portfolio-targets.js';
import { ResearchPortfolioRulesService } from './research-portfolio-rules.service.js';
import { ResearchPortfolioReviewService } from './research-portfolio-review.service.js';
import { parseRule, stableJson } from './research-portfolio-rules.js';

type Tx = Prisma.TransactionClient;
type RequiredRole = 'viewer' | 'editor' | 'owner';
type ImportAction =
  'preview' | 'apply' | 'pause' | 'resume' | 'cancel' | 'retry' | 'reconcile' | 'compensate';
type ImportJob = Awaited<ReturnType<Tx['researchPortfolioImportJob']['findFirstOrThrow']>>;

const ROLE_LEVEL: Record<RequiredRole, number> = { viewer: 1, editor: 2, owner: 3 };
const MEMBER_KINDS = new Set<ResearchPortfolioMemberKind>([
  'program',
  'program_element',
  'project',
  'budget_line',
  'award',
]);
const SCHEMAS: Record<
  ResearchPortfolioImportWorksheetKind,
  { required: readonly string[]; optional: readonly string[] }
> = {
  membership: {
    required: ['target_kind', 'target_id'],
    optional: ['label', 'reason', 'evidence', 'access'],
  },
  rules: {
    required: ['readable_expression', 'expression_json'],
    optional: [
      'reason',
      'access',
      'mode',
      'qualification_policy_json',
      'taxonomy_version_id',
      'template_version_id',
    ],
  },
  reviews: {
    required: ['target_kind', 'target_id', 'reason'],
    optional: ['decision_type', 'evidence_for', 'evidence_against', 'access'],
  },
};

function hash(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function decodeBase64(value: string): Buffer {
  const normalized = value?.replaceAll(/\s/g, '') ?? '';
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new BadRequestException('contentBase64 must be canonical base64');
  }
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.toString('base64') !== normalized)
    throw new BadRequestException('contentBase64 must be canonical base64');
  return bytes;
}

/** Known atomic compensation conflict; metadata stays inside the domain transaction. */
class ImportCompensationConflict extends ConflictException {
  constructor(
    message: string,
    readonly previewHash: string,
    readonly effects: Prisma.InputJsonValue,
  ) {
    super(message);
  }
}

@Injectable()
export class ResearchPortfolioImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: ResearchPortfolioRulesService = new ResearchPortfolioRulesService(
      prisma,
    ),
    private readonly reviews: ResearchPortfolioReviewService = new ResearchPortfolioReviewService(
      prisma,
    ),
  ) {}

  async createJob(
    ctx: TenantContext,
    portfolioId: string,
    input: CreateResearchPortfolioImportDto,
  ): Promise<ResearchPortfolioImportJobDto> {
    this.operationKey(input.operationKey);
    if (!SCHEMAS[input.worksheetKind])
      throw new BadRequestException('Unsupported import worksheet kind');
    if (input.schemaVersion !== `${input.worksheetKind}-v1`)
      throw new BadRequestException('Unsupported import schema version');
    if (!['text/csv', 'application/vnd.ms-excel'].includes(input.mediaType))
      throw new BadRequestException('Only CSV imports are supported');
    const bytes = decodeBase64(input.contentBase64);
    let parsed;
    try {
      parsed = parseResearchPortfolioCsv(bytes);
    } catch (error) {
      if (error instanceof ResearchPortfolioCsvError) throw new BadRequestException(error.message);
      throw error;
    }
    const mapping = this.validateMapping(input.worksheetKind, input.mapping, parsed.headers);
    const originalHash = hash(bytes);
    const requestHash = hash({
      portfolioId,
      originalHash,
      worksheetKind: input.worksheetKind,
      schemaVersion: input.schemaVersion,
      mapping,
    });

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const portfolio = await this.loadAuthorized(tx, ctx, portfolioId, 'editor');
      const existing = await tx.researchPortfolioImportJob.findUnique({
        where: {
          tenantId_operationKey: { tenantId: ctx.tenantId, operationKey: input.operationKey },
        },
        include: { mappings: { orderBy: { version: 'desc' }, take: 1 } },
      });
      if (existing) {
        const creation = await tx.researchPortfolioEvent.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId: ctx.tenantId,
              idempotencyKey: `import:create:${input.operationKey}`,
            },
          },
        });
        if (
          !creation ||
          creation.actorUserId !== ctx.userId ||
          creation.portfolioId !== portfolioId ||
          existing.portfolioId !== portfolioId
        )
          throw new ConflictException(
            'Operation key was already used by another actor or portfolio',
          );
        const existingHash = hash({
          portfolioId: existing.portfolioId,
          originalHash: existing.originalHash,
          worksheetKind: existing.worksheetKind,
          schemaVersion: existing.schemaVersion,
          mapping: existing.mappings[0]?.mapping ?? {},
        });
        if (existingHash !== requestHash)
          throw new ConflictException(
            'Operation key was already used for different import content',
          );
        return this.jobDto(existing);
      }
      if (portfolio.lifecycle === 'archived')
        throw new ConflictException('Archived portfolios are read-only');
      if (portfolio.revision !== input.expectedRevision)
        throw new ConflictException('Portfolio revision mismatch');
      const job = await tx.researchPortfolioImportJob.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          operationKey: input.operationKey,
          worksheetKind: input.worksheetKind,
          status: 'mapped',
          originalHash,
          originalSize: bytes.length,
          fileName: input.fileName.trim().slice(0, 255) || 'import.csv',
          mediaType: input.mediaType,
          originalBytes: bytes,
          fileMetadata: json({
            headers: parsed.headers,
            rowCount: parsed.rows.length,
            requestHash,
          }),
          parserVersion: 'strict-csv-v1',
          schemaVersion: input.schemaVersion,
          targetRevision: portfolio.revision,
        },
      });
      await tx.researchPortfolioImportMappingVersion.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          importJobId: job.id,
          version: 1,
          mapping: json(mapping),
          schemaVersion: input.schemaVersion,
          authorUserId: ctx.userId,
        },
      });
      await this.recordEvent(
        tx,
        ctx,
        portfolioId,
        `import:create:${input.operationKey}`,
        'import_created',
        {
          jobId: job.id,
          originalHash,
          worksheetKind: input.worksheetKind,
        },
      );
      return this.jobDto(job);
    });
  }

  async getJob(
    ctx: TenantContext,
    portfolioId: string,
    jobId: string,
  ): Promise<ResearchPortfolioImportDetailDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.loadAuthorized(tx, ctx, portfolioId, 'viewer');
      const job = await this.loadJobDetail(tx, ctx.tenantId, portfolioId, jobId);
      return this.detailDto(job);
    });
  }

  async action(
    ctx: TenantContext,
    portfolioId: string,
    jobId: string,
    action: string,
    input: ResearchPortfolioImportActionDto,
  ): Promise<ResearchPortfolioImportDetailDto> {
    if (
      ![
        'preview',
        'apply',
        'pause',
        'resume',
        'cancel',
        'retry',
        'reconcile',
        'compensate',
      ].includes(action)
    ) {
      throw new BadRequestException('Unsupported import action');
    }
    this.operationKey(input.operationKey);
    const requestFingerprint = hash(stableJson({ portfolioId, jobId, action, input }));
    const result = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const portfolio = await this.loadAuthorized(tx, ctx, portfolioId, 'editor');
      const job = await tx.researchPortfolioImportJob.findFirst({
        where: { id: jobId, tenantId: ctx.tenantId, portfolioId },
      });
      if (!job) throw new NotFoundException('Import job not found');

      const priorAttempt = await tx.researchPortfolioImportAttempt.findUnique({
        where: {
          tenantId_operationKey: { tenantId: ctx.tenantId, operationKey: input.operationKey },
        },
      });
      if (priorAttempt) {
        if (priorAttempt.actorUserId !== ctx.userId || priorAttempt.portfolioId !== portfolioId)
          throw new ConflictException(
            'Operation key was already used by another actor or portfolio',
          );
        const receipt = priorAttempt.receipt as {
          receiptVersion?: number;
          requestFingerprint?: string;
          failureMessage?: string;
        } | null;
        if (receipt?.receiptVersion !== 1 || typeof receipt.requestFingerprint !== 'string')
          throw new ConflictException(
            'Legacy import action receipt lacks immutable request identity; recover the durable job through GET and use a fresh recovery key',
          );
        if (receipt.requestFingerprint !== requestFingerprint)
          throw new ConflictException(
            'Operation key was already used for a different import request',
          );
        if (priorAttempt.importJobId !== job.id || priorAttempt.action !== action) {
          throw new ConflictException(
            'Operation key was already used for a different import action',
          );
        }
        return {
          detail: this.detailDto(await this.loadJobDetail(tx, ctx.tenantId, portfolioId, job.id)),
          failureMessage:
            priorAttempt.outcome === 'known_failure'
              ? (receipt.failureMessage ?? 'Known import compensation conflict')
              : null,
        };
      }

      if (
        portfolio.lifecycle === 'archived' &&
        !['cancel', 'reconcile', 'compensate'].includes(action)
      ) {
        throw new ConflictException(
          'Archived portfolios are read-only; only recovery actions remain available',
        );
      }

      if (action === 'preview') await this.preview(tx, ctx, job, input, portfolio.revision);
      if (action === 'apply') await this.apply(tx, ctx, job, portfolio.revision, input);
      if (action === 'pause') await this.transition(tx, job, ['applying'], 'paused');
      if (action === 'resume') await this.transition(tx, job, ['paused'], 'applying');
      if (action === 'cancel') await this.cancel(tx, job);
      if (action === 'retry') await this.retry(tx, job);
      if (action === 'reconcile') await this.reconcile(tx, job);
      let compensationFailure: ImportCompensationConflict | null = null;
      if (action === 'compensate') {
        await tx.$executeRawUnsafe('SAVEPOINT rp_import_compensation_action');
        try {
          await this.compensate(tx, ctx, job, portfolio.revision, input);
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT rp_import_compensation_action');
        } catch (error) {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT rp_import_compensation_action');
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT rp_import_compensation_action');
          if (!(error instanceof ImportCompensationConflict)) throw error;
          compensationFailure = error;
          await tx.researchPortfolioImportCompensationReceipt.create({
            data: {
              tenantId: ctx.tenantId,
              portfolioId,
              importJobId: job.id,
              operationKey: input.operationKey,
              previewHash: error.previewHash,
              status: 'failed',
              effects: error.effects,
              actorUserId: ctx.userId,
            },
          });
        }
      }

      await tx.researchPortfolioImportAttempt.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          importJobId: job.id,
          operationKey: input.operationKey,
          action,
          outcome: compensationFailure ? 'known_failure' : 'succeeded',
          errorCode: compensationFailure ? 'compensation_conflict' : null,
          checkpoint: json({ jobId: job.id }),
          receipt: json({
            receiptVersion: 1,
            requestFingerprint,
            failureMessage: compensationFailure?.message ?? null,
            status: (
              await tx.researchPortfolioImportJob.findUniqueOrThrow({ where: { id: job.id } })
            ).status,
          }),
          actorUserId: ctx.userId,
        },
      });
      await this.recordEvent(
        tx,
        ctx,
        portfolioId,
        `import:action:${input.operationKey}`,
        'import_action',
        { jobId, action, outcome: compensationFailure ? 'known_failure' : 'succeeded' },
      );
      return {
        detail: this.detailDto(await this.loadJobDetail(tx, ctx.tenantId, portfolioId, job.id)),
        failureMessage: compensationFailure?.message ?? null,
      };
    });
    // The failure receipt commits before the API reports the known conflict.
    if (result.failureMessage) throw new ConflictException(result.failureMessage);
    return result.detail;
  }

  private async preview(
    tx: Tx,
    ctx: TenantContext,
    job: ImportJob,
    input: ResearchPortfolioImportActionDto,
    currentRevision: number = job.targetRevision,
  ): Promise<void> {
    if (!['mapped', 'previewed', 'failed', 'partial'].includes(job.status)) {
      throw new ConflictException(`Import job cannot be previewed from ${job.status}`);
    }
    if (
      input.expectedRevision !== undefined &&
      (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== currentRevision)
    ) {
      throw new ConflictException('Portfolio revision mismatch; refresh before preview');
    }
    const parsed = parseResearchPortfolioCsv(Buffer.from(job.originalBytes));
    const mappingRow = await tx.researchPortfolioImportMappingVersion.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, importJobId: job.id },
      orderBy: { version: 'desc' },
    });
    const mapping = mappingRow.mapping as Record<string, string>;
    const existingRows = await tx.researchPortfolioImportRow.findMany({
      where: { tenantId: ctx.tenantId, importJobId: job.id },
    });
    const existingByIdentity = new Map(existingRows.map((row) => [row.rowIdentity, row]));
    const selected = input.selectedRowIds ? new Set(input.selectedRowIds) : null;
    const seenCanonical = new Set<string>();

    for (const record of parsed.rows) {
      const rawCells = Object.fromEntries(
        parsed.headers.map((header, index) => [header, record.cells[index] ?? '']),
      );
      const rowIdentity = hash({ rowNumber: record.rowNumber, rawCells });
      const existing = existingByIdentity.get(rowIdentity);
      // Previously committed effects retain their original row receipt and revision.
      if (existing?.finalOutcome === 'applied') continue;
      const repairs = existing && input.repairs?.[existing.id] ? input.repairs[existing.id]! : {};
      const parsedData = { ...this.mapRow(rawCells, mapping), ...repairs };
      const classification = await this.classify(tx, job, parsedData, seenCanonical);
      const targetKind = typeof parsedData.target_kind === 'string' ? parsedData.target_kind : null;
      const targetId =
        typeof parsedData.target_id === 'string' ? parsedData.target_id.trim() : null;
      const canonicalTargetKey = targetKind && targetId ? `${targetKind}:${targetId}` : null;
      const data = {
        tenantId: ctx.tenantId,
        portfolioId: job.portfolioId,
        importJobId: job.id,
        worksheetKind: job.worksheetKind,
        sheetName: 'CSV',
        rowNumber: record.rowNumber,
        rowIdentity,
        rawCells: json(rawCells),
        parsedData: json(parsedData),
        repairs: json(repairs),
        validationIssues: json(classification.issues),
        selected: selected
          ? Boolean(existing && selected.has(existing.id))
          : (existing?.selected ?? true),
        previewClassification: classification.value,
        previewReason: classification.reason,
        finalOutcome: null,
        finalReason: null,
        finalDisposition: json({}),
        expectedRevision: currentRevision,
        canonicalTargetKey,
        targetKind,
        targetId,
      };
      await tx.researchPortfolioImportRow.upsert({
        where: {
          tenantId_importJobId_rowIdentity: {
            tenantId: ctx.tenantId,
            importJobId: job.id,
            rowIdentity,
          },
        },
        create: data,
        update: data,
      });
    }
    await tx.researchPortfolioImportJob.update({
      where: { id: job.id },
      data: {
        status: 'previewed',
        targetRevision: currentRevision,
        rowCount: parsed.rows.length,
        checkpoint: json({ previewedAt: new Date().toISOString() }),
      },
    });
  }

  private async classify(
    tx: Tx,
    job: ImportJob,
    row: Record<string, unknown>,
    seenCanonical: Set<string>,
  ): Promise<{
    value: ResearchPortfolioImportRowPreviewClassification;
    reason: string;
    issues: string[];
  }> {
    if (
      String(row.access ?? '').toLowerCase() === 'inaccessible' ||
      String(row.access ?? '').toLowerCase() === 'denied'
    ) {
      return {
        value: 'inaccessible',
        reason: 'The referenced source or target is not accessible',
        issues: [],
      };
    }
    if (job.worksheetKind === 'rules') {
      if (
        !String(row.readable_expression ?? '').trim() ||
        !String(row.expression_json ?? '').trim()
      )
        return {
          value: 'invalid',
          reason: 'Rule rows require readable_expression and expression_json',
          issues: ['missing_required_field'],
        };
      try {
        parseRule(String(row.expression_json));
      } catch {
        return {
          value: 'invalid',
          reason: 'expression_json is not a valid versioned rule AST',
          issues: ['invalid_rule_ast'],
        };
      }
      if (row.mode && !['rules', 'hybrid'].includes(String(row.mode)))
        return {
          value: 'invalid',
          reason: 'Rule mode must be rules or hybrid',
          issues: ['invalid_rule_mode'],
        };
      if (row.qualification_policy_json) {
        try {
          const policy = JSON.parse(String(row.qualification_policy_json));
          if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error();
        } catch {
          return {
            value: 'invalid',
            reason: 'qualification_policy_json must be an object',
            issues: ['invalid_qualification_policy'],
          };
        }
      }
      return {
        value: 'resolved',
        reason: 'Rule schema is valid and ready for governed review',
        issues: [],
      };
    }
    const kind = String(row.target_kind ?? '').trim() as ResearchPortfolioMemberKind;
    const id = String(row.target_id ?? '').trim();
    if (
      !kind ||
      (job.worksheetKind === 'membership' && !MEMBER_KINDS.has(kind)) ||
      (job.worksheetKind === 'reviews' &&
        !MEMBER_KINDS.has(kind) &&
        !['rule', 'portfolio'].includes(kind))
    )
      return {
        value: 'invalid',
        reason: 'target_kind is missing or unsupported',
        issues: ['invalid_target_kind'],
      };
    if (!id && String(row.label ?? '').trim())
      return {
        value: 'ambiguous',
        reason: 'A label was supplied without a canonical target_id',
        issues: ['ambiguous_label'],
      };
    if (!id)
      return { value: 'invalid', reason: 'target_id is required', issues: ['missing_target_id'] };
    if (job.worksheetKind === 'reviews' && !String(row.reason ?? '').trim())
      return {
        value: 'invalid',
        reason: 'Review rows require a reason',
        issues: ['missing_reason'],
      };
    const canonicalKey = `${kind}:${id}`;
    if (seenCanonical.has(canonicalKey))
      return {
        value: 'duplicate',
        reason: 'The canonical target appears earlier in this import',
        issues: [],
      };
    seenCanonical.add(canonicalKey);
    if (MEMBER_KINDS.has(kind)) {
      const canonical = await readCanonicalResearchTarget(tx, kind, id);
      if (!canonical)
        return {
          value: 'unresolved',
          reason: 'The typed target does not resolve to a canonical record',
          issues: [],
        };
      if (job.worksheetKind === 'membership') {
        const existing = await tx.researchPortfolioMember.findUnique({
          where: {
            tenantId_portfolioId_targetKind_targetId: {
              tenantId: job.tenantId,
              portfolioId: job.portfolioId,
              targetKind: kind,
              targetId: id,
            },
          },
        });
        if (existing)
          return {
            value: 'duplicate',
            reason: 'The canonical member already exists in this portfolio',
            issues: [],
          };
      }
    }
    return {
      value: 'resolved',
      reason: 'The row resolved to an accessible canonical target',
      issues: [],
    };
  }

  private async apply(
    tx: Tx,
    ctx: TenantContext,
    job: ImportJob,
    currentRevision: number,
    input: ResearchPortfolioImportActionDto,
  ): Promise<void> {
    if (!['previewed', 'applying'].includes(job.status))
      throw new ConflictException(`Import job cannot be applied from ${job.status}`);
    if (
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision !== currentRevision ||
      input.expectedRevision !== job.targetRevision
    ) {
      throw new ConflictException('Portfolio revision mismatch; preview the import again');
    }
    if (job.worksheetKind !== 'membership') {
      await this.applyGoverned(tx, ctx, job, currentRevision, input);
      return;
    }
    const rows = await tx.researchPortfolioImportRow.findMany({
      where: { tenantId: ctx.tenantId, importJobId: job.id },
      orderBy: { rowNumber: 'asc' },
    });
    if (!rows.length) throw new ConflictException('Import must be previewed before apply');
    await tx.researchPortfolioImportJob.update({
      where: { id: job.id },
      data: { status: 'applying' },
    });
    let applied = 0;
    let newlyApplied = 0;
    let nonTerminal = 0;
    for (const row of rows) {
      if (row.finalOutcome === 'applied') {
        applied += 1;
        continue;
      }
      if (!row.selected) {
        await this.finishRow(tx, row.id, 'skipped', 'Row was not selected', {});
        continue;
      }
      if (row.previewClassification !== 'resolved') {
        const deliberateDuplicate = row.previewClassification === 'duplicate';
        await this.finishRow(
          tx,
          row.id,
          deliberateDuplicate ? 'skipped' : 'failed',
          `Preview classification: ${row.previewClassification}`,
          {},
        );
        if (!deliberateDuplicate) nonTerminal++;
        continue;
      }
      const data = row.parsedData as Record<string, unknown>;
      const kind = String(data.target_kind) as ResearchPortfolioMemberKind;
      const targetId = String(data.target_id).trim();
      const canonicalKey = `${kind}:${targetId}`;
      const existing = await tx.researchPortfolioMember.findUnique({
        where: {
          tenantId_portfolioId_targetKind_targetId: {
            tenantId: ctx.tenantId,
            portfolioId: job.portfolioId,
            targetKind: kind,
            targetId,
          },
        },
      });
      if (existing) {
        await this.finishRow(tx, row.id, 'skipped', 'Canonical member is already present', {
          memberId: existing.id,
        });
        continue;
      }
      await tx.$executeRawUnsafe('SAVEPOINT rp_import_member_row');
      try {
        const member = await tx.researchPortfolioMember.create({
          data: {
            tenantId: ctx.tenantId,
            portfolioId: job.portfolioId,
            targetKind: kind,
            targetId,
            label: String(data.label ?? '').trim() || null,
            origin: 'import',
            disposition: 'included',
            reason: String(data.reason ?? '').trim() || 'Added by research portfolio import',
            evidence: json({
              imported: data.evidence ?? null,
              importJobId: job.id,
              importRowId: row.id,
            }),
            createdByUserId: ctx.userId,
            updatedByUserId: ctx.userId,
          },
        });
        await tx.researchPortfolioImportEffect.create({
          data: {
            tenantId: ctx.tenantId,
            portfolioId: job.portfolioId,
            importJobId: job.id,
            importRowId: row.id,
            effectFingerprint: hash({ jobId: job.id, rowId: row.id, kind, targetId }),
            effectKind: 'member_created',
            canonicalTargetKey: canonicalKey,
            targetId: member.id,
            targetRevisionAtApply: member.revision,
            payload: json({ targetKind: kind, canonicalTargetId: targetId }),
          },
        });
        await this.finishRow(tx, row.id, 'applied', 'Member created', { memberId: member.id });
        applied += 1;
        newlyApplied += 1;
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT rp_import_member_row');
      } catch (error) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT rp_import_member_row');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT rp_import_member_row');
        await this.finishRow(
          tx,
          row.id,
          'failed',
          error instanceof Error ? error.message : 'Known apply failure',
          {},
        );
        nonTerminal += 1;
      }
    }
    if (newlyApplied > 0) {
      const bumped = await tx.researchPortfolio.updateMany({
        where: {
          id: job.portfolioId,
          tenantId: ctx.tenantId,
          revision: input.expectedRevision,
          lifecycle: 'active',
        },
        data: { revision: { increment: 1 } },
      });
      if (bumped.count !== 1)
        throw new ConflictException('Portfolio revision changed during apply');
    }
    await tx.researchPortfolioImportJob.update({
      where: { id: job.id },
      data: {
        status: nonTerminal ? 'partial' : 'completed',
        appliedCount: applied,
        checkpoint: json({ terminalRows: rows.length, applied }),
      },
    });
  }

  private async applyGoverned(
    tx: Tx,
    ctx: TenantContext,
    job: ImportJob,
    currentRevision: number,
    input: ResearchPortfolioImportActionDto,
  ): Promise<void> {
    const rows = await tx.researchPortfolioImportRow.findMany({
      where: { tenantId: ctx.tenantId, importJobId: job.id },
      orderBy: { rowNumber: 'asc' },
    });
    if (!rows.length) throw new ConflictException('Import must be previewed before apply');
    await tx.researchPortfolioImportJob.update({
      where: { id: job.id },
      data: { status: 'applying' },
    });
    let applied = 0;
    let failures = 0;
    let revision = currentRevision;
    for (const row of rows) {
      if (row.finalOutcome === 'applied') {
        applied++;
        continue;
      }
      if (!row.selected || row.previewClassification !== 'resolved') {
        const failed = row.selected && row.previewClassification !== 'duplicate';
        await this.finishRow(
          tx,
          row.id,
          failed ? 'failed' : 'skipped',
          !row.selected
            ? 'Row was not selected'
            : `Preview classification: ${row.previewClassification}`,
          {},
        );
        if (failed) failures++;
        continue;
      }
      await tx.$executeRawUnsafe('SAVEPOINT rp_import_governed_row');
      try {
        const operationKey = `rpimport:${hash({ jobId: job.id, rowId: row.id })}`;
        const data = row.parsedData as Record<string, unknown>;
        let targetId: string;
        let effectKind: string;
        let targetRevisionAtApply: number | null = null;
        let disposition: Record<string, unknown>;
        if (job.worksheetKind === 'rules') {
          const draft = await this.rules.previewImportDraftInTransaction(
            tx,
            ctx,
            job.portfolioId,
            data,
            revision,
            operationKey,
          );
          targetId = draft.previewId;
          effectKind = 'rule_preview_created';
          disposition = {
            previewId: draft.previewId,
            previewHash: draft.previewHash,
            expiresAt: draft.expiresAt,
            portfolioRevision: draft.portfolioRevision,
            requiresPublish: true,
          };
        } else {
          const receipt = await this.reviews.importReviewInTransaction(
            tx,
            ctx,
            job.portfolioId,
            data,
            operationKey,
            revision,
          );
          const outcome = receipt.outcomes[0];
          if (!outcome?.reviewId || !outcome.decisionId || outcome.revision === null)
            throw new ConflictException(
              'Governed review import produced no durable decision receipt',
            );
          targetId = outcome.reviewId;
          effectKind = 'review_decided';
          targetRevisionAtApply = outcome.revision;
          disposition = {
            reviewId: outcome.reviewId,
            decisionId: outcome.decisionId,
            reviewRevision: outcome.revision,
            operationKey,
          };
          revision += 1;
        }
        await tx.researchPortfolioImportEffect.create({
          data: {
            tenantId: ctx.tenantId,
            portfolioId: job.portfolioId,
            importJobId: job.id,
            importRowId: row.id,
            effectFingerprint: hash({ jobId: job.id, rowId: row.id, effectKind }),
            effectKind,
            canonicalTargetKey: `${job.worksheetKind}:${row.rowIdentity}`,
            targetId,
            targetRevisionAtApply,
            payload: json(disposition),
          },
        });
        await this.finishRow(
          tx,
          row.id,
          'applied',
          job.worksheetKind === 'rules'
            ? 'Governed rule draft created; explicit publication required'
            : 'Review and immutable decision committed',
          disposition,
        );
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT rp_import_governed_row');
        applied++;
      } catch (error) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT rp_import_governed_row');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT rp_import_governed_row');
        revision = (
          await tx.researchPortfolio.findUniqueOrThrow({
            where: { id: job.portfolioId },
            select: { revision: true },
          })
        ).revision;
        await this.finishRow(
          tx,
          row.id,
          'failed',
          error instanceof Error ? error.message : 'Known governed apply failure',
          {},
        );
        failures++;
      }
    }
    await tx.researchPortfolioImportJob.update({
      where: { id: job.id },
      data: {
        status: failures ? 'partial' : 'completed',
        appliedCount: applied,
        checkpoint: json({
          terminalRows: rows.length,
          applied,
          governed: job.worksheetKind,
          resultingRevision: revision,
        }),
      },
    });
  }

  private async finishRow(
    tx: Tx,
    id: string,
    outcome: 'applied' | 'skipped' | 'conflict' | 'failed' | 'unknown',
    reason: string,
    disposition: Record<string, unknown>,
  ) {
    await tx.researchPortfolioImportRow.update({
      where: { id },
      data: { finalOutcome: outcome, finalReason: reason, finalDisposition: json(disposition) },
    });
  }

  private async transition(
    tx: Tx,
    job: ImportJob,
    from: string[],
    to: 'paused' | 'applying',
  ): Promise<void> {
    if (!from.includes(job.status))
      throw new ConflictException(`Import job cannot transition from ${job.status} to ${to}`);
    await tx.researchPortfolioImportJob.update({ where: { id: job.id }, data: { status: to } });
  }

  private async cancel(tx: Tx, job: ImportJob): Promise<void> {
    if (['completed', 'compensated', 'cancelled'].includes(job.status))
      throw new ConflictException(`Import job cannot be cancelled from ${job.status}`);
    await tx.researchPortfolioImportJob.update({
      where: { id: job.id },
      data: { status: 'cancelled', leaseOwner: null, leaseUntil: null },
    });
  }

  private async retry(tx: Tx, job: ImportJob): Promise<void> {
    if (!['failed', 'partial'].includes(job.status))
      throw new ConflictException(
        'Only known failed or partial imports can be retried; reconcile unknown outcomes first',
      );
    await tx.researchPortfolioImportJob.update({
      where: { id: job.id },
      data: { status: 'previewed', leaseOwner: null, leaseUntil: null },
    });
  }

  private async reconcile(tx: Tx, job: ImportJob): Promise<void> {
    if (!['unknown', 'needs_reconciliation'].includes(job.status))
      throw new ConflictException('Only unknown imports require reconciliation');
    const rows = await tx.researchPortfolioImportRow.findMany({
      where: { tenantId: job.tenantId, importJobId: job.id },
      select: { finalOutcome: true },
    });
    const effects = await tx.researchPortfolioImportEffect.count({
      where: { tenantId: job.tenantId, importJobId: job.id },
    });
    const indeterminate = rows.some(
      (row) => row.finalOutcome === null || row.finalOutcome === 'unknown',
    );
    await tx.researchPortfolioImportJob.update({
      where: { id: job.id },
      data: {
        status: indeterminate
          ? 'needs_reconciliation'
          : rows.some((row) => row.finalOutcome === 'failed' || row.finalOutcome === 'conflict')
            ? 'partial'
            : 'completed',
        appliedCount: effects,
        checkpoint: json({ reconciledRows: rows.length, observedEffects: effects, indeterminate }),
      },
    });
  }

  private async compensate(
    tx: Tx,
    ctx: TenantContext,
    job: ImportJob,
    currentRevision: number,
    input: ResearchPortfolioImportActionDto,
  ): Promise<void> {
    if (!['completed', 'partial'].includes(job.status))
      throw new ConflictException(`Import job cannot be compensated from ${job.status}`);
    const effects = await tx.researchPortfolioImportEffect.findMany({
      where: { tenantId: ctx.tenantId, importJobId: job.id },
      orderBy: { id: 'asc' },
    });
    if (!effects.length) throw new ConflictException('Import has no owned effects to compensate');
    const effectReceipt = effects.map((effect) => ({
      id: effect.id,
      effectKind: effect.effectKind,
      targetId: effect.targetId,
      targetRevisionAtApply: effect.targetRevisionAtApply,
    }));
    const previewHash = hash(effectReceipt);
    if (!input.compensationPreviewHash) {
      await tx.researchPortfolioImportCompensationReceipt.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId: job.portfolioId,
          importJobId: job.id,
          operationKey: input.operationKey,
          previewHash,
          status: 'previewed',
          effects: json(effectReceipt),
          actorUserId: ctx.userId,
        },
      });
      return;
    }
    if (input.compensationPreviewHash !== previewHash)
      throw new ConflictException('Compensation preview is stale');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== currentRevision)
      throw new ConflictException('Portfolio revision mismatch');
    const preview = await tx.researchPortfolioImportCompensationReceipt.findFirst({
      where: { tenantId: ctx.tenantId, importJobId: job.id, previewHash, status: 'previewed' },
    });
    if (!preview) throw new ConflictException('Compensation must be previewed before commit');
    let conflicts = 0;
    for (const effect of effects) {
      if (effect.effectKind === 'review_decided') {
        const updated = await tx.researchPortfolioReview.updateMany({
          where: {
            id: effect.targetId,
            tenantId: ctx.tenantId,
            portfolioId: job.portfolioId,
            trigger: 'import',
            revision: effect.targetRevisionAtApply ?? -1,
          },
          data: {
            status: 'cancelled',
            reason: `Compensated import ${job.id}`,
            revision: { increment: 1 },
          },
        });
        if (updated.count !== 1) conflicts++;
        continue;
      }
      if (effect.effectKind === 'rule_preview_created') {
        const payload = effect.payload as { previewHash?: string; expiresAt?: string };
        const published = await tx.researchPortfolioRuleVersion.findFirst({
          where: {
            tenantId: ctx.tenantId,
            portfolioId: job.portfolioId,
            previewHash: payload.previewHash,
          },
        });
        if (published || !payload.previewHash || !payload.expiresAt) {
          conflicts++;
          continue;
        }
        const deleted = await tx.researchPortfolioRulePreview.deleteMany({
          where: {
            id: effect.targetId,
            tenantId: ctx.tenantId,
            portfolioId: job.portfolioId,
            previewHash: payload.previewHash,
            expiresAt: new Date(payload.expiresAt),
          },
        });
        if (deleted.count !== 1) conflicts++;
        continue;
      }
      if (effect.effectKind !== 'member_created') {
        conflicts++;
        continue;
      }
      const updated = await tx.researchPortfolioMember.updateMany({
        where: {
          id: effect.targetId,
          tenantId: ctx.tenantId,
          portfolioId: job.portfolioId,
          origin: 'import',
          revision: effect.targetRevisionAtApply ?? -1,
        },
        data: {
          disposition: 'withdrawn',
          reason: `Compensated import ${job.id}`,
          updatedByUserId: ctx.userId,
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) conflicts += 1;
    }
    if (conflicts)
      throw new ImportCompensationConflict(
        'One or more imported effects changed after apply and were not compensated',
        previewHash,
        json(effectReceipt),
      );
    await tx.researchPortfolioImportCompensationReceipt.create({
      data: {
        tenantId: ctx.tenantId,
        portfolioId: job.portfolioId,
        importJobId: job.id,
        operationKey: input.operationKey,
        previewHash,
        status: 'committed',
        effects: json(effectReceipt),
        actorUserId: ctx.userId,
      },
    });
    const bumped = await tx.researchPortfolio.updateMany({
      where: { id: job.portfolioId, tenantId: ctx.tenantId, revision: input.expectedRevision },
      data: { revision: { increment: 1 } },
    });
    if (bumped.count !== 1)
      throw new ImportCompensationConflict(
        'Portfolio revision mismatch',
        previewHash,
        json(effectReceipt),
      );
    await tx.researchPortfolioImportJob.update({
      where: { id: job.id },
      data: { status: 'compensated' },
    });
  }

  private validateMapping(
    kind: ResearchPortfolioImportWorksheetKind,
    input: Readonly<Record<string, string>>,
    headers: readonly string[],
  ): Record<string, string> {
    const allowed = new Set([...SCHEMAS[kind].required, ...SCHEMAS[kind].optional]);
    const headerSet = new Set(headers);
    const result: Record<string, string> = {};
    for (const [field, header] of Object.entries(input ?? {})) {
      if (!allowed.has(field))
        throw new BadRequestException(`Unknown ${kind} import field: ${field}`);
      if (!headerSet.has(header))
        throw new BadRequestException(`Mapped CSV header does not exist: ${header}`);
      result[field] = header;
    }
    for (const required of SCHEMAS[kind].required) {
      const inferred =
        result[required] ??
        headers.find((header) => header.toLocaleLowerCase('en-US') === required);
      if (!inferred) throw new BadRequestException(`Import mapping requires ${required}`);
      result[required] = inferred;
    }
    return result;
  }

  private mapRow(
    raw: Record<string, string>,
    mapping: Record<string, string>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(mapping).map(([field, header]) => [field, raw[header] ?? '']),
    );
  }

  private operationKey(value: string): void {
    if (!value || value.length > 128)
      throw new BadRequestException('operationKey must be between 1 and 128 characters');
  }

  private async loadAuthorized(
    tx: Tx,
    ctx: TenantContext,
    portfolioId: string,
    required: RequiredRole,
  ) {
    const portfolio = await tx.researchPortfolio.findFirst({
      where: {
        id: portfolioId,
        tenantId: ctx.tenantId,
        grants: { some: { principalUserId: ctx.userId } },
      },
      select: {
        id: true,
        revision: true,
        lifecycle: true,
        grants: { where: { principalUserId: ctx.userId }, select: { role: true }, take: 1 },
      },
    });
    if (!portfolio || !portfolio.grants[0])
      throw new NotFoundException('Research portfolio not found');
    if (ROLE_LEVEL[portfolio.grants[0].role as RequiredRole] < ROLE_LEVEL[required])
      throw new ForbiddenException(`Research portfolio ${required} access required`);
    return portfolio;
  }

  private async loadJobDetail(tx: Tx, tenantId: string, portfolioId: string, jobId: string) {
    const job = await tx.researchPortfolioImportJob.findFirst({
      where: { id: jobId, tenantId, portfolioId },
      include: {
        rows: { orderBy: { rowNumber: 'asc' } },
        mappings: { orderBy: { version: 'asc' } },
        attempts: { orderBy: { createdAt: 'asc' } },
        effects: { orderBy: { appliedAt: 'asc' } },
        receipts: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!job) throw new NotFoundException('Import job not found');
    return job;
  }

  private async recordEvent(
    tx: Tx,
    ctx: TenantContext,
    portfolioId: string,
    idempotencyKey: string,
    eventKind: 'import_created' | 'import_action',
    payload: unknown,
  ) {
    const existing = await tx.researchPortfolioEvent.findUnique({
      where: { tenantId_idempotencyKey: { tenantId: ctx.tenantId, idempotencyKey } },
    });
    if (existing) return;
    const portfolio = await tx.researchPortfolio.findUniqueOrThrow({
      where: { id: portfolioId },
      select: { revision: true },
    });
    await tx.researchPortfolioEvent.create({
      data: {
        tenantId: ctx.tenantId,
        portfolioId,
        eventKind,
        aggregateRevision: portfolio.revision,
        actorUserId: ctx.userId,
        idempotencyKey,
        payloadFingerprint: hash(payload),
        payload: json(payload),
      },
    });
  }

  private jobDto(job: any): ResearchPortfolioImportJobDto {
    return {
      id: job.id,
      tenantId: job.tenantId,
      portfolioId: job.portfolioId,
      operationKey: job.operationKey,
      worksheetKind: job.worksheetKind,
      status: job.status,
      originalHash: job.originalHash,
      originalSize: job.originalSize,
      fileName: job.fileName,
      mediaType: job.mediaType,
      originalStorageKey: job.originalStorageKey,
      fileMetadata: job.fileMetadata,
      parserVersion: job.parserVersion,
      schemaVersion: job.schemaVersion,
      targetRevision: job.targetRevision,
      checkpoint: job.checkpoint,
      leaseOwner: job.leaseOwner,
      leaseUntil: job.leaseUntil?.toISOString() ?? null,
      rowCount: job.rowCount,
      appliedCount: job.appliedCount,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  private detailDto(job: any): ResearchPortfolioImportDetailDto {
    return {
      ...this.jobDto(job),
      rows: job.rows.map((row: any) => ({
        id: row.id,
        tenantId: row.tenantId,
        portfolioId: row.portfolioId,
        importJobId: row.importJobId,
        worksheetKind: row.worksheetKind,
        sheetName: row.sheetName,
        rowNumber: row.rowNumber,
        rowIdentity: row.rowIdentity,
        rawCells: row.rawCells,
        parsedData: row.parsedData,
        repairs: row.repairs,
        validationIssues: row.validationIssues,
        selected: row.selected,
        previewClassification: row.previewClassification,
        previewReason: row.previewReason,
        finalOutcome: row.finalOutcome,
        finalReason: row.finalReason,
        finalDisposition: row.finalDisposition,
        expectedRevision: row.expectedRevision,
        canonicalTargetKey: row.canonicalTargetKey,
        targetKind: row.targetKind,
        targetId: row.targetId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      mappings: job.mappings.map((mapping: any) => ({
        id: mapping.id,
        version: mapping.version,
        mapping: mapping.mapping,
        schemaVersion: mapping.schemaVersion,
        authorUserId: mapping.authorUserId,
        createdAt: mapping.createdAt.toISOString(),
      })),
      attempts: job.attempts.map((attempt: any) => ({
        id: attempt.id,
        operationKey: attempt.operationKey,
        action: attempt.action,
        outcome: attempt.outcome,
        checkpoint: attempt.checkpoint,
        errorCode: attempt.errorCode,
        receipt: attempt.receipt,
        actorUserId: attempt.actorUserId,
        createdAt: attempt.createdAt.toISOString(),
      })),
      effects: job.effects.map((effect: any) => ({
        id: effect.id,
        importRowId: effect.importRowId,
        effectFingerprint: effect.effectFingerprint,
        effectKind: effect.effectKind,
        canonicalTargetKey: effect.canonicalTargetKey,
        targetId: effect.targetId,
        targetRevisionAtApply: effect.targetRevisionAtApply,
        payload: effect.payload,
        appliedAt: effect.appliedAt.toISOString(),
      })),
      compensationReceipts: job.receipts.map((receipt: any) => ({
        id: receipt.id,
        operationKey: receipt.operationKey,
        previewHash: receipt.previewHash,
        status: receipt.status,
        effects: receipt.effects,
        actorUserId: receipt.actorUserId,
        createdAt: receipt.createdAt.toISOString(),
      })),
    };
  }
}
