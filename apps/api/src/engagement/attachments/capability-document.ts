import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';

/** The existing Files source tag selects a capability; it never establishes authority. */
export function capabilityDocumentId(source?: string | null): string | null {
  if (!source?.startsWith('capability:')) return null;
  const id = source.slice('capability:'.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new BadRequestException('Invalid capability document source');
  return id.toLowerCase();
}

export async function requireCapabilityDocumentOwner(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string | null,
  capabilityId: string | null,
): Promise<void> {
  if (!capabilityId) return;
  if (
    !clientId ||
    !(await tx.clientCapability.findFirst({
      where: { id: capabilityId, tenantId: ctx.tenantId, clientId },
      select: { id: true },
    }))
  )
    throw new NotFoundException('Capability not found for this client');
}

export async function linkCapabilityDocument(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string | null,
  capabilityId: string | null,
  attachmentId: string,
): Promise<void> {
  if (!capabilityId || !clientId) return;
  await tx.clientCapabilityDocument.upsert({
    where: {
      tenantId_capabilityId_attachmentId: { tenantId: ctx.tenantId, capabilityId, attachmentId },
    },
    create: { tenantId: ctx.tenantId, clientId, capabilityId, attachmentId },
    update: {},
  });
}
