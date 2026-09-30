import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  decodeExpectedState,
  encodeExpectedState,
  FOUNDATION_FULLCHAT_FLAG,
  FOUNDATION_FULLCHAT_TENANTS,
  runFoundationFullchat,
  type FoundationDatabase,
  type FoundationState,
  type FoundationTransaction,
} from './set-tenant-flag-foundation.js';

const requireTestModule = createRequire(resolve('package.json'));
const { PGlite } = requireTestModule('@electric-sql/pglite');

async function main(): Promise<void> {
  const db = await PGlite.create();
  const database: FoundationDatabase = {
    $transaction: async <T>(fn: (tx: FoundationTransaction) => Promise<T>): Promise<T> =>
      db.transaction(async (transaction: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }) => {
        await transaction.query('SET LOCAL ROLE foundation_test_app');
        return fn({
          $queryRawUnsafe: async <R>(sql: string, ...values: unknown[]): Promise<R> =>
            (await transaction.query(sql, values)).rows as R,
        });
      }),
  };

  await db.exec(`
    CREATE TABLE tenants (
      id uuid PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      settings_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE ROLE foundation_test_app;
    GRANT USAGE ON SCHEMA public TO foundation_test_app;
    GRANT SELECT, UPDATE ON tenants TO foundation_test_app;
    CREATE FUNCTION current_tenant_id() RETURNS uuid AS $$
      SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
    $$ LANGUAGE sql STABLE;
    CREATE FUNCTION rls_bypass() RETURNS boolean AS $$
      SELECT current_setting('app.bypass_rls', true) = 'on'
    $$ LANGUAGE sql STABLE;
    ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenants_isolation ON tenants
      USING (rls_bypass() OR id = current_tenant_id())
      WITH CHECK (rls_bypass() OR id = current_tenant_id());
  `);
  await db.query(
    `INSERT INTO tenants (id, slug, settings_jsonb) VALUES
      ($1, $2, $3::jsonb),
      ($4, $5, $6::jsonb)`,
    [
      FOUNDATION_FULLCHAT_TENANTS[0].id,
      FOUNDATION_FULLCHAT_TENANTS[0].slug,
      JSON.stringify({ privateSetting: 'preserve-a', clioFeatureFlags: { otherFlag: 'a' } }),
      FOUNDATION_FULLCHAT_TENANTS[1].id,
      FOUNDATION_FULLCHAT_TENANTS[1].slug,
      JSON.stringify({ privateSetting: 'preserve-b', clioFeatureFlags: { otherFlag: 'b', [FOUNDATION_FULLCHAT_FLAG]: false } }),
    ],
  );

  const settings = async (): Promise<Array<{ id: string; settings: Record<string, unknown> }>> =>
    (await db.query(`SELECT id::text AS id, settings_jsonb AS settings FROM tenants ORDER BY id`)).rows as Array<{
      id: string;
      settings: Record<string, unknown>;
    }>;

  const beforePlan = await settings();
  const plan = await runFoundationFullchat(database, 'plan');
  assert.equal(plan.result, 'PLAN_ONLY');
  assert.deepEqual(await settings(), beforePlan, 'plan must be DB-read-only');
  const expected: FoundationState[] = plan.tenants.map((tenant) => ({
    tenantId: tenant.tenantId,
    tenantSlug: tenant.tenantSlug,
    flag: FOUNDATION_FULLCHAT_FLAG,
    state: tenant.before,
  }));
  assert.deepEqual(decodeExpectedState(encodeExpectedState(expected)), expected);
  console.log('PASS plan is read-only and state token is exact');

  const apply = await runFoundationFullchat(database, 'apply', expected);
  assert.equal(apply.result, 'APPLIED_AND_VERIFIED');
  assert.ok(apply.tenants.every((tenant) => tenant.after.present && tenant.after.value === true));
  let applied = await settings();
  for (const row of applied) {
    const flags = row.settings.clioFeatureFlags as Record<string, unknown>;
    assert.equal(flags[FOUNDATION_FULLCHAT_FLAG], true);
    assert.ok(flags.otherFlag === 'a' || flags.otherFlag === 'b');
    assert.ok(row.settings.privateSetting === 'preserve-a' || row.settings.privateSetting === 'preserve-b');
  }
  console.log('PASS apply is atomic and preserves unrelated settings/flags');

  await db.query(
    `UPDATE tenants
       SET settings_jsonb = jsonb_set(settings_jsonb, '{concurrentSetting}', '"kept"'::jsonb, true)
     WHERE id = $1::uuid`,
    [FOUNDATION_FULLCHAT_TENANTS[0].id],
  );
  const rollback = await runFoundationFullchat(database, 'rollback', expected);
  assert.equal(rollback.result, 'ROLLED_BACK_AND_VERIFIED');
  const restored = await settings();
  const byId = new Map(restored.map((row) => [row.id, row.settings]));
  const first = byId.get(FOUNDATION_FULLCHAT_TENANTS[0].id)!;
  const second = byId.get(FOUNDATION_FULLCHAT_TENANTS[1].id)!;
  assert.equal((first.clioFeatureFlags as Record<string, unknown>)[FOUNDATION_FULLCHAT_FLAG], undefined);
  assert.equal((second.clioFeatureFlags as Record<string, unknown>)[FOUNDATION_FULLCHAT_FLAG], false);
  assert.equal(first.concurrentSetting, 'kept');
  assert.equal((first.clioFeatureFlags as Record<string, unknown>).otherFlag, 'a');
  assert.equal((second.clioFeatureFlags as Record<string, unknown>).otherFlag, 'b');
  console.log('PASS rollback restores absent/false exactly and preserves concurrent unrelated mutation');

  const reconciled = await runFoundationFullchat(database, 'rollback', expected);
  assert.equal(reconciled.result, 'ROLLED_BACK_AND_VERIFIED');
  assert.deepEqual(await settings(), restored, 'already-restored rollback reconciliation must not rewrite rows');
  console.log('PASS already-committed rollback acknowledgement is reconciled without a blind repeat');

  const stale = structuredClone(expected);
  stale[1].state = { present: true, value: 'wrong-prior' };
  const beforeRefusal = await settings();
  await assert.rejects(() => runFoundationFullchat(database, 'apply', stale), /expected prior state/);
  assert.deepEqual(await settings(), beforeRefusal, 'compare failure must leave both rows unchanged');
  console.log('PASS expected-prior mismatch fails the two-row transaction without partial mutation');

  const invalidToken = encodeExpectedState(expected).slice(0, -1) + '!';
  assert.throws(() => decodeExpectedState(invalidToken), /canonical base64url/);
  console.log('PASS malformed state token is refused');

  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
