import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import { clioMemorySlug } from '../../memory/memory-clio-adapter.helpers.js';
import { ImmutableMemoryVersionService } from '../../memory/immutable-memory-version.service.js';
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

const UUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Storage key for an unkeyed Meri addition (clio_memory.key is NOT NULL). It
 * is never a logical key: reads report such a memory with `key: null`. */
const SYNTHETIC_KEY = new RegExp(`^meri:(${UUID_TEXT})$`);
/**
 * Scoped memory ids (dot #121 6246374007: the existing lineage, never
 * interchangeable UUIDs). `clio:<id>` is a clio_memory row, the same
 * identifier as its canonical projection slug (`clioMemorySlug`); `item:<id>`
 * is a memory_items version published by an immutable correction.
 */
const CLIO_ID = new RegExp(`^clio:(${UUID_TEXT})$`);
const ITEM_ID = new RegExp(`^item:(${UUID_TEXT})$`);
const DAY_MS = 86_400_000;
const CORE_SCOPE: Record<MeriMemoryScope, string> = { personal: 'user_private', client: 'client', firm: 'firm' };
const MERI_SCOPE: Record<string, MeriMemoryScope> = { user_private: 'personal', client: 'client', firm: 'firm' };
/** Candidate source kinds owned by ImmutableMemoryVersionService. */
const VERSION_SOURCE_KINDS = new Set(['memory_correction', 'memory_restore', 'memory_contradiction']);

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

interface ItemRow {
  id: string;
  tenantId: string;
  clientId: string | null;
  ownerUserId: string | null;
  memoryScope: string | null;
  title: string;
  sections: unknown;
  status: string;
  governedStatus: string;
  expiresAt: Date | null;
  updatedAt: Date;
}

const forbidden = () => new ForbiddenException('Memory receiving refused');
const stale = () => new ConflictException('The correction target is no longer the pinned active memory');

/**
 * W8 receiving owner for Meri `apps/control/memory/core-http.mjs`. Every
 * candidate becomes a pending Core candidate that only the existing review
 * owners can decide: additions are `memory_candidate` rows for the generic
 * owner, corrections are review-only version candidates for
 * `ImmutableMemoryVersionService`. Nothing is committed inline for any scope,
 * and `proposeSaveMemory` / `proposeCorrection` (which mint their own ids and
 * activate private memory) are never used. A content-free submission ledger
 * keeps the hash and stable reviewId (not a review_request id); the deletable
 * memory_candidate row owns the payload. A replay after its deletion is gone.
 */
