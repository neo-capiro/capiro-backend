// Phase 2 disposable resource ownership follows the qualified Phase 3 pattern.
export function assertPhase2DisposableInvocation(env = process.env, platform = process.platform) {
  if (env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true' || env.CI_DISPOSABLE_POSTGRES !== '1') {
    throw new Error(
      'Full Phase 2 DB rehearsal requires the GitHub-owned disposable service: GITHUB_ACTIONS=true, CI=true, CI_DISPOSABLE_POSTGRES=1; direct local full rehearsals are unsupported.',
    );
  }
  if (platform !== 'linux')
    throw new Error(
      'Full Phase 2 DB rehearsal supports only the GitHub Linux service; prior split Docker/native Windows invocation is unsupported.',
    );
  if (env.PGHOST !== '127.0.0.1' || env.PGPORT !== '5432' || env.PGUSER !== 'postgres')
    throw new Error('Phase 2 target must be exactly postgres@127.0.0.1:5432.');
  for (const key of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGDATABASE']) {
    if (env[key]) throw new Error(`Phase 2 refuses inherited libpq target override ${key}.`);
  }
  const pinned = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/^PG/i.test(key) &&
        key !== 'DATABASE_URL' &&
        key !== 'DIRECT_URL' &&
        key !== 'SHADOW_DATABASE_URL',
    ),
  );
  return Object.freeze({
    ...pinned,
    PGHOST: '127.0.0.1',
    PGHOSTADDR: '127.0.0.1',
    PGPORT: '5432',
    PGUSER: 'postgres',
    PGDATABASE: 'postgres',
    PGPASSWORD: env.PGPASSWORD || '',
  });
}

export function createPhase2OwnedResources({
  admin,
  psqlInput,
  freshDb,
  upgradeDb,
  probeRole,
  probePassword,
  appendOnlySql,
}) {
  if (
    [freshDb, ...(upgradeDb ? [upgradeDb] : []), ...(probeRole ? [probeRole] : [])].some(
      (name) => typeof name !== 'string' || name.length > 63,
    ) ||
    !/^outreach_v3_p2_(fresh|flow)_[a-zA-Z0-9_]+$/.test(freshDb) ||
    (upgradeDb !== undefined && !/^outreach_v3_p2_upgrade_[a-zA-Z0-9_]+$/.test(upgradeDb)) ||
    (probeRole !== undefined && !/^outreach_v3_p2_probe_[a-zA-Z0-9_]+$/.test(probeRole)) ||
    (probeRole !== undefined && !/^[a-zA-Z0-9_]+$/.test(probePassword))
  )
    throw new Error('Invalid owned Phase 2 resource identity.');
  let verified = false;
  let probeCreated = false;
  const created = new Set();
  const allowed = new Set([freshDb, ...(upgradeDb ? [upgradeDb] : [])]);
  const requireVerified = () => {
    if (!verified) throw new Error('Phase 2 target identity was not verified.');
  };
  return {
    verifyTarget() {
      if (
        admin(
          "SELECT current_database(), current_user, inet_server_port(), current_setting('is_superuser');",
        ).trim() !== 'postgres|postgres|5432|on'
      )
        throw new Error('Unexpected Phase 2 PostgreSQL target identity.');
      const ready =
        admin(`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname='capiro'), EXISTS (
        SELECT 1 FROM pg_roles r WHERE r.rolname='capiro_worker'
        AND NOT (r.rolsuper OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolcanlogin OR r.rolreplication OR r.rolbypassrls)
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE r.oid IN (m.roleid,m.member))
      );`).trim();
      if (ready !== 't|t')
        throw new Error(
          'Owned service capiro database / least-privilege worker role prerequisites are missing; run the guarded canonical CI bootstrap.',
        );
      verified = true;
    },
    createProbe() {
      requireVerified();
      if (!probeRole) throw new Error('No probe role assigned to this Phase 2 invocation.');
      if (probeCreated) throw new Error('Phase 2 probe already created by this invocation.');
      admin(
        `CREATE ROLE "${probeRole}" LOGIN PASSWORD '${probePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
      );
      probeCreated = true;
    },
    createDb(db) {
      requireVerified();
      if (!allowed.has(db) || created.has(db))
        throw new Error('Refusing unowned or repeated Phase 2 database creation.');
      // CREATE collision fails; never delete a database merely because its name matches.
      admin(`CREATE DATABASE "${db}";`);
      created.add(db);
      psqlInput(db, appendOnlySql);
    },
    cleanup() {
      const errors = [];
      if (!verified) return errors;
      for (const db of [...created].reverse()) {
        try {
          admin(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db}' AND pid<>pg_backend_pid();`,
          );
          admin(`DROP DATABASE "${db}";`);
          created.delete(db);
        } catch (error) {
          errors.push(error);
        }
      }
      if (probeCreated) {
        try {
          admin(`DROP ROLE "${probeRole}";`);
          probeCreated = false;
        } catch (error) {
          errors.push(error);
        }
      }
      return errors;
    },
  };
}
