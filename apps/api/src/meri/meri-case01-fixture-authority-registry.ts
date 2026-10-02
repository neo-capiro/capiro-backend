import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';

export interface Case01FixtureOwner {
  qualifyInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    scope: { caseId: '01'; clientId: string },
  ): Promise<unknown>;
}

// Only trusted server composition registers a canonical/hydrated owner. Neither
// HTTP input nor a serialized receipt can register or replace an owner.
const owners = new WeakMap<PrismaService, Case01FixtureOwner>();

export function registerMeriCase01FixtureAuthority(
  prisma: PrismaService,
  owner: Case01FixtureOwner,
): () => void {
  if (owners.has(prisma) || typeof owner?.qualifyInTx !== 'function') {
    throw new Error('meri_case01_fixture_owner_registration_invalid');
  }
  owners.set(prisma, owner);
  return () => {
    if (owners.get(prisma) === owner) owners.delete(prisma);
  };
}

export function currentMeriCase01FixtureAuthority(
  prisma: PrismaService,
): Case01FixtureOwner | undefined {
  return owners.get(prisma);
}