@Injectable()
export class MeriMemoryReceivingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly versions: ImmutableMemoryVersionService,
  ) {}

  async submit(req: Request, ctx: TenantContext, raw: unknown) {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const request = parseSubmitRequest(raw);
    const candidate = parseMeriMemoryCandidate(request.candidate);
    if (nativeCanonicalSha256(request.candidate) !== request.candidateSha256) throw new BadRequestException('candidateSha256 mismatch');
    if (candidate.tenantId !== ctx.tenantId || candidate.proposerActorId !== ctx.userId) throw forbidden();
    if (candidate.key !== null && SYNTHETIC_KEY.test(candidate.key)) throw new BadRequestException('Reserved memory key');
    const existing = await this.findSubmission(ctx.tenantId, candidate.candidateId);
    if (existing) return this.replay(existing, ctx, request.candidateSha256);
    const record = (tx: Prisma.TransactionClient) => tx.clioMeriMemorySubmission.create({
      data: {
        tenantId: ctx.tenantId, candidateId: candidate.candidateId, candidateSha256: request.candidateSha256,
        proposerUserId: ctx.userId, reviewId: randomUUID(),
      },
    }) as Promise<SubmissionRow>;
    try {
      if (candidate.kind === 'correction') {
        // An immutable version keeps its target's expiry; a correction asking for
        // another lifetime would silently lose it, so it is refused until both
        // sides define correction TTL semantics (dot #121 6246764290).
        if (candidate.ttlDays !== null) throw new ConflictException('A correction with ttlDays is not supported yet');
        await this.submitCorrection(ctx, candidate, request.candidateSha256, async (tx) => { await record(tx); });
      } else {
        await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
          if (candidate.clientId && !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, candidate.clientId))) throw forbidden();
          // An addition never replaces committed memory with the same key; that
          // is a correction. Approval re-checks under the row lock (insert-only),
          // which also closes the race between two pending additions with one key.
          if (candidate.key !== null && (await tx.clioMemory.findFirst({
            where: {
              tenantId: ctx.tenantId, scope: CORE_SCOPE[candidate.scope], key: candidate.key,
              ownerUserId: candidate.scope === 'personal' ? ctx.userId : null,
              clientId: candidate.scope === 'client' ? candidate.clientId : null,
            },
            select: { id: true },
          }))) {
            throw new ConflictException('A memory with this key already exists; submit a correction instead');
          }
          await insertPendingCandidate(tx, ctx, candidate, request.candidateSha256);
          await record(tx);
        });
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findSubmission(ctx.tenantId, candidate.candidateId);
        if (winner) return this.replay(winner, ctx, request.candidateSha256);
        // A Core candidate already holds this id without a Meri submission.
        throw new ConflictException('Candidate id already in use');
      }
      throw error;
    }
    const stored = await this.findSubmission(ctx.tenantId, candidate.candidateId);
    if (!stored) throw new ConflictException('Submission was not recorded');
    return ack(stored);
  }

  /**
   * A correction is a review-only immutable version candidate under the Meri
   * candidate id. The exact target pin (scoped id + projection hash, scope,
   * client, active state) is re-verified under the source row lock in the
   * same transaction that writes the candidate and the submission row.
   */
  private async submitCorrection(
    ctx: TenantContext,
    candidate: MeriMemoryCandidate,
    candidateSha256: string,
    record: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    const pin = candidate.corrects!;
    const sourceItemId = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => this.versionSourceFor(tx, ctx, pin.memoryId));
    if (!sourceItemId) throw stale();
    await this.versions.proposeReviewOnlyCorrection(ctx, {
      candidateId: candidate.candidateId,
      sourceItemId,
      newContent: candidate.content,
      provenance: {
        tool: 'meri_memory_review', meriCandidateId: candidate.candidateId, meriCandidateSha256: candidateSha256,
        idempotencyKey: candidate.idempotencyKey, origin: candidate.origin, sources: candidate.sources,
        reason: candidate.reason, corrects: pin,
      },
    }, {
      verify: async (tx) => {
        const current = await readScoped(tx, ctx, pin.memoryId);
        if (!current || current.state !== 'active' || current.memorySha256 !== pin.memorySha256 ||
            current.scope !== candidate.scope || current.clientId !== candidate.clientId) throw stale();
      },
      record,
    });
  }

  /** The memory_items row a correction of this scoped target proposes against. */
  private async versionSourceFor(tx: Prisma.TransactionClient, ctx: TenantContext, memoryId: string): Promise<string | null> {
    const item = ITEM_ID.exec(memoryId);
    if (item) return item[1]!;
    const clio = CLIO_ID.exec(memoryId);
    if (!clio) return null;
    const projection = await loadItem(tx, ctx.tenantId, { slug: clioMemorySlug(clio[1]!) });
    return projection?.id ?? null;
  }

  async status(req: Request, ctx: TenantContext, raw: unknown) {
    if (!hasVerifiedToolServiceIdentity(req)) throw forbidden();
    const pairs = parseStatusRequest(raw);
    const ids = pairs.map((pair) => pair.candidateId);
    const { submissions, candidates } = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => ({
      submissions: await tx.clioMeriMemorySubmission.findMany({ where: { tenantId: ctx.tenantId, candidateId: { in: ids } } }) as SubmissionRow[],
      candidates: await tx.memoryCandidate.findMany({
        where: { tenantId: ctx.tenantId, id: { in: ids } },
        select: {
          id: true, status: true, decidedAt: true, sourceKind: true,
          committedMemoryId: true, committedMemoryItemId: true, duplicateMemoryItemId: true,
        },
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
      // Additions publish a clio_memory row; version candidates publish (or
      // confirm a duplicate of) a memory_items version.
      const published = VERSION_SOURCE_KINDS.has(candidate.sourceKind)
        ? (candidate.committedMemoryItemId ?? candidate.duplicateMemoryItemId)
          ? `item:${candidate.committedMemoryItemId ?? candidate.duplicateMemoryItemId}` : null
        : candidate.committedMemoryId ? `clio:${candidate.committedMemoryId}` : null;
      if ((candidate.status === 'approved' || candidate.status === 'auto_committed') && published && decidedAt) {
        return { ...base, status: 'approved', reviewId: submission.reviewId, decidedAt, publishedMemoryId: published };
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
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => ({ memory: await readScoped(tx, ctx, memoryId) }));
  }

  /** The committed memory a keyed proposal would replace: the clio row for the
   * key, or the controlling version that corrected it. */
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
      if (!row || !(await visible(tx, ctx, row.scope, row.ownerUserId, row.clientId))) return { memory: null };
      const controlling = await controllingVersion(tx, ctx.tenantId, clioMemorySlug(row.id));
      const projection = await loadItem(tx, ctx.tenantId, { slug: clioMemorySlug(row.id) });
      const found = controlling && projection && controlling.id !== projection.id
        ? await itemTarget(tx, ctx, controlling)
        : await clioTarget(tx, ctx, row);
      // A memory whose logical key is null (or differs) is never found by key.
      return { memory: found && found.key === query.key ? found : null };
    });
  }

  private findSubmission(tenantId: string, candidateId: string) {
    return this.prisma.withTenant(tenantId, (tx) => tx.clioMeriMemorySubmission.findUnique({
      where: { tenantId_candidateId: { tenantId, candidateId } },
    })) as Promise<SubmissionRow | null>;
  }

  private async replay(stored: SubmissionRow, ctx: TenantContext, candidateSha256: string) {
    if (stored.proposerUserId !== ctx.userId || stored.candidateSha256 !== candidateSha256) {
      throw new ConflictException('Candidate id already submitted with different content');
    }
    // The content-free receipt survives a client purge to suppress replay.
    // It must not falsely acknowledge a candidate that is no longer reviewable.
    const candidate = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.memoryCandidate.findUnique({ where: { id: stored.candidateId }, select: { id: true } }),
    );
    if (!candidate) throw new GoneException('Memory submission is no longer available');
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

async function visible(
  tx: Prisma.TransactionClient, ctx: TenantContext, coreScope: string, ownerUserId: string | null, clientId: string | null,
): Promise<boolean> {
  if (!MERI_SCOPE[coreScope]) return false;
  if (coreScope === 'user_private') return ownerUserId === ctx.userId;
  if (coreScope === 'client') return !!clientId && (await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId));
  return true;
}

