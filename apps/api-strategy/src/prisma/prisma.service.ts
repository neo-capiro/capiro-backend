import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
// Import from the CUSTOM generated client (not @prisma/client). This is
// load-bearing: `Prisma.dmmf` below drives the tenant-scoped model set, and it
// must reflect THIS service's schema, not apps/api's default client.
import { Prisma, PrismaClient } from '../../generated/prisma-client/index.js';

/**
 * Tenant isolation for the api-strategy engine.
 *
 * Ported from apps/api's PrismaService. Real isolation is the in-query
 * `where.tenantId` injection performed by the query hook below — NOT Postgres
 * RLS. The runtime `capiro_app` role is a member of the table-owner role and
 * BYPASSES RLS, so the RLS policies in the migration are belt-and-suspenders /
 * a forward-ready DB boundary. Every tenant-scoped read/write MUST go through
 * withTenant / withTenantUser (or withSystem for deliberate cross-tenant system
 * work). The tenant-scope-guard.spec.ts build gate enforces this.
 *
 * The closure approach (scope captured per-call, not AsyncLocalStorage) is
 * deliberate: Prisma runs the extension hook off the caller's async context, so
 * an ALS store set around the call would be invisible inside the hook.
 */

type TenantScope = { tenantId: string; bypass?: false } | { bypass: true };

// Operations that carry a `where` we can constrain. create/createMany are
// intentionally excluded (no where; the caller writes an explicit tenantId).
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
 * Pure decision function (exported for unit tests). Injects
 * `where.tenantId = scope.tenantId` for tenant-scoped models on where-bearing
 * ops, unless the scope is a bypass scope.
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

/** True for transient tx errors worth retrying (deadlock / serialization). */
export function isRetryableTransactionError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return (
    /deadlock detected/i.test(message) ||
    /could not serialize access/i.test(message) ||
    /40P01/.test(message) ||
    /40001/.test(message)
  );
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  // Tenant-scoped model set, derived once from the DMMF: every model that has a
  // field literally named `tenantId`. Auto-covers new models the moment they
  // land in the schema (same source of truth as the tenant-scope-guard spec).
  private readonly tenantScopedModels: ReadonlySet<string> = new Set(
    Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === 'tenantId'))
      .map((m) => m.name),
  );

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(
      `api-strategy Prisma connected; ${this.tenantScopedModels.size} tenant-scoped model(s)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

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

  /** Run `fn` in a transaction scoped to `tenantId` (where.tenantId injected). */
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

  /** Like withTenant, additionally setting the app.current_user GUC. */
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

  /**
   * Deliberate cross-tenant / system work (e.g. seeding the global reference
   * baseline). Sets app.bypass_rls and injects NO tenant predicate. Use
   * sparingly and never on a user request path.
   */
  async withSystem<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.scopedClient({ bypass: true }).$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return fn(tx as unknown as Prisma.TransactionClient);
    });
  }

  /** withTenant with exponential-backoff retry on transient tx failures. */
  async withTenantRetry<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: { timeoutMs?: number; maxAttempts?: number },
  ): Promise<T> {
    const maxAttempts = opts?.maxAttempts ?? 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.withTenant(tenantId, fn, opts);
      } catch (err) {
        lastErr = err;
        if (attempt >= maxAttempts || !isRetryableTransactionError(err)) {
          throw err;
        }
        const backoffMs = 25 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    throw lastErr;
  }
}
