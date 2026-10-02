import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TenantContextStore } from '../tenant/tenant-context.store.js';
import type { GovernedMemoryCandidateService } from '../memory/governed-memory-candidate.service.js';
import type { MemoryStoreService } from '../memory/memory-store.service.js';
import type { ImmutableMemoryVersionService } from '../memory/immutable-memory-version.service.js';
import type { MemoryAuthorizationService } from '../memory/memory-authorization.service.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { assertSyntheticCandidateWithdrawalInTx } from '../memory/synthetic-candidate-withdrawal.helpers.js';
import {
  assertSyntheticApprovedMemoryInTx,
  readSyntheticMemoryRetirementInTx,
} from '../memory/synthetic-approved-memory.helpers.js';
import {
  readSyntheticCorrectionInTx,
  readSyntheticCorrectionRetirementInTx,
} from '../memory/synthetic-memory-version.helpers.js';

export interface Case01FixtureDependencies {
  prisma: PrismaService;
  tenantContext: TenantContextStore;
  memoryCandidates: GovernedMemoryCandidateService;
  memoryStore: MemoryStoreService;
  memoryVersions: ImmutableMemoryVersionService;
  memoryAuthorization: MemoryAuthorizationService;
}

export interface HydratedCase01Owner {
  qualifyInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    scope: { caseId: '01'; clientId: string },
  ): Promise<unknown>;
  installLocatorInTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    input: {
      locator: unknown;
      expectedPriorLocatorSha256: string;
      expectedTenantRowVersion: string;
    },
  ): Promise<unknown>;
}

interface FixtureModule {
  createHydratedCase01MemoryOwner(deps: object): HydratedCase01Owner;
}

let modulePromise: Promise<FixtureModule> | undefined;

/** Fixed source-owned path works from src/meri and dist/meri. No env or request
 * can select executable code. Docker packages this exact MJS dependency graph.
 * Import is lazy; ordinary tenants never load or execute the fixture composition.
 */
export async function loadHydratedCase01FixtureOwner(
  dependencies: Case01FixtureDependencies,
): Promise<HydratedCase01Owner> {
  if (process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== 'meri-foundation-20260928')
    throw new Error('CASE01_FIXTURE_NAMESPACE_REQUIRED');
  modulePromise ??= import(
    pathToFileURL(
      resolve(
        __dirname,
        '../../../../evals/meri/live-v1/fixture-provisioning/case01-memory-owner.mjs',
      ),
    ).href
  ).then((loaded: unknown) => {
    if (
      !loaded ||
      typeof loaded !== 'object' ||
      !('createHydratedCase01MemoryOwner' in loaded) ||
      typeof loaded.createHydratedCase01MemoryOwner !== 'function'
    )
      throw new Error('CASE01_FIXTURE_MODULE_INVALID');
    return loaded as FixtureModule;
  });
  const module = await modulePromise;
  return module.createHydratedCase01MemoryOwner({
    ...dependencies,
    clientMemoryAllowed,
    assertSyntheticCandidateWithdrawalInTx,
    assertSyntheticApprovedMemoryInTx,
    readSyntheticMemoryRetirementInTx,
    readSyntheticCorrectionInTx,
    readSyntheticCorrectionRetirementInTx,
  });
}