/** Either scoped form; anything else (including a bare UUID) is not found. */
async function readScoped(tx: Prisma.TransactionClient, ctx: TenantContext, memoryId: string): Promise<MeriMemoryTarget | null> {
  const clio = CLIO_ID.exec(memoryId);
  if (clio) {
    const row = await tx.clioMemory.findFirst({ where: { id: clio[1]!, tenantId: ctx.tenantId } }) as MemoryRow | null;
    return row && (await visible(tx, ctx, row.scope, row.ownerUserId, row.clientId)) ? clioTarget(tx, ctx, row) : null;
  }
  const item = ITEM_ID.exec(memoryId);
  if (item) {
    const row = await loadItem(tx, ctx.tenantId, { id: item[1]! });
    return row ? itemTarget(tx, ctx, row) : null;
  }
  return null;
}

/**
 * The logical key Meri submitted: null for memory that came from an unkeyed
 * Meri addition (its storage key is synthetic), else the storage key. The
 * null is translated only with proven lineage (dot #121 6246772795): Meri
 * refuses an explicit logical key in the reserved `meri:<uuid>` namespace,
 * and a clio row must be the one that submission committed; an item must descend
 * (supersedes ancestry) from that committed row's canonical projection.
 */
async function logicalKey(
  tx: Prisma.TransactionClient, ctx: TenantContext, storageKey: string, subject: { clioId: string } | { itemId: string },
): Promise<string | null> {
  const synthetic = SYNTHETIC_KEY.exec(storageKey);
  if (!synthetic) return storageKey;
  const rows = await tx.$queryRaw<Array<{ committedMemoryId: string | null }>>`
    SELECT mc.committed_memory_id::text AS "committedMemoryId"
    FROM clio_meri_memory_submissions s
    JOIN memory_candidate mc ON mc.tenant_id = s.tenant_id AND mc.id = s.candidate_id
    WHERE s.tenant_id = ${ctx.tenantId}::uuid AND s.candidate_id = ${synthetic[1]}::uuid`;
  const row = rows.length === 1 ? rows[0]! : null;
  if (!row?.committedMemoryId) return storageKey;
  if ('clioId' in subject) return row.committedMemoryId === subject.clioId ? null : storageKey;
  const ancestry = await tx.$queryRaw<Array<{ found: number }>>`
    WITH RECURSIVE ancestry AS (
      SELECT id, supersedes_id, slug FROM memory_items
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${subject.itemId}::uuid
      UNION ALL
      SELECT parent.id, parent.supersedes_id, parent.slug FROM memory_items parent
      JOIN ancestry child ON parent.id = child.supersedes_id
      WHERE parent.tenant_id = ${ctx.tenantId}::uuid
    )
    SELECT 1 AS found FROM ancestry WHERE slug = ${clioMemorySlug(row.committedMemoryId)} LIMIT 1`;
  return ancestry.length === 1 ? null : storageKey;
}

