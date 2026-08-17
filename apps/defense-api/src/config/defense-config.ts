export type DefenseCutoverMode = 'dark' | 'strict';

export interface DefenseRuntimeConfig {
  readonly port: number;
  readonly bodyLimit: string;
  readonly cutoverMode: DefenseCutoverMode;
  readonly expectedDatabaseRole: string;
  readonly databasePoolMax: number;
  readonly statementTimeoutMs: number;
  readonly internalAuthMaxSkewSeconds: number;
  readonly internalAuthReplayTtlSeconds: number;
  readonly internalServiceAllowlist: readonly string[];
  readonly snapshotDomain: string;
  readonly snapshotEnvironment: string;
}

const DEFENSE_BUDGET_DOMAIN = 'defense_budget';

/**
 * Same convention as PeSnapshotGateService.environment() in apps/api
 * (src/program-element/snapshot/pe-snapshot-gate.service.ts): an explicit
 * override first, falling back to NODE_ENV. /readyz must resolve the active
 * snapshot for the same (domain, environment) the canonical read path would,
 * or a pointer that is genuinely active in production would read as absent.
 */
function resolveSnapshotEnvironment(env: NodeJS.ProcessEnv): string {
  const explicit = env.PE_SNAPSHOT_ENVIRONMENT?.trim();
  return explicit && explicit.length > 0 ? explicit : (env.NODE_ENV?.trim() || 'development');
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value == null || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadDefenseConfig(env: NodeJS.ProcessEnv = process.env): DefenseRuntimeConfig {
  const mode = (env.DEFENSE_CUTOVER_MODE ?? 'dark').trim();
  if (mode !== 'dark' && mode !== 'strict') {
    throw new Error('DEFENSE_CUTOVER_MODE must be dark or strict');
  }

  return {
    port: positiveInt(env.PORT, 4400, 'PORT'),
    bodyLimit: (env.DEFENSE_HTTP_BODY_LIMIT ?? '1mb').trim(),
    cutoverMode: mode,
    expectedDatabaseRole: (env.DEFENSE_SERVE_DB_ROLE ?? 'capiro_defense_serve').trim(),
    databasePoolMax: positiveInt(env.DEFENSE_DB_POOL_MAX, 12, 'DEFENSE_DB_POOL_MAX'),
    statementTimeoutMs: positiveInt(
      env.DEFENSE_DB_STATEMENT_TIMEOUT_MS,
      15_000,
      'DEFENSE_DB_STATEMENT_TIMEOUT_MS',
    ),
    internalAuthMaxSkewSeconds: positiveInt(
      env.DEFENSE_INTERNAL_AUTH_MAX_SKEW_SECONDS,
      60,
      'DEFENSE_INTERNAL_AUTH_MAX_SKEW_SECONDS',
    ),
    internalAuthReplayTtlSeconds: positiveInt(
      env.DEFENSE_INTERNAL_AUTH_REPLAY_TTL_SECONDS,
      120,
      'DEFENSE_INTERNAL_AUTH_REPLAY_TTL_SECONDS',
    ),
    internalServiceAllowlist: csv(env.DEFENSE_INTERNAL_SERVICE_ALLOWLIST),
    snapshotDomain: DEFENSE_BUDGET_DOMAIN,
    snapshotEnvironment: resolveSnapshotEnvironment(env),
  };
}
