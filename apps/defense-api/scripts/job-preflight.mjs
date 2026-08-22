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
 * Authoritative, post-connection database identity + capability proof.
 *
 * The Phase 9 first cut compared a CONFIGURED env string (`DB_USER`) against the
 * expected capability-role name. That is not a security check: it trusts the
 * caller's own configuration, it is trivially spoofed by editing
 * `DEFENSE_JOB_DB_ROLE`, and it cannot express the real production design, where
 * the connecting principal is a LOGIN role (`capiro_defense_job_login`) that
 * derives its lifecycle privileges by INHERITed MEMBERSHIP in a NOLOGIN
 * capability role (`capiro_defense_job`). Under that design the configured
 * username is CORRECTLY not equal to the capability role, so a string compare
 * either wrongly refuses the real login or, if "fixed" by renaming, proves
 * nothing at all.
 *
 * So authorisation is decided by PostgreSQL, after connecting, from the catalog:
 *
 *   - `current_user` / `session_user`  — who we actually are;
 *   - `pg_has_role(current_user, '<capability>', 'member')` — are we genuinely
 *     authorised through the capability role;
 *   - `pg_has_role(..., 'USAGE')` — is that membership actually INHERITed, i.e.
 *     do the privileges apply without an explicit SET ROLE;
 *   - `rolsuper/rolcreaterole/rolcreatedb/rolreplication/rolbypassrls` — the
 *     connecting login must hold none of these dangerous attributes.
 *
 * `DEFENSE_JOB_DB_ROLE` now only names WHICH capability to require. It cannot
 * grant authorisation: the membership assertion is evaluated in the database, so
 * pointing it at a role the login is not a member of makes the check FAIL, never
 * pass.
 */
export const CAPABILITY_PROOF_SQL = `
  SELECT
    current_user::text                                            AS current_user,
    session_user::text                                            AS session_user,
    current_database()::text                                      AS database,
    pg_has_role(current_user, $1::name, 'member')                  AS is_member,
    pg_has_role(current_user, $1::name, 'usage')                   AS inherits_capability,
    (SELECT rolsuper       FROM pg_roles WHERE rolname = current_user) AS is_superuser,
    (SELECT rolcreaterole  FROM pg_roles WHERE rolname = current_user) AS can_create_role,
    (SELECT rolcreatedb    FROM pg_roles WHERE rolname = current_user) AS can_create_db,
    (SELECT rolreplication FROM pg_roles WHERE rolname = current_user) AS can_replicate,
    (SELECT rolbypassrls   FROM pg_roles WHERE rolname = current_user) AS can_bypass_rls,
    (SELECT rolinherit     FROM pg_roles WHERE rolname = current_user) AS inherit_enabled,
    (SELECT rolcanlogin    FROM pg_roles WHERE rolname = $1::name)     AS capability_can_login
`;

/** Dangerous attributes that must all be false on the connecting login. */
export const FORBIDDEN_ROLE_ATTRIBUTES = Object.freeze([
  ['is_superuser', 'superuser'],
  ['can_create_role', 'createrole'],
  ['can_create_db', 'createdb'],
  ['can_replicate', 'replication'],
  ['can_bypass_rls', 'bypassrls'],
]);

/**
 * Evaluate a capability-proof row. Pure, so it is unit-testable against every
 * production and rejection identity without needing a live database.
 *
 * Returns the proof lines to log. Throws JobPreflightError (77) on refusal.
 */
