import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { embedAndUpsert } from '../embeddings/embedder.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import { governedMemoryLifecycleEnabled } from './memory-governance-lifecycle.helpers.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import {
  classifyMemoryVersionActivation,
  immutableMemoryVersionSlug,
  isMemoryVersionKind,
  type MemoryVersionKind,
} from './memory-version.helpers.js';

const VERSION_SOURCE_KIND = {
  correction: 'memory_correction',
  restore: 'memory_restore',
  contradiction: 'memory_contradiction',
} as const satisfies Record<MemoryVersionKind, string>;

interface VersionSection {
  key: string;
  heading: string;
  owner: 'human' | 'engine';
  body: string;
}

interface ItemRow {
  id: string;
  tenant_id: string;
  client_id: string | null;
  owner_user_id: string | null;
  type: string;
  visibility: string;
  slug: string;
  title: string;
  sections_jsonb: unknown;
  status: string;
  governed_status: string;
  memory_class: string;
  memory_scope: string;
  legal_hold: boolean;
  conflict_group_id: string | null;
}

interface CandidateRow {
  id: string;
  proposed_by: string;
  source_kind: string;
  payload_jsonb: unknown;
}

interface VersionPayload {
  key: string;
  value: string;
  source: string;
  scope: 'firm' | 'client' | 'user_private';
  ownerUserId: string | null;
  clientId: string | null;
  canonicalItem: {
    type: string;
    slug: string;
    title: string;
    sections: VersionSection[];
  };
  versionProposal: {
    kind: MemoryVersionKind;
    sourceItemId: string;
    targetItemId: string | null;
  };
}

export type MemoryVersionResult =
  | { status: 'not_found' }
  | { status: 'legal_hold'; title: string }
  | {
      status: 'pending_review';
      title: string;
      candidateId: string;
      activeItemUnchanged: true;
    }
  | { status: 'activated'; title: string; memoryItemId: string }
  | { status: 'duplicate'; title: string; memoryItemId: string };

export interface VersionCandidateDecisionResult {
  candidateId: string;
  outcome: 'activated' | 'duplicate' | 'conflict' | 'rejected';
  memoryItemId?: string;
  controllingItemId?: string;
  conflictGroupId?: string;
}

interface PendingEmbed {
  tenantId: string;
  clientId: string | null;
  ownerUserId: string | null;
  memoryItemId: string;
  title: string;
  body: string;
}

interface TransactionOutcome<T> {
  result: T;
  embed?: PendingEmbed;
}

/**
 * Immutable governed-memory corrections, restores, and contradictions.
 *
 * The service deliberately does not call MemoryCandidateService.approve(): that
 * generic path upserts a canonical slug and can replace shared truth in place.
 * Version candidates have a dedicated database-guarded activation transaction.
 */
@Injectable()
export class ImmutableMemoryVersionService {
  private readonly logger = new Logger(ImmutableMemoryVersionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextStore,
    private readonly authorization: MemoryAuthorizationService,
    private readonly transitionAudit: MemoryTransitionAuditService,
    private readonly cleanupOutbox: MemoryCleanupOutboxService,
  ) {}

  async correctForCurrentUser(itemId: string, newContent: string): Promise<MemoryVersionResult> {
    const body = (newContent ?? '').trim();
    if (!body) return { status: 'not_found' };
    return this.proposeOrActivate(this.tenantCtx.require(), itemId, 'correction', body);
  }

  async proposeCorrection(
    ctx: TenantContext,
    itemId: string,
    newContent: string,
  ): Promise<MemoryVersionResult> {
    const body = (newContent ?? '').trim();
    if (!body) throw new BadRequestException('newContent is required.');
    return this.proposeOrActivate(ctx, itemId, 'correction', body);
  }

  async proposeContradiction(
    ctx: TenantContext,
    itemId: string,
    newContent: string,
  ): Promise<MemoryVersionResult> {
    const body = (newContent ?? '').trim();
    if (!body) throw new BadRequestException('newContent is required.');
    return this.proposeOrActivate(ctx, itemId, 'contradiction', body);
  }

  async proposeRestore(ctx: TenantContext, itemId: string): Promise<MemoryVersionResult> {
    return this.proposeOrActivate(ctx, itemId, 'restore', null);
  }

