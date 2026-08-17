import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '../../generated/prisma-client/index.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: ['error', 'warn'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('defense-api Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  // No withSystem()/app.bypass_rls escape hatch here. That would let any
  // future caller run arbitrary raw SQL under a generic RLS bypass, which
  // defeats the least-privilege HTTP boundary this service exists to hold.
  // The one place that previously needed it (resolving a tenant before
  // app.current_tenant is known) now calls the three narrow SECURITY DEFINER
  // functions granted to capiro_defense_serve
  // (see org-tenant-resolver.provider.ts and migration
  // 20261120200000_phase8_defense_runtime_roles) instead of bypassing RLS
  // from application code.

  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return fn(tx);
    });
  }
}
