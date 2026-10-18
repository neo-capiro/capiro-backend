import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import { nativeCanonicalSha256 } from '../native-approvals/native-approval.contract.js';
import {
  parseFindByKeyRequest,
  parseMeriMemoryCandidate,
  parseReadTargetRequest,
  parseStatusRequest,
  parseSubmitRequest,
  type MeriMemoryCandidate,
  type MeriMemoryScope,
} from './meri-memory.contract.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_MS = 86_400_000;
const CORE_SCOPE: Record<MeriMemoryScope, string> = { personal: 'user_private', client: 'client', firm: 'firm' };
const MERI_SCOPE: Record<string, MeriMemoryScope> = { user_private: 'personal', client: 'client', firm: 'firm' };

export interface MeriMemoryTarget {
  tenantId: string;
  memoryId: string;
  memorySha256: string;
  scope: MeriMemoryScope;
  clientId: string | null;
  ownerActorId: string | null;
  key: string | null;
  state: 'active' | 'superseded' | 'forgotten' | 'expired';
}

interface SubmissionRow {
  tenantId: string;
  candidateId: string;
  candidateSha256: string;
  proposerUserId: string;
  reviewId: string;
}

interface MemoryRow {
  id: string;
  tenantId: string;
  scope: string;
  ownerUserId: string | null;
  clientId: string | null;
  key: string;
  value: string;
  expiresAt: Date | null;
  updatedAt: Date;
}

const forbidden = () => new ForbiddenException('Memory receiving refused');

/**
 * W8 receiving owner for Meri `apps/control/memory/core-http.mjs`. Every
 * candidate becomes a pending Core `memory_candidate` that only the existing
 * review lifecycle can approve: no inline commit for any scope, and no use of
 * `proposeSaveMemory` (which mints its own id and auto-commits personal
 * memory). A submission ledger keeps the exact Meri candidate, its hash and a
 * stable reviewId, so a replay answers the original acknowledgement.
 */
@Injectable()
export class MeriMemoryReceivingService {
  constructor(private readonly prisma: PrismaService) {}

  async submit(req: Request, ctx: TenantContext, raw: unknown) {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const request = parseSubmitRequest(raw);
    const candidate = parseMeriMemoryCandidate(request.candidate);
    if (nativeCanonicalSha256(request.candidate) !== request.candidateSha256) throw new BadRequestException('candidateSha256 mismatch');
    if (candidate.tenantId !== ctx.tenantId || candidate.proposerActorId !== ctx.userId) throw forbidden();
    if (candidate.kind === 'correction') {
      // Core corrections target memory_items through the immutable version
      // owner; the Meri target id (clio_memory) has no agreed mapping yet.
      throw new ConflictException('Memory corrections are not supported by this receiving route yet');
    }
    const existing = await this.findSubmission(ctx.tenantId, candidate.candidateId);
    if (existing) return this.replay(existing, ctx, request.candidateSha256);
    try {
      const stored = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        if (candidate.clientId && !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, candidate.clientId))) throw forbidden();
        await insertPendingCandidate(tx, ctx, candidate, request.candidateSha256);
        return tx.clioMeriMemorySubmission.create({
          data: {
            tenantId: ctx.tenantId, candidateId: candidate.candidateId, candidateSha256: request.candidateSha256,
            proposerUserId: ctx.userId, reviewId: randomUUID(), candidate: request.candidate as Prisma.InputJsonValue,
          },
        });
      }) as SubmissionRow;
      return ack(stored);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findSubmission(ctx.tenantId, candidate.candidateId);
        if (winner) return this.replay(winner, ctx, request.candidateSha256);
        // A Core candidate already holds this id without a Meri submission.
        throw new ConflictException('Candidate id already in use');
      }
      throw error;
    }
  }

  async status(req: Request, ctx: TenantContext, raw: unknown) {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const pairs = parseStatusRequest(raw);
    const ids = pairs.map((pair) => pair.candidateId);
    const { submissions, candidates } = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => ({
      submissions: await tx.clioMeriMemorySubmission.findMany({ where: { tenantId: ctx.tenantId, candidateId: { in: ids } } }) as SubmissionRow[],
      candidates: await tx.memoryCandidate.findMany({
        where: { tenantId: ctx.tenantId, id: { in: ids } },
        select: { id: true, status: true, decidedAt: true, committedMemoryId: true },
      }),
    }));
    const submissionById = new Map(submissions.map((row) => [row.candidateId, row]));
    const candidateById = new Map(candidates.map((row) => [row.id, row]));
    const reviews = pairs.map((pair) => {
      const submission = submissionById.get(pair.candidateId);
      const base = { candidateId: pair.candidateId, candidateSha256: pair.candidateSha256 };
      // Proposer visibility: another actor's candidate or a different hash is
      // answered exactly like an unknown one.
      if (!submission || submission.proposerUserId !== ctx.userId || submission.candidateSha256 !== pair.candidateSha256) {
        return { ...base, status: 'not_found', reviewId: null, decidedAt: null, publishedMemoryId: null };
      }
      const candidate = candidateById.get(pair.candidateId);
      // The pending row is created with the submission; a purged candidate is
      // no longer held for review.
      if (!candidate) return { ...base, status: 'not_found', reviewId: null, decidedAt: null, publishedMemoryId: null };
      const decidedAt = candidate.decidedAt ? candidate.decidedAt.toISOString() : null;
      if ((candidate.status === 'approved' || candidate.status === 'auto_committed') && candidate.committedMemoryId && decidedAt) {
        return { ...base, status: 'approved', reviewId: submission.reviewId, decidedAt, publishedMemoryId: candidate.committedMemoryId };
      }
      if ((candidate.status === 'rejected' || candidate.status === 'withdrawn') && decidedAt) {
        return { ...base, status: candidate.status, reviewId: submission.reviewId, decidedAt, publishedMemoryId: null };
      }
      return { ...base, status: 'pending', reviewId: submission.reviewId, decidedAt: null, publishedMemoryId: null };
    });
    return { reviews, checkedAt: new Date().toISOString() };
  }

  async readTarget(req: Request, ctx: TenantContext, raw: unknown) {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const { memoryId } = parseReadTargetRequest(raw);
    if (!UUID.test(memoryId)) return { memory: null };
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const row = await tx.clioMemory.findFirst({ where: { id: memoryId, tenantId: ctx.tenantId } }) as MemoryRow | null;
      return { memory: row && (await visible(tx, ctx, row)) ? target(row) : null };
    });
  }

  async findByKey(req: Request, ctx: TenantContext, raw: unknown) {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const query = parseFindByKeyRequest(raw);
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      if (query.clientId && !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, query.clientId))) return { memory: null };
      const row = await tx.clioMemory.findFirst({
        where: {
          tenantId: ctx.tenantId, scope: CORE_SCOPE[query.scope], key: query.key,
          ownerUserId: query.scope === 'personal' ? ctx.userId : null,
          clientId: query.scope === 'client' ? query.clientId : null,
        },
        orderBy: { updatedAt: 'desc' },
      }) as MemoryRow | null;
      return { memory: row && (await visible(tx, ctx, row)) ? target(row) : null };
    });
  }

  private findSubmission(tenantId: string, candidateId: string) {
    return this.prisma.withTenant(tenantId, (tx) => tx.clioMeriMemorySubmission.findUnique({
      where: { tenantId_candidateId: { tenantId, candidateId } },
    })) as Promise<SubmissionRow | null>;
  }

  private replay(stored: SubmissionRow, ctx: TenantContext, candidateSha256: string) {
    if (stored.proposerUserId !== ctx.userId || stored.candidateSha256 !== candidateSha256) {
      throw new ConflictException('Candidate id already submitted with different content');
    }
    return ack(stored);
  }
}