export function evaluateCapabilityProof({ mode, row, capabilityRole }) {
  if (!row) {
    throw new JobPreflightError(
      `refusing ${mode} commit: database identity proof returned no row`,
      77,
    );
  }

  const truthy = (value) => value === true || value === 't' || value === 'true';

  const lines = [
    `[phase9-identity] current_user=${row.current_user}`,
    `[phase9-identity] session_user=${row.session_user}`,
    `[phase9-identity] database=${row.database}`,
    `[phase9-identity] capabilityRole=${capabilityRole}`,
    `[phase9-identity] pg_has_role(member)=${truthy(row.is_member)}`,
    `[phase9-identity] pg_has_role(usage/inherited)=${truthy(row.inherits_capability)}`,
    `[phase9-identity] login.rolinherit=${truthy(row.inherit_enabled)}`,
    `[phase9-identity] capability.rolcanlogin=${truthy(row.capability_can_login)}`,
  ];
  for (const [field, label] of FORBIDDEN_ROLE_ATTRIBUTES) {
    lines.push(`[phase9-identity] login.${label}=${truthy(row[field])}`);
  }

  // 1. Genuine membership in the capability role, per the database.
  if (!truthy(row.is_member)) {
    throw new JobPreflightError(
      `refusing ${mode} commit: authenticated role "${row.current_user}" is not a member of ` +
        `the "${capabilityRole}" capability role. Membership is verified in PostgreSQL ` +
        `(pg_has_role), so no environment variable can grant it.`,
      77,
    );
  }

  // 2. Membership must be INHERITed, or the privileges do not actually apply.
  if (!truthy(row.inherits_capability)) {
    throw new JobPreflightError(
      `refusing ${mode} commit: "${row.current_user}" is a member of "${capabilityRole}" but ` +
        `does not inherit it (NOINHERIT). The lifecycle privileges would not apply without an ` +
        `explicit SET ROLE; grant the login INHERIT instead.`,
      77,
    );
  }

  // 3. No dangerous role attributes on the connecting login.
  const dangerous = FORBIDDEN_ROLE_ATTRIBUTES.filter(([field]) => truthy(row[field])).map(
    ([, label]) => label,
  );
  if (dangerous.length > 0) {
    throw new JobPreflightError(
      `refusing ${mode} commit: authenticated role "${row.current_user}" holds forbidden ` +
        `attribute(s) [${dangerous.join(', ')}]. The job login must be an unprivileged ` +
        `member of "${capabilityRole}" only.`,
      77,
    );
  }

  // 4. The capability role itself must remain NOLOGIN. If it can log in, the
  //    separation between capability and login has been collapsed.
  if (truthy(row.capability_can_login)) {
    throw new JobPreflightError(
      `refusing ${mode} commit: capability role "${capabilityRole}" is LOGIN-capable. ` +
        `It must remain NOLOGIN; connect as a dedicated login role that is a member of it.`,
      77,
    );
  }

  return Object.freeze(lines);
}

/** Which capability role a commit must be authorised through. */
export function resolveCapabilityRole(env = process.env) {
  const configured = (env.DEFENSE_JOB_DB_ROLE ?? DEFAULT_JOB_DB_ROLE).trim();
  if (configured === '') return DEFAULT_JOB_DB_ROLE;
  // Guard the identifier: it is interpolated as a ::name parameter, but keep it
  // to a plain SQL identifier shape so a hostile value cannot become anything else.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(configured)) {
    throw new JobPreflightError(
      `DEFENSE_JOB_DB_ROLE is not a valid role identifier: "${configured}"`,
      64,
    );
  }
  return configured;
}

/**
 * Assert the live connection is authorised to mutate.
 *
 * Runs the capability proof through the caller's SQL executor, logs the proof,
 * and throws on refusal. There is deliberately NO environment escape hatch: the
 * previous `PHASE9_ALLOW_NON_JOB_ROLE` bypass is gone, because an env var that
 * disables the authorisation check is not a safe production path.
 */
export async function assertLiveJobCapability({ mode, commit, sql, env = process.env }) {
  if (!commit) return null;
  const capabilityRole = resolveCapabilityRole(env);
  let rows;
  try {
    rows = await sql.$queryRawUnsafe(CAPABILITY_PROOF_SQL, capabilityRole);
  } catch (error) {
    throw new JobPreflightError(
      `refusing ${mode} commit: could not verify database identity/capability ` +
        `(${error?.message ?? error})`,
      77,
    );
  }
  const lines = evaluateCapabilityProof({ mode, row: rows?.[0], capabilityRole });
  for (const line of lines) console.log(line);
  console.log(
    `[phase9-identity] CAPABILITY_PROOF_OK role=${rows[0].current_user} via=${capabilityRole}`,
  );
  return rows[0];
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
