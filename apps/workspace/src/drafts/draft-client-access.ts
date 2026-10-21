import { ConflictException, NotFoundException } from '@nestjs/common';
import { clientMemoryAllowed } from '@capiro/shared';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/** Ordinary draft association is an explicit UUID, never a display-name match.
 * Bound drafts cannot be reassigned: create a reviewed new draft instead. Legacy
 * null rows may be explicitly associated by the owner; old snapshots stay null. */
export async function requireDraftClient(identity: PrismaService, db: PrismaService | Prisma.TransactionClient, tenantId: string, actorId: string, clientId: string | null) {
  // Shared identity tables use the established scoped system reader; the
  // subsequent client read stays inside the caller's tenant transaction.
  const members = await identity.withSystem(tx => tx.$queryRaw<Array<{ id: string }>>`
    SELECT u.id::text AS id FROM users u JOIN tenant_memberships m ON m.user_id=u.id
    JOIN tenants t ON t.id=m.tenant_id
    WHERE m.tenant_id=${tenantId}::uuid AND m.status::text='active' AND t.status::text='active'
      AND u.clerk_user_id=${actorId} AND m.role::text IN ('standard_user','user_admin','capiro_admin')`);
  if (!members[0]) throw new NotFoundException('Draft not found');
  if (clientId === null) return;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))
    throw new NotFoundException('Client not found');
  const clients = await db.$queryRaw<Array<{ id: string; name: string }>>`
    SELECT id::text AS id,name FROM clients WHERE tenant_id=${tenantId}::uuid AND id=${clientId}::uuid
    AND status::text='active' AND COALESCE(profile_status::text,'ACTIVE') <> 'ARCHIVED'`;
  if (!clients[0] || !(await clientMemoryAllowed(db, tenantId, members[0].id, clientId)))
    throw new NotFoundException('Client not found');
  return clients[0];
}

export async function draftClientSourceAccess(prisma: PrismaService, draft: { tenantId: string; clientId?: string | null; config?: unknown }, actorId: string) {
  const clientId = draft.clientId ?? null;
  const config = (draft.config ?? {}) as Record<string, unknown>;
  // No implicit promotion of legacy JSON or names. Corrupted mismatches are held.
  if ((config.clientId ?? null) !== clientId) return false;
  try {
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant',${draft.tenantId},true)`;
      await requireDraftClient(prisma, tx, draft.tenantId, actorId, clientId);
    });
    return true;
  } catch (error) {
    if (error instanceof NotFoundException) return false;
    throw error;
  }
}

export function nextDraftClient(current: { clientId?: string | null; ownerId: string; prospectId?: string | null }, actorId: string, requested: string | null | undefined) {
  const prior = current.clientId ?? null;
  if (requested === undefined || requested === prior) return prior;
  if (current.prospectId || prior !== null || actorId !== current.ownerId)
    throw new ConflictException('Client association cannot be changed on this draft');
  return requested;
}
