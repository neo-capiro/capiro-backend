import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma-client/index.js';

/**
 * Intel API Prisma client.
 *
 * The intel service owns only intel_* tables (starting with the Live Hearing
 * models) in the shared Aurora cluster. Tenant isolation is enforced in
 * application code: every query MUST include the `tenantId` resolved by the
 * TenantGuard (see auth/tenant.guard.ts). It does NOT define or migrate any
 * apps/api-owned table; it references them by id only (no cross-schema FKs),
 * mirroring the apps/workspace boundary.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Intel API Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
