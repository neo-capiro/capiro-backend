import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerClient } from './client-ordered-owner.access.js';
import type { AdvancedFindingRow } from './client-profile-fill-finding-review.shared.js';
import {
  currentReviewRevision,
  loadReviewFindings,
  reviewHash,
} from './client-profile-fill-review-snapshot.js';

export type ReviewTransaction = {
  tx: Prisma.TransactionClient;
  afterCommit: Array<() => unknown | Promise<unknown>>;
};
export type ReviewCommand = {
  requestId: string;
  expectedClientRevision: string;
  findings: Array<{ id: string; revision: string }>;
};
export type ReviewResult = {
  requestId: string;
  applied: string[];
  alreadyApplied: string[];
  errors: Array<{ findingId: string; message: string }>;
};
const action = 'client_profile_fill.reviewed_application';

/** Existing audit and finding rows own the receipt. Each finding's domain writes,
 * audit and acceptance share a savepoint; a failed item cannot leave half a write. */
export async function commitReviewedFindings(
  prisma: PrismaService,
  ctx: TenantContext,
  clientId: string,
  runId: string,
  command: ReviewCommand,
  apply: (scope: ReviewTransaction, finding: AdvancedFindingRow) => Promise<unknown>,
  options: {
    target?: unknown;
    warn(message: string): void;
    afterApplied?(findings: AdvancedFindingRow[]): Promise<void>;
  },
) {
  if (
    !command ||
    !isUUID(command.requestId) ||
    !/^[a-f0-9]{64}$/.test(command.expectedClientRevision) ||
    !command.findings?.length ||
    command.findings.length > 200 ||
    command.findings.some((f) => !isUUID(f.id) || !/^[a-f0-9]{64}$/.test(f.revision)) ||
    new Set(command.findings.map((f) => f.id)).size !== command.findings.length
  )
    throw new BadRequestException(
      'A current review snapshot and a unique application request are required',
    );
  const requestId = command.requestId.toLowerCase();
  const digest = reviewHash({
    schemaVersion: 1,
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    clientId,
    runId,
    revision: command.expectedClientRevision,
    findings: [...command.findings].sort((a, b) => a.id.localeCompare(b.id)),
    target: options.target ?? null,
  });
  const effects: ReviewTransaction['afterCommit'] = [];
  const appliedFindings: AdvancedFindingRow[] = [];
  const committed = await prisma.withTenantUser(
    ctx.tenantId,
    ctx.userId,
    async (tx) => {
      await requireOwnerClient(tx, ctx, clientId, true);
      const receipt = await tx.auditLog.findFirst({
        where: { id: requestId, tenantId: ctx.tenantId },
      });
      if (receipt) {
        const saved = receipt.after as {
          schemaVersion?: number;
          digest?: string;
          result?: ReviewResult;
        } | null;
        if (
          receipt.action !== action ||
          receipt.entityId !== clientId ||
          receipt.actorUserId !== ctx.userId ||
          saved?.schemaVersion !== 1 ||
          saved.digest !== digest ||
          !saved.result
        )
          throw new ConflictException('Application request identity or inputs changed');
        return { ...saved.result, replayed: true };
      }
      if ((await currentReviewRevision(tx, ctx, clientId, true)) !== command.expectedClientRevision)
        throw new ConflictException(
          'The client changed after this review. Reload and review the current data before applying.',
        );
      const all = await loadReviewFindings(tx, ctx, clientId, runId, true);
      const selected = command.findings
        .map((expected) => {
          const finding = all.find((f) => f.id === expected.id);
          if (!finding || reviewHash(finding) !== expected.revision)
            throw new ConflictException(
              'A selected finding changed. Reload and review it before applying.',
            );
          return finding;
        })
        .sort((a, b) => (a.kind === 'advocacy_record' ? -1 : b.kind === 'advocacy_record' ? 1 : 0));
      const result: ReviewResult = { requestId, applied: [], alreadyApplied: [], errors: [] };
      for (const finding of selected) {
        if (finding.status === 'accepted') {
          result.alreadyApplied.push(finding.id);
          continue;
        }
        await tx.$executeRawUnsafe('SAVEPOINT reviewed_finding');
        const scope: ReviewTransaction = { tx, afterCommit: [] };
        try {
          if (finding.status !== 'pending')
            throw new BadRequestException('Only pending findings can be applied');
          await apply(scope, finding);
          const changed = await tx.$executeRawUnsafe(
            `UPDATE client_profile_fill_finding SET status='accepted', reviewed_by=$4::uuid, reviewed_at=now(),
             applied_at=now(), rejection_reason=NULL, updated_at=now()
           WHERE id=$1::uuid AND tenant_id=$2::uuid AND client_id=$3::uuid AND status='pending'`,
            finding.id,
            ctx.tenantId,
            clientId,
            ctx.userId,
          );
          if (Number(changed) !== 1) throw new ConflictException('Finding is no longer pending');
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT reviewed_finding');
          effects.push(...scope.afterCommit);
          appliedFindings.push(finding);
          result.applied.push(finding.id);
        } catch (error) {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT reviewed_finding');
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT reviewed_finding');
          result.errors.push({
            findingId: finding.id,
            message:
              error instanceof HttpException
                ? error.message
                : 'Could not apply this finding. No changes from this finding were saved.',
          });
        }
      }
      await tx.auditLog.create({
        data: {
          id: requestId,
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action,
          entityType: 'client_profile_fill_run',
          entityId: clientId,
          after: { schemaVersion: 1, digest, runId, result } as Prisma.InputJsonValue,
        },
      });
      return { ...result, replayed: false };
    },
    { timeoutMs: 30000 },
  );
  if (appliedFindings.length && options.afterApplied)
    effects.push(() => options.afterApplied!(appliedFindings));
  for (const effect of effects) {
    try {
      await effect();
    } catch {
      options.warn('A post-application update failed; the saved review result is unchanged.');
    }
  }
  return committed;
}
