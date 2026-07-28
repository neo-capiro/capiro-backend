import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryIngestService } from './memory-ingest.service.js';
import { evaluateMemoryCandidate } from './memory-candidate-rules.js';
import { fetchDeniedClientIds } from './memory-wall.helpers.js';
import type { AppConfig } from '../config/config.schema.js';

/** The shape MeriToolsService.saveMemory already builds via buildSavedMemoryRecord. */
export interface MemorySaveRequest {
  scope: 'firm' | 'user_private' | 'client';
  ownerUserId: string | null;
  /** G2: required iff scope='client' (CHECK-enforced at the DB). */
  clientId?: string | null;
  key: string;
  value: string;
  source: string;
  /** G2 ephemeral/working memory: when set, the row expires (hidden from
   *  recall, purged by the daily sweep). Any scope may be ephemeral. */
  expiresAt?: Date | null;
  /** Phase 4: extraction confidence [0,1] for a model-sourced save; null/absent
   *  for explicit human saves (unscored → neutral at recall). Flows to the
   *  candidate row, the payload, and (on commit) clio_memory.metadata.confidence. */
  confidence?: number | null;
  /** Phase 0 governed auto-learning provenance. These fields are optional for
   * explicit human saves and required by the auto-learn caller. */
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  sourceExcerpt?: string | null;
}

export interface MemoryCandidateRow {
  id: string;
  tenantId: string;
  proposedBy: string;
  sourceKind: string;
  scope: string;
  status: string;
  duplicateOfId: string | null;
  committedMemoryId: string | null;
  createdAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
}

export interface ProposeSaveMemoryResult {
  candidateId: string;
  status: 'auto_committed' | 'pending';
  memoryId: string | null;
  ruleId: string;
  reason: string;
}

/**
 * Phase 1 (1B) — candidate lifecycle for memory writes (blueprint §4.6.5).
 *
 * Every memory write from `save_memory` (both surfaces — see
 * memory-candidate-rules.ts's header comment) goes through
 * `proposeSaveMemory`: a `memory_candidate` row is always created first, then
 * `evaluateMemoryCandidate` resolves PASS (commit in the same request) or
 * WARN (stays 'pending' until `approve`/`reject`). Personal-scope and
 * admin-firm-scope saves therefore have IDENTICAL latency/behavior to before
 * Phase 1 — the candidate row is just an added audit trail alongside an
 * unchanged synchronous commit.
 */
