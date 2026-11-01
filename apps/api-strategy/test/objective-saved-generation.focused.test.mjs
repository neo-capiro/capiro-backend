// Actual discovery orchestration with synthetic SQL/owner ports. Existing
// objective-saved-review tests qualify the exact reader; no native SQL claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const data = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const nest = data(
  'export class NotFoundException extends Error{}; export class ServiceUnavailableException extends Error{};',
);
const ports = data(`
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function normalizeObjectiveDestination(v){return {...v};}
export async function readObjectiveSavedReview(tx,ctx,id,input){
  tx.reads.push({ctx,id,input}); if(tx.error)throw tx.error; return tx.saved;
}`);
let source = await readFile(
  new URL('../src/strategy/objective-saved-generation.ts', import.meta.url),
  'utf8',
);
source = source.replaceAll("'@nestjs/common'", JSON.stringify(nest));
for (const path of [
  '../meri/objective-generation.types.js',
  './objective-destination.js',
  './objective-saved-review.js',
])
  source = source.replaceAll(`'${path}'`, JSON.stringify(ports));
const { readObjectiveSavedGeneration } = await import(
  data(stripTypeScriptTypes(source, { mode: 'transform' }))
);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const ctx = { tenantId: id(1), clerkUserId: 'synthetic-reader' };
  const binding = { clientId: id(2), objectiveId: id(3), objectiveVersion: 7 };
  const candidate = { generationJobId: id(4), strategyId: id(5), strategyVersionId: id(6) };
  const tx = {
    candidates: [candidate],
    reads: [],
    queries: [],
    saved: {
      source: { ...candidate, objectiveRevisionId: id(7), privateWitness: 'not-public' },
      savedAt: '2026-11-01T00:00:00.000Z',
      snapshot: { private: 'not-public' },
    },
    async $queryRaw(strings, ...values) {
      this.queries.push({ sql: strings.join('?'), values });
      return this.candidates;
    },
  };
  return { ctx, binding, candidate, tx };
}
test('routes only the exact discovered job/version through the existing authority reader', async () => {
  const f = fixture(),
    result = await readObjectiveSavedGeneration(f.tx, f.ctx, f.binding);
  assert.deepEqual(f.tx.reads, [
    {
      ctx: f.ctx,
      id: f.candidate.strategyId,
      input: {
        ...f.binding,
        generationJobId: f.candidate.generationJobId,
        strategyVersionId: f.candidate.strategyVersionId,
      },
    },
  ]);
  assert.deepEqual(result, {
    selection: {
      query: f.binding,
      ids: { strategyId: id(5), strategyVersionId: id(6), generatedJobId: id(4) },
    },
    objectiveRevisionId: id(7),
    savedAt: '2026-11-01T00:00:00.000Z',
  });
});
test('candidate query remains actor/client/revision/canonical scoped and refuses ambiguity without choosing newest', async () => {
  const f = fixture();
  f.tx.candidates.push({ ...f.candidate, generationJobId: id(8) });
  await assert.rejects(
    () => readObjectiveSavedGeneration(f.tx, f.ctx, f.binding),
    /could not be selected/,
  );
  assert.equal(f.tx.reads.length, 0);
  const q = f.tx.queries[0];
  assert.deepEqual(q.values, [
    f.ctx.tenantId,
    f.ctx.clerkUserId,
    f.binding.clientId,
    f.binding.clientId,
    f.binding.objectiveId,
    '7',
  ]);
  for (const fragment of [
    "status='completed'",
    "input ? 'canonicalGeneration'",
    'ORDER BY id LIMIT 2 FOR SHARE',
  ])
    assert.ok(q.sql.includes(fragment));
});
test('no candidate is unavailable, never an empty success or reserved output', async () => {
  const f = fixture();
  f.tx.candidates = [];
  await assert.rejects(() => readObjectiveSavedGeneration(f.tx, f.ctx, f.binding), /unavailable/);
  assert.equal(f.tx.reads.length, 0);
});
test('malformed stored output is unavailable before exact reader invocation', async () => {
  for (const key of ['generationJobId', 'strategyId', 'strategyVersionId']) {
    const f = fixture();
    f.candidate[key] = null;
    await assert.rejects(() => readObjectiveSavedGeneration(f.tx, f.ctx, f.binding), /unavailable/);
    assert.equal(f.tx.reads.length, 0);
  }
});
for (const reason of [
  'access revoked',
  'stale Objective',
  'unconfirmed producer',
  'missing immutable version',
])
  test(`preserves exact reader refusal: ${reason}`, async () => {
    const f = fixture();
    f.tx.error = new Error(reason);
    await assert.rejects(
      () => readObjectiveSavedGeneration(f.tx, f.ctx, f.binding),
      (e) => e === f.tx.error,
    );
    assert.equal(f.tx.reads.length, 1);
  });
