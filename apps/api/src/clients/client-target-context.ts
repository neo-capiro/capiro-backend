import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IsIn, IsOptional, IsUUID, isUUID } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerClient } from './client-ordered-owner.access.js';

export class TargetContextQueryDto {
  @IsIn(['objectives', 'steps']) section!: 'objectives' | 'steps';
  @IsOptional() @IsUUID() after?: string;
}
interface SavedTarget {
  id: string;
  memberId: string;
  sourceDirectory: string;
}
export interface ObjectiveContext {
  id: string;
  outcome: string;
  status: string;
  version: number;
  askType: string | null;
  minimumWin: string;
}
export interface StepContext {
  id: string;
  strategyId: string;
  strategyTitle: string;
  title: string;
  kind: string;
  subject: string;
  status: string;
  startsOn: string;
  endsOn: string | null;
  openEnded: boolean;
}
const PAGE_SIZE = 25;

/** Read-only reverse projection of existing links. It never creates an association,
 * edits work or infers identity from a display name, email or note. */
export async function readTargetContext(
  prisma: PrismaService,
  ctx: TenantContext,
  clientId: string,
  targetId: string,
  input: TargetContextQueryDto,
) {
  if (
    !isUUID(clientId) ||
    !isUUID(targetId) ||
    !input ||
    Object.keys(input).some((key) => !['section', 'after'].includes(key)) ||
    !['objectives', 'steps'].includes(input.section) ||
    (input.after !== undefined && !isUUID(input.after))
  )
    throw new BadRequestException('Invalid target context selection');
  clientId = clientId.toLowerCase();
  targetId = targetId.toLowerCase();
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
    const targets = await tx.$queryRaw<SavedTarget[]>`
      SELECT id::text AS id, member_id AS "memberId", source_directory AS "sourceDirectory"
      FROM client_targets WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${clientId}::uuid
        AND id=${targetId}::uuid FOR SHARE`;
    const target = targets[0];
    if (
      targets.length !== 1 ||
      !target ||
      !['congress', 'state', 'staff'].includes(target.sourceDirectory)
    )
      throw new NotFoundException('Target unavailable');
    const after = input.after?.toLowerCase() ?? null;
    const rows =
      input.section === 'objectives'
        ? await objectiveContext(tx, ctx.tenantId, clientId, targetId, after)
        : await stepContext(tx, ctx.tenantId, clientId, target, after);
    const items = rows.slice(0, PAGE_SIZE);
    return {
      schemaVersion: 1 as const,
      clientId,
      targetId,
      section: input.section,
      items,
      nextCursor: rows.length > PAGE_SIZE ? items.at(-1)!.id : null,
    };
  });
}

function objectiveContext(
  tx: Prisma.TransactionClient,
  tenantId: string,
  clientId: string,
  targetId: string,
  after: string | null,
) {
  return tx.$queryRaw<ObjectiveContext[]>`
    SELECT o.id::text AS id, o.outcome, o.status, o.version,
      o.ask_type AS "askType", o.minimum_win AS "minimumWin"
    FROM client_objectives o
    WHERE o.tenant_id=${tenantId}::uuid AND o.client_id=${clientId}::uuid AND o.deleted_at IS NULL
      AND o.status IN ('draft', 'in_review', 'ready') AND (${after}::uuid IS NULL OR o.id>${after}::uuid)
      AND EXISTS (SELECT 1 FROM client_objective_resource_links l
        WHERE l.tenant_id=o.tenant_id AND l.client_id=o.client_id AND l.objective_id=o.id
          AND l.resource_kind='directory_target' AND l.resource_id=${targetId}::uuid AND l.removed_at IS NULL)
    ORDER BY o.id LIMIT ${PAGE_SIZE + 1}`;
}

function stepContext(
  tx: Prisma.TransactionClient,
  tenantId: string,
  clientId: string,
  target: SavedTarget,
  after: string | null,
) {
  // Strategy owns these rows. Match its canonical saved target ID first; only
  // a complete directory+member identifier can identify an older snapshot.
  // A conflicting explicit saved ID never falls back to its other fields.
  return tx.$queryRaw<StepContext[]>`
    SELECT n.id::text AS id, s.id::text AS "strategyId", s.title AS "strategyTitle", n.title,
      n.kind::text AS kind, n.subject::text AS subject, n.status::text AS status,
      n.starts_on::text AS "startsOn", n.ends_on::text AS "endsOn", n.open_ended AS "openEnded"
    FROM sp_strategy s JOIN sp_node n ON n.strategy_id=s.id AND n.tenant_id=s.tenant_id
    WHERE s.tenant_id=${tenantId}::uuid AND s.client_id=${clientId}::uuid
      AND s.archived_at IS NULL AND n.archived_at IS NULL AND (${after}::uuid IS NULL OR n.id>${after}::uuid)
      AND (lower(n.target_ref->>'clientTargetId')=${target.id}
        OR (COALESCE(n.target_ref->>'clientTargetId','')=''
          AND n.target_ref->>'memberId'=${target.memberId}
          AND n.target_ref->>'sourceDirectory'=${target.sourceDirectory}))
    ORDER BY n.id LIMIT ${PAGE_SIZE + 1}`;
}
