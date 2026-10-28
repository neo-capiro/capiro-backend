import { ConflictException } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import type { MeriMemoryReceivingService } from '../memory-receiving/meri-memory-receiving.service.js';
import type { NativeApprovalService } from '../native-approvals/native-approval.service.js';
import {
  nativeCanonicalSha256 as hash,
  sameJson,
  UUID,
  type NativeApprovalProposal,
} from '../native-approvals/native-approval.contract.js';
import {
  authorizeNativeMemory,
  nativeMemoryCandidate,
} from '../native-approvals/native-memory-command.js';
import { retainedReadObject } from '../retained-read-context.js';
import { receiveNativeDatabaseCommand } from './native-approved-database-execution.js';
import { meriExecutionDbNow } from './meri-execution-authority.js';

type Ports = {
  prisma: PrismaService;
  approvals: NativeApprovalService;
  tenant: TenantContextMiddleware;
  memory: MeriMemoryReceivingService;
};
export type NativeMemoryResult = {
  candidateId: string;
  candidateSha256: string;
  reviewId: string;
  review: {
    status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'not_found';
    decidedAt: string | null;
    publishedMemoryId: string | null;
    checkedAt: string;
  };
};
const conflict = () =>
  new ConflictException('Memory submission differs from the approved proposal');

/** Validate the immutable submission receipt. Current review state is read separately at release. */
function retainedResult(raw: unknown, p: NativeApprovalProposal): NativeMemoryResult {
  const r = retainedReadObject(raw, ['candidateId', 'candidateSha256', 'reviewId', 'review']);
  const review = retainedReadObject(r.review, [
    'status',
    'decidedAt',
    'publishedMemoryId',
    'checkedAt',
  ]);
  if (
    r.candidateId !== p.proposalId ||
    r.candidateSha256 !== hash(nativeMemoryCandidate(p)) ||
    typeof r.reviewId !== 'string' ||
    !UUID.test(r.reviewId) ||
    review.status !== 'pending' ||
    review.decidedAt !== null ||
    review.publishedMemoryId !== null ||
    typeof review.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(review.checkedAt)) ||
    new Date(review.checkedAt).toISOString() !== review.checkedAt
  )
    throw conflict();
  return r as NativeMemoryResult;
}

/** Review-only memory additions share the existing transaction and receipt owner with native tasks. */
export function receiveNativeMemory(
  ports: Ports,
  req: Request,
  ctx: TenantContext,
  raw: unknown,
  mode: 'execute' | 'read',
) {
  return receiveNativeDatabaseCommand<NativeMemoryResult>(
    ports,
    {
      kind: 'native-memory',
      actions: ['memory.propose'],
      userTransaction: true,
      validate: retainedResult,
      async authorize(_tx, _ctx, p, selected, role) {
        const args = authorizeNativeMemory(p, selected, role);
        return args.clientId ? [args.clientId] : [];
      },
      async execute(tx, ctx, p) {
        const candidate = nativeMemoryCandidate(p),
          candidateSha256 = hash(candidate);
        const ack = await ports.memory.submitAdditionInTransaction(
          tx,
          ctx,
          candidate,
          candidateSha256,
        );
        return {
          candidateId: ack.candidateId,
          candidateSha256: ack.candidateSha256,
          reviewId: ack.reviewId,
          review: {
            status: 'pending',
            decidedAt: null,
            publishedMemoryId: null,
            checkedAt: new Date().toISOString(),
          },
        };
      },
      async check(tx, ctx, p, _selected, result) {
        if (!result) return undefined;
        const current = await ports.memory.statusInTransaction(tx, ctx, [
          { candidateId: result.candidateId, candidateSha256: result.candidateSha256 },
        ]);
        const review = current.reviews[0];
        if (
          !review ||
          review.candidateId !== p.proposalId ||
          review.candidateSha256 !== result.candidateSha256 ||
          (review.status !== 'not_found' && review.reviewId !== result.reviewId) ||
          !sameJson(
            { candidateId: result.candidateId, candidateSha256: result.candidateSha256 },
            { candidateId: p.proposalId, candidateSha256: hash(nativeMemoryCandidate(p)) },
          )
        )
          throw conflict();
        return {
          ...result,
          review: {
            status: review.status as NativeMemoryResult['review']['status'],
            decidedAt: review.decidedAt,
            publishedMemoryId: review.publishedMemoryId,
            checkedAt: new Date(await meriExecutionDbNow(tx)).toISOString(),
          },
        };
      },
    },
    req,
    ctx,
    raw,
    mode,
  );
}
