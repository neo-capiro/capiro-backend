import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';

/** Called only after fixture.ts verifies PG16, loopback, empty DB and minimal role. */
export async function installObjectiveSchema(owner: PoolClient, schema: string) {
  if (schema !== 'a2_associations') throw Error('Unexpected Objective fixture schema.');
  await owner.query(readFileSync(resolve(__dirname, 'objective-prerequisites.sql'), 'utf8'));
  // Synthetic migration-owner grants model the historical default DML policy.
  // They do not establish deployed ownership/inheritance or expand production policy.
  await owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA a2_associations
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO capiro_app`);
  for (const name of [
    '20281011010000_client_objectives',
    '20281015010000_client_objective_work_intents',
    '20281015020000_client_objective_canonical_plans',
    '20281015030000_client_objective_operational_links',
  ]) {
    const source = readFileSync(
      resolve(__dirname, '../../prisma/migrations', name, 'migration.sql'),
      'utf8',
    );
    await owner.query(source);
    // These historical migrations are intentionally not repeatable. Verify refusal
    // transactionally so even an unexpected success cannot mutate the fixture twice.
    await owner.query('BEGIN');
    let refusal: unknown;
    try {
      await owner.query(source);
    } catch (error) {
      refusal = error;
    } finally {
      await owner.query('ROLLBACK');
    }
    if (!refusal || !['42P07', '42710'].includes((refusal as { code: string }).code))
      throw Error(`Expected duplicate-object refusal on second application of ${name}.`);
  }
}
