import { Injectable, type OnModuleInit, type OnApplicationShutdown } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { GovernedMemoryCandidateService } from '../memory/governed-memory-candidate.service.js';
import { MemoryStoreService } from '../memory/memory-store.service.js';
import { ImmutableMemoryVersionService } from '../memory/immutable-memory-version.service.js';
import { MemoryAuthorizationService } from '../memory/memory-authorization.service.js';
import { registerMeriCase01FixtureAuthority } from './meri-case01-fixture-authority-registry.js';
import { loadHydratedCase01FixtureOwner } from './meri-case01-fixture-loader.js';

/** Registers an in-process read-only authority, not fixtures or a request route.
 * Registration performs no database, provider, or fixture writes at startup.
 */
@Injectable()
export class MeriCase01FixtureBootstrapProvider implements OnModuleInit, OnApplicationShutdown {
  private dispose: (() => void) | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextStore,
    private readonly memoryCandidates: GovernedMemoryCandidateService,
    private readonly memoryStore: MemoryStoreService,
    private readonly memoryVersions: ImmutableMemoryVersionService,
    private readonly memoryAuthorization: MemoryAuthorizationService,
  ) {}

  onModuleInit(): void {
    if (this.dispose) return;
    this.dispose = registerMeriCase01FixtureAuthority(this.prisma, {
      qualifyInTx: async (tx, ctx, scope) => {
        const owner = await loadHydratedCase01FixtureOwner({
          prisma: this.prisma,
          tenantContext: this.tenantContext,
          memoryCandidates: this.memoryCandidates,
          memoryStore: this.memoryStore,
          memoryVersions: this.memoryVersions,
          memoryAuthorization: this.memoryAuthorization,
        });
        return owner.qualifyInTx(tx, ctx, scope);
      },
    });
  }

  onApplicationShutdown(): void {
    this.dispose?.();
    this.dispose = undefined;
  }
}
