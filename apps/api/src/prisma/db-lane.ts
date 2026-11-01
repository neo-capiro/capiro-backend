import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Database lanes: which Prisma connection pool a `withTenant` / `withSystem`
 * transaction is opened on.
 *
 *  - `request`    the ordinary pool every HTTP handler already uses
 *                 (`connection_limit=10` per task, composed by the entrypoint).
 *  - `authority`  a small dedicated pool for Meri's conversation-authority
 *                 reads (identity / membership / current / conversation
 *                 metadata). Those reads are a handful of indexed point lookups
 *                 and must answer in well under a second even while profile-v1,
 *                 engagement and mailbox-sync work is saturating the database.
 *                 With one shared pool a queue of 4–7 s intelligence
 *                 transactions starved them (observed 2026-10-31 23:55Z and
 *                 2026-11-01 00:17Z: Core calls went unanswered and the chat UI
 *                 showed "Conversation access unavailable" after the model run
 *                 had already completed). Every authority transaction also
 *                 carries a short server-side `statement_timeout`, so a slow
 *                 lookup fails fast and visibly instead of holding the lane.
 *  - `background` a bounded pool for the mailbox auto-sync scheduler and the
 *                 Graph-notification sync queue, so a burst of syncs cannot
 *                 consume request connections.
 *
 * The lane is carried by AsyncLocalStorage from the point where it is chosen
 * (the lane middleware for authority routes, the scheduler tick for background
 * work) to the `PrismaService` transaction helpers, which read it synchronously
 * at call time. Tenant scoping is untouched: every lane client gets the same
 * tenant-scope query extension and the same `SET LOCAL` GUCs.
 */
export type DbLane = 'request' | 'authority' | 'background';

const laneStore = new AsyncLocalStorage<DbLane>();

/** The lane the current async context runs in; `request` when none was set. */
export function currentDbLane(): DbLane {
  return laneStore.getStore() ?? 'request';
}

/** Run `fn` with every transaction helper call inside it routed to `lane`. */
export function runInDbLane<T>(lane: DbLane, fn: () => T): T {
  return laneStore.run(lane, fn);
}

/**
 * Routes Meri's control plane calls for conversation authority. Matched on the
 * mounted request path (global prefix included), so `/api/clio/...` and a
 * bare `/clio/...` both qualify.
 */
const AUTHORITY_PATH = /(?:^|\/)clio\/(?:application-authority|conversations\/management)(?:\/|$)/;

export function isAuthorityRequestPath(path: string): boolean {
  return AUTHORITY_PATH.test(path);
}

export interface DbLanePoolSettings {
  /** Prisma `connection_limit` for the lane's pool. */
  connectionLimit: number;
  /** Prisma `pool_timeout` (seconds) before a connection wait fails with P2024. */
  poolTimeoutSeconds: number;
  /** Server-side `statement_timeout` applied with SET LOCAL in every lane transaction. */
  statementTimeoutMs: number | null;
}

export interface DbLaneSettings {
  enabled: boolean;
  authority: DbLanePoolSettings;
  background: DbLanePoolSettings;
}

export const DB_LANE_ENV = {
  switch: 'CORE_DB_LANES',
  authorityConnectionLimit: 'CORE_AUTHORITY_DB_CONNECTION_LIMIT',
  authorityPoolTimeoutSeconds: 'CORE_AUTHORITY_DB_POOL_TIMEOUT_SECONDS',
  authorityStatementTimeoutMs: 'CORE_AUTHORITY_DB_STATEMENT_TIMEOUT_MS',
  backgroundConnectionLimit: 'CORE_BACKGROUND_DB_CONNECTION_LIMIT',
  backgroundPoolTimeoutSeconds: 'CORE_BACKGROUND_DB_POOL_TIMEOUT_SECONDS',
} as const;

export const DB_LANE_DEFAULTS: DbLaneSettings = Object.freeze({
  enabled: true,
  authority: Object.freeze({ connectionLimit: 3, poolTimeoutSeconds: 2, statementTimeoutMs: 2_000 }),
  background: Object.freeze({ connectionLimit: 4, poolTimeoutSeconds: 10, statementTimeoutMs: null }),
});

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new RangeError(`Invalid database lane setting ${JSON.stringify(value)} (expected an integer in ${min}..${max})`);
  }
  return parsed;
}

/**
 * Lane configuration from the environment. Every value has a default, so a
 * deployment needs no new variables; `CORE_DB_LANES=off` is the rollback
 * switch that puts every transaction back on the single request pool.
 */
export function readDbLaneSettings(env: NodeJS.ProcessEnv = process.env): DbLaneSettings {
  const raw = env[DB_LANE_ENV.switch]?.trim().toLowerCase();
  if (raw !== undefined && raw !== '' && raw !== 'on' && raw !== 'off') {
    throw new RangeError(`Invalid ${DB_LANE_ENV.switch} value (expected "on" or "off")`);
  }
  const d = DB_LANE_DEFAULTS;
  return {
    enabled: raw !== 'off',
    authority: {
      connectionLimit: integer(env[DB_LANE_ENV.authorityConnectionLimit], d.authority.connectionLimit, 1, 50),
      poolTimeoutSeconds: integer(env[DB_LANE_ENV.authorityPoolTimeoutSeconds], d.authority.poolTimeoutSeconds, 1, 60),
      statementTimeoutMs: integer(env[DB_LANE_ENV.authorityStatementTimeoutMs], d.authority.statementTimeoutMs!, 100, 60_000),
    },
    background: {
      connectionLimit: integer(env[DB_LANE_ENV.backgroundConnectionLimit], d.background.connectionLimit, 1, 50),
      poolTimeoutSeconds: integer(env[DB_LANE_ENV.backgroundPoolTimeoutSeconds], d.background.poolTimeoutSeconds, 1, 120),
      statementTimeoutMs: null,
    },
  };
}

/**
 * The lane's connection URL: the base `DATABASE_URL` with only the pool
 * parameters replaced. The URL is edited as text at the query string so the
 * credential bytes in the authority section are passed through untouched (a
 * `URL` round-trip can re-encode them).
 */
export function laneDatabaseUrl(baseUrl: string, pool: Pick<DbLanePoolSettings, 'connectionLimit' | 'poolTimeoutSeconds'>): string {
  const hashIndex = baseUrl.indexOf('#');
  const withoutFragment = hashIndex === -1 ? baseUrl : baseUrl.slice(0, hashIndex);
  const queryIndex = withoutFragment.indexOf('?');
  const head = queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? '' : withoutFragment.slice(queryIndex + 1));
  params.set('connection_limit', String(pool.connectionLimit));
  params.set('pool_timeout', String(pool.poolTimeoutSeconds));
  return `${head}?${params.toString()}`;
}