function ack(row: SubmissionRow) {
  return { candidateId: row.candidateId, candidateSha256: row.candidateSha256, reviewId: row.reviewId, accepted: true as const };
}

/** Same columns as the existing candidate owner, but always pending, with the
 * Meri candidate id as the row id and the Meri identity in governance source. */
async function insertPendingCandidate(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  candidate: MeriMemoryCandidate,
  candidateSha256: string,
) {
  const coreScope = CORE_SCOPE[candidate.scope];
  const payload = {
    // clio_memory.key is NOT NULL; an unkeyed Meri addition gets a stable key.
    key: candidate.key ?? `meri:${candidate.candidateId}`,
    value: candidate.content,
    source: 'meri',
    scope: coreScope,
    ownerUserId: candidate.scope === 'personal' ? ctx.userId : null,
    clientId: candidate.clientId,
    expiresAt: candidate.ttlDays ? new Date(Date.parse(candidate.createdAt) + candidate.ttlDays * DAY_MS).toISOString() : null,
    confidence: null,
    sourceConversationId: null,
    sourceMessageId: null,
    sourceExcerpt: null,
    canonicalItem: null,
  };
  const provenance = {
    tool: 'meri_memory_review',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    meriCandidateId: candidate.candidateId,
    meriCandidateSha256: candidateSha256,
    idempotencyKey: candidate.idempotencyKey,
    origin: candidate.origin,
    sources: candidate.sources,
  };
  const scopeColumn = candidate.scope;
  await tx.$executeRaw`
    INSERT INTO memory_candidate (
      id, tenant_id, proposed_by, source_kind, scope, client_id, payload_jsonb,
      provenance_jsonb, status, source_type, source_id
    ) VALUES (
      ${candidate.candidateId}::uuid, ${ctx.tenantId}::uuid, ${ctx.userId}::uuid, 'explicit_user', ${scopeColumn},
      ${candidate.clientId}::uuid, ${JSON.stringify(payload)}::jsonb, ${JSON.stringify(provenance)}::jsonb,
      'pending', 'meri', ${candidate.candidateId}
    )`;
}

async function visible(tx: Prisma.TransactionClient, ctx: TenantContext, row: MemoryRow): Promise<boolean> {
  if (!MERI_SCOPE[row.scope]) return false;
  if (row.scope === 'user_private') return row.ownerUserId === ctx.userId;
  if (row.scope === 'client') return !!row.clientId && (await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, row.clientId));
  return true;
}

/** Meri addresses at most 120-character keys; a longer Core key would fail
 * Meri's closed target check, so it is treated as not addressable. */
function target(row: MemoryRow): MeriMemoryTarget | null {
  if (row.key.length > 120) return null;
  const scope = MERI_SCOPE[row.scope]!;
  const clientId = scope === 'client' ? row.clientId : null;
  const ownerActorId = scope === 'personal' ? row.ownerUserId : null;
  return {
    tenantId: row.tenantId,
    memoryId: row.id,
    memorySha256: nativeCanonicalSha256({
      schema: 'capiro.clio-memory.v1', memoryId: row.id, scope, clientId, ownerActorId, key: row.key, value: row.value,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null, updatedAt: row.updatedAt.toISOString(),
    }),
    scope,
    clientId,
    ownerActorId,
    key: row.key,
    state: row.expiresAt && row.expiresAt.getTime() <= Date.now() ? 'expired' : 'active',
  };
}
