/**
 * One-shot task that rotates the runtime database roles' passwords to match
 * what is in Secrets Manager. Run after the migration that creates a role, and
 * any time that role's secret rotates.
 *
 * Connects as the Aurora master (env: MASTER_USER / MASTER_PASSWORD) and runs
 * `ALTER ROLE <role> PASSWORD '<from secret>'` for each role whose credentials
 * are present in the environment.
 *
 * Roles handled:
 *   * `capiro_app`            — APP_USER / APP_PASSWORD. Required.
 *   * `capiro_pe_promoter`    — PROMOTER_USER / PROMOTER_PASSWORD. Optional.
 *   * `capiro_analytics_ro`   — ANALYTICS_USER / ANALYTICS_PASSWORD. Optional.
 *
 * --query-readers selects only capiro_analytics_ro and capiro_private_query_ro,
 * requiring both complete credential pairs and DB_SSL_CA_FILE. This mode uses
 * strict certificate/hostname verification and one password-update transaction;
 * APP/PROMOTER inputs are refused. Run only after the reviewed role migrations.
 * A post-commit login failure requires operator reconciliation, not a blind retry.
 *
 * The promoter and analytics roles are optional so this task keeps working in
 * environments where their secrets have not been provisioned yet. Creating
 * the promoter secret and passing it to this task is Workstream N; migration
 * 20260822010000 creates that role itself with an unusable placeholder
 * password, exactly as migration 20260502020000 did for capiro_app, so until
 * the secret exists the promoter simply cannot authenticate. Migration
 * 20280210010000 does the same for capiro_analytics_ro (Meri's
 * query_global_data tool).
 *
 * Identifier and password are quoted via pg-format-style escaping. The
 * password contains only generated characters from the secret's
 * `excludePunctuation` set so the only required escape is single-quote
 * doubling, defensive in case CDK config changes.
 * @cleanup-smoke noArgsExit=2 helpExit=0
 */
import { config as dotenvConfig } from 'dotenv';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const usage = 'Usage: tsx scripts/bootstrap-roles.ts --run [--query-readers]';

function required(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

function escapeSqlIdent(s: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
    throw new Error(`Refusing to use unusual role identifier: ${s}`);
  }
  return s;
}

interface RoleRotation {
  label: string;
  user: string;
  password: string;
}

/** Legacy app/optional roles, or the two explicit ordinary query roles only. */
function plannedRotations(env: NodeJS.ProcessEnv, queryOnly: boolean): RoleRotation[] {
  if (queryOnly) {
    if (
      ['APP_USER', 'APP_PASSWORD', 'PROMOTER_USER', 'PROMOTER_PASSWORD'].some(
        (key) => env[key] !== undefined,
      )
    )
      throw new Error('Query-only bootstrap refuses application and promoter credentials');
    return (
      [
        ['ANALYTICS', 'capiro_analytics_ro'],
        ['PRIVATE_QUERY', 'capiro_private_query_ro'],
      ] as const
    ).map(([prefix, expected]) => {
      const user = required(`${prefix}_USER`, env);
      const password = required(`${prefix}_PASSWORD`, env);
      if (user !== expected || password === '***')
        throw new Error('Exact ordinary query role and unmasked password required');
      return { label: prefix, user, password };
    });
  }
  const rotations: RoleRotation[] = [
    { label: 'app', user: required('APP_USER', env), password: required('APP_PASSWORD', env) },
  ];

  const promoterUser = env.PROMOTER_USER;
  const promoterPassword = env.PROMOTER_PASSWORD;
  if (promoterUser && promoterPassword) {
    rotations.push({ label: 'pe-promoter', user: promoterUser, password: promoterPassword });
  } else if (promoterUser || promoterPassword) {
    // Half-supplied credentials are a misconfiguration, not an opt-out: failing
    // here is better than silently leaving the promoter unable to log in.
    throw new Error('PROMOTER_USER and PROMOTER_PASSWORD must be supplied together');
  }

  const analyticsUser = env.ANALYTICS_USER;
  const analyticsPassword = env.ANALYTICS_PASSWORD;
  if (analyticsUser && analyticsPassword) {
    rotations.push({ label: 'analytics-ro', user: analyticsUser, password: analyticsPassword });
  } else if (analyticsUser || analyticsPassword) {
    throw new Error('ANALYTICS_USER and ANALYTICS_PASSWORD must be supplied together');
  }

  return rotations;
}

