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
    super({ log: ['error', 'warn'] });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('defense-api Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  // No generic system-query or RLS-bypass escape hatch. Bootstrap tenant resolution
  // and actor resolution use fixed-shape SECURITY DEFINER functions.
  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return fn(tx);
    });
  }

  async withTenantActor<T>(
    tenantId: string,
    userId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user', ${userId}, true)`;
      return fn(tx);
    });
  }
}
