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
 *
 * The promoter role is optional so this task keeps working in environments
 * where the Phase 7 promoter secret has not been provisioned yet. Creating that
 * secret and passing it to this task is Workstream N; migration
 * 20260822010000 creates the role itself with an unusable placeholder password,
 * exactly as migration 20260502020000 did for capiro_app, so until the secret
 * exists the promoter simply cannot authenticate.
 *
 * Identifier and password are quoted via pg-format-style escaping. The
 * password contains only generated characters from the secret's
 * `excludePunctuation` set so the only required escape is single-quote
 * doubling, defensive in case CDK config changes.
 */
import { config as dotenvConfig } from 'dotenv';
import { Client } from 'pg';

dotenvConfig();

function required(name: string): string {
  const v = process.env[name];
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

/** Roles to rotate: the app role always, the promoter role when provisioned. */
function plannedRotations(): RoleRotation[] {
  const rotations: RoleRotation[] = [
    { label: 'app', user: required('APP_USER'), password: required('APP_PASSWORD') },
  ];

  const promoterUser = process.env.PROMOTER_USER;
  const promoterPassword = process.env.PROMOTER_PASSWORD;
  if (promoterUser && promoterPassword) {
    rotations.push({ label: 'pe-promoter', user: promoterUser, password: promoterPassword });
  } else if (promoterUser || promoterPassword) {
    // Half-supplied credentials are a misconfiguration, not an opt-out: failing
    // here is better than silently leaving the promoter unable to log in.
    throw new Error('PROMOTER_USER and PROMOTER_PASSWORD must be supplied together');
  }

  return rotations;
}

async function main() {
  const host = required('DB_HOST');
  const port = parseInt(required('DB_PORT'), 10);
  const database = required('DB_NAME');
  const masterUser = required('MASTER_USER');
  const masterPassword = required('MASTER_PASSWORD');
  const rotations = plannedRotations();

  // eslint-disable-next-line no-console
  console.log(`Rotating ${rotations.map((r) => r.user).join(', ')} (db=${database} host=${host})`);

  const client = new Client({
    host,
    port,
    database,
    user: masterUser,
    password: masterPassword,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    for (const rotation of rotations) {
      const role = escapeSqlIdent(rotation.user);
      const pw = escapeSqlLiteral(rotation.password);

      // The role must already exist: it is created by a migration, never here.
      // Creating roles from this task would give it exactly the privilege the
      // Phase 7 boundary says no runtime task should hold.
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
        rotation.user,
      ]);
      if (exists.rowCount === 0) {
        throw new Error(
          `role ${rotation.user} does not exist — run the migration that creates it first`,
        );
      }

      await client.query(`ALTER ROLE "${role}" PASSWORD '${pw}'`);

      // Verify the role can authenticate by re-connecting under it.
      const verify = new Client({
        host,
        port,
        database,
        user: rotation.user,
        password: rotation.password,
        ssl: { rejectUnauthorized: false },
      });
      await verify.connect();
      const r = await verify.query('SELECT current_user, current_database()');
      // eslint-disable-next-line no-console
      console.log(
        `Verified login as ${r.rows[0].current_user} on ${r.rows[0].current_database} (${rotation.label})`,
      );
      await verify.end();
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
