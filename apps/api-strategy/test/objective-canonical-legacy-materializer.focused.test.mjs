import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

// Exercise the actual Planner entry body up to its existing downstream owner.
// Synthetic transaction ports establish refusal ordering, not PostgreSQL behavior.
const source = await readFile(new URL('../src/planner/planner.service.ts', import.meta.url), 'utf8');
const start = source.indexOf('  private async prepareStrategyPlanInTransaction(');
assert.ok(start >= 0);
const end = source.indexOf('\n  private ', start + 1);
assert.ok(end > start);
const method = source.slice(start, end).replace('private async', 'async');
const executable = stripTypeScriptTypes(`class Planner { ${method} }`, { mode: 'transform' });
function fixture({ canonical, binding, stored = null }) {
  const reached = new Error('existing downstream owner reached');
  const counters = { outputQueries: 0 };
  const Planner = new Function('materializationError', 'requireCanonicalMaterializationSource', 'digest', `${executable}; return Planner;`)(
    (code, requestId) => { throw Object.assign(new Error(code), { code, requestId }); },
    () => { throw reached; },
    () => { throw reached; },
  );
  const planner = new Planner();
  planner.storedMaterialization = async () => stored;
  planner.canonicalStrategyPlanCreationInTransaction = async () => stored;
  planner.materializationSource = async () => ({ canonical, source: {}, snapshot: {}, objectiveReceiptSha256: 'synthetic' });
  const tx = { spNode: { findMany: async () => { counters.outputQueries++; throw reached; } } };
  const input = { requestId: 'synthetic-original-request' };
  return { run: () => planner.prepareStrategyPlanInTransaction(tx, {}, input, binding), reached, counters, input };
}

test('a new canonical saved generation cannot use the legacy materializer', async () => {
  const f = fixture({ canonical: true });
  await assert.rejects(f.run(), error => error.code === 'MATERIALIZATION_NOT_AVAILABLE' && error.requestId === f.input.requestId);
  assert.equal(f.counters.outputQueries, 0);
});

test('a legacy saved generation continues to its existing Planner owner', async () => {
  const f = fixture({ canonical: false });
  await assert.rejects(f.run(), error => error === f.reached);
  assert.equal(f.counters.outputQueries, 1);
});

test('canonical application with its existing binding reaches canonical validation', async () => {
  const f = fixture({ canonical: true, binding: {} });
  await assert.rejects(f.run(), error => error === f.reached);
  assert.equal(f.counters.outputQueries, 0);
});

test('an already recorded legacy attempt still reaches its original replay validation', async () => {
  const f = fixture({ canonical: true, stored: { input: {}, fingerprint: 'synthetic' } });
  await assert.rejects(f.run(), error => error === f.reached);
  assert.equal(f.counters.outputQueries, 0);
});

