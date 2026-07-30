import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

const VERSION_SOURCE_KINDS = {
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

interface VersionItemRow {
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
}

interface VersionProposalPayload {
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

interface LockedVersionCandidate {
  id: string;
  proposed_by: string;
  source_kind: string;
  payload_jsonb: unknown;
}

export type MemoryVersionResult =
  | { status: 'not_found' }
  | { status: 'legal_hold'; title: string }
  | { status: 'pending_review'; title: string; candidateId: string; activeItemUnchanged: true }
  | { status: 'activated'; title: string; memoryItemId: string }
  | { status: 'duplicate'; title: string; memoryItemId: string };

export interface VersionCandidateDecisionResult {
  candidateId: string;
  outcome: 'activated' | 'duplicate' | 'conflict' | 'rejected';
  memoryItemId?: string;
  controllingItemId?: string;
  conflictGroupId?: string;
}

interface ActivationOutcome {
  result: VersionCandidateDecisionResult;
  embed?: {
    tenantId: string;
    clientId: string | null;
    ownerUserId: string | null;
    sourceId: string;
    title: string;
    body: string;
  };
}

/**
 * Phase 4 immutable version lifecycle.
 *
 * Shared corrections/restores/contradictions are proposals. The controlling item
 * remains untouched until a different authorized reviewer approves the candidate.
 * Approval owns the candidate lock, version insert, old-version transition, audit,
 * conflict metadata, and cleanup-outbox intent in one tenant transaction.
 */
@Injectable()
export class MemoryVersionService {
  private readonly logger = new Logger(MemoryVersionService.name);

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

  async proposeRestore(ctx: TenantContext, historicalItemId: string): Promise<MemoryVersionResult> {
    return this.proposeOrActivate(ctx, historicalItemId, 'restore', null);
  }

  async approveCandidate(
    ctx: TenantContext,
    candidateId: string,
  ): Promise<VersionCandidateDecisionResult> {
    this.requireLifecycle();
    const outcome = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const candidate = await this.lockPendingCandidateInTx(tx, ctx.tenantId, candidateId);
      const payload = parseVersionPayload(candidate.payload_jsonb);
      const kind = payload.versionProposal.kind;
      if (VERSION_SOURCE_KINDS[kind] !== candidate.source_kind) {
        throw new BadRequestException('Memory version candidate kind does not match its source kind.');
      }

      await this.authorizeCandidateInTx(tx, ctx, candidateId, 'approve');
      if (candidate.proposed_by === ctx.userId && payload.scope !== 'user_private') {
        throw new ForbiddenException(
          'Shared-scope memory must be approved by a reviewer other than the proposer.',
        );
      }

      const source = await this.loadItemForUpdateInTx(
        tx,
        ctx.tenantId,
        payload.versionProposal.sourceItemId,
      );
      if (!source) throw new NotFoundException('Historical memory item not found.');
      await this.authorizeVersionSourceInTx(tx, ctx, source, kind);

      const target =
        kind === 'restore'
          ? await this.findCurrentDescendantForUpdateInTx(tx, ctx.tenantId, source.id)
          : source;
      if (kind !== 'restore' && isTerminal(target.governed_status, target.status)) {
        throw new BadRequestException('The controlling memory version is no longer active.');
      }
      if (kind === 'correction' && target.legal_hold) {
        throw new ForbiddenException('Memory operation denied: legal_hold');
      }

      const proposedSections = payload.canonicalItem.sections;
      const proposedText = textFromSections(proposedSections);
      const targetText = target ? textFromSections(parseSections(target.sections_jsonb)) : null;
      const decision = classifyMemoryVersionActivation(kind, proposedText, targetText);

      // A database trigger prevents the generic candidate approval path from
      // activating version candidates. This transaction-local capability is set
      // only after all server-owned authorization and row locks have succeeded.
      await tx.$executeRaw`SELECT set_config('app.memory_version_activation', 'on', true)`;

      if (decision === 'duplicate' && target) {
        await this.confirmDuplicateInTx(tx, ctx, candidate, target);
        return {
          result: {
            candidateId,
            outcome: 'duplicate',
            memoryItemId: target.id,
            controllingItemId: target.id,
          },
        } satisfies ActivationOutcome;
      }

      if (decision === 'conflict' && target) {
        const conflictGroupId = targetConflictGroup(target) ?? randomUUID();
        const created = await this.createVersionItemInTx(tx, {
          tenantId: ctx.tenantId,
          copySourceItemId: source.id,
          lineageParentId: null,
          contradictsItemId: target.id,
          candidateId,
          assertedByUserId: candidate.proposed_by,
          approvedByUserId: ctx.userId,
          kind,
          sections: proposedSections,
          conflictGroupId,
          governedStatus: 'conflicted',
          conflictStatus: 'open',
        });
        await this.openConflictInTx(tx, ctx, target, created.id, conflictGroupId, candidateId);
        await this.markCandidateApprovedInTx(tx, ctx, candidate, created.id, null, target.id);
        return {
          result: {
            candidateId,
            outcome: 'conflict',
            memoryItemId: created.id,
            controllingItemId: target.id,
            conflictGroupId,
          },
          embed: toEmbed(created, proposedText),
        } satisfies ActivationOutcome;
      }

      const lineageParentId = target?.id ?? source.id;
      const created = await this.createVersionItemInTx(tx, {
        tenantId: ctx.tenantId,
        copySourceItemId: source.id,
        lineageParentId,
        contradictsItemId: null,
        candidateId,
        assertedByUserId: candidate.proposed_by,
        approvedByUserId: ctx.userId,
        kind,
        sections: proposedSections,
        conflictGroupId: null,
        governedStatus: 'active',
        conflictStatus: 'none',
      });
      if (target) {
        await this.supersedeExactlyOneInTx(tx, ctx, target, created.id, candidateId);
      }
      await this.markCandidateApprovedInTx(tx, ctx, candidate, created.id, null, null);
      return {
        result: {
          candidateId,
          outcome: 'activated',
          memoryItemId: created.id,
          controllingItemId: created.id,
        },
        embed: toEmbed(created, proposedText),
      } satisfies ActivationOutcome;
    });

    if (outcome.embed) this.dispatchEmbedding(outcome.embed);
    return outcome.result;
  }

  async rejectCandidate(
    ctx: TenantContext,
    candidateId: string,
    reason: string,
  ): Promise<VersionCandidateDecisionResult> {
    this.requireLifecycle();
    const normalizedReason = (reason ?? '').trim();
    if (!normalizedReason) throw new BadRequestException('A rejection reason is required.');

    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const candidate = await this.lockPendingCandidateInTx(tx, ctx.tenantId, candidateId);
      parseVersionPayload(candidate.payload_jsonb);
      await this.authorizeCandidateInTx(tx, ctx, candidateId, 'review');
      await tx.$executeRaw`
        UPDATE memory_candidate
        SET status = 'rejected', governed_status = 'rejected', decided_by = ${ctx.userId}::uuid,
            decided_at = now(), updated_at = now()
        WHERE id = ${candidateId}::uuid AND tenant_id = ${ctx.tenantId}::uuid AND status = 'pending'
      `;
      await this.transitionAudit.record(tx, ctx.tenantId, {
        subject: { memoryCandidateId: candidateId },
        actorUserId: ctx.userId,
        fromStatus: 'pending_review',
        toStatus: 'rejected',
        reasonCode: 'rejected',
        reason: normalizedReason,
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
      const source = await this.loadItemForUpdateInTx(tx, ctx.tenantId, sourceItemId);
      if (!source) return { result: { status: 'not_found' } as MemoryVersionResult };

      if (kind === 'restore') {
        if (!isTerminal(source.governed_status, source.status)) {
          throw new BadRequestException('Only a revoked, superseded, rejected, or expired version can be restored.');
        }
      } else if (isTerminal(source.governed_status, source.status)) {
        throw new BadRequestException('Correct or contradict the current controlling memory version instead.');
      }
      if (kind === 'correction' && source.legal_hold) {
        return {
          result: { status: 'legal_hold', title: source.title } as MemoryVersionResult,
        };
      }

      await this.authorizeVersionSourceInTx(tx, ctx, source, kind);
      const target =
        kind === 'restore'
          ? await this.findCurrentDescendantForUpdateInTx(tx, ctx.tenantId, source.id)
          : source;
      const sections =
        kind === 'restore'
          ? parseSections(source.sections_jsonb)
          : [{ key: 'memory', heading: 'Memory', owner: 'human' as const, body: newContent! }];
      const proposedText = textFromSections(sections);
      const scope = normalizeScope(source.memory_scope, source.client_id, source.owner_user_id);

      if (scope !== 'user_private') {
        const candidateId = await this.insertVersionCandidateInTx(tx, {
          ctx,
          source,
          targetItemId: target?.id ?? null,
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
      const decision = classifyMemoryVersionActivation(kind, proposedText, targetText);
      if (decision === 'duplicate' && target) {
        await tx.$executeRaw`
          UPDATE memory_items SET last_confirmed_at = now(), updated_at = now()
          WHERE id = ${target.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        `;
        await this.transitionAudit.record(tx, ctx.tenantId, {
          subject: { memoryItemId: target.id },
          actorUserId: ctx.userId,
          toStatus: normalizeGovernedStatus(target.governed_status),
          reasonCode: 'confirmed',
          reason: 'Exact memory version already controls this private scope.',
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

      const syntheticCandidateId = randomUUID();
      if (decision === 'conflict' && target) {
        const conflictGroupId = targetConflictGroup(target) ?? randomUUID();
        const created = await this.createVersionItemInTx(tx, {
          tenantId: ctx.tenantId,
          copySourceItemId: source.id,
          lineageParentId: null,
          contradictsItemId: target.id,
          candidateId: syntheticCandidateId,
          assertedByUserId: ctx.userId,
          approvedByUserId: ctx.userId,
          kind,
          sections,
          conflictGroupId,
          governedStatus: 'conflicted',
          conflictStatus: 'open',
        });
        await this.openConflictInTx(
          tx,
          ctx,
          target,
          created.id,
          conflictGroupId,
          syntheticCandidateId,
        );
        return {
          result: {
            status: 'activated',
            title: created.title,
            memoryItemId: created.id,
          } as MemoryVersionResult,
          embed: toEmbed(created, proposedText),
        };
      }

      const created = await this.createVersionItemInTx(tx, {
        tenantId: ctx.tenantId,
        copySourceItemId: source.id,
        lineageParentId: target?.id ?? source.id,
        contradictsItemId: null,
        candidateId: syntheticCandidateId,
        assertedByUserId: ctx.userId,
        approvedByUserId: ctx.userId,
        kind,
        sections,
        conflictGroupId: null,
        governedStatus: 'active',
        conflictStatus: 'none',
      });
      if (target) {
        await this.supersedeExactlyOneInTx(tx, ctx, target, created.id, syntheticCandidateId);
      }
      return {
        result: {
          status: 'activated',
          title: created.title,
          memoryItemId: created.id,
        } as MemoryVersionResult,
        embed: toEmbed(created, proposedText),
      };
    });

    if ('embed' in outcome && outcome.embed) this.dispatchEmbedding(outcome.embed);
    return outcome.result;
  }

  private async authorizeVersionSourceInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    source: VersionItemRow,
    kind: MemoryVersionKind,
  ): Promise<void> {
    const subject = await this.authorization.loadItemInTx(tx, ctx.tenantId, source.id);
    if (!subject) throw new NotFoundException('Memory item not found.');

    // Restores are non-destructive to the historical row, so terminal status may
    // not veto the proposal. Access to the historical body is still checked first.
    const read = await this.authorization.evaluateInTx(tx, ctx, subject, 'read');
    if (!read.allowed) throw new ForbiddenException(`Memory operation denied: ${read.reason}`);
    const effectiveSubject = kind === 'restore' ? { ...subject, status: 'active' as const } : subject;
    const operation = source.memory_scope === 'user_private' ? 'edit' : 'propose';
    const decision = await this.authorization.evaluateInTx(tx, ctx, effectiveSubject, operation);
    if (!decision.allowed) {
      throw new ForbiddenException(`Memory operation denied: ${decision.reason}`);
    }
  }

  private async authorizeCandidateInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    candidateId: string,
    operation: 'approve' | 'review',
  ): Promise<void> {
    const subject = await this.authorization.loadCandidateInTx(tx, ctx.tenantId, candidateId);
    if (!subject) throw new NotFoundException('Memory candidate not found.');
    const decision = await this.authorization.evaluateInTx(tx, ctx, subject, operation);
    if (!decision.allowed) throw new ForbiddenException(`Memory operation denied: ${decision.reason}`);
  }

  private async insertVersionCandidateInTx(
    tx: Prisma.TransactionClient,
    input: {
      ctx: TenantContext;
      source: VersionItemRow;
      targetItemId: string | null;
      kind: MemoryVersionKind;
      sections: VersionSection[];
      proposedText: string;
    },
  ): Promise<string> {
    const candidateId = randomUUID();
    const scope = normalizeScope(
      input.source.memory_scope,
      input.source.client_id,
      input.source.owner_user_id,
    );
    const payload: VersionProposalPayload = {
      key: input.source.title,
      value: input.proposedText,
      source: VERSION_SOURCE_KINDS[input.kind],
      scope,
      ownerUserId: scope === 'user_private' ? input.source.owner_user_id : null,
      clientId: scope === 'client' ? input.source.client_id : null,
      canonicalItem: {
        type: input.source.type,
        slug: immutableMemoryVersionSlug(input.source.slug, candidateId),
        title: input.source.title,
        sections: input.sections,
      },
      versionProposal: {
        kind: input.kind,
        sourceItemId: input.source.id,
        targetItemId: input.targetItemId,
      },
    };
    const sourceHash = createHash('sha256').update(input.proposedText).digest('hex');
    const legacyScope = scope === 'user_private' ? 'personal' : scope;
    await tx.$executeRaw`
      INSERT INTO memory_candidate (
        id, tenant_id, proposed_by, source_kind, scope, client_id,
        payload_jsonb, provenance_jsonb, status, memory_class, memory_scope,
        governed_status, source_type, source_id, source_ref, source_content_hash,
        source_version, asserted_by_user_id, as_of, effective_from, conflict_status,
        legal_hold, origin_surface, origin_trace_id, instructions_allowed,
        contradicts_memory_item_id
      ) VALUES (
        ${candidateId}::uuid, ${input.ctx.tenantId}::uuid, ${input.ctx.userId}::uuid,
        ${VERSION_SOURCE_KINDS[input.kind]}, ${legacyScope}, ${input.source.client_id}::uuid,
        ${JSON.stringify(payload)}::jsonb,
        ${JSON.stringify({ sourceItemId: input.source.id, kind: input.kind })}::jsonb,
        'pending', ${input.source.memory_class}, ${scope}, 'pending_review',
        'user_message', ${input.source.id}, ${VERSION_SOURCE_KINDS[input.kind]}, ${sourceHash},
        ${`candidate:${candidateId}`}, ${input.ctx.userId}::uuid, now(), now(),
        ${input.kind === 'contradiction' ? 'open' : 'none'}, false,
        ${VERSION_SOURCE_KINDS[input.kind]}, ${candidateId}, false,
        ${input.kind === 'contradiction' ? input.source.id : null}::uuid
      )
    `;
    await this.transitionAudit.record(tx, input.ctx.tenantId, {
      subject: { memoryCandidateId: candidateId },
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
        targetItemId: input.targetItemId,
      },
    });
    return candidateId;
  }

  private async lockPendingCandidateInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    candidateId: string,
  ): Promise<LockedVersionCandidate> {
    const rows = await tx.$queryRaw<Array<LockedVersionCandidate>>`
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

  private async loadItemForUpdateInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    itemId: string,
  ): Promise<VersionItemRow | null> {
    const rows = await tx.$queryRaw<Array<VersionItemRow>>`
      SELECT id::text AS id, tenant_id::text AS tenant_id, client_id::text AS client_id,
             owner_user_id::text AS owner_user_id, type, visibility, slug, title,
             sections_jsonb, status, governed_status, memory_class, memory_scope, legal_hold
      FROM memory_items
      WHERE id = ${itemId}::uuid AND tenant_id = ${tenantId}::uuid
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  private async findCurrentDescendantForUpdateInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    historicalItemId: string,
  ): Promise<VersionItemRow | null> {
    const rows = await tx.$queryRaw<Array<VersionItemRow>>`
      WITH RECURSIVE lineage AS (
        SELECT mi.id, mi.supersedes_id, mi.created_at
        FROM memory_items mi
        WHERE mi.id = ${historicalItemId}::uuid AND mi.tenant_id = ${tenantId}::uuid
        UNION ALL
        SELECT child.id, child.supersedes_id, child.created_at
        FROM memory_items child
        JOIN lineage parent ON child.supersedes_id = parent.id
        WHERE child.tenant_id = ${tenantId}::uuid
      )
      SELECT mi.id::text AS id, mi.tenant_id::text AS tenant_id,
             mi.client_id::text AS client_id, mi.owner_user_id::text AS owner_user_id,
             mi.type, mi.visibility, mi.slug, mi.title, mi.sections_jsonb,
             mi.status, mi.governed_status, mi.memory_class, mi.memory_scope, mi.legal_hold
      FROM memory_items mi
      JOIN lineage l ON l.id = mi.id
      WHERE mi.id <> ${historicalItemId}::uuid
        AND mi.status = 'active'
        AND mi.governed_status IN ('active','stale','conflicted')
      ORDER BY l.created_at DESC, mi.id DESC
      LIMIT 1
      FOR UPDATE OF mi
    `;
    return rows[0] ?? null;
  }

  private async createVersionItemInTx(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      copySourceItemId: string;
      lineageParentId: string | null;
      contradictsItemId: string | null;
      candidateId: string;
      assertedByUserId: string;
      approvedByUserId: string;
      kind: MemoryVersionKind;
      sections: VersionSection[];
      conflictGroupId: string | null;
      governedStatus: 'active' | 'conflicted';
      conflictStatus: 'none' | 'open';
    },
  ): Promise<VersionItemRow> {
    const sections = JSON.stringify(input.sections);
    const text = textFromSections(input.sections);
    const hash = createHash('sha256').update(text).digest('hex');
    const slug = immutableMemoryVersionSlug(
      (await this.loadItemForUpdateInTx(tx, input.tenantId, input.copySourceItemId))?.slug ??
        input.copySourceItemId,
      input.candidateId,
    );
    const version = `memory-version:${input.candidateId}`.slice(0, 160);
    const rows = await tx.$queryRaw<Array<VersionItemRow>>`
      INSERT INTO memory_items (
        tenant_id, client_id, owner_user_id, type, visibility, entity_id,
        slug, title, aliases, tags, source, source_ref, provenance,
        sections_jsonb, schema_version, status, last_confirmed_at, review_cadence_days,
        supersedes_id, contradicts_id, sensitivity, retention_policy_jsonb,
        legal_hold, exportable, training_use, expires_at, confidence,
        memory_class, memory_authority, memory_scope, governed_status,
        source_type, source_id, source_excerpt, source_content_hash, source_version,
        asserted_by_user_id, approved_by_user_id, approved_at,
        second_approved_by_user_id, second_approved_at, review_state, review_due_at,
        as_of, effective_from, valid_until, conflict_status, conflict_group_id,
        controlling_item_id, origin_surface, origin_trace_id, origin_context_packet_id,
        origin_model, origin_prompt_version, instructions_allowed
      )
      SELECT
        mi.tenant_id, mi.client_id, mi.owner_user_id, mi.type, mi.visibility, mi.entity_id,
        ${slug}, mi.title, mi.aliases, mi.tags, 'manual', mi.source_ref, 'human',
        ${sections}::jsonb, mi.schema_version, 'active', now(), mi.review_cadence_days,
        ${input.lineageParentId}::uuid, ${input.contradictsItemId}::uuid,
        mi.sensitivity, mi.retention_policy_jsonb, false, mi.exportable, mi.training_use,
        mi.expires_at, mi.confidence, mi.memory_class,
        CASE mi.memory_scope WHEN 'firm' THEN 'firm_approved'
          WHEN 'client' THEN 'client_approved' ELSE 'user_asserted' END,
        mi.memory_scope, ${input.governedStatus}, 'approved_document_edit',
        ${input.copySourceItemId}, NULL, ${hash}, ${version},
        ${input.assertedByUserId}::uuid, ${input.approvedByUserId}::uuid, now(),
        NULL, NULL, 'confirmed',
        CASE WHEN mi.review_cadence_days IS NULL THEN NULL
          ELSE now() + (mi.review_cadence_days * INTERVAL '1 day') END,
        now(), now(), mi.valid_until, ${input.conflictStatus},
        ${input.conflictGroupId}::uuid, NULL, ${VERSION_SOURCE_KINDS[input.kind]},
        ${input.candidateId}, NULL, NULL, NULL, mi.instructions_allowed
      FROM memory_items mi
      WHERE mi.id = ${input.copySourceItemId}::uuid AND mi.tenant_id = ${input.tenantId}::uuid
      RETURNING id::text AS id, tenant_id::text AS tenant_id,
                client_id::text AS client_id, owner_user_id::text AS owner_user_id,
                type, visibility, slug, title, sections_jsonb, status, governed_status,
                memory_class, memory_scope, legal_hold
    `;
    const row = rows[0];
    if (!row) throw new Error('Immutable memory version insert returned no row.');
    await this.transitionAudit.record(tx, input.tenantId, {
      subject: { memoryItemId: row.id },
      actorUserId: input.approvedByUserId,
      clientId: row.client_id,
      toStatus: input.governedStatus,
      reasonCode: input.kind === 'contradiction' ? 'conflict_detected' : 'corrected',
      reason: `Created immutable ${input.kind} memory version.`,
      sourceType: 'approved_document_edit',
      sourceId: input.copySourceItemId,
      proposalId: input.candidateId,
      metadata: {
        kind: input.kind,
        lineageParentId: input.lineageParentId,
        contradictsItemId: input.contradictsItemId,
      },
    });
    return row;
  }

  private async supersedeExactlyOneInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    target: VersionItemRow,
    newItemId: string,
    candidateId: string,
  ): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE memory_items
      SET status = 'superseded', governed_status = 'superseded', updated_at = now()
      WHERE id = ${target.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        AND status = 'active' AND governed_status IN ('active','stale','conflicted')
    `;
    if (changed !== 1) {
      throw new Error('Immutable memory activation did not supersede exactly one controlling row.');
    }
    await this.transitionAudit.record(tx, ctx.tenantId, {
      subject: { memoryItemId: target.id },
      actorUserId: ctx.userId,
      clientId: target.client_id,
      fromStatus: normalizeGovernedStatus(target.governed_status),
      toStatus: 'superseded',
      reasonCode: 'superseded',
      reason: 'Approved immutable memory version became controlling.',
      sourceType: 'approved_document_edit',
      sourceId: newItemId,
      proposalId: candidateId,
      metadata: { supersededByItemId: newItemId },
    });
    await this.cleanupOutbox.enqueue(tx, ctx.tenantId, {
      memoryItemId: target.id,
      operation: 'supersede_projections',
      idempotencyKey: `supersede_projections:${target.id}:${newItemId}`,
    });
  }

  private async openConflictInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    target: VersionItemRow,
    newItemId: string,
    conflictGroupId: string,
    candidateId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE memory_items
      SET governed_status = 'conflicted', conflict_status = 'open',
          conflict_group_id = ${conflictGroupId}::uuid, controlling_item_id = NULL,
          updated_at = now()
      WHERE id = ${target.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
        AND status = 'active' AND governed_status IN ('active','stale','conflicted')
    `;
    if (target.governed_status !== 'conflicted') {
      await this.transitionAudit.record(tx, ctx.tenantId, {
        subject: { memoryItemId: target.id },
        actorUserId: ctx.userId,
        clientId: target.client_id,
        fromStatus: normalizeGovernedStatus(target.governed_status),
        toStatus: 'conflicted',
        reasonCode: 'conflict_detected',
        reason: 'Approved contradictory memory version opened a conflict group.',
        sourceType: 'approved_document_edit',
        sourceId: newItemId,
        proposalId: candidateId,
        metadata: { conflictGroupId, contradictoryItemId: newItemId },
      });
    }
  }

  private async confirmDuplicateInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    candidate: LockedVersionCandidate,
    target: VersionItemRow,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE memory_items SET last_confirmed_at = now(), updated_at = now()
      WHERE id = ${target.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
    `;
    await this.markCandidateApprovedInTx(tx, ctx, candidate, target.id, target.id, null);
    await this.transitionAudit.record(tx, ctx.tenantId, {
      subject: { memoryItemId: target.id },
      actorUserId: ctx.userId,
      clientId: target.client_id,
      toStatus: normalizeGovernedStatus(target.governed_status),
      reasonCode: 'confirmed',
      reason: 'Exact duplicate proposal linked to the existing controlling version.',
      sourceType: 'approved_document_edit',
      sourceId: candidate.id,
      proposalId: candidate.id,
      metadata: { duplicateCandidateId: candidate.id },
    });
  }

  private async markCandidateApprovedInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    candidate: LockedVersionCandidate,
    committedItemId: string,
    duplicateItemId: string | null,
    contradictsItemId: string | null,
  ): Promise<void> {
    const updated = await tx.$executeRaw`
      UPDATE memory_candidate
      SET status = 'approved', governed_status = 'active',
          decided_by = ${ctx.userId}::uuid, decided_at = now(),
          approved_by_user_id = ${ctx.userId}::uuid, approved_at = now(),
          committed_memory_item_id = ${committedItemId}::uuid,
          duplicate_memory_item_id = ${duplicateItemId}::uuid,
          contradicts_memory_item_id = ${contradictsItemId}::uuid,
          memory_authority = CASE memory_scope WHEN 'firm' THEN 'firm_approved'
            WHEN 'client' THEN 'client_approved' ELSE 'user_asserted' END,
          updated_at = now()
      WHERE id = ${candidate.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid AND status = 'pending'
    `;
    if (updated !== 1) throw new Error('Memory version candidate decision was not atomic.');
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
        committedItemId,
        duplicateItemId,
        contradictsItemId,
        sourceKind: candidate.source_kind,
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

  private dispatchEmbedding(input: NonNullable<ActivationOutcome['embed']>): void {
    void embedAndUpsert(this.prisma, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      ownerUserId: input.ownerUserId,
      sourceType: 'memory_item',
      sourceId: input.sourceId,
      text: `${input.title}: ${input.body}`,
      bypassRls: true,
    }).catch((err: unknown) => {
      this.logger.warn(
        `immutable memory version embed failed (outbox/backfill remains available): ${(err as Error).message}`,
      );
    });
  }
}

function parseVersionPayload(value: unknown): VersionProposalPayload {
  const p = value as Partial<VersionProposalPayload> | null;
  const proposal = p?.versionProposal as Partial<VersionProposalPayload['versionProposal']> | null;
  const canonical = p?.canonicalItem as Partial<VersionProposalPayload['canonicalItem']> | null;
  if (
    !p ||
    typeof p.key !== 'string' ||
    typeof p.value !== 'string' ||
    !['firm', 'client', 'user_private'].includes(String(p.scope)) ||
    !proposal ||
    !isMemoryVersionKind(proposal.kind) ||
    typeof proposal.sourceItemId !== 'string' ||
    !canonical ||
    typeof canonical.type !== 'string' ||
    typeof canonical.slug !== 'string' ||
    typeof canonical.title !== 'string' ||
    !Array.isArray(canonical.sections)
  ) {
    throw new BadRequestException('Malformed immutable memory version candidate payload.');
  }
  return {
    key: p.key,
    value: p.value,
    source: typeof p.source === 'string' ? p.source : VERSION_SOURCE_KINDS[proposal.kind],
    scope: p.scope as VersionProposalPayload['scope'],
    ownerUserId: typeof p.ownerUserId === 'string' ? p.ownerUserId : null,
    clientId: typeof p.clientId === 'string' ? p.clientId : null,
    canonicalItem: {
      type: canonical.type,
      slug: canonical.slug,
      title: canonical.title,
      sections: parseSections(canonical.sections),
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
    const row = raw as Partial<VersionSection>;
    if (
      typeof row.key !== 'string' ||
      typeof row.heading !== 'string' ||
      (row.owner !== 'human' && row.owner !== 'engine') ||
      typeof row.body !== 'string'
    ) {
      throw new BadRequestException('Malformed memory section.');
    }
    return { key: row.key, heading: row.heading, owner: row.owner, body: row.body };
  });
}

function textFromSections(sections: readonly VersionSection[]): string {
  return sections
    .map((section) => section.body.trim())
    .filter(Boolean)
    .join('\n\n');
}

function normalizeScope(
  rawScope: string,
  clientId: string | null,
  ownerUserId: string | null,
): VersionProposalPayload['scope'] {
  if (rawScope === 'client' || clientId) return 'client';
  if (rawScope === 'user_private' || ownerUserId) return 'user_private';
  return 'firm';
}

function isTerminal(governedStatus: string, legacyStatus: string): boolean {
  return (
    ['revoked', 'superseded', 'rejected', 'expired'].includes(governedStatus) ||
    ['revoked', 'superseded'].includes(legacyStatus)
  );
}

function normalizeGovernedStatus(value: string):
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
  return allowed.includes(value as (typeof allowed)[number])
    ? (value as (typeof allowed)[number])
    : 'pending_review';
}

function targetConflictGroup(target: VersionItemRow): string | null {
  const candidate = target as VersionItemRow & { conflict_group_id?: string | null };
  return candidate.conflict_group_id ?? null;
}

function toEmbed(
  row: VersionItemRow,
  body: string,
): NonNullable<ActivationOutcome['embed']> {
  return {
    tenantId: row.tenant_id,
    clientId: row.client_id,
    ownerUserId: row.owner_user_id,
    sourceId: row.id,
    title: row.title,
    body,
  };
}
