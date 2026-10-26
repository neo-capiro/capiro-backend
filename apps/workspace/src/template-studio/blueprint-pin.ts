import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { BlueprintPin } from '../document-agent/document-agent-state.js';

/** Resolve an explicit pin through the existing Blueprint owner, never a latest-version lookup. */
export async function resolveBlueprintPin(
  db: Pick<Prisma.TransactionClient, 'wsBlueprintVersion'>,
  tenantId: string,
  input: unknown,
  use: 'adopt' | 'retained' = 'adopt',
) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('A complete blueprint pin is required');
  const pin = input as Record<string, unknown>;
  if (
    typeof pin.blueprintId !== 'string' ||
    !isUUID(pin.blueprintId) ||
    typeof pin.versionId !== 'string' ||
    !isUUID(pin.versionId) ||
    typeof pin.version !== 'number' ||
    !Number.isSafeInteger(pin.version) ||
    pin.version < 1 ||
    typeof pin.definitionHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(pin.definitionHash)
  )
    throw new BadRequestException('A complete blueprint pin is required');

  const version = await db.wsBlueprintVersion.findFirst({
    where: {
      id: pin.versionId,
      blueprintId: pin.blueprintId,
      blueprint: { OR: [{ tenantId }, { tenantId: null }] },
    },
  });
  if (!version) throw new NotFoundException('Blueprint version not found');
  if (version.version !== pin.version || version.definitionHash !== pin.definitionHash)
    throw new ConflictException('Blueprint pin does not match the saved version');
  // Retirement stops new adoption; it does not move an existing document off
  // its immutable, previously published version.
  if (
    version.status !== 'published' &&
    !(use === 'retained' && version.status === 'retired' && version.publishedAt !== null)
  )
    throw new ConflictException('Select a published blueprint version');
  const canonical: BlueprintPin = {
    blueprintId: version.blueprintId,
    versionId: version.id,
    version: version.version,
    definitionHash: version.definitionHash,
  };
  return { pin: canonical, version };
}