  async approveCandidate(
    ctx: TenantContext,
    candidateId: string,
  ): Promise<VersionCandidateDecisionResult> {
    this.requireLifecycle();
    const outcome = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const candidate = await this.lockCandidate(tx, ctx.tenantId, candidateId);
      const payload = parsePayload(candidate.payload_jsonb);
      const kind = payload.versionProposal.kind;
      if (candidate.source_kind !== VERSION_SOURCE_KIND[kind]) {
        throw new BadRequestException('Version candidate source kind does not match its payload.');
      }
      await this.authorizeCandidate(tx, ctx, candidateId, 'approve');
      if (payload.scope !== 'user_private' && candidate.proposed_by === ctx.userId) {
        throw new ForbiddenException(
          'Shared-scope memory must be approved by a reviewer other than the proposer.',
        );
      }

      const source = await this.loadItem(tx, ctx.tenantId, payload.versionProposal.sourceItemId);
      if (!source) throw new NotFoundException('Historical memory item not found.');
      await this.authorizeSource(tx, ctx, source, kind);

      const target =
        kind === 'restore' ? await this.findCurrentDescendant(tx, ctx.tenantId, source.id) : source;
      if (kind !== 'restore' && !isControlling(target)) {
        throw new BadRequestException('The proposed source is no longer a controlling version.');
      }
      if (kind === 'correction' && target?.legal_hold) {
        throw new ForbiddenException('Memory operation denied: legal_hold');
      }

      const proposedText = textFromSections(payload.canonicalItem.sections);
      const targetText = target ? textFromSections(parseSections(target.sections_jsonb)) : null;
      const activation = classifyMemoryVersionActivation(kind, proposedText, targetText);

      // A migration trigger rejects version-candidate approval from every other
      // code path. This transaction-local capability is set only after row locks,
      // server-owned authorization, wall checks, and independent-review checks.
      await tx.$queryRaw<Array<{ set_config: string }>>`
        SELECT set_config('app.memory_version_activation', 'on', true)
      `;

      if (activation === 'duplicate' && target) {
        await this.linkDuplicate(tx, ctx, candidate, target);
        return {
          result: {
            candidateId,
            outcome: 'duplicate',
            memoryItemId: target.id,
            controllingItemId: target.id,
          },
        } satisfies TransactionOutcome<VersionCandidateDecisionResult>;
      }

      if (activation === 'conflict' && target) {
        const conflictGroupId = target.conflict_group_id ?? randomUUID();
        const created = await this.insertVersion(tx, {
          tenantId: ctx.tenantId,
          copySource: source,
          parentId: null,
          contradictsId: target.id,
          candidateId,
          assertedBy: candidate.proposed_by,
          approvedBy: ctx.userId,
          kind,
          sections: payload.canonicalItem.sections,
          governedStatus: 'conflicted',
          conflictStatus: 'open',
          conflictGroupId,
        });
        await this.openConflict(tx, ctx, target, created.id, conflictGroupId, candidateId);
        await this.finishCandidate(tx, ctx, candidate, created.id, null, target.id);
        return {
          result: {
            candidateId,
            outcome: 'conflict',
            memoryItemId: created.id,
            controllingItemId: target.id,
            conflictGroupId,
          },
          embed: embedInput(created, proposedText),
        } satisfies TransactionOutcome<VersionCandidateDecisionResult>;
      }

      const created = await this.insertVersion(tx, {
        tenantId: ctx.tenantId,
        copySource: source,
        parentId: target?.id ?? source.id,
        contradictsId: null,
        candidateId,
        assertedBy: candidate.proposed_by,
        approvedBy: ctx.userId,
        kind,
        sections: payload.canonicalItem.sections,
        governedStatus: 'active',
        conflictStatus: 'none',
        conflictGroupId: null,
      });
      if (target) await this.supersedeOne(tx, ctx, target, created.id, candidateId);
      await this.finishCandidate(tx, ctx, candidate, created.id, null, null);
      return {
        result: {
          candidateId,
          outcome: 'activated',
          memoryItemId: created.id,
          controllingItemId: created.id,
        },
        embed: embedInput(created, proposedText),
      } satisfies TransactionOutcome<VersionCandidateDecisionResult>;
    });

    if (outcome.embed) this.embedAfterCommit(outcome.embed);
    return outcome.result;
  }

  async rejectCandidate(
    ctx: TenantContext,
    candidateId: string,
    reason: string,
  ): Promise<VersionCandidateDecisionResult> {
    this.requireLifecycle();
    const cleanReason = (reason ?? '').trim();
    if (!cleanReason) throw new BadRequestException('A rejection reason is required.');
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const candidate = await this.lockCandidate(tx, ctx.tenantId, candidateId);
      parsePayload(candidate.payload_jsonb);
      await this.authorizeCandidate(tx, ctx, candidateId, 'review');
      const changed = await tx.$executeRaw`
        UPDATE memory_candidate
        SET status = 'rejected', governed_status = 'rejected',
            decided_by = ${ctx.userId}::uuid, decided_at = now()
        WHERE id = ${candidateId}::uuid AND tenant_id = ${ctx.tenantId}::uuid
          AND status = 'pending'
      `;
      if (changed !== 1) throw new Error('Memory version rejection was not atomic.');
      await this.transitionAudit.record(tx, ctx.tenantId, {
        subject: { memoryCandidateId: candidateId },
        actorUserId: ctx.userId,
        fromStatus: 'pending_review',
        toStatus: 'rejected',
        reasonCode: 'rejected',
        reason: cleanReason,
        sourceType: 'user_message',
        sourceId: candidateId,
        metadata: { sourceKind: candidate.source_kind },
      });
    });
    return { candidateId, outcome: 'rejected' };
  }

  private async proposeOrActivate(
    ctx: TenantContext,
    sourceItemId: string,
    kind: MemoryVersionKind,
    newContent: string | null,
  ): Promise<MemoryVersionResult> {
    this.requireLifecycle();
    const outcome = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const source = await this.loadItem(tx, ctx.tenantId, sourceItemId);
      if (!source) return { result: { status: 'not_found' } as MemoryVersionResult };

      if (kind === 'restore') {
        if (!isTerminal(source)) {
          throw new BadRequestException(
            'Only a revoked, superseded, rejected, or expired version can be restored.',
          );
        }
      } else if (!isControlling(source)) {
        throw new BadRequestException(
          'Correct or contradict the current controlling memory version.',
        );
      }
      if (kind === 'correction' && source.legal_hold) {
        return {
          result: { status: 'legal_hold', title: source.title } as MemoryVersionResult,
        };
      }
      await this.authorizeSource(tx, ctx, source, kind);

      const target =
        kind === 'restore' ? await this.findCurrentDescendant(tx, ctx.tenantId, source.id) : source;
      const sections =
        kind === 'restore'
          ? parseSections(source.sections_jsonb)
          : [{ key: 'memory', heading: 'Memory', owner: 'human' as const, body: newContent! }];
      const proposedText = textFromSections(sections);
      const scope = scopeFor(source);

      if (scope !== 'user_private') {
        const candidateId = await this.insertCandidate(tx, {
          ctx,
          source,
          targetId: target?.id ?? null,
          kind,
          sections,
          proposedText,
        });
        return {
          result: {
            status: 'pending_review',
            title: source.title,
            candidateId,
            activeItemUnchanged: true,
          } as MemoryVersionResult,
        };
      }

      const targetText = target ? textFromSections(parseSections(target.sections_jsonb)) : null;
      const activation = classifyMemoryVersionActivation(kind, proposedText, targetText);
      if (activation === 'duplicate' && target) {
        await tx.$executeRaw`
          UPDATE memory_items SET last_confirmed_at = now(), updated_at = now()
          WHERE id = ${target.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        `;
        await this.transitionAudit.record(tx, ctx.tenantId, {
          subject: { memoryItemId: target.id },
          actorUserId: ctx.userId,
          toStatus: governedStatus(target),
          reasonCode: 'confirmed',
          reason: 'Exact private-memory version already controls this scope.',
          sourceType: 'approved_document_edit',
          sourceId: source.id,
          metadata: { kind, duplicate: true },
        });
        return {
          result: {
            status: 'duplicate',
            title: target.title,
            memoryItemId: target.id,
          } as MemoryVersionResult,
        };
      }

      const activationId = randomUUID();
      if (activation === 'conflict' && target) {
        const conflictGroupId = target.conflict_group_id ?? randomUUID();
        const created = await this.insertVersion(tx, {
          tenantId: ctx.tenantId,
          copySource: source,
          parentId: null,
          contradictsId: target.id,
          candidateId: activationId,
          assertedBy: ctx.userId,
          approvedBy: ctx.userId,
          kind,
          sections,
          governedStatus: 'conflicted',
          conflictStatus: 'open',
          conflictGroupId,
        });
        await this.openConflict(tx, ctx, target, created.id, conflictGroupId, activationId);
        return {
          result: {
            status: 'activated',
            title: created.title,
            memoryItemId: created.id,
          } as MemoryVersionResult,
          embed: embedInput(created, proposedText),
        };
      }

      const created = await this.insertVersion(tx, {
        tenantId: ctx.tenantId,
        copySource: source,
        parentId: target?.id ?? source.id,
        contradictsId: null,
        candidateId: activationId,
        assertedBy: ctx.userId,
        approvedBy: ctx.userId,
        kind,
        sections,
        governedStatus: 'active',
        conflictStatus: 'none',
        conflictGroupId: null,
      });
      if (target) await this.supersedeOne(tx, ctx, target, created.id, activationId);
      return {
        result: {
          status: 'activated',
          title: created.title,
          memoryItemId: created.id,
        } as MemoryVersionResult,
        embed: embedInput(created, proposedText),
      };
    });

    if (outcome.embed) this.embedAfterCommit(outcome.embed);
    return outcome.result;
  }

  private async authorizeSource(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    source: ItemRow,
    kind: MemoryVersionKind,
  ): Promise<void> {
    const subject = await this.authorization.loadItemInTx(tx, ctx.tenantId, source.id);
    if (!subject) throw new NotFoundException('Memory item not found.');
    const read = await this.authorization.evaluateInTx(tx, ctx, subject, 'read');
    if (!read.allowed) throw new ForbiddenException(`Memory operation denied: ${read.reason}`);

    // Restore never reopens or mutates the terminal source. Evaluate the proposal
    // against the same server-owned scope with an active synthetic lifecycle only
    // after read access to the actual historical row has succeeded.
    const mutationSubject =
      kind === 'restore' ? { ...subject, status: 'active' as const } : subject;
    const operation = scopeFor(source) === 'user_private' ? 'edit' : 'propose';
    const decision = await this.authorization.evaluateInTx(tx, ctx, mutationSubject, operation);
    if (!decision.allowed)
      throw new ForbiddenException(`Memory operation denied: ${decision.reason}`);
  }

  private async authorizeCandidate(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    candidateId: string,
    operation: 'approve' | 'review',
  ): Promise<void> {
    const subject = await this.authorization.loadCandidateInTx(tx, ctx.tenantId, candidateId);
    if (!subject) throw new NotFoundException('Memory candidate not found.');
    const decision = await this.authorization.evaluateInTx(tx, ctx, subject, operation);
    if (!decision.allowed)
      throw new ForbiddenException(`Memory operation denied: ${decision.reason}`);
  }

  private async insertCandidate(
    tx: Prisma.TransactionClient,
    input: {
      ctx: TenantContext;
      source: ItemRow;
      targetId: string | null;
      kind: MemoryVersionKind;
      sections: VersionSection[];
      proposedText: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    const scope = scopeFor(input.source);
    const payload: VersionPayload = {
      key: input.source.title,
      value: input.proposedText,
      source: VERSION_SOURCE_KIND[input.kind],
      scope,
      ownerUserId: scope === 'user_private' ? input.source.owner_user_id : null,
      clientId: scope === 'client' ? input.source.client_id : null,
      canonicalItem: {
        type: input.source.type,
        slug: immutableMemoryVersionSlug(input.source.slug, id),
        title: input.source.title,
        sections: input.sections,
      },
      versionProposal: {
        kind: input.kind,
        sourceItemId: input.source.id,
        targetItemId: input.targetId,
      },
    };
    const hash = createHash('sha256').update(input.proposedText).digest('hex');
    const legacyScope = scope === 'user_private' ? 'personal' : scope;
    await tx.$executeRaw`
      INSERT INTO memory_candidate (
        id, tenant_id, proposed_by, source_kind, scope, client_id,
        payload_jsonb, provenance_jsonb, status, memory_class, memory_scope,
        governed_status, source_type, source_id, source_ref, source_content_hash,
        source_version, asserted_by_user_id, as_of, effective_from,
        conflict_status, legal_hold, origin_surface, origin_trace_id,
        instructions_allowed, contradicts_memory_item_id
      ) VALUES (
        ${id}::uuid, ${input.ctx.tenantId}::uuid, ${input.ctx.userId}::uuid,
        ${VERSION_SOURCE_KIND[input.kind]}, ${legacyScope}, ${input.source.client_id}::uuid,
        ${JSON.stringify(payload)}::jsonb,
        ${JSON.stringify({ kind: input.kind, sourceItemId: input.source.id })}::jsonb,
        'pending', ${input.source.memory_class}, ${scope}, 'pending_review',
        'user_message', ${input.source.id}, ${VERSION_SOURCE_KIND[input.kind]}, ${hash},
        ${`candidate:${id}`}, ${input.ctx.userId}::uuid, now(), now(),
        ${input.kind === 'contradiction' ? 'open' : 'none'}, false,
        ${VERSION_SOURCE_KIND[input.kind]}, ${id}, false,
        ${input.kind === 'contradiction' ? input.source.id : null}::uuid
      )
    `;
    await this.transitionAudit.record(tx, input.ctx.tenantId, {
      subject: { memoryCandidateId: id },
      actorUserId: input.ctx.userId,
      clientId: input.source.client_id,
      toStatus: 'pending_review',
      reasonCode: 'submitted_for_review',
      reason: `Shared memory ${input.kind} submitted for independent review.`,
      sourceType: 'user_message',
      sourceId: input.source.id,
      metadata: {
        kind: input.kind,
        sourceItemId: input.source.id,
        targetItemId: input.targetId,
      },
    });
    return id;
  }

  private async lockCandidate(
    tx: Prisma.TransactionClient,
    tenantId: string,
    candidateId: string,
  ): Promise<CandidateRow> {
    const rows = await tx.$queryRaw<Array<CandidateRow>>`
      SELECT id::text AS id, proposed_by::text AS proposed_by, source_kind, payload_jsonb
      FROM memory_candidate
      WHERE id = ${candidateId}::uuid AND tenant_id = ${tenantId}::uuid
        AND status = 'pending'
        AND source_kind IN ('memory_correction','memory_restore','memory_contradiction')
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('No pending memory version candidate with that id.');
    return row;
  }

  private async loadItem(
    tx: Prisma.TransactionClient,
    tenantId: string,
    itemId: string,
  ): Promise<ItemRow | null> {
    const rows = await tx.$queryRaw<Array<ItemRow>>`
      SELECT id::text AS id, tenant_id::text AS tenant_id,
             client_id::text AS client_id, owner_user_id::text AS owner_user_id,
             type, visibility, slug, title, sections_jsonb, status, governed_status,
             memory_class, memory_scope, legal_hold,
             conflict_group_id::text AS conflict_group_id
      FROM memory_items
      WHERE id = ${itemId}::uuid AND tenant_id = ${tenantId}::uuid
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  private async findCurrentDescendant(
    tx: Prisma.TransactionClient,
    tenantId: string,
    sourceId: string,
  ): Promise<ItemRow | null> {
    const rows = await tx.$queryRaw<Array<ItemRow>>`
      WITH RECURSIVE lineage AS (
        SELECT id, supersedes_id, created_at
        FROM memory_items
        WHERE id = ${sourceId}::uuid AND tenant_id = ${tenantId}::uuid
        UNION ALL
        SELECT child.id, child.supersedes_id, child.created_at
        FROM memory_items child
        JOIN lineage parent ON child.supersedes_id = parent.id
        WHERE child.tenant_id = ${tenantId}::uuid
      )
      SELECT mi.id::text AS id, mi.tenant_id::text AS tenant_id,
             mi.client_id::text AS client_id, mi.owner_user_id::text AS owner_user_id,
             mi.type, mi.visibility, mi.slug, mi.title, mi.sections_jsonb,
             mi.status, mi.governed_status, mi.memory_class, mi.memory_scope,
             mi.legal_hold, mi.conflict_group_id::text AS conflict_group_id
      FROM memory_items mi
      JOIN lineage l ON l.id = mi.id
      WHERE mi.id <> ${sourceId}::uuid AND mi.status = 'active'
        AND mi.governed_status IN ('active','stale','conflicted')
      ORDER BY l.created_at DESC, mi.id DESC
      LIMIT 1
      FOR UPDATE OF mi
    `;
    return rows[0] ?? null;
  }

  private async insertVersion(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      copySource: ItemRow;
      parentId: string | null;
      contradictsId: string | null;
      candidateId: string;
      assertedBy: string;
      approvedBy: string;
      kind: MemoryVersionKind;
      sections: VersionSection[];
      governedStatus: 'active' | 'conflicted';
      conflictStatus: 'none' | 'open';
      conflictGroupId: string | null;
    },
  ): Promise<ItemRow> {
    const text = textFromSections(input.sections);
    const sectionsJson = JSON.stringify(input.sections);
    const hash = createHash('sha256').update(text).digest('hex');
    const slug = immutableMemoryVersionSlug(input.copySource.slug, input.candidateId);
    const sourceVersion = `memory-version:${input.candidateId}`.slice(0, 160);
    const rows = await tx.$queryRaw<Array<ItemRow>>`
      INSERT INTO memory_items (
        tenant_id, client_id, owner_user_id, type, visibility, entity_id,
        slug, title, aliases, tags, source, source_ref, provenance,
        sections_jsonb, schema_version, status, last_confirmed_at,
        review_cadence_days, supersedes_id, contradicts_id, sensitivity,
        retention_policy_jsonb, legal_hold, exportable, training_use,
        confidence, ingest_run_id, ingested_at, review_state, expires_at,
        memory_class, memory_authority, memory_scope, governed_status,
        source_type, source_id, source_excerpt, source_content_hash, source_version,
        asserted_by_user_id, approved_by_user_id, approved_at,
        second_approved_by_user_id, second_approved_at, as_of, effective_from,
        valid_until, review_due_at, conflict_status, conflict_group_id,
        controlling_item_id, origin_surface, origin_trace_id,
        origin_context_packet_id, origin_model, origin_prompt_version,
        instructions_allowed
      )
      SELECT
        mi.tenant_id, mi.client_id, mi.owner_user_id, mi.type, mi.visibility, mi.entity_id,
        ${slug}, mi.title, mi.aliases, mi.tags, 'manual', mi.source_ref, 'human',
        ${sectionsJson}::jsonb, mi.schema_version, 'active', now(),
        mi.review_cadence_days, ${input.parentId}::uuid, ${input.contradictsId}::uuid,
        mi.sensitivity, mi.retention_policy_jsonb, false, mi.exportable,
        mi.training_use, mi.confidence, NULL, now(), 'confirmed', mi.expires_at,
        mi.memory_class,
        CASE mi.memory_scope WHEN 'firm' THEN 'firm_approved'
          WHEN 'client' THEN 'client_approved' ELSE 'user_asserted' END,
        mi.memory_scope, ${input.governedStatus}, 'approved_document_edit',
        ${input.copySource.id}, NULL, ${hash}, ${sourceVersion},
        ${input.assertedBy}::uuid, ${input.approvedBy}::uuid, now(),
        NULL, NULL, now(), now(), mi.valid_until,
        CASE WHEN mi.review_cadence_days IS NULL THEN NULL
          ELSE now() + (mi.review_cadence_days * INTERVAL '1 day') END,
        ${input.conflictStatus}, ${input.conflictGroupId}::uuid, NULL,
        ${VERSION_SOURCE_KIND[input.kind]}, ${input.candidateId}, NULL, NULL, NULL,
        mi.instructions_allowed
      FROM memory_items mi
      WHERE mi.id = ${input.copySource.id}::uuid AND mi.tenant_id = ${input.tenantId}::uuid
      RETURNING id::text AS id, tenant_id::text AS tenant_id,
                client_id::text AS client_id, owner_user_id::text AS owner_user_id,
                type, visibility, slug, title, sections_jsonb, status, governed_status,
                memory_class, memory_scope, legal_hold,
                conflict_group_id::text AS conflict_group_id
    `;
    const created = rows[0];
    if (!created) throw new Error('Immutable memory version insert returned no row.');
    await this.transitionAudit.record(tx, input.tenantId, {
      subject: { memoryItemId: created.id },
      actorUserId: input.approvedBy,
      clientId: created.client_id,
      toStatus: input.governedStatus,
      reasonCode: input.kind === 'contradiction' ? 'conflict_detected' : 'corrected',
      reason: `Created immutable ${input.kind} memory version.`,
      sourceType: 'approved_document_edit',
      sourceId: input.copySource.id,
      proposalId: input.candidateId,
      metadata: {
        kind: input.kind,
        parentId: input.parentId,
        contradictsId: input.contradictsId,
      },
    });
    return created;
  }

  private async supersedeOne(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    target: ItemRow,
    replacementId: string,
    proposalId: string,
  ): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE memory_items
      SET status = 'superseded', governed_status = 'superseded', updated_at = now()
      WHERE id = ${target.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        AND status = 'active' AND governed_status IN ('active','stale','conflicted')
    `;
    if (changed !== 1) {
      throw new Error('Immutable activation did not supersede exactly one controlling version.');
    }
    await this.transitionAudit.record(tx, ctx.tenantId, {
      subject: { memoryItemId: target.id },
      actorUserId: ctx.userId,
      clientId: target.client_id,
      fromStatus: governedStatus(target),
      toStatus: 'superseded',
      reasonCode: 'superseded',
      reason: 'Approved immutable version became controlling.',
      sourceType: 'approved_document_edit',
      sourceId: replacementId,
      proposalId,
      metadata: { supersededByItemId: replacementId },
    });
    await this.cleanupOutbox.enqueue(tx, ctx.tenantId, {
      memoryItemId: target.id,
      operation: 'supersede_projections',
      idempotencyKey: `supersede_projections:${target.id}:${replacementId}`,
    });
  }

  private async openConflict(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    target: ItemRow,
    contradictoryItemId: string,
    groupId: string,
    proposalId: string,
  ): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE memory_items
      SET governed_status = 'conflicted', conflict_status = 'open',
          conflict_group_id = ${groupId}::uuid, controlling_item_id = NULL,
          updated_at = now()
      WHERE id = ${target.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        AND status = 'active' AND governed_status IN ('active','stale','conflicted')
    `;
    if (changed !== 1) throw new Error('Conflict activation lost its controlling item.');
    if (target.governed_status !== 'conflicted') {
      await this.transitionAudit.record(tx, ctx.tenantId, {
        subject: { memoryItemId: target.id },
        actorUserId: ctx.userId,
        clientId: target.client_id,
        fromStatus: governedStatus(target),
        toStatus: 'conflicted',
        reasonCode: 'conflict_detected',
        reason: 'Approved contradictory version opened a conflict group.',
        sourceType: 'approved_document_edit',
        sourceId: contradictoryItemId,
        proposalId,
        metadata: { conflictGroupId: groupId, contradictoryItemId },
      });
    }
  }

  private async linkDuplicate(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    candidate: CandidateRow,
    target: ItemRow,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE memory_items SET last_confirmed_at = now(), updated_at = now()
      WHERE id = ${target.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
    `;
    await this.finishCandidate(tx, ctx, candidate, target.id, target.id, null);
    await this.transitionAudit.record(tx, ctx.tenantId, {
      subject: { memoryItemId: target.id },
      actorUserId: ctx.userId,
      clientId: target.client_id,
      toStatus: governedStatus(target),
      reasonCode: 'confirmed',
      reason: 'Exact duplicate proposal linked to the controlling memory version.',
      sourceType: 'approved_document_edit',
      sourceId: candidate.id,
      proposalId: candidate.id,
      metadata: { duplicateCandidateId: candidate.id },
    });
  }

  private async finishCandidate(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    candidate: CandidateRow,
    committedItemId: string,
    duplicateItemId: string | null,
    contradictsItemId: string | null,
  ): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE memory_candidate
      SET status = 'approved', governed_status = 'active',
          decided_by = ${ctx.userId}::uuid, decided_at = now(),
          approved_by_user_id = ${ctx.userId}::uuid, approved_at = now(),
          committed_memory_item_id = ${committedItemId}::uuid,
          duplicate_memory_item_id = ${duplicateItemId}::uuid,
          contradicts_memory_item_id = ${contradictsItemId}::uuid,
          memory_authority = CASE memory_scope WHEN 'firm' THEN 'firm_approved'
            WHEN 'client' THEN 'client_approved' ELSE 'user_asserted' END
      WHERE id = ${candidate.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        AND status = 'pending'
    `;
    if (changed !== 1) throw new Error('Memory version candidate activation was not atomic.');
    await this.transitionAudit.record(tx, ctx.tenantId, {
      subject: { memoryCandidateId: candidate.id },
      actorUserId: ctx.userId,
      fromStatus: 'pending_review',
      toStatus: 'active',
      reasonCode: 'approved',
      reason: 'Immutable memory version proposal approved.',
      sourceType: 'approved_document_edit',
      sourceId: committedItemId,
      proposalId: candidate.id,
      metadata: {
        sourceKind: candidate.source_kind,
        committedItemId,
        duplicateItemId,
        contradictsItemId,
      },
    });
  }

  private requireLifecycle(): void {
    if (!governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE)) {
      throw new ServiceUnavailableException(
        'Immutable governed memory versions are disabled (MEMORY_GOVERNANCE_LIFECYCLE is not "enforce").',
      );
    }
  }

  private embedAfterCommit(input: PendingEmbed): void {
    void embedAndUpsert(this.prisma, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      ownerUserId: input.ownerUserId,
      sourceType: 'memory_item',
      sourceId: input.memoryItemId,
      text: `${input.title}: ${input.body}`,
      bypassRls: true,
    }).catch((error: unknown) => {
      this.logger.warn(
        `immutable memory embed failed; projection recovery remains available: ${(error as Error).message}`,
      );
    });
  }
}

