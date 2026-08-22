/**
 * Phase 9 — governed one-shot job runtime preflight.
 *
 * Shared by every mutating and non-mutating job mode in `scripts/job.mjs`.
 *
 * The job runtime is a DIFFERENT trust context from the HTTP `serve` image:
 * it may write to the production control plane. So before any mutation the
 * caller must be able to see, in the log, exactly which database identity is
 * about to be written to — host, database, port, role, and whether the run is a
 * dry run or a commit. "It printed COMMITTED" is only trustworthy if the
 * identity it committed against was printed first.
 *
 * Nothing here reaches the network or issues a write. It resolves config,
 * refuses missing credentials, and produces a redacted identity banner.
 */

import process from 'node:process';

/** Authorisation env var per mutating job mode. Fail closed by default. */
export const COMMIT_AUTHORISATION_ENV = Object.freeze({
  'backfill-run': 'PHASE9_BACKFILL_COMMIT_AUTHORIZED',
  'lifecycle-watch': 'PHASE8_SESSION7_COMMIT_AUTHORIZED',
  'schedule-tick': 'PHASE8_SESSION10_TICK_AUTHORIZED',
});

/** Job role expected for a mutating run. Read-only modes may use any role. */
export const DEFAULT_JOB_DB_ROLE = 'capiro_defense_job';

export class JobPreflightError extends Error {
  constructor(message, exitCode = 78) {
    super(message);
    this.name = 'JobPreflightError';
    this.exitCode = exitCode;
  }
}

/**
 * Build a DATABASE_URL from discrete secret-injected parts.
 *
 * Task definitions inject DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD from
 * Secrets Manager rather than baking a URL (a URL in an env var leaks the
 * password into `describe-task-definition` output). The password is
 * percent-encoded because Aurora master/job passwords contain reserved chars.
 */
export function resolveDatabaseIdentity(env = process.env) {
  const explicit = env.DATABASE_URL?.trim();
  if (explicit) {
    let parsed;
    try {
      parsed = new URL(explicit);
    } catch {
      throw new JobPreflightError('DATABASE_URL is set but is not a parseable URL');
    }
    return Object.freeze({
      url: explicit,
      host: parsed.hostname,
      port: parsed.port || '5432',
      database: parsed.pathname.replace(/^\//, ''),
      role: decodeURIComponent(parsed.username || ''),
      source: 'DATABASE_URL',
    });
  }

  const host = env.DB_HOST?.trim();
  const port = env.DB_PORT?.trim() || '5432';
  const database = env.DB_NAME?.trim();
  const role = env.DB_USER?.trim();
  const password = env.DB_PASSWORD;

  const missing = [];
  if (!host) missing.push('DB_HOST');
  if (!database) missing.push('DB_NAME');
  if (!role) missing.push('DB_USER');
  if (password == null || password === '') missing.push('DB_PASSWORD');
  if (missing.length > 0) {
    throw new JobPreflightError(
      `refusing to run: missing production database configuration (${missing.join(', ')}). ` +
        'Provide DATABASE_URL, or DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD via secret injection.',
    );
  }

  const url =
    `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${database}?schema=public&sslmode=require`;

  return Object.freeze({ url, host, port, database, role, source: 'DB_* parts' });
}

/**
 * Print the target environment/database identity BEFORE any mutation.
 * Never prints the password, and never returns the URL.
 */
export function printTargetIdentity({ mode, commit, identity, extra = {} }) {
  const lines = [
    `[phase9-job] mode=${mode}`,
    `[phase9-job] intent=${commit ? 'COMMIT (will write)' : 'DRY-RUN (no writes)'}`,
    `[phase9-job] nodeEnv=${process.env.NODE_ENV ?? '(unset)'}`,
    `[phase9-job] db.host=${identity.host}`,
    `[phase9-job] db.port=${identity.port}`,
    `[phase9-job] db.name=${identity.database}`,
    `[phase9-job] db.role=${identity.role}`,
    `[phase9-job] db.configSource=${identity.source}`,
  ];
  for (const [key, val] of Object.entries(extra)) {
    lines.push(`[phase9-job] ${key}=${val}`);
  }
  for (const line of lines) console.log(line);
}

/**
 * Fail closed: a mutating mode runs only with BOTH `--commit` AND its explicit
 * authorisation env var. A mistyped flag can never write.
 */
export function assertCommitAuthorised({ mode, commit, env = process.env }) {
  if (!commit) return;
  const varName = COMMIT_AUTHORISATION_ENV[mode];
  if (!varName) {
    throw new JobPreflightError(`mode ${mode} does not support --commit`, 64);
  }
  if (env[varName] !== 'true') {
    throw new JobPreflightError(
      `refusing ${mode} database mutation without ${varName}=true`,
      77,
    );
  }
}

/**
 * A mutating run should use the least-privilege job role, not the serve role and
 * not master. Enforced unless explicitly overridden for an authorised recovery.
 */
export function assertJobRole({ mode, commit, identity, env = process.env }) {
  if (!commit) return;
  const expected = (env.DEFENSE_JOB_DB_ROLE ?? DEFAULT_JOB_DB_ROLE).trim();
  if (env.PHASE9_ALLOW_NON_JOB_ROLE === 'true') {
    console.log(
      `[phase9-job] WARNING: role check bypassed via PHASE9_ALLOW_NON_JOB_ROLE ` +
        `(role=${identity.role}, expected=${expected})`,
    );
    return;
  }
  if (identity.role !== expected) {
    throw new JobPreflightError(
      `refusing ${mode} commit: database role is "${identity.role}" but the job runtime ` +
        `requires "${expected}". Set DEFENSE_JOB_DB_ROLE to change the expectation.`,
      77,
    );
  }
}

/** Parse `--fiscal-years 2024,2025` into a validated, sorted, deduped list. */
export function parseFiscalYears(raw) {
  if (raw == null || String(raw).trim() === '') {
    throw new JobPreflightError(
      'missing --fiscal-years. This runtime never infers the fiscal-year set from the ' +
        'current date; pass it explicitly, e.g. --fiscal-years 2024,2025,2026,2027,2028',
      64,
    );
  }
  const parts = String(raw)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new JobPreflightError('--fiscal-years was supplied but contained no values', 64);
  }
  const years = [];
  for (const part of parts) {
    if (!/^\d{4}$/.test(part)) {
      throw new JobPreflightError(`--fiscal-years contains a non-4-digit value: "${part}"`, 64);
    }
    const year = Number(part);
    // Deliberately wider than the backfill horizon but narrow enough that a
    // typo like 20255 or 1024 cannot bootstrap a nonsense cycle.
    if (year < 2000 || year > 2100) {
      throw new JobPreflightError(`--fiscal-years value out of range: ${year}`, 64);
    }
    years.push(year);
  }
  return Object.freeze([...new Set(years)].sort((a, b) => a - b));
}

/** Bounded execution: every mode accepts an explicit cap. */
export function parseBound(raw, fallback, name) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new JobPreflightError(`${name} must be a positive integer`, 64);
  }
  return parsed;
}