@Injectable()
export class MemoryCandidateService {
  private readonly logger = new Logger(MemoryCandidateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memoryIngest: MemoryIngestService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Entry point for MeriToolsService.saveMemory. Always creates a candidate;
   *  commits inline when the rule evaluates PASS. */
  async proposeSaveMemory(
    tenantId: string,
    proposedByUserId: string,
    record: MemorySaveRequest,
    isAdmin: boolean,
    // Additive (Phase 3.4): distinguishes where the candidate originated so the
    // admin review queue can tell a chat save ('explicit_user') from a Workspace
    // artifact promotion ('workspace_artifact'). Defaults preserve every existing
    // caller's behavior exactly.
    sourceKind: string = 'explicit_user',
  ): Promise<ProposeSaveMemoryResult> {
    const scope: 'personal' | 'firm' | 'client' =
      record.scope === 'user_private' ? 'personal' : record.scope === 'client' ? 'client' : 'firm';
    if (record.scope === 'client' && !record.clientId) {
      throw new BadRequestException('Client-scope memory requires a clientId.');
    }

    // Duplicate detection (D3, minimal): does a candidate already own the
    // clio_memory row this save would target? If so, this is a re-save of an
    // existing key, not a fresh fact — record that lineage rather than
    // silently double-writing with no trail.
    const priorCommitted = await this.prisma.withTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<Array<{ id: string; committed_memory_id: string | null }>>`
        SELECT mc.id, mc.committed_memory_id
        FROM memory_candidate mc
        JOIN clio_memory cm ON cm.id = mc.committed_memory_id
        WHERE mc.tenant_id = ${tenantId}::uuid
          AND cm.tenant_id = ${tenantId}::uuid
          AND cm.scope = ${record.scope}
          AND cm.key = ${record.key}
          AND (cm.owner_user_id IS NOT DISTINCT FROM ${record.ownerUserId}::uuid)
          AND (cm.client_id IS NOT DISTINCT FROM ${record.clientId ?? null}::uuid)
        ORDER BY mc.created_at DESC
        LIMIT 1
      `,
    );
    const duplicateOfId = priorCommitted[0]?.id ?? null;

    // Phase 4: clamp a finite confidence to [0,1]; anything else = unscored (null).
    const candidateConfidence =
      typeof record.confidence === 'number' && Number.isFinite(record.confidence)
        ? Math.min(1, Math.max(0, record.confidence))
        : null;

    const sourceExcerpt =
      typeof record.sourceExcerpt === 'string' ? record.sourceExcerpt.slice(0, 4_000) : null;
    const sourceConversationId =
      typeof record.sourceConversationId === 'string' ? record.sourceConversationId : null;
    const sourceMessageId = typeof record.sourceMessageId === 'string' ? record.sourceMessageId : null;
    const payload = {
      key: record.key,
      value: record.value,
      source: record.source,
      scope: record.scope,
      ownerUserId: record.ownerUserId,
      clientId: record.clientId ?? null,
      expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
      confidence: candidateConfidence,
      sourceConversationId,
      sourceMessageId,
      sourceExcerpt,
    };
    const provenance = {
      tool: 'save_memory',
      tenantId,
      userId: proposedByUserId,
      sourceConversationId,
      sourceMessageId,
      sourceExcerpt,
    };

    const candidateId = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO memory_candidate (
          tenant_id, proposed_by, source_kind, scope, client_id, payload_jsonb,
          provenance_jsonb, duplicate_of_id, status, confidence
        ) VALUES (
          ${tenantId}::uuid, ${proposedByUserId}::uuid, ${sourceKind}, ${scope},
          ${record.clientId ?? null}::uuid,
          ${JSON.stringify(payload)}::jsonb, ${JSON.stringify(provenance)}::jsonb,
          ${duplicateOfId}::uuid, 'pending', ${candidateConfidence}
        )
        RETURNING id
      `;
      const row = rows[0];
      if (!row) throw new Error('memory_candidate insert returned no row');
      return row.id;
    });

    // Phase 4: the model_extraction low-confidence rule can route a machine
    // write to review; inert for explicit human saves (no model sourceKind).
    const decision = evaluateMemoryCandidate({
      scope,
      isAdmin,
      sourceKind,
      confidence: candidateConfidence,
    });
    if (decision.outcome === 'WARN') {
      this.logger.log(
        `memory_candidate ${candidateId} pending (${decision.ruleId}), tenant ${tenantId}`,
      );
      return { candidateId, status: 'pending', memoryId: null, ...decision };
    }

    const memoryId = await this.commitToClioMemory(tenantId, record);
    await this.markDecided(tenantId, candidateId, 'auto_committed', proposedByUserId, memoryId);
    return { candidateId, status: 'auto_committed', memoryId, ...decision };
  }

  /** Admin action: commit a pending candidate's payload and mark it approved. */
  async approve(
    tenantId: string,
    candidateId: string,
    approverUserId: string,
  ): Promise<{ memoryId: string }> {
    const candidate = await this.getPendingOrThrow(tenantId, candidateId);
    const record = payloadToSaveRequest(candidate.payload);
    const memoryId = await this.commitToClioMemory(tenantId, record);
    await this.markDecided(tenantId, candidateId, 'approved', approverUserId, memoryId);
    return { memoryId };
  }

  /** Admin action: reject a pending candidate. No memory write ever happens. */
  async reject(tenantId: string, candidateId: string, reviewerUserId: string): Promise<void> {
    await this.getPendingOrThrow(tenantId, candidateId);
    await this.markDecided(tenantId, candidateId, 'rejected', reviewerUserId, null);
  }

  /**
   * Admin review queue. When a viewer is identified, candidates proposing
   * memory for a walled client the viewer is not granted are withheld — the
   * proposed payload is itself confidential content (fail-closed; the wall
   * manager grants a reviewer access when one is needed).
   */
  async listPending(tenantId: string, viewerUserId?: string): Promise<MemoryCandidateRow[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.memoryCandidate.findMany({
        where: { tenantId, status: 'pending' },
        orderBy: { createdAt: 'asc' },
      });
      if (!viewerUserId) return rows;
      const denied = new Set(await fetchDeniedClientIds(tx, tenantId, viewerUserId));
      return denied.size ? rows.filter((r) => !r.clientId || !denied.has(r.clientId)) : rows;
    });
  }

  private async getPendingOrThrow(
    tenantId: string,
    candidateId: string,
  ): Promise<{ id: string; payload: unknown }> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.memoryCandidate.findFirst({
        where: { id: candidateId, tenantId, status: 'pending' },
        select: { id: true, payload: true },
      }),
    );
    if (!row) {
      throw new NotFoundException('No pending memory candidate with that id for this tenant.');
    }
    return row;
  }

  private async markDecided(
    tenantId: string,
    candidateId: string,
    status: 'auto_committed' | 'approved' | 'rejected',
    decidedBy: string,
    committedMemoryId: string | null,
  ): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.memoryCandidate.update({
        where: { id: candidateId },
        data: { status, decidedBy, decidedAt: new Date(), committedMemoryId },
      }),
    );
  }

  /**
   * The actual clio_memory write, moved out of MeriToolsService.saveMemory
   * unchanged (same find→update-else-create-with-P2002-retry idiom) so both
   * the auto-commit path and the admin-approve path share one implementation.
   */
  private async commitToClioMemory(tenantId: string, record: MemorySaveRequest): Promise<string> {
    const metadata = {
      tool: 'save_memory',
      createdBy: 'user-requested',
      visibility: record.scope,
      // Phase 4: carry a scored confidence so projectClioMemory → the clio
      // adapter stamps memory_items.confidence. Omitted when unscored (human
      // saves) so the projection confidence stays NULL/neutral.
      ...(typeof record.confidence === 'number' && Number.isFinite(record.confidence)
        ? { confidence: Math.min(1, Math.max(0, record.confidence)) }
        : {}),
      ...(record.sourceConversationId ? { sourceConversationId: record.sourceConversationId } : {}),
      ...(record.sourceMessageId ? { sourceMessageId: record.sourceMessageId } : {}),
      ...(record.sourceExcerpt ? { sourceExcerpt: record.sourceExcerpt.slice(0, 4_000) } : {}),
    };
    const findExisting = () =>
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clioMemory.findFirst({
          where: {
            tenantId,
            scope: record.scope,
            ownerUserId: record.ownerUserId,
            clientId: record.clientId ?? null,
            key: record.key,
          },
          select: { id: true },
        }),
      );
    const updateExisting = (id: string) =>
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clioMemory.update({
          where: { id },
          data: {
            value: record.value,
            source: record.source,
            metadata,
            expiresAt: record.expiresAt ?? null,
          },
        }),
      );

    let memoryId: string;
    const existing = await findExisting();
    if (existing) {
      await updateExisting(existing.id);
      memoryId = existing.id;
    } else {
      try {
        const created = await this.prisma.withTenant(tenantId, (tx) =>
          tx.clioMemory.create({
            data: {
              tenantId,
              scope: record.scope,
              ownerUserId: record.ownerUserId,
              clientId: record.clientId ?? null,
              key: record.key,
              value: record.value,
              source: record.source,
              metadata,
              expiresAt: record.expiresAt ?? null,
            },
            select: { id: true },
          }),
        );
        memoryId = created.id;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const raced = await findExisting();
          if (!raced) throw err;
          await updateExisting(raced.id);
          memoryId = raced.id;
        } else {
          throw err;
        }
      }
    }

    void this.embedMemory(tenantId, record.key, record.value).catch(() => {});
    void this.memoryIngest.projectClioMemory(tenantId, memoryId);
    return memoryId;
  }

  /** Best-effort semantic-recall embedding; unchanged from the pre-1B implementation. */
  private async embedMemory(tenantId: string, key: string, value: string): Promise<void> {
    const openaiKey = this.config.get('OPENAI_API_KEY', { infer: true });
    if (!openaiKey) return;
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: `${key}: ${value}` }),
    });
    if (!res.ok) return;
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = json.data?.[0]?.embedding;
    if (!embedding || embedding.length !== 1536) return;
    const vecStr = `[${embedding.join(',')}]`;
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE clio_memory SET embedding = $1::vector WHERE tenant_id = $2::uuid AND key = $3`,
        vecStr,
        tenantId,
        key,
      ),
    );
  }
}

