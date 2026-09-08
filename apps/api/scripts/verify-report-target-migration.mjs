/**
 * Rehearse the report-target annual migration in a fresh, disposable PostgreSQL
 * WASM database. This script never reads DATABASE_URL or connects to an app DB.
 *
 * Optional runtime: @electric-sql/pglite. Install it in a disposable directory,
 * or use an existing package installation. No repository dependency is needed.
 *
 * From the repository root, with the package on Node's resolution path:
 *   node apps/api/scripts/verify-report-target-migration.mjs
 * Or with an external runtime:
 *   PGLITE_MODULE_PATH=/absolute/path/to/pglite/dist/index.js node apps/api/scripts/verify-report-target-migration.mjs
 *
 * This runs the real migration and triggers against a minimal synthetic base
 * schema with tenant/RLS fixtures. It is not a full production migration replay.
 * PGlite has one backend; concurrent-session lock/deadlock behavior is not tested.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function main() {
  const { PGlite } = await import(process.env.PGLITE_MODULE_PATH ?? '@electric-sql/pglite');
  const db = new PGlite();
  try {
    const tenantA = '00000000-0000-4000-8000-000000000001';
    const tenantB = '00000000-0000-4000-8000-000000000002';
    const targetA = '10000000-0000-4000-8000-000000000001';
    const targetB = '10000000-0000-4000-8000-000000000002';
    const unassigned = '10000000-0000-4000-8000-000000000003';
    const oldWriterTarget = '10000000-0000-4000-8000-000000000004';
    const checks = [];
    const check = (name, fn) => {
      fn();
      checks.push(name);
    };
    await db.exec(`
      CREATE TABLE tenants (id uuid PRIMARY KEY);
      CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
      CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT coalesce(nullif(current_setting('app.rls_bypass', true), '')::boolean, false) $$;
      CREATE TABLE engagement_report_target_offices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
        client_id uuid, scope_key text NOT NULL, office_key text NOT NULL,
        member_principal text NOT NULL, prep_status text NOT NULL DEFAULT 'auto',
        outreach_status text NOT NULL DEFAULT 'auto', submission_status text NOT NULL DEFAULT 'auto',
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT engagement_report_targets_identity_key UNIQUE (tenant_id, scope_key, office_key)
      );
      INSERT INTO tenants VALUES ('${tenantA}'), ('${tenantB}');
      INSERT INTO engagement_report_target_offices
        (id, tenant_id, client_id, scope_key, office_key, member_principal, prep_status, outreach_status, created_at)
      VALUES ('${targetA}', '${tenantA}', '${tenantA}', '${tenantA}', 'directory:member-1', 'A', 'complete', 'in_progress', '2024-06-01'),
             ('${targetB}', '${tenantB}', '${tenantB}', '${tenantB}', 'directory:member-2', 'B', 'complete', 'auto', '2025-06-01'),
             ('${unassigned}', '${tenantA}', null, 'all', 'manual:legacy', 'Unassigned', 'auto', 'auto', '2025-01-01');
    `);
    await db.exec(
      await readFile(
        new URL(
          '../prisma/migrations/20260908200000_report_target_annual_overrides/migration.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    checks.push('migration SQL executes against PostgreSQL WASM');
    const [{ year }] = (
      await db.query(
        "SELECT EXTRACT(year FROM CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::integer AS year",
      )
    ).rows;
    const row = async (sql, params = []) => (await db.query(sql, params)).rows[0];
    let saved = await row('SELECT * FROM engagement_report_target_offices WHERE id = $1', [
      targetA,
    ]);
    check('first reporting year backfilled from creation date', () =>
      assert.equal(saved.first_report_year, 2024),
    );
    saved = await row('SELECT * FROM engagement_report_target_offices WHERE id = $1', [unassigned]);
    check('legacy unassigned client and scope remain unchanged', () => {
      assert.equal(saved.client_id, null);
      assert.equal(saved.scope_key, 'all');
    });
    saved = await row('SELECT * FROM engagement_report_target_overrides WHERE target_id = $1', [
      targetA,
    ]);
    check('legacy statuses retained only in the deployment current year', () => {
      assert.equal(saved.report_year, year);
      assert.equal(saved.prep_status, 'complete');
      assert.equal(saved.outreach_status, 'in_progress');
    });

    await db.query(
      `INSERT INTO engagement_report_target_offices
      (id, tenant_id, client_id, scope_key, office_key, member_principal, prep_status)
      VALUES ($1, $2::uuid, $2::uuid, $2::text, 'manual:old-writer', 'Old writer', 'in_progress')
      ON CONFLICT (tenant_id, scope_key, office_key) DO UPDATE SET prep_status = EXCLUDED.prep_status`,
      [oldWriterTarget, tenantA],
    );
    saved = await row('SELECT * FROM engagement_report_target_offices WHERE id = $1', [
      oldWriterTarget,
    ]);
    check('old insert and ON CONFLICT identity survive without new columns supplied', () =>
      assert.equal(saved.first_report_year, year),
    );
    saved = await row('SELECT * FROM engagement_report_target_overrides WHERE target_id = $1', [
      oldWriterTarget,
    ]);
    check('old insert mirrors the current annual status without recursion', () =>
      assert.equal(saved.prep_status, 'in_progress'),
    );

    await db.query(
      `UPDATE engagement_report_target_overrides SET submission_status = 'complete'
      WHERE target_id = $1 AND report_year = $2`,
      [targetA, year],
    );
    saved = await row('SELECT * FROM engagement_report_target_offices WHERE id = $1', [targetA]);
    check('current annual writes remain visible to old readers', () =>
      assert.equal(saved.submission_status, 'complete'),
    );

    await db.query(
      `INSERT INTO engagement_report_target_overrides
      (tenant_id, target_id, report_year, prep_status, outreach_status)
      VALUES ($1, $2, $3, 'not_started', 'complete')`,
      [tenantA, targetA, year - 1],
    );
    saved = await row('SELECT * FROM engagement_report_target_offices WHERE id = $1', [targetA]);
    check('historical annual writes do not change legacy current-year statuses', () => {
      assert.equal(saved.prep_status, 'complete');
      assert.equal(saved.outreach_status, 'in_progress');
    });

    await db.query(
      `UPDATE engagement_report_target_overrides SET prep_status = 'auto'
      WHERE target_id = $1 AND report_year = $2`,
      [targetA, year - 1],
    );
    saved = await row(
      'SELECT * FROM engagement_report_target_overrides WHERE target_id = $1 AND report_year = $2',
      [targetA, year - 1],
    );
    check('restoring a historical field preserves its sibling statuses', () => {
      assert.equal(saved.prep_status, 'auto');
      assert.equal(saved.outreach_status, 'complete');
    });

    await db.query(
      `UPDATE engagement_report_target_offices SET prep_status = 'not_started' WHERE id = $1`,
      [targetA],
    );
    saved = await row(
      'SELECT * FROM engagement_report_target_overrides WHERE target_id = $1 AND report_year = $2',
      [targetA, year],
    );
    check('old status update mirrors only its current-year row', () => {
      assert.equal(saved.prep_status, 'not_started');
      assert.equal(saved.outreach_status, 'in_progress');
      assert.equal(saved.submission_status, 'complete');
    });
    saved = await row(
      'SELECT * FROM engagement_report_target_overrides WHERE target_id = $1 AND report_year = $2',
      [targetA, year - 1],
    );
    check('old current-year writer leaves historical overrides untouched', () =>
      assert.equal(saved.prep_status, 'auto'),
    );

    await db.query(
      `UPDATE engagement_report_target_overrides SET prep_status = 'auto'
      WHERE target_id = $1 AND report_year = $2`,
      [targetA, year],
    );
    saved = await row('SELECT * FROM engagement_report_target_offices WHERE id = $1', [targetA]);
    check('restoring current prep preserves current outreach and submission', () => {
      assert.equal(saved.prep_status, 'auto');
      assert.equal(saved.outreach_status, 'in_progress');
      assert.equal(saved.submission_status, 'complete');
    });

    // PGlite's PostgreSQL clock reads Date.now through its WASM host. Advancing it
    // exercises the unmodified trigger expressions at the actual UTC boundary.
    const realNow = Date.now;
    let rollover;
    try {
      Date.now = () => Date.UTC(year + 1, 0, 1, 0, 0, 1);
      const nextClock = await row(
        "SELECT EXTRACT(year FROM CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::integer AS year",
      );
      assert.equal(nextClock.year, year + 1);
      await db.query(
        "UPDATE engagement_report_target_offices SET prep_status = 'complete' WHERE id = $1",
        [targetA],
      );
      const nextYear = await row(
        'SELECT * FROM engagement_report_target_overrides WHERE target_id = $1 AND report_year = $2',
        [targetA, year + 1],
      );
      rollover = {
        reportYear: nextYear.report_year,
        actual: {
          prep: nextYear.prep_status,
          outreach: nextYear.outreach_status,
          submission: nextYear.submission_status,
        },
        expected: { prep: 'complete', outreach: 'auto', submission: 'auto' },
      };
      check('UTC rollover does not inherit untouched last-year statuses', () =>
        assert.deepEqual(rollover.actual, rollover.expected),
      );
      const legacyNext = await row('SELECT * FROM engagement_report_target_offices WHERE id = $1', [
        targetA,
      ]);
      check('old readers receive the normalized new-year status row', () => {
        assert.equal(legacyNext.prep_status, 'complete');
        assert.equal(legacyNext.outreach_status, 'auto');
        assert.equal(legacyNext.submission_status, 'auto');
      });

      Date.now = () => Date.UTC(year + 2, 0, 1, 0, 0, 1);
      await db.query(
        "UPDATE engagement_report_target_offices SET prep_status = 'complete', outreach_status = 'in_progress' WHERE id = $1",
        [targetA],
      );
      const nextAgain = await row(
        'SELECT * FROM engagement_report_target_overrides WHERE target_id = $1 AND report_year = $2',
        [targetA, year + 2],
      );
      check('rollover preserves explicitly supplied unchanged and multi-column values', () => {
        assert.equal(nextAgain.prep_status, 'complete');
        assert.equal(nextAgain.outreach_status, 'in_progress');
        assert.equal(nextAgain.submission_status, 'auto');
      });

      Date.now = () => Date.UTC(year + 3, 0, 1, 0, 0, 1);
      await db.query(
        `INSERT INTO engagement_report_target_overrides (tenant_id, target_id, report_year, prep_status)
        VALUES ($1, $2, $3, 'not_started')`,
        [tenantA, targetA, year + 3],
      );
      await db.query(
        "UPDATE engagement_report_target_offices SET submission_status = 'complete' WHERE id = $1",
        [targetA],
      );
      const mixed = await row(
        'SELECT * FROM engagement_report_target_overrides WHERE target_id = $1 AND report_year = $2',
        [targetA, year + 3],
      );
      check('old and new writers preserve each other’s current-year fields', () => {
        assert.equal(mixed.prep_status, 'not_started');
        assert.equal(mixed.outreach_status, 'auto');
        assert.equal(mixed.submission_status, 'complete');
      });
    } finally {
      Date.now = realNow;
    }

    await db.exec(
      'CREATE ROLE rehearsal_app NOLOGIN; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rehearsal_app;',
    );
    await db.query("SELECT set_config('app.tenant_id', $1, false)", [tenantA]);
    await db.exec('SET ROLE rehearsal_app');
    const visible = (await db.query('SELECT tenant_id FROM engagement_report_target_overrides'))
      .rows;
    check('annual RLS excludes another tenant for a non-owner application role', () => {
      assert.ok(visible.length > 0);
      assert.ok(visible.every((item) => item.tenant_id === tenantA));
    });
    await assert.rejects(
      db.query(
        `INSERT INTO engagement_report_target_overrides
      (tenant_id, target_id, report_year) VALUES ($1, $2, $3)`,
        [tenantB, targetB, year - 2],
      ),
      /row-level security/,
    );
    checks.push('annual RLS rejects another tenant insert');
    const crossTenant = await db
      .query(
        `INSERT INTO engagement_report_target_overrides
      (tenant_id, target_id, report_year) VALUES ($1, $2, $3) RETURNING id`,
        [tenantA, targetB, year - 3],
      )
      .then(
        () => ({ accepted: true }),
        (error) => ({ accepted: false, error: error.message }),
      );
    check(
      'composite tenant/target foreign key rejects cross-tenant reference despite matching annual RLS',
      () => assert.equal(crossTenant.accepted, false),
    );
    await db.exec('RESET ROLE');
    console.log(
      JSON.stringify(
        {
          passed: checks.length,
          checks,
          yearRollover: rollover,
          crossTenantTargetReference: crossTenant,
          limitation: 'PGlite runs one backend; no multi-session lock/deadlock claims.',
        },
        null,
        2,
      ),
    );
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(`Report-target migration rehearsal failed: ${error.message}`);
  process.exitCode = 1;
});
