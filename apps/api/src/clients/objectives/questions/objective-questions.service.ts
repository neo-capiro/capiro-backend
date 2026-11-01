import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { loadCurrentOperationalScopeWithinTx } from '../operational/objective-operational.store.js';
import { operationalFailure } from '../operational/objective-operational.rules.js';
import { parseQuestionCommand, questionId } from './objective-question.rules.js';
import {
  commitQuestion,
  findQuestionReceipt,
  presentRevision,
  readQuestionHistory,
  readQuestions,
} from './objective-question.store.js';

@Injectable()
export class ObjectiveQuestionsService {
  constructor(private readonly prisma: PrismaService) {}

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
      ...(await readQuestions(tx, ctx, scope, after ? questionId(after) : null, status || null)),
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
      ...(await readQuestionHistory(tx, ctx, scope, questionId(id), cursor)),
    }));
  }

  command(ctx: TenantContext, clientId: string, objectiveId: string, input: unknown) {
    const command = parseQuestionCommand(input);
    return this.withScope(ctx, clientId, objectiveId, (tx, scope) =>
      commitQuestion(tx, ctx, scope, command),
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
      return presentRevision(row, scope);
    });
  }
}