/** Meri addresses at most 120-character keys. A longer Core key would fail
 * Meri's closed target check, so it is not addressable (D23, not truncated).
 * The projection hash covers the logical and the storage key and the state;
 * it is not a memory_items version hash. */
async function clioTarget(tx: Prisma.TransactionClient, ctx: TenantContext, row: MemoryRow): Promise<MeriMemoryTarget | null> {
  const key = await logicalKey(tx, ctx, row.key, { clioId: row.id });
  if (key !== null && key.length > 120) return null;
  const scope = MERI_SCOPE[row.scope]!;
  const clientId = scope === 'client' ? row.clientId : null;
  const ownerActorId = scope === 'personal' ? row.ownerUserId : null;
  const memoryId = `clio:${row.id}`;
  // A clio row whose canonical projection was superseded (corrected) or
  // revoked is no longer the active memory.
  const projection = await loadItem(tx, ctx.tenantId, { slug: clioMemorySlug(row.id) });
  const lifecycle = projection ? itemState(projection) : 'active';
  const state = lifecycle === null ? null
    : lifecycle !== 'active' ? lifecycle
    : row.expiresAt && row.expiresAt.getTime() <= Date.now() ? 'expired' : 'active';
  if (state === null) return null;
  return {
    tenantId: row.tenantId, memoryId,
    memorySha256: nativeCanonicalSha256({
      schema: 'capiro.clio-memory.v1', memoryId, scope, clientId, ownerActorId, key, storageKey: row.key, state,
      value: row.value, expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null, updatedAt: row.updatedAt.toISOString(),
    }),
    scope, clientId, ownerActorId, key, state,
  };
}

/** A memory_items version. Conflicted, pending or rejected versions are not
 * addressable targets (Meri's MEMORY_STATES has no such state). */
async function itemTarget(tx: Prisma.TransactionClient, ctx: TenantContext, row: ItemRow): Promise<MeriMemoryTarget | null> {
  const coreScope = row.memoryScope === 'client' || row.clientId ? 'client'
    : row.memoryScope === 'user_private' || row.ownerUserId ? 'user_private' : 'firm';
  if (!(await visible(tx, ctx, coreScope, row.ownerUserId, row.clientId))) return null;
  const state = itemState(row);
  const value = sectionsText(row.sections);
  if (state === null || value === null) return null;
  const key = await logicalKey(tx, ctx, row.title, { itemId: row.id });
  if (key !== null && key.length > 120) return null;
  const scope = MERI_SCOPE[coreScope]!;
  const clientId = scope === 'client' ? row.clientId : null;
  const ownerActorId = scope === 'personal' ? row.ownerUserId : null;
  const memoryId = `item:${row.id}`;
  return {
    tenantId: row.tenantId, memoryId,
    memorySha256: nativeCanonicalSha256({
      schema: 'capiro.memory-item.v1', memoryId, scope, clientId, ownerActorId, key, storageKey: row.title, state,
      value, expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null, updatedAt: row.updatedAt.toISOString(),
    }),
    scope, clientId, ownerActorId, key, state,
  };
}

