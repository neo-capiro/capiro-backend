import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import type {
  PendingSettingsCandidate,
  SettingsMemoryCandidateInput,
} from './memory-candidate.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import type { MemorySection, MemoryItemType } from './memory.types.js';

const IMMUTABLE_SOURCE_KINDS = new Set([
  'memory_correction',
  'memory_restore',
  'memory_contradiction',
]);

interface SettingsSourceRow {
  id: string;
  clientId: string | null;
  ownerUserId: string | null;
  type: string;
  slug: string;
  title: string;
  memoryClass: string;
  memoryScope: string;
  governedStatus: string;
  legalHold: boolean;
}

/**
 * Converts an edit to an existing firm/client Settings file into the exact
 * immutable-memory candidate contract. First-time files remain on the standard
 * candidate path; approved edits to existing shared truth never use a canonical
 * slug upsert and therefore never replace the prior version in place.
 */
@Injectable()
export class SettingsMemoryVersionCandidateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: MemoryAuthorizationService,
    private readonly transitions: MemoryTransitionAuditService,
  ) {}

  async proposeExistingCorrection(
    ctx: TenantContext,
    input: SettingsMemoryCandidateInput,
  ): Promise<PendingSettingsCandidate | null> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const source = await this.findCurrentSettingsItem(tx, ctx.tenantId, input.type, input.slug);
      if (!source) return null;
      if (source.memoryScope !== input.scope) {
        throw new BadRequestException('The Settings file scope no longer matches its active memory.');
      }
      if (input.scope === 'client' && source.clientId !== input.clientId) {
        throw new BadRequestException('The Settings file client no longer matches its active memory.');
      }
      if (source.legalHold) throw new ForbiddenException('Memory operation denied: legal_hold');

      const subject = await this.authorization.loadItemInTx(tx, ctx.tenantId, source.id);
      if (!subject) throw new NotFoundException('Active Settings memory was not found.');
      const read = await this.authorization.evaluateInTx(tx, ctx, subject, 'read');
      if (!read.allowed) throw new ForbiddenException(`Memory operation denied: ${read.reason}`);
      const propose = await this.authorization.evaluateInTx(tx, ctx, subject, 'propose');
      if (!propose.allowed) {
        throw new ForbiddenException(`Memory operation denied: ${propose.reason}`);
      }

      const id = randomUUID();
      const proposedText = textFromSections(input.sections);
      const hash = createHash('sha256').update(proposedText).digest('hex');
      const payload = {
        key: `settings-file:${input.type}:${input.slug}`,
        value: proposedText,
        source: 'memory_correction',
        scope: input.scope,
        ownerUserId: null,
        clientId: input.scope === 'client' ? input.clientId : null,
        canonicalItem: {
          type: input.type,
          slug: input.slug,
          title: input.title,
          sections: input.sections,
        },
        versionProposal: {
          kind: 'correction',
          sourceItemId: source.id,
          targetItemId: source.id,
        },
        settingsCorrection: true,
        settingsStableSlug: input.slug,
      };

      await tx.$executeRaw`
        INSERT INTO memory_candidate (
          id, tenant_id, proposed_by, source_kind, scope, client_id,
          payload_jsonb, provenance_jsonb, status, memory_class, memory_scope,
          governed_status, source_type, source_id, source_ref, source_content_hash,
          source_version, asserted_by_user_id, as_of, effective_from,
          conflict_status, legal_hold, origin_surface, origin_trace_id,
          instructions_allowed
        ) VALUES (
          ${id}::uuid, ${ctx.tenantId}::uuid, ${ctx.userId}::uuid,
          'memory_correction', ${input.scope}, ${source.clientId}::uuid,
          ${JSON.stringify(payload)}::jsonb,
          ${JSON.stringify({
            kind: 'correction',
            sourceItemId: source.id,
            surface: 'settings_memory_editor',
            stableSlug: input.slug,
          })}::jsonb,
          'pending', ${source.memoryClass}, ${source.memoryScope}, 'pending_review',
          'settings_editor', ${source.id}, 'settings_sections', ${hash},
          ${`candidate:${id}`}, ${ctx.userId}::uuid, now(), now(),
          'none', false, 'settings_memory_editor', ${id}, false
        )
      `;

      await this.transitions.record(tx, ctx.tenantId, {
        subject: { memoryCandidateId: id },
        actorUserId: ctx.userId,
        clientId: source.clientId,
        toStatus: 'pending_review',
        reasonCode: 'submitted_for_review',
        reason: 'Existing shared Settings memory submitted as an immutable correction.',
        sourceType: 'settings_editor',
        sourceId: source.id,
        proposalId: id,
        metadata: {
          kind: 'correction',
          sourceItemId: source.id,
          type: input.type,
          stableSlug: input.slug,
        },
      });

      return {
        candidateId: id,
        status: 'pending_review',
        submittedAt: new Date().toISOString(),
      };
    });
  }

  async findPendingSettingsCorrection(
    tenantId: string,
    viewerUserId: string,
    type: MemoryItemType,
    stableSlug: string,
  ): Promise<PendingSettingsCandidate | null> {
    return this.prisma.withTenantUser(tenantId, viewerUserId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; createdAt: Date }>>`
        SELECT id::text AS id, created_at AS "createdAt"
        FROM memory_candidate
        WHERE tenant_id = ${tenantId}::uuid
          AND status = 'pending'
          AND source_kind = 'memory_correction'
          AND payload_jsonb->>'settingsCorrection' = 'true'
          AND payload_jsonb #>> '{canonicalItem,type}' = ${type}
          AND payload_jsonb->>'settingsStableSlug' = ${stableSlug}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const row = rows[0];
      return row
        ? {
            candidateId: row.id,
            status: 'pending_review',
            submittedAt: row.createdAt.toISOString(),
          }
        : null;
    });
  }

  async isImmutableVersionCandidate(
    tenantId: string,
    userId: string,
    candidateId: string,
  ): Promise<boolean> {
    return this.prisma.withTenantUser(tenantId, userId, async (tx) => {
      const row = await tx.memoryCandidate.findFirst({
        where: { id: candidateId, tenantId, status: 'pending' },
        select: { sourceKind: true },
      });
      return Boolean(row && IMMUTABLE_SOURCE_KINDS.has(row.sourceKind));
    });
  }

  private async findCurrentSettingsItem(
    tx: Prisma.TransactionClient,
    tenantId: string,
    type: MemoryItemType,
    stableSlug: string,
  ): Promise<SettingsSourceRow | null> {
    const rows = await tx.$queryRaw<SettingsSourceRow[]>`
      WITH RECURSIVE lineage AS (
        SELECT id
        FROM memory_items
        WHERE tenant_id = ${tenantId}::uuid AND type = ${type} AND slug = ${stableSlug}
        UNION ALL
        SELECT child.id
        FROM memory_items child
        JOIN lineage parent ON child.supersedes_id = parent.id
        WHERE child.tenant_id = ${tenantId}::uuid
      )
      SELECT mi.id::text AS id,
             mi.client_id::text AS "clientId",
             mi.owner_user_id::text AS "ownerUserId",
             mi.type,
             mi.slug,
             mi.title,
             mi.memory_class AS "memoryClass",
             mi.memory_scope AS "memoryScope",
             mi.governed_status AS "governedStatus",
             mi.legal_hold AS "legalHold"
      FROM memory_items mi
      JOIN lineage l ON l.id = mi.id
      WHERE mi.tenant_id = ${tenantId}::uuid
        AND mi.status = 'active'
        AND mi.governed_status IN ('active','stale','conflicted')
      ORDER BY mi.created_at DESC, mi.id DESC
      LIMIT 1
      FOR UPDATE OF mi
    `;
    return rows[0] ?? null;
  }
}

function textFromSections(sections: readonly MemorySection[]): string {
  return sections
    .map((section) => section.body.trim())
    .filter(Boolean)
    .join('\n\n');
}
