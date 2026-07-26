import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '../../generated/prisma-client/index.js';

/**
 * Workspace engine Prisma client.
 *
 * The engine owns only ws_* tables in the shared Aurora cluster. Tenant
 * isolation is enforced in application code: every query MUST include the
 * `tenantId` resolved by the TenantGuard (see auth/tenant.guard.ts). There is
 * no Postgres RLS on ws_* tables in this pass — the guard + mandatory tenantId
 * filters are the isolation boundary. Helpers below make the tenant filter
 * impossible to forget.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Workspace Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run `fn` in a transaction with `app.bypass_rls` set, mirroring apps/api's
   * withSystem.
   *
   * Workspace's OWN tables (ws_*) have no RLS, so this is not needed for them.
   * It exists for the identity tables in the same Aurora database — `tenants`
   * and `tenant_memberships`, owned by apps/api — which have FORCE ROW LEVEL
   * SECURITY. FORCE subjects even the table owner to the policy, so connecting
   * as capiro_app is not sufficient: without this GUC the canonical
   * org->tenant lookup returns ZERO ROWS rather than raising, and every request
   * 403s with "No tenant for the supplied identifiers" — a total outage that
   * presents as a data problem.
   *
   * The GUC is `app.bypass_rls` (NOT `app.rls_bypass`).
   */
  async withSystem<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return fn(tx as unknown as Prisma.TransactionClient);
    });
  }
}