function itemState(row: ItemRow): MeriMemoryTarget['state'] | null {
  if (row.status === 'superseded' || row.governedStatus === 'superseded') return 'superseded';
  if (row.status === 'revoked' || row.governedStatus === 'revoked') return 'forgotten';
  if (row.governedStatus === 'expired' || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) return 'expired';
  if (row.status === 'active' && (row.governedStatus === 'active' || row.governedStatus === 'stale')) return 'active';
  return null;
}

/** ImmutableMemoryVersionService textFromSections, read-only. */
function sectionsText(sections: unknown): string | null {
  if (!Array.isArray(sections)) return null;
  const bodies: string[] = [];
  for (const section of sections) {
    const body = (section as { body?: unknown } | null)?.body;
    if (typeof body !== 'string') return null;
    if (body.trim()) bodies.push(body.trim());
  }
  return bodies.join('\n\n');
}

async function loadItem(tx: Prisma.TransactionClient, tenantId: string, by: { id: string } | { slug: string }): Promise<ItemRow | null> {
  const rows = 'id' in by
    ? await tx.$queryRaw<ItemRow[]>`
        SELECT id::text AS id, tenant_id::text AS "tenantId", client_id::text AS "clientId", owner_user_id::text AS "ownerUserId",
               memory_scope AS "memoryScope", title, sections_jsonb AS sections, status, governed_status AS "governedStatus",
               expires_at AS "expiresAt", updated_at AS "updatedAt"
        FROM memory_items WHERE tenant_id = ${tenantId}::uuid AND id = ${by.id}::uuid`
    : await tx.$queryRaw<ItemRow[]>`
        SELECT id::text AS id, tenant_id::text AS "tenantId", client_id::text AS "clientId", owner_user_id::text AS "ownerUserId",
               memory_scope AS "memoryScope", title, sections_jsonb AS sections, status, governed_status AS "governedStatus",
               expires_at AS "expiresAt", updated_at AS "updatedAt"
        FROM memory_items WHERE tenant_id = ${tenantId}::uuid AND slug = ${by.slug}`;
  return rows.length === 1 ? rows[0]! : null;
}

/** The current controlling version in the lineage rooted at a projection slug
 * (the read-only form of ImmutableMemoryVersionService.findCurrentDescendant). */
async function controllingVersion(tx: Prisma.TransactionClient, tenantId: string, slug: string): Promise<ItemRow | null> {
  const rows = await tx.$queryRaw<ItemRow[]>`
    WITH RECURSIVE lineage AS (
      SELECT id, created_at FROM memory_items WHERE tenant_id = ${tenantId}::uuid AND slug = ${slug}
      UNION ALL
      SELECT child.id, child.created_at FROM memory_items child
      JOIN lineage parent ON child.supersedes_id = parent.id
      WHERE child.tenant_id = ${tenantId}::uuid
    )
    SELECT mi.id::text AS id, mi.tenant_id::text AS "tenantId", mi.client_id::text AS "clientId",
           mi.owner_user_id::text AS "ownerUserId", mi.memory_scope AS "memoryScope", mi.title,
           mi.sections_jsonb AS sections, mi.status, mi.governed_status AS "governedStatus",
           mi.expires_at AS "expiresAt", mi.updated_at AS "updatedAt"
    FROM memory_items mi JOIN lineage l ON l.id = mi.id
    WHERE mi.status = 'active' AND mi.governed_status IN ('active', 'stale')
    ORDER BY l.created_at DESC, mi.id DESC
    LIMIT 1`;
  return rows[0] ?? null;
}