function parsePayload(value: unknown): VersionPayload {
  const payload = value as Partial<VersionPayload> | null;
  const proposal = payload?.versionProposal as Partial<VersionPayload['versionProposal']> | null;
  const item = payload?.canonicalItem as Partial<VersionPayload['canonicalItem']> | null;
  if (
    !payload ||
    typeof payload.key !== 'string' ||
    typeof payload.value !== 'string' ||
    !['firm', 'client', 'user_private'].includes(String(payload.scope)) ||
    !proposal ||
    !isMemoryVersionKind(proposal.kind) ||
    typeof proposal.sourceItemId !== 'string' ||
    !item ||
    typeof item.type !== 'string' ||
    typeof item.slug !== 'string' ||
    typeof item.title !== 'string' ||
    !Array.isArray(item.sections)
  ) {
    throw new BadRequestException('Malformed immutable memory version candidate payload.');
  }
  return {
    key: payload.key,
    value: payload.value,
    source:
      typeof payload.source === 'string' ? payload.source : VERSION_SOURCE_KIND[proposal.kind],
    scope: payload.scope as VersionPayload['scope'],
    ownerUserId: typeof payload.ownerUserId === 'string' ? payload.ownerUserId : null,
    clientId: typeof payload.clientId === 'string' ? payload.clientId : null,
    canonicalItem: {
      type: item.type,
      slug: item.slug,
      title: item.title,
      sections: parseSections(item.sections),
    },
    versionProposal: {
      kind: proposal.kind,
      sourceItemId: proposal.sourceItemId,
      targetItemId: typeof proposal.targetItemId === 'string' ? proposal.targetItemId : null,
    },
  };
}

