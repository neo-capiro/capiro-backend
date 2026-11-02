import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { loadCurrentOperationalScopeWithinTx } from '../operational/objective-operational.store.js';
import { operationalFailure } from '../operational/objective-operational.rules.js';
import {
  parseEvidenceReference,
  parseEvidenceSelectors,
  parseQuestionCommand,
  questionId,
} from './objective-question.rules.js';
import { ObjectiveEvidenceSourceService } from '../evidence/objective-evidence-source.service.js';
import type { QuestionEvidenceOwner } from './objective-question.evidence.js';
import {
  commitQuestion,
  findQuestionReceipt,
  presentRevision,
  readQuestionHistory,
  readQuestions,
  readQuestionCitation,
} from './objective-question.store.js';

@Injectable()
export class ObjectiveQuestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: ObjectiveEvidenceSourceService,
  ) {}

  private evidence(
    tx: Parameters<Parameters<PrismaService['withTenant']>[1]>[0],
    ctx: TenantContext,
    scope: Awaited<ReturnType<typeof loadCurrentOperationalScopeWithinTx>>,
  ): QuestionEvidenceOwner {
    return {
      resolve: (selector) => this.sources.resolveWithinTx(tx, ctx, scope, selector),
      inspect: (snapshot) => this.sources.inspectWithinTx(tx, ctx, scope, snapshot),
    };
  }

  evidenceList(
    ctx: TenantContext,
    clientId: string,
    objectiveId: string,
    kind?: string,
    search?: string,
    cursor?: string,
  ) {
    if (
      (kind !== 'document' && kind !== 'news') ||
      (search?.length ?? 0) > 200 ||
      (cursor?.length ?? 0) > 1000
    )
      throw new BadRequestException('Invalid evidence selection.');
    return this.withScope(ctx, clientId, objectiveId, async (tx, scope) => ({
      clientId: scope.clientId,
      objectiveId: scope.objectiveId,
      objectiveVersion: scope.objectiveVersion,
      ...(await this.sources.listWithinTx(tx, ctx, scope, { kind, search, cursor })),
    }));
  }

  evidencePreview(ctx: TenantContext, clientId: string, objectiveId: string, input: unknown) {
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).length !== 1 ||
      !('reference' in input)
    )
      throw new BadRequestException('Invalid evidence reference.');
    const reference = parseEvidenceReference(input.reference);
    return this.withScope(ctx, clientId, objectiveId, async (tx, scope) => ({
      clientId: scope.clientId,
      objectiveId: scope.objectiveId,
      objectiveVersion: scope.objectiveVersion,
      snapshot: await this.sources.previewWithinTx(tx, ctx, scope, reference),
    }));
  }

  evidenceHistory(ctx: TenantContext, clientId: string, objectiveId: string, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('Invalid citation history request.');
    const row = input as Record<string, unknown>;
    if (row.from === 'preview' && Object.keys(row).length === 2 && Object.hasOwn(row, 'selector')) {
      const selector = parseEvidenceSelectors([row.selector])[0]!;
      if (selector.kind !== 'document')
        throw new BadRequestException('Document citation required.');
      return this.withScope(ctx, clientId, objectiveId, async (tx, scope) => ({
        clientId: scope.clientId,
        objectiveId: scope.objectiveId,
        objectiveVersion: scope.objectiveVersion,
        anchor: await this.sources.historyAnchorWithinTx(
          tx,
          ctx,
          scope,
          await this.sources.resolveWithinTx(tx, ctx, scope, selector),
        ),
      }));
    }
    if (
      row.from !== 'question' ||
      Object.keys(row).length !== 4 ||
      !Number.isInteger(row.questionVersion) ||
      Number(row.questionVersion) < 1 ||
      Number(row.questionVersion) > 2147483647 ||
      typeof row.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.digest)
    )
      throw new BadRequestException('Invalid saved citation history request.');
    const id = questionId(row.questionId),
      version = Number(row.questionVersion),
      digest = row.digest;
    return this.withScope(ctx, clientId, objectiveId, async (tx, scope) => ({
      clientId: scope.clientId,
      objectiveId: scope.objectiveId,
      objectiveVersion: scope.objectiveVersion,
      anchor: await this.sources.historyAnchorWithinTx(
        tx,
        ctx,
        scope,
        await readQuestionCitation(tx, ctx, scope, id, version, digest),
      ),
    }));
  }

  private withScope<T>(
    ctx: TenantContext,
    clientId: string,
    objectiveId: string,
    work: (
      tx: Parameters<Parameters<PrismaService['withTenant']>[1]>[0],
      scope: Awaited<ReturnType<typeof loadCurrentOperationalScopeWithinTx>>,
    ) => Promise<T>,
  ) {
    if (!ctx?.tenantId || !ctx.userId || !ctx.clerkUserId) operationalFailure('UNAUTHENTICATED');
    if (!['standard_user', 'user_admin', 'capiro_admin'].includes(ctx.role))
      operationalFailure('FORBIDDEN');
    const client = questionId(clientId),
      objective = questionId(objectiveId);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // The existing canonical reader rechecks actual current member role, wall and revision under locks.
      const scope = await loadCurrentOperationalScopeWithinTx(tx, ctx, client, objective);
      return work(tx, scope);
    });
  }

  list(ctx: TenantContext, clientId: string, objectiveId: string, after?: string, status?: string) {
    if (status && !['open', 'answered', 'closed'].includes(status))
      throw new BadRequestException('Invalid Question status.');
    return this.withScope(ctx, clientId, objectiveId, async (tx, scope) => ({
      clientId: scope.clientId,
      objectiveId: scope.objectiveId,
      objectiveVersion: scope.objectiveVersion,
      ...(await readQuestions(
        tx,
        ctx,
        scope,
        after ? questionId(after) : null,
        status || null,
        this.evidence(tx, ctx, scope),
      )),
    }));
  }

  history(ctx: TenantContext, clientId: string, objectiveId: string, id: string, before?: string) {
    const cursor = before === undefined ? null : Number(before);
    if (cursor !== null && (!Number.isInteger(cursor) || cursor < 1 || cursor > 2147483647))
      throw new BadRequestException('Invalid Question history cursor.');
    return this.withScope(ctx, clientId, objectiveId, async (tx, scope) => ({
      clientId: scope.clientId,
      objectiveId: scope.objectiveId,
      objectiveVersion: scope.objectiveVersion,
      ...(await readQuestionHistory(
        tx,
        ctx,
        scope,
        questionId(id),
        cursor,
        this.evidence(tx, ctx, scope),
      )),
    }));
  }

  command(ctx: TenantContext, clientId: string, objectiveId: string, input: unknown) {
    const command = parseQuestionCommand(input);
    return this.withScope(ctx, clientId, objectiveId, (tx, scope) =>
      commitQuestion(tx, ctx, scope, command, this.evidence(tx, ctx, scope)),
    );
  }

  receipt(ctx: TenantContext, clientId: string, objectiveId: string, requestId: string) {
    return this.withScope(ctx, clientId, objectiveId, async (tx, scope) => {
      const row = await findQuestionReceipt(tx, ctx, scope, questionId(requestId));
      if (!row)
        throw new NotFoundException({
          code: 'OBJECTIVE_QUESTION_RECEIPT_NOT_AVAILABLE',
          outcome: 'unknown',
          message: 'Original Question outcome is not yet available.',
        });
      return presentRevision(row, scope, this.evidence(tx, ctx, scope));
    });
  }
}
