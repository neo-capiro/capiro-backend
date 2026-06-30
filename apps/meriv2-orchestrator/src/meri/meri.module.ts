import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriController } from './meri.controller.js';
import { MeriRegistryService } from './meri-registry.service.js';
import { MeriContextResolver } from './meri-context.resolver.js';
import { ApiClientContextRepo } from './api-client-context.repo.js';

/**
 * Hosts the MeriV2 tool registry over HTTP at `/meri-api/tools/*`. Thin: all
 * reasoning lives in `@capiro/meriv2-core`; this module wires the data adapters
 * (Phase 0: the api-delegating client-context repo) and the tenant-scoped
 * invocation path.
 */
@Module({
  controllers: [MeriController],
  providers: [PrismaService, MeriContextResolver, ApiClientContextRepo, MeriRegistryService],
})
export class MeriModule {}