function parseSections(value: unknown): VersionSection[] {
  if (!Array.isArray(value)) throw new BadRequestException('Memory sections must be an array.');
  return value.map((raw) => {
    const section = raw as Partial<VersionSection>;
    if (
      typeof section.key !== 'string' ||
      typeof section.heading !== 'string' ||
      (section.owner !== 'human' && section.owner !== 'engine') ||
      typeof section.body !== 'string'
    ) {
      throw new BadRequestException('Malformed memory section.');
    }
    return {
      key: section.key,
      heading: section.heading,
      owner: section.owner,
      body: section.body,
    };
  });
}

function textFromSections(sections: readonly VersionSection[]): string {
  return sections
    .map((section) => section.body.trim())
    .filter(Boolean)
    .join('\n\n');
}

function scopeFor(item: ItemRow): VersionPayload['scope'] {
  if (item.memory_scope === 'client' || item.client_id) return 'client';
  if (item.memory_scope === 'user_private' || item.owner_user_id) return 'user_private';
  return 'firm';
}

function isTerminal(item: ItemRow): boolean {
  return (
    ['revoked', 'superseded', 'rejected', 'expired'].includes(item.governed_status) ||
    ['revoked', 'superseded'].includes(item.status)
  );
}

function isControlling(item: ItemRow | null): item is ItemRow {
  return Boolean(
    item &&
    item.status === 'active' &&
    ['active', 'stale', 'conflicted'].includes(item.governed_status),
  );
}

function governedStatus(
  item: ItemRow,
):
  | 'suggested'
  | 'pending_review'
  | 'active'
  | 'stale'
  | 'conflicted'
  | 'superseded'
  | 'revoked'
  | 'rejected'
  | 'expired' {
  const allowed = [
    'suggested',
    'pending_review',
    'active',
    'stale',
    'conflicted',
    'superseded',
    'revoked',
    'rejected',
    'expired',
  ] as const;
  return allowed.includes(item.governed_status as (typeof allowed)[number])
    ? (item.governed_status as (typeof allowed)[number])
    : 'pending_review';
}

function embedInput(item: ItemRow, body: string): PendingEmbed {
  return {
    tenantId: item.tenant_id,
    clientId: item.client_id,
    ownerUserId: item.owner_user_id,
    memoryItemId: item.id,
    title: item.title,
    body,
  };
}
