// Native PostgreSQL lock regression, local disposable database only. Actual
// Strategy owner/kernel SQL; no production database or authorization substitute.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { randomUUID } from 'node:crypto';
import { objectiveStrategyIntakeUrl } from '../../api-strategy/test/objective-strategy-request-loader.mjs';

const url = new URL(process.env.OBJECTIVE_STATUS_TEST_DATABASE_URL ?? 'invalid:');
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
  'Set OBJECTIVE_STATUS_TEST_DATABASE_URL to an isolated localhost PostgreSQL database');
const require = createRequire(import.meta.url);
const { Client } = require(process.env.OBJECTIVE_STATUS_TEST_PG_MODULE ?? 'pg');
const root = new URL('../../../', import.meta.url), work = 'apps/api/src/clients/objectives/work/';
const data = s => `data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
function source(path, replacements = []) {
  const url = new URL(path, root); let text = readFileSync(url, 'utf8');
  for (const [from, to] of replacements) { assert.ok(text.includes(from)); text = text.replaceAll(from, JSON.stringify(to)); }
  return data(stripTypeScriptTypes(text, { mode: 'transform', sourceUrl: url.href }));
}
const consent = source('apps/api/src/auth/workload-authority/objective-consent-policy.ts');
const regeneration = source(work + 'objective-planner-regeneration.ts');
const kernel = source(work + 'objective-work-command.ts', [
  ["'../../../auth/workload-authority/objective-consent-policy.js'", consent], ["'./objective-planner-regeneration.js'", regeneration],
]);
const selection = source(work + 'objective-strategy-selection.ts', [
  ["'@capiro/shared/objective-strategy-intake'", objectiveStrategyIntakeUrl], ["'./objective-work-command.js'", kernel],
]);
const reservation = source(work + 'objective-strategy-job-reservation.ts', [
  ["'@capiro/shared/objective-strategy-intake'", objectiveStrategyIntakeUrl], ["'./objective-work-command.js'", kernel],
]);
const selectionSql = source(work + 'objective-strategy-selection-prisma.ts', [
  ["'./objective-strategy-job-reservation.js'", reservation], ["'./objective-strategy-selection.js'", selection], ["'./objective-work-command.js'", kernel],
]);
const retry = source(work + 'objective-strategy-prepublication-retry.ts', [
  ["'@capiro/shared/objective-strategy-intake'", objectiveStrategyIntakeUrl], ["'./objective-strategy-selection.js'", selection], ["'./objective-work-command.js'", kernel],
]);
const { ObjectiveStrategyWorkOwner } = await import(source(work + 'objective-strategy-work-owner.ts', [
  ["'@capiro/shared/objective-strategy-intake'", objectiveStrategyIntakeUrl], ["'./objective-strategy-job-reservation.js'", reservation],
  ["'./objective-strategy-selection-prisma.js'", selectionSql], ["'./objective-strategy-selection.js'", selection],
  ["'./objective-work-command.js'", kernel], ["'./objective-strategy-prepublication-retry.js'", retry],
]));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(4), role: 'standard_user' };
const read = { clientId: id(2), objectiveId: id(3), workAction: 'objective.strategy.draft' };
const authority = { ...ctx, actorUserId: id(4), clientId: id(2), objectiveId: id(3) };
const state = { control: null, consent: null, source: { rootIntentId: id(7), canonicalPlanId: id(8), canonicalEpoch: 1 } };
const owner = () => new ObjectiveStrategyWorkOwner({ OBJECTIVE_STRATEGY_INTAKE_ENABLED: 'true', OBJECTIVE_STRATEGY_CONSENT_DURATION_MS: '60000' },
  { withSystem: async () => { throw Error('Status observation must not inspect global output or audit'); } });
async function fixture(count, run) {
  const schema = 'objective_status_' + randomUUID().replaceAll('-', '');
  const options = { connectionString: url.href, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 4000 };
  const first = new Client(options), second = new Client(options);
  await first.connect(); await second.connect();
  try {
    await first.query(`CREATE SCHEMA ${schema}`);
    for (const db of [first, second]) await db.query(`SET search_path TO ${schema},public`);
    await first.query(`CREATE TABLE sp_draft_job (id uuid PRIMARY KEY,tenant_id uuid,client_id uuid,owner_user_id text,status text,attempt int,
      claimed_by text,claimed_at timestamptz,strategy_id uuid,request_key text,input jsonb,deadline_at timestamptz)`);
    for (let n = 0; n < count; n++) await first.query(`INSERT INTO sp_draft_job VALUES ($1,$2,$3,'user_synthetic','queued',1,NULL,NULL,NULL,'synthetic','{}',now()+interval '1 hour')`,
      [id(100+n), id(1), n === 0 ? id(2) : id(99)]);
    let queries = 0;
    const tx = { $queryRawUnsafe: async (sql, ...values) => { queries++; return (await first.query(sql, values)).rows; },
      $queryRaw: async (parts, ...values) => { queries++; return (await first.query(parts.reduce((sql, part, n) => sql + (n ? `$${n}` : '') + part, ''), values)).rows; } };
    await run({ first, second, tx, queries: () => queries });
  } finally {
    await Promise.all([first.query('ROLLBACK').catch(() => {}), second.query('ROLLBACK').catch(() => {})]);
    await first.query(`DROP SCHEMA ${schema} CASCADE`);
    await Promise.all([first.end(), second.end()]);
  }
}
for (const n of [0, 1]) test(`status remains readable while ${n ? 'an unrelated tenant job' : 'the selected job'} is row-locked; writes still refuse`, async () => {
  await fixture(2, async ({ first, second, tx, queries }) => {
    await second.query('BEGIN'); await second.query('SELECT id FROM sp_draft_job WHERE id=$1 FOR UPDATE', [id(100+n)]);
    await first.query('BEGIN'); const o = owner();
    await assert.doesNotReject(o.lockReadWithinTx(tx, ctx, read));
    assert.equal((await o.reconcileWithinTx(tx, authority, read.workAction, state)).state, 'outcome_unconfirmed');
    await assert.rejects(o.policyWithinTx(tx, authority, read.workAction, state), { code: 'AUTHORITY_UNAVAILABLE' });
    assert.equal(queries(), 0);
    await first.query('ROLLBACK'); await first.query('BEGIN');
    await assert.rejects(o.lockWithinTx(tx, ctx, { ...read, command: { workAction: read.workAction } }), { code: '55P03' });
  });
});
test('tenant inventory write limit cannot disable status reads and still refuses issuance', async () => {
  await fixture(129, async ({ first, tx, queries }) => {
    await first.query('BEGIN'); const o = owner();
    await assert.doesNotReject(o.lockReadWithinTx(tx, ctx, read));
    assert.equal((await o.reconcileWithinTx(tx, authority, read.workAction, state)).state, 'outcome_unconfirmed');
    assert.equal(queries(), 0);
    await assert.rejects(o.lockWithinTx(tx, ctx, { ...read, command: { workAction: read.workAction } }));
    await assert.rejects(o.policyWithinTx(tx, authority, read.workAction, state), { code: 'AUTHORITY_UNAVAILABLE' });
  });
});
