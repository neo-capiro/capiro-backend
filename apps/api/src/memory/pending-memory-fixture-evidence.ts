import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { GovernedMemoryCandidateService } from './governed-memory-candidate.service.js';
import { clientMemoryAllowed } from './memory-wall.helpers.js';
import { memoryReviewSurfaceEnabled } from './memory-review-switch.js';

interface PendingOwnerModule {
  readPendingMemoryEvidenceForActor(deps: object, ctx: TenantContext): Promise<unknown | null>;
}
let modulePromise: Promise<PendingOwnerModule> | undefined;

/** Fixed source-owned import, only after authenticated synthetic scope checks.
 * No request input supplies a locator, source, receipt or executable module. */
export async function readOwnPendingMemoryFixtureEvidence(
  prisma: PrismaService,
  memoryCandidates: GovernedMemoryCandidateService,
  ctx: TenantContext,
): Promise<unknown | null> {
  if (
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== 'meri-foundation-20260928' ||
    ctx.tenantId !== 'f2d6cf8f-057c-479a-8110-62fe5086d43f' ||
    ctx.tenantSlug !== 'meri-foundation-20260928-t1' ||
    ctx.role !== 'user_admin' ||
    !memoryReviewSurfaceEnabled()
  )
    return null;
  modulePromise ??= import(
    pathToFileURL(
      resolve(
        __dirname,
        '../../../../evals/meri/live-v1/fixture-provisioning/memory-pending-execution.mjs',
      ),
    ).href
  ).then((loaded: unknown) => {
    if (
      !loaded ||
      typeof loaded !== 'object' ||
      !('readPendingMemoryEvidenceForActor' in loaded) ||
      typeof loaded.readPendingMemoryEvidenceForActor !== 'function'
    )
      throw new Error('PENDING_MEMORY_MODULE_INVALID');
    return loaded as PendingOwnerModule;
  });
  return (await modulePromise).readPendingMemoryEvidenceForActor(
    { prisma, memoryCandidates, clientMemoryAllowed },
    ctx,
  );
}
