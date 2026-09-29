import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChange, inspectChanges } from './outreach-v3-p1-change-scope.mjs';

const fixturePath = 'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json';
const fixture = {
  schemaVersion: 1,
  routes: [{ method: 'POST', path: '/api/engagement/a', sourceLine: 3, guards: ['AuthGuard'] }],
};
const json = JSON.stringify;
test('line-number maintenance runs current gates without attributing unrelated migrations', () => {
  const result = inspectChanges([
    {
      file: fixturePath,
      before: json(fixture),
      after: json({ ...fixture, routes: [{ ...fixture.routes[0], sourceLine: 8 }] }),
    },
    { file: 'apps/api/prisma/migrations/old/migration.sql', before: 'old', after: 'repair' },
  ]);
  assert.equal(result.shouldRun, true);
  assert.equal(result.productChanged, false);
});
for (const mutation of ['path', 'method', 'guards'])
  test(`route ${mutation} change retains product attribution`, () => {
    const route = {
      ...fixture.routes[0],
      [mutation]: mutation === 'guards' ? [] : 'changed',
      sourceLine: 8,
    };
    assert.equal(
      classifyChange(fixturePath, json(fixture), json({ ...fixture, routes: [route] })),
      'product',
    );
  });
for (const sourceLine of [0, -1, '8', null])
  test(`invalid line number ${sourceLine} fails closed`, () => {
    assert.equal(
      classifyChange(
        fixturePath,
        json(fixture),
        json({ ...fixture, routes: [{ ...fixture.routes[0], sourceLine }] }),
      ),
      'product',
    );
  });
test('route additions, removals and fixture schema changes retain product attribution', () => {
  for (const after of [
    { ...fixture, routes: [] },
    { ...fixture, routes: [...fixture.routes, { ...fixture.routes[0], path: '/new' }] },
    { ...fixture, schemaVersion: 2 },
  ])
    assert.equal(classifyChange(fixturePath, json(fixture), json(after)), 'product');
});
test('malformed or deleted fixtures fail closed', () => {
  for (const after of ['{', null])
    assert.equal(classifyChange(fixturePath, json(fixture), after), 'product');
});
test('the exact documentation-only method count correction is maintenance', () => {
  const file = 'apps/api/src/meeting-capture/meeting-capture-persistence.service.ts';
  const before =
    '/** receives this six-method object rather than the broad EngagementService. */\nexport const x = 1;';
  const after = before.replace('six-method', 'seven-method');
  assert.equal(classifyChange(file, before, after), 'gate');
  assert.equal(classifyChange(file, before, after.replace('x = 1', 'x = 2')), 'product');
});
test('only the existing declaration include addition is maintenance', () => {
  const file = 'apps/api/tsconfig.outreach-v3-phase1.json';
  const before = { extends: './tsconfig.json', include: ['src/engagement/**/*.ts'] };
  const after = { ...before, include: [...before.include, 'src/types/word-extractor.d.ts'] };
  assert.equal(classifyChange(file, json(before), json(after)), 'gate');
  for (const changed of [
    { ...after, exclude: ['src/engagement/**/*.ts'] },
    { ...after, compilerOptions: { strict: false } },
    { ...after, include: ['src/types/word-extractor.d.ts'] },
    { ...after, include: [...after.include, 'src/other/**/*.ts'] },
  ])
    assert.equal(classifyChange(file, json(before), json(changed)), 'product');
});
test('test maintenance is gated; deletion is not exempted', () => {
  const file = 'apps/api/src/meeting-capture/meeting-capture-persistence.service.spec.ts';
  assert.equal(classifyChange(file, 'old', 'new'), 'gate');
  assert.equal(classifyChange(file, null, 'new'), 'gate');
  assert.equal(classifyChange(file, 'old', null), 'product');
});
test('runtime, capability, dependency, ownership and security changes retain attribution', () => {
  for (const file of [
    'apps/api/src/engagement/engagement.service.ts',
    'apps/api/src/engagement-api.app.module.ts',
    'apps/api/src/engagement-workers/worker.ts',
    'apps/api/src/engagement-callbacks/callback.ts',
    'apps/api/src/webhooks/webhook.ts',
    'apps/api/src/capabilities/catalog.ts',
    'apps/api/src/ai-credentials/resolver.ts',
    'apps/api/src/intelligence/alert-memo/memo.ts',
    'apps/api/src/client-documents/writer.ts',
    'apps/api/src/outreach-review/review.ts',
    'apps/api/src/reviews/reviews.module.ts',
    'apps/api/src/meri/meri.module.ts',
    'apps/api/src/app.module.ts',
    'package.json',
    'pnpm-lock.yaml',
    'apps/api/package.json',
    'infra/cdk/fixtures/engagement-runtime-ownership.v1.json',
    'docs/contracts/capiro-capabilities-v1.md',
    'docs/contracts/engagement-runtime-ownership-v1.md',
    'docs/runbooks/capiro-capability-security.md',
    'docs/runbooks/engagement-runtime-ownership.md',
    'docs/plans/outreach-v3/revised-phase-1-foo.md',
    'docs/plans/outreach-v3/revised-phase-2-foo.md',
  ])
    assert.equal(classifyChange(file, 'old', 'new'), 'product', file);
});
test('mixed product and maintenance changes retain full PR scope', () => {
  const result = inspectChanges([
    { file: 'scripts/outreach-v3-p1-change-scope.mjs', before: 'old', after: 'new' },
    { file: 'apps/api/src/engagement/x.ts', before: 'old', after: 'new' },
    { file: 'apps/web/src/x.tsx', before: 'old', after: 'new' },
  ]);
  assert.equal(result.shouldRun, true);
  assert.equal(result.productChanged, true);
});
test('unrelated product changes do not select Phase 1', () => {
  const result = inspectChanges([{ file: 'apps/web/src/x.tsx', before: 'old', after: 'new' }]);
  assert.equal(result.shouldRun, false);
  assert.equal(result.productChanged, false);
});
