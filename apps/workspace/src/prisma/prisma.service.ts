import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '../../generated/prisma-client/index.js';
import {
  assertContextPersistenceReleased,
  workspaceDraftWriteTarget,
} from '../generation/context-persistence-hold.js';

/** Workspace engine Prisma client. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private persistenceGateInstalled = false;

  async onModuleInit(): Promise<void> {
    if (!this.persistenceGateInstalled) {
      this.$use(async (params, next) => {
        const target = workspaceDraftWriteTarget(params);
        if (target) assertContextPersistenceReleased(target.tenantId, target.draftId);
        return next(params);
      });
      this.persistenceGateInstalled = true;
    }
    await this.$connect();
    this.logger.log('Workspace Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run `fn` in a transaction with `app.bypass_rls` set, mirroring apps/api's
   * withSystem. Workspace's own ws_* tables have no RLS; this exists for shared
   * identity tables protected by FORCE ROW LEVEL SECURITY.
   */
  async withSystem<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return fn(tx as unknown as Prisma.TransactionClient);
    });
  }
}