export async function bootstrapRoles(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (
    (argv.length === 1 && argv[0] === '--help') ||
    (argv.length === 2 && argv[0] === '--run' && argv[1] === '--help')
  ) {
    console.log(usage);
    return 0;
  }
  const queryOnly = argv.length === 2 && argv[0] === '--run' && argv[1] === '--query-readers';
  if (!queryOnly && !(argv.length === 1 && argv[0] === '--run')) {
    console.error(usage);
    return 2;
  }
  if (!queryOnly) dotenvConfig();
  const host = required('DB_HOST', env);
  const port = queryOnly
    ? Number(required('DB_PORT', env))
    : parseInt(required('DB_PORT', env), 10);
  const database = required('DB_NAME', env);
  const masterUser = required('MASTER_USER', env);
  const masterPassword = required('MASTER_PASSWORD', env);
  const rotations = plannedRotations(env, queryOnly);
  if (
    queryOnly &&
    (!Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
  )
    throw new Error('Query bootstrap requires a valid port and strict TLS');
  const ssl = queryOnly
    ? {
        rejectUnauthorized: true,
        ca: readFileSync(required('DB_SSL_CA_FILE', env), 'utf8'),
        servername: host,
      }
    : { rejectUnauthorized: false };

  // eslint-disable-next-line no-console
  console.log(`Rotating ${rotations.map((r) => r.user).join(', ')} (db=${database} host=${host})`);

  const client = new Client({
    host,
    port,
    database,
    user: masterUser,
    password: masterPassword,
    ssl,
    ...(queryOnly
      ? { connectionTimeoutMillis: 5000, statement_timeout: 8000, query_timeout: 10000 }
      : {}),
  });
  async function verifyRotation(rotation: RoleRotation) {
    // Verify the role can authenticate by re-connecting under it.
    const verify = new Client({
      host,
      port,
      database,
      user: rotation.user,
      password: rotation.password,
      ssl,
      ...(queryOnly
        ? { connectionTimeoutMillis: 5000, statement_timeout: 8000, query_timeout: 10000 }
        : {}),
    });
    try {
      await verify.connect();
      const r = await verify.query('SELECT current_user, current_database()');
      if (
        queryOnly &&
        (r.rows.length !== 1 ||
          r.rows[0].current_user !== rotation.user ||
          r.rows[0].current_database !== database)
      )
        throw new Error('Query role login verification failed');
      // eslint-disable-next-line no-console
      console.log(
        `Verified login as ${r.rows[0].current_user} on ${r.rows[0].current_database} (${rotation.label})`,
      );
    } finally {
      await verify.end();
    }
  }
  let transaction = false;
  try {
    await client.connect();
    if (queryOnly) {
      // Inspect both fixed roles before either password changes. Migration owns roles/grants.
      const checked = await client.query(
        `SELECT rolname FROM pg_catalog.pg_roles
        WHERE rolname = ANY($1::text[]) AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls
          AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = pg_roles.oid)`,
        [rotations.map((rotation) => rotation.user)],
      );
      if (
        checked.rows.length !== 2 ||
        rotations.some((rotation) => !checked.rows.some((row) => row.rolname === rotation.user))
      )
        throw new Error('Both ordinary query roles must already exist');
      await client.query('BEGIN');
      transaction = true;
      await client.query("SET LOCAL statement_timeout = '8000ms'");
      await client.query("SET LOCAL lock_timeout = '1000ms'");
    }
    for (const rotation of rotations) {
      const role = escapeSqlIdent(rotation.user);
      const pw = escapeSqlLiteral(rotation.password);

      // The role must already exist: it is created by a migration, never here.
      // Creating roles from this task would give it exactly the privilege the
      // Phase 7 boundary says no runtime task should hold.
      const exists = queryOnly
        ? { rowCount: 1 }
        : await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [rotation.user]);
      if (exists.rowCount === 0) {
        throw new Error(
          `role ${rotation.user} does not exist — run the migration that creates it first`,
        );
      }

      await client.query(`ALTER ROLE "${role}" PASSWORD '${pw}'`);
      if (!queryOnly) await verifyRotation(rotation);
    }
    if (queryOnly) {
      await client.query('COMMIT');
      transaction = false;
    }

    if (queryOnly) for (const rotation of rotations) await verifyRotation(rotation);
    return 0;
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    // Driver errors can contain password-bearing ALTER text. Never emit them for this mode.
    if (queryOnly)
      throw new Error('Query role bootstrap failed; inspect restricted operator evidence');
    throw error;
  } finally {
    try {
      await client.end();
    } catch (error) {
      if (queryOnly) throw new Error('Query role bootstrap connection cleanup failed');
      throw error;
    }
  }
}

if (require.main === module)
  bootstrapRoles(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
