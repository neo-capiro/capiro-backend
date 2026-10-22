import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { HillDaySourceService } from './hillday-source.service.js';

/** Hill Day packets are private to their owner. Current membership and the
 * sponsor's active client wall are required on authenticated boundaries and
 * whenever a signed export URL is served. */
export async function admitHillDayDocument(
  prisma: PrismaService, source: HillDaySourceService,
  tenantId: string, actorId: string, documentId: string,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId))
    throw new NotFoundException('Document not found');
  const doc = await prisma.wsHillDayDocument.findFirst({ where: { id: documentId, tenantId } });
  if (!doc || !actorId || doc.ownerId !== actorId) throw new NotFoundException('Document not found');
  await source.requireClient(tenantId, actorId, doc.clientId);
  return doc;
}
