import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * The tenant scope baked into a per-call query-extended client so its query
 * hook can inject the tenant predicate. `bypass` marks a `withSystem`
 * (cross-tenant) scope. (A closure — not AsyncLocalStorage — because Prisma
 * executes the extension hook off the caller's async context, so an ALS store
 * set around the call is not visible inside the hook.)
 */
type TenantScope = { tenantId: string; bypass?: false } | { bypass: true };

/**
 * Model operations that accept a `where` we can constrain to the current
 * tenant. create / createMany are intentionally excluded — their rows are
 * written with an explicit tenantId by the caller, and they carry no `where`.
 */
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
 * Pure decision function for the tenant-scope query hook (exported for tests).
 * Returns the args to run: unchanged for bypass scopes, non-tenant-scoped
 * models, or non-where operations; otherwise a shallow clone with
 * `where.tenantId` forced to the scope's tenant. A sibling `tenantId` ANDs with
 * any existing where and, on unique-where ops, applies as an extended-where
 * filter (GA since Prisma 5).
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
 * RLS-aware Prisma client.
 *
 * ⚠️ Direct use of `this.prisma.<tenantModel>.findMany()` (without a tenant
 * scope) is NOT fail-closed and MUST be avoided. The runtime DB role
 * (capiro_app) is a member of the table-owner role and BYPASSES Postgres RLS,
 * so a bare query on a tenant-scoped model returns EVERY tenant's rows
 * (cross-tenant leak — the 2026-07-16 incident). Tenant isolation is enforced
 * ONLY by routing through the scoped helpers below, which inject
 * `where.tenantId` in-query. The `tenant-scope-guard.spec.ts` test fails the
 * build on any new bare tenant-scoped access. Bare access to GLOBAL (no
 * tenantId) reference tables is fine.
 *
 * Per-request tenant-scoped queries go through `withTenant(tenantId, fn)`.
 * That opens a transaction, sets the GUC with `SET LOCAL`, and hands the
 * caller a transactional client. When the transaction commits, the GUC is
 * automatically discarded, no leakage between requests.
 *
 * `withSystem(fn)` is the same pattern but with the bypass flag set, used
 * for cross-tenant admin work and webhook ingestion. Use sparingly and
 * always log via the audit_logs table.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  // Every model that has a `tenantId` field, derived from the schema at
  // construction — the set the tenant-scope hook constrains. Auto-maintained:
  // a new tenant-scoped model is covered the moment it lands in the schema.
  private readonly tenantScopedModels: ReadonlySet<string> = new Set(
    Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === 'tenantId'))
      .map((m) => m.name),
  );

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(
      `Prisma connected (tenant-scope enforcement active on ${this.tenantScopedModels.size} models)`,
    );
  }

  /**
   * A query-extended client with the given tenant scope baked in. IMPORTANT:
   * the runtime DB role (capiro_app) is a member of the table-owner role and
   * BYPASSES Postgres row-level security, so the RLS policies never fire for
   * the app connection. Tenant isolation is therefore enforced HERE, in-query:
   * for any where-bearing operation on a tenant-scoped model, we force
   * `where.tenantId = <scope tenant>`. A `bypass` scope (withSystem) injects
   * nothing, preserving intentional cross-tenant reach. Built per call — a
   * Prisma client extension is a lightweight proxy over the same connection
   * pool (no new connection), and baking the scope in a closure sidesteps the
   * ALS-context-loss that makes an AsyncLocalStorage approach silently no-op.
   */
  private scopedClient(scope: TenantScope) {
    const scopedModels = this.tenantScopedModels;
    return this.$extends(
      Prisma.defineExtension({
        name: 'tenant-scope',
        query: {
          $allModels: {
            async $allOperations({ model, operation, args, query }) {
              // Force the tenant predicate for where-bearing ops on tenant-
              // scoped models (bypass/global/non-where pass through). On the
              // unique-where ops (findUnique/update/delete/upsert) the injected
              // tenantId applies as an extended-where filter (GA since Prisma 5)
              // so a cross-tenant id resolves to "not found" rather than
              // leaking or being mutated.
              return query(
                applyTenantScope(scope, model, operation, args, scopedModels) as typeof args,
              );
            },
          },
        },
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run `fn` with `app.current_tenant` set to the given UUID inside a
   * transaction. The transactional client passed to `fn` MUST be used for
   * any query that should respect the tenant scope.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    return this.scopedClient({ tenantId }).$transaction(
      async (tx) => {
        // SET LOCAL is bound to the transaction. set_config(..., true) returns
        // the value, which we discard. Parameter binding via $executeRaw is
        // safe against injection. (The GUC is now belt-and-suspenders: the
        // real isolation is the tenant-scope query hook, since capiro_app
        // bypasses the RLS that reads this GUC.)
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      },
      // Prisma's interactive-transaction default is 5000 ms. Most tenant
      // queries finish in <100 ms, but a few SQL graph helpers (e.g.
      // kg_walk in intelligence.service.getKnowledgeGraph) can take
      // several seconds on warm Aurora and were producing
      //   "Transaction already closed: ... however 8061 ms passed since
      //    the start of the transaction"
      // every time the intel tab loaded. Callers can pass a higher
      // timeoutMs for known-slow paths.
      opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
    );
  }

  /**
   * Like {@link withTenant}, but ALSO sets `app.current_user` in the same
   * transaction (Phase 1, 1C). Required for any query against a table whose
   * RLS policy references `current_user_id()` — today that's memory_items
   * and the memory_item-sourced rows of context_embeddings. Every other
   * table's RLS is unaffected by this GUC (their policies don't reference
   * it), so this is purely additive: existing `withTenant` callers on other
   * tables need no change. A caller that reads/writes memory_items via plain
   * `withTenant` instead of this method will silently see zero private-item
   * rows (visibility='tenant' rows are unaffected) — see the 1C migration's
   * header comment for the caller-conversion sweep this depends on.
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

  /**
   * Like {@link withTenant} but retries the whole transaction when Postgres
   * aborts it with a deadlock (SQLSTATE 40P01) or serialization failure
   * (40001) — both transient. Concurrent writers that touch the same rows are
   * expected to lose this race occasionally; the loser is safe to replay as
   * long as `fn` is idempotent (upsert / updateMany / deleteMany+create).
   *
   * Used by the Microsoft Graph sync, where a burst of webhook notifications
   * for a freshly connected mailbox runs several syncs at once and they all
   * upsert the same brand-new engagement_contacts rows.
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
        // Exponential backoff with jitter so the two deadlock victims don't
        // line up and collide again on the retry.
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
   * paths (cross-tenant admin tooling, webhook ingestion, migrations).
   */
  async withSystem<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    // bypass:true → the tenant-scope hook does NOT inject a tenant predicate,
    // preserving the intentional cross-tenant reach of system paths.
    return this.scopedClient({ bypass: true }).$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      },
      // Same escape hatch withTenant/withTenantUser already had. Without it a
      // system path was hard-capped at the 5s interactive-transaction default
      // with no way to extend it — which is how a slow-but-legitimate write
      // (MemoryStoreService.upsertSystem, the Client Soul save) failed under
      // pool pressure rather than merely running slowly.
      opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
    );
  }
}

/**
 * True when a Postgres error is a transient transaction conflict worth
 * retrying: a deadlock (40P01) or a serialization failure (40001). Prisma
 * maps these to P2034, but when the failure surfaces from a raw query it can
 * arrive as a generic error whose message carries the SQLSTATE, so we sniff
 * both.
 */
export function isRetryableTransactionError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
    return true;
  }
  // A deadlock raised mid interactive-transaction frequently surfaces NOT as a
  // tidy P2034 but as a generic error whose message carries the raw SQLSTATE
  // (the form seen in production), so we also sniff the message. Match the
  // phrases (already specific) and the bare SQLSTATEs only with a leading
  // boundary, so an incidental "40001" inside row data / external ids in some
  // other error can't trigger a spurious retry.
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('deadlock detected') ||
    message.includes('could not serialize access') ||
    /(?:^|[^0-9A-Za-z])40P01\b/.test(message) ||
    /(?:^|[^0-9A-Za-z])40001\b/.test(message)
  );
}
