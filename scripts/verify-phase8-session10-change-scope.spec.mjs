import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasScheduleProductChanges,
  frozenScheduleProblems,
} from './verify-phase8-session10-change-scope.mjs';
const schema =
  'generator client {\n provider = "prisma-client-js"\n}\ndatasource db {\n provider = "postgresql"\n url = env("DATABASE_URL")\n}\nmodel DefenseBudgetScheduleTick {\n id String @id\n outcome String\n}\nmodel Memory {\n id String @id\n}\n';
const discovery = {
  file: 'apps/defense-api/src/budget-lifecycle/discovery/publisher-crawler.ts',
  before: 'old',
  after: 'approved compatibility',
};
test('unrelated discovery changes are not attributed to schedule implementation', () => {
  assert.equal(hasScheduleProductChanges([discovery]), false);
  assert.deepEqual(frozenScheduleProblems([discovery]), []);
});
test('memory-only Prisma changes retain current schedule checks without schedule attribution', () => {
  const change = {
    file: 'apps/api/prisma/schema.prisma',
    before: schema,
    after: schema + 'model OtherMemory {\n id String @id\n}\n',
  };
  assert.equal(hasScheduleProductChanges([change, discovery]), false);
});
for (const file of [
  'apps/defense-api/src/budget-lifecycle/budget-lifecycle.module.ts',
  'apps/defense-api/src/budget-lifecycle/schedule/coordinator.ts',
  'apps/defense-api/scripts/run-schedule-controller.mjs',
  'packages/defense-domain/src/budget-lifecycle/schedule.ts',
  'packages/defense-domain/src/budget-lifecycle/index.ts',
  'packages/defense-domain/src/index.ts',
  'apps/api/prisma/migrations/20261211120000_phase8_session10_schedule_control_plane/migration.sql',
])
  test(`schedule product path retains frozen boundary: ${file}`, () => {
    const change = { file, before: 'old', after: 'new' };
    assert.equal(hasScheduleProductChanges([change]), true);
    assert.deepEqual(frozenScheduleProblems([change, discovery]), [discovery.file]);
  });
test('schedule schema changes, deletion and malformed schema retain frozen boundary', () => {
  for (const after of [
    schema.replace('outcome String', 'outcome Int'),
    schema.replace('model DefenseBudgetScheduleTick', 'model Removed'),
    null,
    '{',
    schema.replace('provider = "postgresql"', 'provider = "mysql"'),
    schema.replace('prisma-client-js', 'different-generator'),
  ]) {
    const change = { file: 'apps/api/prisma/schema.prisma', before: schema, after };
    assert.equal(hasScheduleProductChanges([change]), true);
    assert.deepEqual(frozenScheduleProblems([change, discovery]), [discovery.file]);
  }
});
test('mixed schedule and frozen primitive edits fail even when tests or gate files also change', () => {
  const changes = [
    { file: 'scripts/verify-phase8-session10.mjs' },
    { file: 'apps/defense-api/src/budget-lifecycle/schedule/coordinator.spec.ts' },
    discovery,
    { file: 'apps/defense-api/src/budget-lifecycle/lifecycle-store.ts' },
  ];
  assert.deepEqual(frozenScheduleProblems(changes), [
    discovery.file,
    'apps/defense-api/src/budget-lifecycle/lifecycle-store.ts',
  ]);
});
test('documentation, verifier maintenance and EOLs do not invent product attribution', () => {
  const changes = [
    { file: 'scripts/verify-phase8-session10.mjs' },
    { file: 'docs/defense-budget/phase8-session10-spec.md' },
    { file: 'apps/api/prisma/schema.prisma', before: schema, after: schema.replace(/\n/g, '\r\n') },
  ];
  assert.equal(hasScheduleProductChanges(changes), false);
});
