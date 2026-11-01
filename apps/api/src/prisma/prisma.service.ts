import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  currentDbLane,
  laneDatabaseUrl,
  readDbLaneSettings,
  type DbLane,
  type DbLanePoolSettings,
  type DbLaneSettings,
} from './db-lane.js';

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

/** Injection token for optional PrismaClient options (tests and fixtures pass them directly). */
export const PRISMA_SERVICE_OPTIONS = Symbol('PRISMA_SERVICE_OPTIONS');

type TransactionOptions = {
  timeoutMs?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
  readOnly?: boolean;
};

/** The pool a transaction helper opens on, resolved from the current lane. */
export interface DbLaneSelection {
  lane: DbLane;
  /** `undefined` means the service's own (request) client. */
  client: PrismaClient | undefined;
  statementTimeoutMs: number | null;
  poolTimeoutSeconds: number | null;
}

/**
 * Owns the dedicated lane clients. Exported for tests; `PrismaService` builds
 * one when a base connection URL is known and lanes are not switched off.
 */
export class DbLanes {
  private readonly clients = new Map<Exclude<DbLane, 'request'>, PrismaClient>();

  constructor(
    readonly settings: DbLaneSettings,
    private readonly baseUrl: string,
    private readonly clientOptions: Prisma.PrismaClientOptions | undefined,
    private readonly factory: (options: Prisma.PrismaClientOptions) => PrismaClient = (options) => new PrismaClient(options),
  ) {}

  pool(lane: Exclude<DbLane, 'request'>): DbLanePoolSettings {
    return this.settings[lane];
  }

  /** The lane's client, created on first use so an unused lane never connects. */
  client(lane: Exclude<DbLane, 'request'>): PrismaClient {
    const existing = this.clients.get(lane);
    if (existing) return existing;
    // `datasourceUrl` and `datasources` are mutually exclusive in Prisma 5;
    // the lane always sets its own datasource URL.
    const { datasourceUrl: _ignored, ...rest } = (this.clientOptions ?? {}) as Prisma.PrismaClientOptions & { datasourceUrl?: string };
    const created = this.factory({
      ...rest,
      datasources: { db: { url: laneDatabaseUrl(this.baseUrl, this.pool(lane)) } },
    });
    this.clients.set(lane, created);
    return created;
  }

  select(lane: DbLane): DbLaneSelection {
    if (lane === 'request' || !this.settings.enabled) {
      return { lane: 'request', client: undefined, statementTimeoutMs: null, poolTimeoutSeconds: null };
    }
    const pool = this.pool(lane);
    return { lane, client: this.client(lane), statementTimeoutMs: pool.statementTimeoutMs, poolTimeoutSeconds: pool.poolTimeoutSeconds };
  }

  async connect(lane: Exclude<DbLane, 'request'>): Promise<void> {
    await this.client(lane).$connect();
  }

  async disconnectAll(): Promise<void> {
    const open = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(open.map((client) => client.$disconnect()));
  }

  describe(): string {
    const { authority, background } = this.settings;
    return `authority(connection_limit=${authority.connectionLimit}, pool_timeout=${authority.poolTimeoutSeconds}s, statement_timeout=${authority.statementTimeoutMs}ms) ` +
      `background(connection_limit=${background.connectionLimit}, pool_timeout=${background.poolTimeoutSeconds}s)`;
  }
}

const REQUEST_LANE: DbLaneSelection = Object.freeze({ lane: 'request', client: undefined, statementTimeoutMs: null, poolTimeoutSeconds: null });

/** The pool for a transaction opened now, from the current async lane. */
function selectLane(lanes: DbLanes | undefined): DbLaneSelection {
  return lanes ? lanes.select(currentDbLane()) : REQUEST_LANE;
}

/**
 * Interactive-transaction options. Unchanged for the request lane (callers'
 * `timeoutMs` / `isolationLevel` pass through; nothing when unspecified).
 * A lane with a statement timeout defaults the transaction timeout to just
 * above it, and waits for a connection no longer than its pool timeout.
 */
export function laneTransactionOptions(selection: DbLaneSelection, opts: TransactionOptions | undefined) {
  const options: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number } = {};
  if (opts?.timeoutMs) options.timeout = opts.timeoutMs;
  else if (selection.statementTimeoutMs !== null) options.timeout = selection.statementTimeoutMs + 1_000;
  if (opts?.isolationLevel) options.isolationLevel = opts.isolationLevel;
  if (selection.poolTimeoutSeconds !== null) options.maxWait = selection.poolTimeoutSeconds * 1_000;
  return Object.keys(options).length ? options : undefined;
}

