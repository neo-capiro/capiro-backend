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
 * Onboard API Prisma client.
 *
 * Owns onboard_* tables (no RLS; scoped in application code) AND is the single
 * writer of the billing state on apps/api-owned tables. Of those external
 * tables, `tenants` and `tenant_memberships` carry FORCE ROW LEVEL SECURITY
 * (fail-closed): every read/write of them MUST run inside {@link withTenant}
 * (tenant-scoped request paths) or {@link withSystem} (webhooks/crons with no
 * tenant context — e.g. Stripe subscription sync resolving a tenant by
 * stripe_customer_id). `users`, `stripe_events` and `tenant_usage_meters` are
 * not RLS-protected.
 *
 * The GUC names MUST match the apps/api RLS policies: `app.current_tenant`
 * (scoped) and `app.bypass_rls` (system). SET LOCAL via set_config(..., true)
 * is transaction-local — no leakage across pool connections.
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
      `Onboard API Prisma connected (tenant-scope enforcement active on ${this.tenantScopedModels.size} models)`,
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

  /**
   * Run `fn` with `app.current_tenant` set to the given UUID inside a
   * transaction. The transactional client passed to `fn` MUST be used for any
   * query that should respect the tenant scope.
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
   * paths (Stripe webhooks, lifecycle crons, provisioning). Use sparingly.
   */
  async withSystem<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    return this.scopedClient({ bypass: true }).$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      },
      opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
    );
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
