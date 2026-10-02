#!/usr/bin/env node
/** Pure node:test for governanceTask. No AWS. No network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { governanceTask } from './meri-synthetic-governance.mjs';

const now = 1727846400000;
const image =
  '967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:0000000000000000000000000000000000000000000000000000000000000000';
const sourceSha = '0000000000000000000000000000000000000000';
const qualification = {
  schemaVersion: 1,
  service: 'api',
  sourceSha,
  image,
  status: 'qualified',
  expiresAt: new Date(now + 3600000).toISOString(),
  reviewer: 'fixture-reviewer',
  reviewedAt: new Date(now).toISOString(),
  evidence: ['https://github.com/neo-capiro/capirov2/commit/' + sourceSha],
  checks: [
    {
      name: 'build',
      url: 'https://github.com/neo-capiro/capirov2/blob/0000000000000000000000000000000000000000/test.js',
      status: 'passed',
      sourceSha,
      image,
    },
    {
      name: 'automated-tests',
      url: 'https://github.com/neo-capiro/capirov2/blob/0000000000000000000000000000000000000000/test.js',
      status: 'passed',
      sourceSha,
      image,
    },
    {
      name: 'retirement-compatibility',
      url: 'https://github.com/neo-capiro/capirov2/blob/0000000000000000000000000000000000000000/test.js',
      status: 'passed',
      sourceSha,
      image,
    },
  ],
  schemaChange: false,
};

const baseTd = {
  family: 'capiro-dev-api',
  networkMode: 'awsvpc',
  requiresCompatibilities: ['FARGATE'],
  containerDefinitions: [
    {
      name: 'api',
      image,
      runtimePlatform: { os: 'linux', cpu: 'arm64' },
      environment: [
        { name: 'MEMORY_GOVERNANCE_LIFECYCLE', value: 'enforce' },
        { name: 'MEMORY_GOVERNANCE_CENTER', value: 'enforce' },
        { name: 'MEMORY_GOVERNANCE_ENFORCE', value: 'enforce' },
        { name: 'MEMORY_CLIENT_REVIEW', value: 'enforce' },
        { name: 'MEMORY_GOVERNANCE_TENANTS', value: 'f2d6cf8f-057c-479a-8110-62fe5086d43f' },
        { name: 'GIT_SHA', value: sourceSha },
        { name: 'RELEASE_SHA', value: sourceSha },
      ],
      secrets: [],
      portMappings: [],
      logConfiguration: { logDriver: 'awslogs', options: {} },
    },
  ],
  taskRoleArn: 'arn:aws:iam::967807252336:role/capiro-dev-task',
  executionRoleArn: 'arn:aws:iam::967807252336:role/capiro-dev-exec',
  cpu: '1024',
  memory: '2048',
};

const validQualification = structuredClone(qualification);

// 1. Basic path: first tenant added, namespace added
test('governanceTask appends only approved missing tenants and namespace', () => {
  const td = structuredClone(baseTd);
  td.containerDefinitions[0].environment.find((e) => e.name === 'MEMORY_GOVERNANCE_TENANTS').value =
    '11111111-1111-4111-8111-111111111111';
  const result = governanceTask(td, validQualification, now);
  assert.strictEqual(result.changed, true);
  assert.deepStrictEqual(result.changes.addedTenantIds, [
    'f2d6cf8f-057c-479a-8110-62fe5086d43f',
    '52e91176-08f0-4d89-9633-bc212f5bdbbf',
  ]);
  assert.strictEqual(result.changes.namespaceAdded, true);
  assert.strictEqual(result.changes.priorCohortCount, 1);
  const env = result.proposed.containerDefinitions[0].environment;
  assert.strictEqual(
    env.find((e) => e.name === 'MEMORY_GOVERNANCE_TENANTS').value,
    '11111111-1111-4111-8111-111111111111,f2d6cf8f-057c-479a-8110-62fe5086d43f,52e91176-08f0-4d89-9633-bc212f5bdbbf',
  );
  assert.strictEqual(
    env.find((e) => e.name === 'MERI_SYNTHETIC_FIXTURE_NAMESPACE').value,
    'meri-foundation-20260928',
  );
});

// 2. Existing cohort with both tenants: no-op
test('governanceTask with both tenants already present is no-op', () => {
  const td = structuredClone(baseTd);
  td.containerDefinitions[0].environment.find((e) => e.name === 'MEMORY_GOVERNANCE_TENANTS').value =
    'f2d6cf8f-057c-479a-8110-62fe5086d43f,52e91176-08f0-4d89-9633-bc212f5bdbbf';
  td.containerDefinitions[0].environment.push({
    name: 'MERI_SYNTHETIC_FIXTURE_NAMESPACE',
    value: 'meri-foundation-20260928',
  });
  const result = governanceTask(td, validQualification, now);
  assert.strictEqual(result.changed, false);
  assert.deepStrictEqual(result.changes.addedTenantIds, []);
  assert.strictEqual(result.changes.namespaceAdded, false);
  assert.strictEqual(result.changes.priorCohortCount, 2);
});

// 3. One tenant already present, second added
test('governanceTask adds second tenant when first exists', () => {
  const td = structuredClone(baseTd);
  td.containerDefinitions[0].environment.find((e) => e.name === 'MEMORY_GOVERNANCE_TENANTS').value =
    'f2d6cf8f-057c-479a-8110-62fe5086d43f';
  td.containerDefinitions[0].environment.push({
    name: 'MERI_SYNTHETIC_FIXTURE_NAMESPACE',
    value: 'meri-foundation-20260928',
  });
  const result = governanceTask(td, validQualification, now);
  assert.strictEqual(result.changed, true);
  assert.deepStrictEqual(result.changes.addedTenantIds, ['52e91176-08f0-4d89-9633-bc212f5bdbbf']);
  assert.strictEqual(result.changes.namespaceAdded, false);
  const env = result.proposed.containerDefinitions[0].environment;
  assert.strictEqual(
    env.find((e) => e.name === 'MEMORY_GOVERNANCE_TENANTS').value,
    'f2d6cf8f-057c-479a-8110-62fe5086d43f,52e91176-08f0-4d89-9633-bc212f5bdbbf',
  );
});

// 4. Opaque environmentFiles rejected
test('governanceTask rejects environmentFiles', () => {
  const td = structuredClone(baseTd);
  td.containerDefinitions[0].environmentFiles = [{ type: 's3', location: 'bucket/key' }];
  assert.throws(() => governanceTask(td, validQualification, now), /environmentFiles refused/);
});

// 5. Secret-backed control fields rejected
test('governanceTask rejects secret-backed control fields', () => {
  const td = structuredClone(baseTd);
  td.containerDefinitions[0].secrets.push({
    name: 'MEMORY_GOVERNANCE_LIFECYCLE',
    valueFrom: 'arn:aws:secretsmanager:us-east-1:967807252336:secret/x',
  });
  assert.throws(() => governanceTask(td, validQualification, now), /Secret-backed control refused/);
});

// 6. Namespace conflict rejected
test('governanceTask rejects conflicting namespace', () => {
  const td = structuredClone(baseTd);
  td.containerDefinitions[0].environment.push({
    name: 'MERI_SYNTHETIC_FIXTURE_NAMESPACE',
    value: 'wrong-namespace',
  });
  assert.throws(
    () => governanceTask(td, validQualification, now),
    /Conflicting fixture namespace refused/,
  );
});

// 7. Existing governance flags must remain enforce
test('governanceTask rejects non-enforce flags', () => {
  const td = structuredClone(baseTd);
  td.containerDefinitions[0].environment.find(
    (e) => e.name === 'MEMORY_GOVERNANCE_LIFECYCLE',
  ).value = 'audit';
  assert.throws(
    () => governanceTask(td, validQualification, now),
    /Existing governance flags must remain enforce/,
  );
});

// 8. Live source identity mismatch rejected
test('governanceTask rejects source SHA mismatch', () => {
  const td = structuredClone(baseTd);
  td.containerDefinitions[0].environment.find((e) => e.name === 'GIT_SHA').value =
    '1111111111111111111111111111111111111111';
  assert.throws(() => governanceTask(td, validQualification, now), /Live source identity mismatch/);
});

// 9. Invalid or duplicate environment names rejected
test('governanceTask rejects duplicate environment names', () => {
  const td = structuredClone(baseTd);
  td.containerDefinitions[0].environment.push({ name: 'GIT_SHA', value: sourceSha });
  assert.throws(
    () => governanceTask(td, validQualification, now),
    /Invalid or duplicate environment/,
  );
});

// 10. Malformed or duplicate cohort UUIDs rejected
test('governanceTask rejects malformed cohort UUIDs', () => {
  const td = structuredClone(baseTd);
  td.containerDefinitions[0].environment.find((e) => e.name === 'MEMORY_GOVERNANCE_TENANTS').value =
    'not-a-uuid,52e91176-08f0-4d89-9633-bc212f5bdbbf';
  assert.throws(
    () => governanceTask(td, validQualification, now),
    /malformed or duplicate cohort refused/,
  );
});

// 11. Duplicate cohort UUIDs rejected
test('governanceTask rejects duplicate cohort UUIDs', () => {
  const td = structuredClone(baseTd);
  td.containerDefinitions[0].environment.find((e) => e.name === 'MEMORY_GOVERNANCE_TENANTS').value =
    'f2d6cf8f-057c-479a-8110-62fe5086d43f,f2d6cf8f-057c-479a-8110-62fe5086d43f';
  assert.throws(
    () => governanceTask(td, validQualification, now),
    /malformed or duplicate cohort refused/,
  );
});

// 12. Wrong API family/network rejected
test('governanceTask rejects wrong family', () => {
  const td = structuredClone(baseTd);
  td.family = 'wrong-family';
  assert.throws(() => governanceTask(td, validQualification, now), /Wrong API family\/network/);
});

test('preserves sidecars, unrelated blanks, secret refs, roles and original input', () => {
  const td = structuredClone(baseTd);
  td.containerDefinitions.push({
    name: 'sidecar',
    image: 'sidecar@sha256:' + 'a'.repeat(64),
    environment: [{ name: 'KEEP', value: '' }],
    secrets: [{ name: 'PRIVATE', valueFrom: 'opaque-ref' }],
  });
  const before = structuredClone(td),
    result = governanceTask(td, validQualification, now);
  assert.deepEqual(td, before);
  assert.deepEqual(result.proposed.containerDefinitions[1], before.containerDefinitions[1]);
  assert.equal(result.proposed.taskRoleArn, before.taskRoleArn);
  assert.equal(result.proposed.executionRoleArn, before.executionRoleArn);
});
test('all and empty cohorts are explicitly rejected', () => {
  for (const value of ['all', 'ALL', '', ',', '   ']) {
    const td = structuredClone(baseTd);
    td.containerDefinitions[0].environment.find(
      (e) => e.name === 'MEMORY_GOVERNANCE_TENANTS',
    ).value = value;
    assert.throws(() => governanceTask(td, validQualification, now));
  }
});