/** SET LOCAL is bound to the transaction, so the lane's limit never leaks onto another pooled caller. */
async function applyLaneStatementTimeout(tx: Prisma.TransactionClient, selection: DbLaneSelection): Promise<void> {
  if (selection.statementTimeoutMs === null) return;
  await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${selection.statementTimeoutMs}ms`}, true)`;
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
 *
 * Connection pools: the service itself is the ordinary request pool. The
 * transaction helpers additionally honour the current database lane (see
 * `db-lane.ts`): Meri's conversation-authority routes and background mailbox
 * sync open their transactions on their own small pools, with the same
 * tenant-scope extension and GUCs, so heavy request work cannot starve them.
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

  /** Dedicated lane pools; `undefined` when no base URL is known or lanes are off. */
  private readonly lanes: DbLanes | undefined;

  constructor(@Optional() @Inject(PRISMA_SERVICE_OPTIONS) options?: Prisma.PrismaClientOptions) {
    super(options);
    this.lanes = PrismaService.buildLanes(options);
  }

  private static buildLanes(options: Prisma.PrismaClientOptions | undefined): DbLanes | undefined {
    const explicit = options as (Prisma.PrismaClientOptions & { datasourceUrl?: string; datasources?: { db?: { url?: string } } }) | undefined;
    const baseUrl = explicit?.datasources?.db?.url ?? explicit?.datasourceUrl ?? process.env.DATABASE_URL;
    if (!baseUrl) return undefined;
    const settings = readDbLaneSettings();
    if (!settings.enabled) return undefined;
    return new DbLanes(settings, baseUrl, options);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(
      `Prisma connected (tenant-scope enforcement active on ${this.tenantScopedModels.size} models)`,
    );
    if (this.lanes) {
      // The authority lane must be warm before Meri's first control call;
      // the background lane connects on its first scheduler tick.
      await this.lanes.connect('authority');
      this.logger.log(`Prisma database lanes active: ${this.lanes.describe()}`);
    } else {
      this.logger.log('Prisma database lanes inactive: every transaction uses the request pool');
    }
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
   * `base` selects the pool: a lane client, or this service when omitted
   * (request lane; callers pass exactly one argument then, as before).
   */
  private scopedClient(scope: TenantScope, base: PrismaClient = this) {
    const scopedModels = this.tenantScopedModels;
    return base.$extends(
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
    if (this.lanes) await this.lanes.disconnectAll();
  }

  /**
   * Run `fn` with `app.current_tenant` set to the given UUID inside a
   * transaction. The transactional client passed to `fn` MUST be used for
   * any query that should respect the tenant scope.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: { timeoutMs?: number; isolationLevel?: Prisma.TransactionIsolationLevel; readOnly?: boolean },
  ): Promise<T> {
    const selection = selectLane(this.lanes);
    return (selection.client ? this.scopedClient({ tenantId }, selection.client) : this.scopedClient({ tenantId })).$transaction(
      async (tx) => {
        // PostgreSQL requires transaction characteristics before any data query.
        if (opts?.readOnly) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await applyLaneStatementTimeout(tx as unknown as Prisma.TransactionClient, selection);
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
      laneTransactionOptions(selection, opts),
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
    const selection = selectLane(this.lanes);
    return (selection.client ? this.scopedClient({ tenantId }, selection.client) : this.scopedClient({ tenantId })).$transaction(
      async (tx) => {
        await applyLaneStatementTimeout(tx as unknown as Prisma.TransactionClient, selection);
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_user', ${userId}, true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      },
      laneTransactionOptions(selection, opts),
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
    opts?: { timeoutMs?: number; isolationLevel?: Prisma.TransactionIsolationLevel; retries?: number },
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
    opts?: { timeoutMs?: number; isolationLevel?: Prisma.TransactionIsolationLevel; readOnly?: boolean },
  ): Promise<T> {
    const selection = selectLane(this.lanes);
    // bypass:true → the tenant-scope hook does NOT inject a tenant predicate,
    // preserving the intentional cross-tenant reach of system paths.
    return (selection.client ? this.scopedClient({ bypass: true }, selection.client) : this.scopedClient({ bypass: true })).$transaction(
      async (tx) => {
        if (opts?.readOnly) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await applyLaneStatementTimeout(tx as unknown as Prisma.TransactionClient, selection);
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      },
      // Same escape hatch withTenant/withTenantUser already had. Without it a
      // system path was hard-capped at the 5s interactive-transaction default
      // with no way to extend it — which is how a slow-but-legitimate write
      // (MemoryStoreService.upsertSystem, the Client Soul save) failed under
      // pool pressure rather than merely running slowly.
      laneTransactionOptions(selection, opts),
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

/**
 * True when a Postgres statement was cancelled by `statement_timeout`
 * (SQLSTATE 57014) or the request could not get a pooled connection /
 * transaction in time (P2024 / P2028). Callers with a degradable section use
 * this to fail that section open instead of the whole response.
 */
export function isDatabaseBusyError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2024' || err.code === 'P2028') return true;
    if (err.code === 'P2010' && (err.meta as { code?: unknown } | undefined)?.code === '57014') return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /canceling statement due to statement timeout|(?:^|[^0-9A-Za-z])57014\b/.test(message);
}
