import { timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Inject,
  Optional,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MeriActionProposal, Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { computeActionFingerprintV2 } from '@capiro/meriv2-core';
import type { MeriGovernedArtifactCapturePolicy } from '@capiro/meriv2-core';
import type { Case46AuthorityDependencies } from './meri-case46-authority.js';
import {
  CASE46_AUTHORITY_DEPENDENCIES, CASE46_PROPOSAL_MARKER, assertCase46ProposalAuthorityInTx,
  case46ProposalMarker, publicCase46ProposalPreview,
} from './meri-case46-action-authority.js';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { buildMeriActionPreview, type MeriActionPreview } from './meri-action-preview.js';
import {
  MeriPolicyPackService,
  type AuthoritativePolicyDecision,
} from './meri-policy-pack.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { assertMeriToolRequestActive } from './meri-tool-request-control.js';
import { classifyMeriActionLogicalFailure } from './meri-action-logical-outcome.js';
import { ResearchPortfolioMeriScopeService } from '../research-portfolios/research-portfolio-meri-scope.service.js';
import {
  assertResearchPortfolioProposalTurnScope,
  authorizeResearchPortfolioProposalConversation,
  bindResearchPortfolioProposalInput,
  bindStoredResearchPortfolioProposalInput,
  isResearchPortfolioProposalTool,
  publicResearchPortfolioProposalPreview,
  readStoredResearchPortfolioProposalTurnScope,
  researchPortfolioProposalFingerprintInput,
  storeResearchPortfolioProposalTurnScope,
  type ResearchPortfolioProposalConversationCheckpoint,
  type ResearchPortfolioProposalTurnScope,
} from './meri-rp-proposal-binding.js';

export const MERI_ACTION_PROPOSAL_STATUSES = [
  'proposed',
  'approved',
  'executing',
  'succeeded',
  'failed_retryable',
  'failed_terminal',
  'outcome_unknown',
  'blocked',
  'dismissed',
  'expired',
] as const;
export type MeriActionProposalStatus = (typeof MERI_ACTION_PROPOSAL_STATUSES)[number];

export interface CreateMeriActionProposalInput {
  tool: string;
  input: unknown;
  conversationId?: string;
  surface: 'chat';
}

export interface PublicMeriActionProposal {
  proposalId: string;
  status: MeriActionProposalStatus;
  tool: string;
  preview: MeriActionPreview;
  expiresAt: string;
  reason: string;
  ruleId: string | null;
  riskTier: string | null;
  policyCode: string | null;
  attemptCount: number;
  resultSummary: unknown;
  error?: { code: string | null; message: string | null };
  approvedAt?: string | null;
  approvedBy?: string | null;
  policy: {
    source: string;
    mode: string;
    packKey: string;
    packVersion: string;
    binding: string;
    decisionHash: string;
    contextHash: string;
    decision: string;
    jurisdiction: string;
    channel: string;
    recipientType: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export type MeriActionAuthorityResult =
  | { disposition: 'executed'; proposal: PublicMeriActionProposal; executionResult: unknown }
  | { disposition: 'pending_approval'; proposal: PublicMeriActionProposal }
  | { disposition: 'blocked'; proposal: PublicMeriActionProposal }
  | { disposition: 'failed'; proposal: PublicMeriActionProposal; executionResult?: unknown };

const TERMINAL_STATUSES = new Set<MeriActionProposalStatus>([
  'succeeded',
  'failed_terminal',
  'outcome_unknown',
  'blocked',
  'dismissed',
  'expired',
]);
const CLAIMABLE_STATUSES: MeriActionProposalStatus[] = ['proposed', 'failed_retryable'];
const EXTERNAL_SEND_TOOLS = new Set(['send_email', 'reply_email']);

function bounded(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|secret|token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function constantTimeHexEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function resultSummary(result: unknown): Prisma.InputJsonValue {
  if (result === null || result === undefined) return { ok: true };
  if (typeof result !== 'object' || Array.isArray(result)) {
    return { ok: true, value: bounded(result, 300) } as Prisma.InputJsonValue;
  }
  const source = result as Record<string, unknown>;
  const summary: Record<string, Prisma.InputJsonValue> = { ok: source.ok !== false };
  for (const key of [
    'tool',
    'id',
    'status',
    'name',
    'title',
    'clientId',
    'clientName',
    'documentId',
    'location',
    'indexingStatus',
    'reused',
    'savedCount',
    'pendingCount',
    'failedCount',
    'message',
    'portfolioId',
    'portfolioRevision',
    'resultingRevision',
    'snapshotId',
    'requestId',
    'jobId',
    'outputId',
    'artifactId',
    'operationKey',
    'operationId',
    'sha256',
    'byteLength',
    'filename',
    'contentHash',
    'attachmentId',
    'attachmentName',
    'openPath',
    'draftId',
    'sentFrom',
    'to',
    'subject',
    'error',
    'scheduled',
    'active',
    'creationConfirmed',
    'reconciled',
    'canceled',
    'taskId',
  ]) {
    const value = source[key];
    if (typeof value === 'string') summary[key] = bounded(value, 300) ?? '';
    else if (typeof value === 'number' || typeof value === 'boolean') summary[key] = value;
  }
  const client = source.client;
  if (client && typeof client === 'object' && !Array.isArray(client)) {
    const record = client as Record<string, unknown>;
    summary.client = {
      ...(typeof record.id === 'string' ? { id: bounded(record.id, 100) ?? '' } : {}),
      ...(typeof record.name === 'string' ? { name: bounded(record.name, 200) ?? '' } : {}),
    };
  }
  const counts: Record<string, number> = {};
  for (const key of [
    'fieldsWritten',
    'peopleCreated',
    'facilitiesCreated',
    'capabilitiesCreated',
    'recipients',
  ]) {
    if (Array.isArray(source[key])) counts[key] = source[key].length;
    else if (typeof source[key] === 'number') counts[key] = source[key] as number;
  }
  if (Object.keys(counts).length) summary.counts = counts;
  // Durable filing receipts must survive a proposal round trip. Keep only
  // identity/status/navigation fields; note bodies and uploaded bytes stay out
  // of the public action history.
  if (source.note && typeof source.note === 'object' && !Array.isArray(source.note)) {
    const note = source.note as Record<string, unknown>;
    summary.note = Object.fromEntries(
      ['id', 'clientId', 'title']
        .filter(
          (key) => typeof note[key] === 'string' || (key === 'clientId' && note[key] === null),
        )
        .map((key) => [key, note[key] === null ? null : (bounded(note[key], 200) ?? '')]),
    );
  }
  if (source.tool === 'save_chat_attachments' && Array.isArray(source.files)) {
    summary.files = source.files.slice(0, 10).map((file: unknown) => {
      if (!file || typeof file !== 'object' || Array.isArray(file)) return {};
      const row = file as Record<string, unknown>;
      return Object.fromEntries(
        ['attachmentId', 'fileName', 'status', 'documentId', 'location', 'reason', 'indexingStatus']
          .filter((key) => typeof row[key] === 'string')
          .map((key) => [key, bounded(row[key], key === 'reason' ? 500 : 300) ?? '']),
      );
    });
  }
  for (const key of ['request', 'artifact', 'task']) {
    const value = source[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    summary[key] = Object.fromEntries(
      [
        'id',
        'status',
        'portfolioId',
        'snapshotId',
        'operationKey',
        'requestId',
        'artifactId',
        'contentHash',
        'attachmentId',
        'openPath',
        'title',
        'enabled',
        'lastStatus',
        'active',
        'creationConfirmed',
      ]
        .filter(
          (field) =>
            typeof record[field] === 'string' ||
            typeof record[field] === 'number' ||
            typeof record[field] === 'boolean' ||
            record[field] === null,
        )
        .map((field) => [
          field,
          typeof record[field] === 'string'
            ? (bounded(record[field], 300) ?? '')
            : (record[field] as Prisma.InputJsonValue),
        ]),
    );
  }
  const sendReceipt = source.sendReceipt;
  if (sendReceipt && typeof sendReceipt === 'object' && !Array.isArray(sendReceipt)) {
    const receipt = sendReceipt as Record<string, unknown>;
    summary.sendReceipt = {
      ok: receipt.ok === true,
      ...Object.fromEntries(
        [
          'provider',
          'providerMessageId',
          'providerThreadId',
          'providerDraftId',
          'providerConversationId',
          'providerInternetMessageId',
          'correlationId',
        ]
          .filter((field) => typeof receipt[field] === 'string')
          .map((field) => [field, bounded(receipt[field], 300) ?? '']),
      ),
    };
  }
  const artifactPersistence = source.artifactPersistence;
  if (
    artifactPersistence &&
    typeof artifactPersistence === 'object' &&
    !Array.isArray(artifactPersistence)
  ) {
    const persistence = artifactPersistence as Record<string, unknown>;
    summary.artifactPersistence = {
      persisted: persistence.persisted === true,
      ...(typeof persistence.error === 'string'
        ? { error: bounded(persistence.error, 500) ?? '' }
        : {}),
      ...(typeof persistence.reason === 'string'
        ? { reason: bounded(persistence.reason, 500) ?? '' }
        : {}),
    };
  }
  return summary as Prisma.InputJsonValue;
}

function filingExecutionFailure(
  tool: string,
  result: unknown,
): {
  status: 'failed_retryable' | 'outcome_unknown';
  errorCode: string;
  errorMessage: string;
} | null {
  if (tool !== 'save_note' && tool !== 'save_chat_attachments') return null;
  const value =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  if (
    tool === 'save_chat_attachments' &&
    (value.status === 'failed' ||
      (Array.isArray(value.files) &&
        value.files.some(
          (file: unknown) =>
            !!file &&
            typeof file === 'object' &&
            (file as Record<string, unknown>).status === 'failed',
        )))
  ) {
    return {
      status: 'failed_retryable',
      errorCode: 'client_filing_incomplete',
      errorMessage:
        'Some files could not be filed. Review each file result and retry the failed files; completed files will not be duplicated.',
    };
  }
  const note =
    value.note && typeof value.note === 'object' ? (value.note as Record<string, unknown>) : {};
  if (tool === 'save_note' && value.status === 'failed') {
    return {
      status: 'failed_retryable',
      errorCode: 'client_filing_incomplete',
      errorMessage:
        bounded(value.message, 900) ??
        'The note is unavailable under the document readiness policy.',
    };
  }
  const confirmed =
    tool === 'save_note'
      ? ['saved', 'pending'].includes(String(value.status)) &&
        (typeof note.id === 'string' || typeof value.documentId === 'string')
      : ['saved', 'pending', 'partial'].includes(String(value.status)) &&
        Array.isArray(value.files) &&
        value.files.length > 0 &&
        value.files.every(
          (file: unknown) =>
            !!file &&
            typeof file === 'object' &&
            ['saved', 'pending'].includes(String((file as Record<string, unknown>).status)) &&
            typeof (file as Record<string, unknown>).documentId === 'string',
        );
  if (confirmed) return null;
  return {
    status: 'outcome_unknown',
    errorCode: 'client_filing_receipt_missing',
    errorMessage:
      'The save did not return a confirmed record. Check the client records before retrying.',
  };
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return null;
}

function classifyExecutionFailure(
  tool: string,
  error: unknown,
): {
  status: 'failed_retryable' | 'failed_terminal' | 'outcome_unknown';
  code: string;
  message: string;
} {
  const httpStatus = errorStatus(error);
  const rawCode =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null;
  const message =
    bounded(error instanceof Error ? error.message : error, 900) ?? 'Execution failed';
  const terminal =
    (httpStatus !== null &&
      httpStatus >= 400 &&
      httpStatus < 500 &&
      httpStatus !== 408 &&
      httpStatus !== 429) ||
    /invalid|malformed|not found|forbidden|unauthorized|permission|validation|required/i.test(
      message,
    );
  if (EXTERNAL_SEND_TOOLS.has(tool)) {
    return terminal
      ? { status: 'failed_terminal', code: rawCode ?? `http_${httpStatus ?? 400}`, message }
      : { status: 'outcome_unknown', code: rawCode ?? 'external_outcome_unknown', message };
  }
  if (tool === 'schedule_task' && !terminal) {
    return {
      status: 'outcome_unknown',
      code: rawCode ?? 'schedule_task_outcome_unknown',
      message: `${message} Check scheduled tasks before any retry.`,
    };
  }
  if (terminal)
    return { status: 'failed_terminal', code: rawCode ?? `http_${httpStatus ?? 400}`, message };
  const retryable =
    httpStatus === 408 ||
    httpStatus === 429 ||
    (httpStatus !== null && httpStatus >= 500) ||
    /timeout|temporar|unavailable|rate limit|ECONNRESET|ETIMEDOUT|deadlock/i.test(message);
  return retryable
    ? { status: 'failed_retryable', code: rawCode ?? 'transient_failure', message }
    : { status: 'failed_terminal', code: rawCode ?? 'execution_failed', message };
}

function confirmedScheduleCreation(tool: string, result: unknown): boolean {
  if (tool !== 'schedule_task' || !result || typeof result !== 'object' || Array.isArray(result)) {
    return false;
  }
  const value = result as Record<string, unknown>;
  const task =
    value.task && typeof value.task === 'object' && !Array.isArray(value.task)
      ? (value.task as Record<string, unknown>)
      : null;
  return value.creationConfirmed === true && typeof task?.id === 'string' && task.id.length > 0;
}

@Injectable()
export class MeriActionProposalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: MeriToolsService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly policyPacks: MeriPolicyPackService,
    private readonly researchPortfolioScopes: ResearchPortfolioMeriScopeService,
    @Optional() @Inject(CASE46_AUTHORITY_DEPENDENCIES)
    private readonly case46?: Case46AuthorityDependencies,
  ) {}

  private assertEnabled(): void {
    if (!this.config.get('MERIV2_ACTION_PROPOSALS_ENABLED')) {
      throw new ServiceUnavailableException('MeriV2 action proposals are disabled.');
    }
  }

  private toPublic(row: MeriActionProposal): PublicMeriActionProposal {
    const preview = publicResearchPortfolioProposalPreview(
      publicCase46ProposalPreview(row.preview),
    ) as unknown as MeriActionPreview;
    return {
      proposalId: row.id,
      status: row.status as MeriActionProposalStatus,
      tool: row.tool,
      preview,
      expiresAt: row.expiresAt.toISOString(),
      reason: preview.reason,
      ruleId: row.policyRuleId,
      riskTier: row.riskTier,
      policyCode: row.policyCode,
      attemptCount: row.attemptCount,
      resultSummary: row.resultSummary,
      ...(row.lastErrorCode || row.lastErrorMessage
        ? { error: { code: row.lastErrorCode, message: row.lastErrorMessage } }
        : {}),
      approvedAt: row.approvedAt?.toISOString() ?? null,
      approvedBy: row.approvedBy ?? null,
      policy: {
        source: row.policySource,
        mode: row.policyMode,
        packKey: row.policyPackKey,
        packVersion: row.policyPackVersion,
        binding: row.policyBinding,
        decisionHash: row.policyDecisionHash,
        contextHash: row.policyContextHash,
        decision: row.policyDecision,
        jurisdiction: row.policyJurisdiction,
        channel: row.policyChannel,
        recipientType: row.policyRecipientType,
      },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async recordDecisionInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    proposalId: string,
    tool: string,
    decision: AuthoritativePolicyDecision,
  ): Promise<void> {
    await this.policyPacks.recordDecisionInTx(tx, ctx.tenantId, decision, {
      tool,
      channel: decision.context.channel,
      recipientType: decision.context.recipientType,
      actorUserId: decision.context.actorUserId,
      actorRole: String(decision.context.actorRole),
      clientId: decision.context.clientId,
      jurisdiction: decision.context.jurisdiction,
      meriActionProposalId: proposalId,
    });
    await tx.complianceCheck.create({
      data: {
        tenantId: ctx.tenantId,
        trigger: tool.slice(0, 120),
        decision: decision.outcome,
        reason: bounded(decision.reason, 4000) ?? 'Policy decision',
        ruleSource: decision.ruleId?.slice(0, 120) ?? null,
        policyPackKey: decision.packId,
        policyPackVersion: decision.packVersion,
        policyBinding: decision.binding,
        policyDecisionHash: decision.decisionHash,
        requiredApproval: decision.outcome === 'WARN',
        actorUserId: decision.context.actorUserId,
        entityType: 'meri_action_proposal',
        entityId: proposalId,
      },
    });
  }

  private async recordTransitionCheck(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    row: MeriActionProposal,
    outcome: 'WARN' | 'BLOCK',
    code: string,
    message: string,
  ): Promise<void> {
    await tx.complianceCheck.create({
      data: {
        tenantId: ctx.tenantId,
        trigger: row.tool.slice(0, 120),
        decision: outcome,
        reason: bounded(message, 4000) ?? code,
        ruleSource: code,
        policyPackKey: row.policyPackKey,
        policyPackVersion: row.policyPackVersion,
        policyBinding: row.policyBinding,
        policyDecisionHash: row.policyDecisionHash,
        requiredApproval: outcome === 'WARN',
        actorUserId: ctx.userId,
        entityType: 'meri_action_proposal',
        entityId: row.id,
      },
    });
  }

  private async resolveClientName(
    ctx: TenantContext,
    input: Record<string, unknown>,
  ): Promise<string | null> {
    const clientId = typeof input.clientId === 'string' ? input.clientId : null;
    if (!clientId) return null;
    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { name: true },
      }),
    );
    return client?.name ?? null;
  }

  private async lockResearchPortfolioProposalConversation(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    conversationId: string,
    checkpoint: ResearchPortfolioProposalConversationCheckpoint,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "clio_conversations"
      WHERE "id" = ${conversationId}::uuid
        AND "tenant_id" = ${ctx.tenantId}::uuid
        AND "user_id" = ${ctx.userId}::uuid
        AND "archived_at" IS NULL
        AND "client_id" IS NOT DISTINCT FROM ${checkpoint.clientId}::uuid
        AND "metadata_jsonb" = ${JSON.stringify(checkpoint.metadata)}::jsonb
      FOR UPDATE
    `;
    return rows.length === 1;
  }

  async create(
    ctx: TenantContext,
    request: CreateMeriActionProposalInput,
    trustedTurn?: ResearchPortfolioProposalTurnScope,
    capturePolicy: MeriGovernedArtifactCapturePolicy | null = null,
  ): Promise<MeriActionAuthorityResult> {
    assertMeriToolRequestActive();
    this.assertEnabled();
    const tool = request.tool.trim();
    const proposalTurn = assertResearchPortfolioProposalTurnScope(
      tool,
      trustedTurn,
      request.conversationId,
    );
    const boundInput = bindResearchPortfolioProposalInput(
      tool,
      request.input,
      request.conversationId,
    );
    const input = this.tools.validateSideEffectingInput(tool, boundInput);
    if (isResearchPortfolioProposalTool(tool)) {
      await authorizeResearchPortfolioProposalConversation(
        this.prisma,
        this.researchPortfolioScopes,
        ctx,
        request.conversationId!,
        proposalTurn!.selectedClientId,
        typeof input.clientId === 'string' ? input.clientId : null,
      );
    }
    const decision = await this.policyPacks.decideForAction(ctx, tool, input);
    const status: MeriActionProposalStatus =
      decision.outcome === 'BLOCK'
        ? 'blocked'
        : decision.outcome === 'WARN' || capturePolicy
          ? 'proposed'
          : 'executing';
    const now = new Date();
    const expiresAt = new Date(
      Math.min(now.getTime() + this.config.get('MERIV2_ACTION_PROPOSAL_TTL_MINUTES') * 60_000,
        capturePolicy?.expiresAt ?? Number.POSITIVE_INFINITY),
    );
    const fingerprint = computeActionFingerprintV2({
      effectiveTenantId: ctx.tenantId,
      userId: ctx.userId,
      tool,
      input: researchPortfolioProposalFingerprintInput(tool, input, proposalTurn),
      policyVersion: decision.packVersion,
      policyBinding: decision.binding,
      policyDecisionHash: decision.decisionHash,
      policyContextHash: decision.contextHash,
    });
    const clientName = await this.resolveClientName(ctx, input);
    const preview = buildMeriActionPreview({
      tool,
      input,
      riskTier: decision.tier ?? null,
      reason: decision.reason,
      clientName,
    });
    const storedPreview = storeResearchPortfolioProposalTurnScope(
      tool,
      preview as unknown as Record<string, unknown>,
      proposalTurn,
    );

    const rpCheckpoint = isResearchPortfolioProposalTool(tool)
      ? await authorizeResearchPortfolioProposalConversation(
          this.prisma,
          this.researchPortfolioScopes,
          ctx,
          request.conversationId!,
          proposalTurn!.selectedClientId,
          typeof input.clientId === 'string' ? input.clientId : null,
        )
      : undefined;

    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      assertMeriToolRequestActive();
      const currentCapture = await assertCase46ProposalAuthorityInTx(tx, this.case46, ctx,
        { ...request, tool, input }, { phase: 'create', policy: capturePolicy });
      if (
        rpCheckpoint &&
        !(await this.lockResearchPortfolioProposalConversation(
          tx,
          ctx,
          request.conversationId!,
          rpCheckpoint,
        ))
      ) {
        throw new BadRequestException(
          'The current Research Portfolio conversation authority changed before proposal creation.',
        );
      }
      const created = await tx.meriActionProposal.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          actorUserId: decision.context.actorUserId,
          impersonationSessionId: null,
          conversationId: request.conversationId ?? null,
          surface: request.surface,
          tool,
          input: input as Prisma.InputJsonValue,
          fingerprint,
          policyVersion: decision.packVersion,
          policyPackId: decision.policyPackRowId,
          policyPackKey: decision.packId,
          policyPackVersion: decision.packVersion,
          policyBinding: decision.binding,
          policyDecisionHash: decision.decisionHash,
          policyContextHash: decision.contextHash,
          policySource: decision.source,
          policyMode: decision.mode,
          policyJurisdiction: decision.context.jurisdiction,
          policyChannel: decision.context.channel,
          policyRecipientType: decision.context.recipientType ?? null,
          policyClientId: decision.context.clientId ?? null,
          policyEffectiveUserId: decision.context.effectiveUserId,
          policyEffectiveAt: decision.context.effectiveAt,
          policyRuleId: decision.ruleId,
          policyDecision: decision.outcome,
          policyCode: decision.code ?? null,
          riskTier: decision.tier ?? null,
          preview: { ...storedPreview, ...(currentCapture ? {
            [CASE46_PROPOSAL_MARKER]: case46ProposalMarker(currentCapture),
          } : {}) } as unknown as Prisma.InputJsonValue,
          status,
          expiresAt,
          ...(decision.outcome === 'PASS' && !currentCapture
            ? { executionStartedAt: now, attemptCount: 1 }
            : decision.outcome === 'BLOCK'
              ? {
                  executedAt: now,
                  lastErrorCode: decision.code ?? 'policy_blocked',
                  lastErrorMessage: decision.reason,
                }
              : {}),
        },
      });
      await this.recordDecisionInTx(tx, ctx, created.id, tool, decision);
      return created;
    });

    if (decision.outcome === 'WARN' || (capturePolicy && decision.outcome !== 'BLOCK'))
      return { disposition: 'pending_approval', proposal: this.toPublic(row) };
    if (decision.outcome === 'BLOCK')
      return { disposition: 'blocked', proposal: this.toPublic(row) };

    try {
      assertMeriToolRequestActive();
      const result = await this.tools.executeFromAuthenticatedUser(ctx, tool, input, {
        actionProposalId: row.id,
      });
      // The proposal id is the send correlation id: an accepted send_email
      // receipt must be bound to this exact proposal before it counts as success.
      const incomplete = confirmedScheduleCreation(tool, result)
        ? null
        : (classifyMeriActionLogicalFailure(tool, result, row.id) ??
          filingExecutionFailure(tool, result));
      if (incomplete) {
        const failed = await this.finalize(ctx, row.id, {
          ...incomplete,
          resultSummary: resultSummary(result),
        });
        return { disposition: 'failed', proposal: this.toPublic(failed), executionResult: result };
      }
      const completed = await this.finalize(ctx, row.id, {
        status: 'succeeded',
        resultSummary: resultSummary(result),
      });
      return {
        disposition: 'executed',
        proposal: this.toPublic(completed),
        executionResult: result,
      };
    } catch (error) {
      const failure = classifyExecutionFailure(tool, error);
      const failed = await this.finalize(ctx, row.id, {
        status: failure.status,
        errorCode: bounded(failure.code, 120),
        errorMessage: failure.message,
      });
      return { disposition: 'failed', proposal: this.toPublic(failed) };
    }
  }

  private async reconcileStaleExecuting(ctx: TenantContext): Promise<void> {
    const cutoff = new Date(Date.now() - 5 * 60_000);
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriActionProposal.updateMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          status: 'executing',
          executionStartedAt: { lt: cutoff },
        },
        data: {
          status: 'outcome_unknown',
          executedAt: new Date(),
          lastErrorCode: 'stale_execution',
          lastErrorMessage:
            'Execution ended without a provable terminal result; reconciliation is required.',
        },
      }),
    );
  }

  private async reconcileUnknownScheduleReceipts(ctx: TenantContext): Promise<void> {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriActionProposal.findMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          tool: 'schedule_task',
          status: 'outcome_unknown',
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
    for (const row of rows) {
      // Re-check the immutable proposal/policy binding before exposing a durable
      // receipt through status recovery. This is evidence lookup, not renewed
      // authority, and it never redispatches the tool.
      if (row.tool !== 'schedule_task' || row.status !== 'outcome_unknown') continue;
      let canonical: Record<string, unknown>;
      try {
        canonical = this.tools.validateSideEffectingInput(row.tool, row.input);
      } catch {
        continue;
      }
      const recomputed = computeActionFingerprintV2({
        effectiveTenantId: ctx.tenantId,
        userId: ctx.userId,
        tool: row.tool,
        input: canonical,
        policyVersion: row.policyPackVersion,
        policyBinding: row.policyBinding,
        policyDecisionHash: row.policyDecisionHash,
        policyContextHash: row.policyContextHash,
      });
      if (!constantTimeHexEqual(row.fingerprint, recomputed)) continue;
      const receipt = await this.tools.readScheduleTaskReceipt(ctx, row.id, canonical);
      if (!receipt) continue;
      await this.finalize(ctx, row.id, {
        status: 'succeeded',
        resultSummary: resultSummary({
          tool: 'schedule_task',
          scheduled: receipt.active,
          active: receipt.active,
          creationConfirmed: true,
          reconciled: true,
          task: receipt,
        }),
      });
    }
  }

  private async expireStale(ctx: TenantContext): Promise<void> {
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriActionProposal.updateMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          status: { in: ['proposed', 'approved', 'failed_retryable'] },
          expiresAt: { lte: new Date() },
        },
        data: { status: 'expired' },
      }),
    );
  }

  async list(
    ctx: TenantContext,
    conversationId?: string,
    proposalId?: string,
  ): Promise<PublicMeriActionProposal[]> {
    this.assertEnabled();
    if (proposalId && !conversationId) {
      throw new BadRequestException('conversationId is required for an exact proposal receipt.');
    }
    await this.reconcileStaleExecuting(ctx);
    await this.reconcileUnknownScheduleReceipts(ctx);
    await this.expireStale(ctx);
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriActionProposal.findMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          ...(conversationId ? { conversationId } : {}),
          ...(proposalId ? { id: proposalId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
    return rows.map((row) => this.toPublic(row));
  }

  private async owned(ctx: TenantContext, proposalId: string): Promise<MeriActionProposal> {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriActionProposal.findFirst({
        where: { id: proposalId, tenantId: ctx.tenantId, userId: ctx.userId },
      }),
    );
    if (!row) throw new NotFoundException('Action proposal not found.');
    return row;
  }

  private async transitionWithoutExecution(
    ctx: TenantContext,
    row: MeriActionProposal,
    status: 'blocked' | 'expired',
    code: string,
    message: string,
  ): Promise<PublicMeriActionProposal> {
    const updated = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.meriActionProposal.updateMany({
        where: {
          id: row.id,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          status: { in: CLAIMABLE_STATUSES },
        },
        data: {
          status,
          lastErrorCode: code,
          lastErrorMessage: bounded(message, 900),
          executedAt: new Date(),
        },
      });
      await this.recordTransitionCheck(
        tx,
        ctx,
        row,
        status === 'blocked' ? 'BLOCK' : 'WARN',
        code,
        message,
      );
      return tx.meriActionProposal.findFirstOrThrow({
        where: { id: row.id, tenantId: ctx.tenantId, userId: ctx.userId },
      });
    });
    return this.toPublic(updated);
  }

  private async invalidateForPolicyChange(
    ctx: TenantContext,
    row: MeriActionProposal,
    current: AuthoritativePolicyDecision,
  ): Promise<PublicMeriActionProposal> {
    const message =
      'The governing policy pack, rule, or server-resolved context changed after proposal creation. Review a new proposal.';
    const updated = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.meriActionProposal.updateMany({
        where: {
          id: row.id,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          status: { in: CLAIMABLE_STATUSES },
        },
        data: {
          status: 'blocked',
          lastErrorCode: 'policy_binding_changed',
          lastErrorMessage: message,
          executedAt: new Date(),
        },
      });
      await this.recordDecisionInTx(tx, ctx, row.id, row.tool, current);
      return tx.meriActionProposal.findFirstOrThrow({
        where: { id: row.id, tenantId: ctx.tenantId, userId: ctx.userId },
      });
    });
    return this.toPublic(updated);
  }

  private async finalize(
    ctx: TenantContext,
    proposalId: string,
    data: {
      status: 'succeeded' | 'failed_retryable' | 'failed_terminal' | 'outcome_unknown';
      resultSummary?: Prisma.InputJsonValue;
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<MeriActionProposal> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.meriActionProposal.updateMany({
        where: {
          id: proposalId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          status: { in: ['executing', 'outcome_unknown'] },
        },
        data: {
          status: data.status,
          executedAt: new Date(),
          resultSummary: data.resultSummary,
          lastErrorCode: data.errorCode ?? null,
          lastErrorMessage: data.errorMessage ?? null,
        },
      });
      return tx.meriActionProposal.findFirstOrThrow({
        where: { id: proposalId, tenantId: ctx.tenantId, userId: ctx.userId },
      });
    });
  }

  async approveAndExecute(
    ctx: TenantContext,
    proposalId: string,
  ): Promise<PublicMeriActionProposal> {
    this.assertEnabled();
    await this.reconcileStaleExecuting(ctx);
    let row = await this.owned(ctx, proposalId);
    const status = row.status as MeriActionProposalStatus;
    if (TERMINAL_STATUSES.has(status) || status === 'executing') return this.toPublic(row);
    if (!CLAIMABLE_STATUSES.includes(status)) return this.toPublic(row);
    if (row.expiresAt.getTime() <= Date.now()) {
      return this.transitionWithoutExecution(
        ctx,
        row,
        'expired',
        'proposal_expired',
        'This proposal expired before approval and cannot execute.',
      );
    }

    let proposalTurn: ResearchPortfolioProposalTurnScope | undefined;
    if (isResearchPortfolioProposalTool(row.tool)) {
      try {
        proposalTurn = readStoredResearchPortfolioProposalTurnScope(
          row.tool,
          row.preview,
          row.conversationId,
        );
      } catch {
        return this.transitionWithoutExecution(
          ctx,
          row,
          'blocked',
          'stored_scope_invalid',
          'The stored Research Portfolio proposal has no valid trusted current-turn scope.',
        );
      }
    }
    let canonical: Record<string, unknown>;
    try {
      const boundInput = bindStoredResearchPortfolioProposalInput(
        row.tool,
        row.input,
        row.conversationId,
      );
      canonical = this.tools.validateSideEffectingInput(row.tool, boundInput);
    } catch {
      return this.transitionWithoutExecution(
        ctx,
        row,
        'blocked',
        'stored_input_invalid',
        'The stored action no longer passes the canonical write-input parser.',
      );
    }
    if (isResearchPortfolioProposalTool(row.tool)) {
      await authorizeResearchPortfolioProposalConversation(
        this.prisma,
        this.researchPortfolioScopes,
        ctx,
        row.conversationId!,
        proposalTurn!.selectedClientId,
        row.policyClientId,
      );
    }
    const recomputed = computeActionFingerprintV2({
      effectiveTenantId: ctx.tenantId,
      userId: ctx.userId,
      tool: row.tool,
      input: researchPortfolioProposalFingerprintInput(row.tool, canonical, proposalTurn),
      policyVersion: row.policyPackVersion,
      policyBinding: row.policyBinding,
      policyDecisionHash: row.policyDecisionHash,
      policyContextHash: row.policyContextHash,
    });
    if (!constantTimeHexEqual(row.fingerprint, recomputed)) {
      return this.transitionWithoutExecution(
        ctx,
        row,
        'blocked',
        'fingerprint_mismatch',
        'The immutable proposal payload or bound policy evidence does not match its server fingerprint.',
      );
    }

    const current = await this.policyPacks.decideForAction(ctx, row.tool, canonical);
    const captureRequest = { tool: row.tool, input: canonical, conversationId: row.conversationId, surface: row.surface };
    const currentCapture = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      assertCase46ProposalAuthorityInTx(tx, this.case46, ctx, captureRequest,
        { phase: 'approve', proposalId: row.id, preview: row.preview }));
    // PASS actions can already have executed and failed safely in create(). A
    // retry keeps that original authority; it does not turn a new PASS action
    // into an approval or accept a changed policy outcome.
    const sameOutcome =
      (row.policyDecision === 'WARN' && current.outcome === 'WARN') ||
      (currentCapture !== null && row.policyDecision === 'PASS' && current.outcome === 'PASS') ||
      (status === 'failed_retryable' &&
        row.attemptCount > 0 &&
        row.policyDecision === 'PASS' &&
        current.outcome === 'PASS');
    const sameAuthority =
      sameOutcome &&
      row.policyBinding === current.binding &&
      row.policyDecisionHash === current.decisionHash &&
      row.policyContextHash === current.contextHash &&
      row.policyPackKey === current.packId &&
      row.policyPackVersion === current.packVersion;
    if (!sameAuthority) return this.invalidateForPolicyChange(ctx, row, current);

    const rpCheckpoint = isResearchPortfolioProposalTool(row.tool)
      ? await authorizeResearchPortfolioProposalConversation(
          this.prisma,
          this.researchPortfolioScopes,
          ctx,
          row.conversationId!,
          proposalTurn!.selectedClientId,
          row.policyClientId,
        )
      : undefined;

    const claimed = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // The earlier read decides policy compatibility; this same-transaction
      // reread holds source/actor/turn/budget locks through the canonical claim.
      await assertCase46ProposalAuthorityInTx(tx, this.case46, ctx, captureRequest,
        { phase: 'approve', proposalId: row.id, preview: row.preview });
      if (
        rpCheckpoint &&
        !(await this.lockResearchPortfolioProposalConversation(
          tx,
          ctx,
          row.conversationId!,
          rpCheckpoint,
        ))
      ) {
        throw new BadRequestException(
          'The current Research Portfolio conversation authority changed before execution claim.',
        );
      }
      const claim = await tx.meriActionProposal.updateMany({
        where: {
          id: row.id,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          status: { in: CLAIMABLE_STATUSES },
          expiresAt: { gt: new Date() },
        },
        data: {
          status: 'executing',
          approvedAt: new Date(),
          approvedBy: ctx.userId,
          executionStartedAt: new Date(),
          executedAt: null,
          attemptCount: { increment: 1 },
          lastErrorCode: null,
          lastErrorMessage: null,
          resultSummary: undefined,
        },
      });
      if (claim.count === 1) await this.recordDecisionInTx(tx, ctx, row.id, row.tool, current);
      const found = await tx.meriActionProposal.findFirstOrThrow({
        where: { id: row.id, tenantId: ctx.tenantId, userId: ctx.userId },
      });
      return { won: claim.count === 1, row: found };
    });
    if (!claimed.won) return this.toPublic(claimed.row);
    row = claimed.row;

    try {
      const result = await this.tools.executeFromAuthenticatedUser(ctx, row.tool, canonical, {
        actionProposalId: row.id,
      });
      const incomplete = confirmedScheduleCreation(row.tool, result)
        ? null
        : (classifyMeriActionLogicalFailure(row.tool, result, row.id) ??
          filingExecutionFailure(row.tool, result));
      if (incomplete)
        return this.toPublic(
          await this.finalize(ctx, row.id, {
            ...incomplete,
            resultSummary: resultSummary(result),
          }),
        );
      return this.toPublic(
        await this.finalize(ctx, row.id, {
          status: 'succeeded',
          resultSummary: resultSummary(result),
        }),
      );
    } catch (error) {
      const failure = classifyExecutionFailure(row.tool, error);
      return this.toPublic(
        await this.finalize(ctx, row.id, {
          status: failure.status,
          errorCode: bounded(failure.code, 120),
          errorMessage: failure.message,
        }),
      );
    }
  }

  async dismiss(ctx: TenantContext, proposalId: string): Promise<PublicMeriActionProposal> {
    this.assertEnabled();
    const row = await this.owned(ctx, proposalId);
    const status = row.status as MeriActionProposalStatus;
    if (!CLAIMABLE_STATUSES.includes(status)) return this.toPublic(row);
    const updated = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const result = await tx.meriActionProposal.updateMany({
        where: {
          id: proposalId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          status: { in: CLAIMABLE_STATUSES },
        },
        data: { status: 'dismissed', executedAt: new Date() },
      });
      if (result.count === 1)
        await this.recordTransitionCheck(
          tx,
          ctx,
          row,
          'WARN',
          'user_dismissed',
          'The user dismissed the proposed action; it was not executed.',
        );
      return tx.meriActionProposal.findFirstOrThrow({
        where: { id: proposalId, tenantId: ctx.tenantId, userId: ctx.userId },
      });
    });
    return this.toPublic(updated);
  }
}
