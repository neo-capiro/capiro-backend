import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/** Scope baked into a per-call query-extended client (see applyTenantScope). */
type TenantScope = { tenantId: string; bypass?: false } | { bypass: true };

const WHERE_BEARING_OPS = new Set<string>([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

/**
 * Pure decision fn for the tenant-scope query hook (exported for tests). The
 * runtime DB role (capiro_app) is a member of the table-owner role and BYPASSES
 * RLS, so tenant isolation must be enforced in-query. See
 * apps/api/src/prisma/prisma.service.ts for full rationale.
 */
export function applyTenantScope(
  scope: TenantScope,
  model: string,
  operation: string,
  args: unknown,
  scopedModels: ReadonlySet<string>,
): unknown {
  if (scope.bypass === true || !scopedModels.has(model) || !WHERE_BEARING_OPS.has(operation)) {
    return args;
  }
  const next = { ...((args as Record<string, unknown> | undefined) ?? {}) };
  const where = (next.where as Record<string, unknown> | undefined) ?? {};
  next.where = { ...where, tenantId: scope.tenantId };
  return next;
}

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

  // Models with a tenantId field (auto-derived from the shared schema) — the
  // set the tenant-scope hook constrains.
  private readonly tenantScopedModels: ReadonlySet<string> = new Set(
    Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === 'tenantId'))
      .map((m) => m.name),
  );

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * A query-extended client with the given tenant scope baked in — enforces
   * tenant isolation in-query because capiro_app bypasses RLS. See
   * apps/api/src/prisma/prisma.service.ts for full rationale.
   */
  private scopedClient(scope: TenantScope) {
    const scopedModels = this.tenantScopedModels;
    return this.$extends(
      Prisma.defineExtension({
        name: 'tenant-scope',
        query: {
          $allModels: {
            async $allOperations({ model, operation, args, query }) {
              return query(
                applyTenantScope(scope, model, operation, args, scopedModels) as typeof args,
              );
            },
          },
        },
      }),
    );
  }

  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    return this.scopedClient({ tenantId }).$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
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
    return this.scopedClient({ bypass: true }).$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return fn(tx as unknown as Prisma.TransactionClient);
    });
  }

  /**
   * Like {@link withTenant}, but ALSO sets `app.current_user` — mirrors
   * apps/api/src/prisma/prisma.service.ts's `withTenantUser` EXACTLY (Phase 1,
   * 1C). Added retroactively (Phase 2 audit, 2026-07-12): this class was never
   * given the Phase 1 method, so `MeriContextResolver.loadUserVoice` — the ONLY
   * place in this app reading a private (`visibility='user'`) memory_items row —
   * had been silently returning zero rows for every GA-chat turn since the 1C
   * RLS policy went live, because plain `withTenant` never sets
   * `app.current_user` and the owner-aware policy requires it. See apps/api's
   * doc comment on its own `withTenantUser` for the general hazard.
   */
  async withTenantUser<T>(
    tenantId: string,
    userId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    return this.scopedClient({ tenantId }).$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_user', ${userId}, true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      },
      opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
    );
  }
}
