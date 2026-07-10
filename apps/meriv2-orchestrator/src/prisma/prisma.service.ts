import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Prisma access for the orchestrator. Uses the SAME generated `@prisma/client`
 * as apps/api (shared monorepo client → shared DB; architecture §5.4: a
 * separate service isolates CODE, not DATA), so there is no duplicated schema.
 *
 * Connects LAZILY (no `$connect` in a lifecycle hook): the service must boot for
 * the ungated `/health` probe even when the DB is unreachable; the first query
 * establishes the connection.
 *
 * `withTenant` mirrors apps/api/src/prisma/prisma.service.ts EXACTLY: a
 * transaction with `SET LOCAL set_config('app.current_tenant', …)` so Postgres
 * RLS scopes every row. Never weaken this.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return fn(tx);
      },
      opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
    );
  }

  /**
   * RLS-bypass transaction, mirroring apps/api's `withSystem` exactly. Added
   * for Phase 1 M5.0 so `@capiro/shared`'s `recordAiUsageEvent` (which needs
   * both `withTenant` and `withSystem` on its `deps.prisma`) type-checks here
   * too — the orchestrator's own chat/in-editor loops always meter a real
   * tenant (never tenant-agnostic), so this path isn't exercised by them
   * today, but keeping the same capability set as apps/api's PrismaService
   * matches this class's own "isolates CODE, not DATA" doc comment above.
   */
  async withSystem<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return fn(tx);
    });
  }
}
