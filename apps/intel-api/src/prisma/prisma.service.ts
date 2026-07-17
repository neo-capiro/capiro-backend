import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '../../generated/prisma-client/index.js';

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
 * Pure decision fn for the tenant-scope query hook (exported for tests).
 * See apps/api/src/prisma/prisma.service.ts for the full rationale: the runtime
 * DB role (capiro_app) is a member of the table-owner role and BYPASSES RLS, so
 * tenant isolation must be enforced in-query. Forces `where.tenantId` for
 * where-bearing ops on tenant-scoped models; passthrough for bypass/global/
 * non-where.
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

  // Models with a tenantId field (auto-derived from the schema) — the set the
  // tenant-scope hook constrains.
  private readonly tenantScopedModels: ReadonlySet<string> = new Set(
    Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === 'tenantId'))
      .map((m) => m.name),
  );

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(
      `Intel API Prisma connected (tenant-scope enforcement active on ${this.tenantScopedModels.size} models)`,
    );
  }

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

  // ── RLS session helpers (Phase 1 port from apps/api) ──────────────────────
  // Ported faithfully so later phases (match engine / change detection) have
  // the tenant-context primitives they depend on. INERT in Phase 1: no Phase-1
  // read path calls them (all Phase-1 cross-DB reads are GLOBAL / NULL-tenant
  // and set no tenant context). The GUC names MUST match the apps/api RLS
  // policies: `app.current_tenant` (scoped) and `app.bypass_rls` (system).

  /**
   * Run `fn` with `app.current_tenant` set to the given UUID inside a
   * transaction. The transactional client passed to `fn` MUST be used for any
   * query that should respect the tenant scope. `SET LOCAL` (via set_config
   * with is_local=true) is discarded when the transaction ends — no leakage.
   */
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
   * Like {@link withTenant} but retries the whole transaction when Postgres
   * aborts it with a deadlock (40P01) or serialization failure (40001) — both
   * transient. `fn` MUST be idempotent (upsert / updateMany / deleteMany+create).
   */
  async withTenantRetry<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: { timeoutMs?: number; retries?: number },
  ): Promise<T> {
    const maxRetries = opts?.retries ?? 3;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.withTenant(tenantId, fn, opts);
      } catch (err) {
        if (attempt >= maxRetries || !isRetryableTransactionError(err)) throw err;
        const backoffMs = Math.min(250, 25 * 2 ** attempt) + Math.floor(Math.random() * 25);
        this.logger.warn(
          `Retryable transaction conflict (attempt ${attempt + 1}/${maxRetries + 1}); retrying in ${backoffMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  /**
   * Run `fn` with the RLS bypass flag enabled. Use only for trusted server
   * paths (cross-tenant detection, admin tooling, migrations). Use sparingly.
   */
  async withSystem<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.scopedClient({ bypass: true }).$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return fn(tx as unknown as Prisma.TransactionClient);
    });
  }
}

/**
 * True when a Postgres error is a transient transaction conflict worth
 * retrying: a deadlock (40P01) or a serialization failure (40001). Prisma maps
 * these to P2034, but a raw-query failure can arrive as a generic error whose
 * message merely carries the SQLSTATE, so we sniff both.
 */
export function isRetryableTransactionError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('deadlock detected') ||
    message.includes('could not serialize access') ||
    /(?:^|[^0-9A-Za-z])40P01\b/.test(message) ||
    /(?:^|[^0-9A-Za-z])40001\b/.test(message)
  );
}