function payloadToSaveRequest(payload: unknown): MemorySaveRequest {
  const p = payload as Partial<MemorySaveRequest> | null;
  if (
    !p ||
    typeof p.key !== 'string' ||
    typeof p.value !== 'string' ||
    typeof p.source !== 'string'
  ) {
    throw new BadRequestException('Malformed memory candidate payload.');
  }
  const scope = p.scope === 'firm' ? 'firm' : p.scope === 'client' ? 'client' : 'user_private';
  const raw = payload as {
    clientId?: unknown;
    expiresAt?: unknown;
    confidence?: unknown;
    sourceConversationId?: unknown;
    sourceMessageId?: unknown;
    sourceExcerpt?: unknown;
  };
  return {
    scope,
    ownerUserId: typeof p.ownerUserId === 'string' ? p.ownerUserId : null,
    clientId: typeof raw.clientId === 'string' ? raw.clientId : null,
    key: p.key,
    value: p.value,
    source: p.source,
    expiresAt: typeof raw.expiresAt === 'string' ? new Date(raw.expiresAt) : null,
    // Phase 4: round-trip confidence so an APPROVED candidate commits with the
    // extraction confidence it was reviewed at (else it would lose it on commit).
    confidence:
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? raw.confidence
        : null,
    sourceConversationId:
      typeof raw.sourceConversationId === 'string' ? raw.sourceConversationId : null,
    sourceMessageId: typeof raw.sourceMessageId === 'string' ? raw.sourceMessageId : null,
    sourceExcerpt: typeof raw.sourceExcerpt === 'string' ? raw.sourceExcerpt.slice(0, 4_000) : null,
  };
}
