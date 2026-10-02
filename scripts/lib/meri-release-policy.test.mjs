import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprint,
  taskInput,
  validateQualification,
  candidateTask,
  assertStable,
  serviceConfigFingerprint,
  serviceFingerprint,
  assertBaseline,
  SERVICES,
} from './meri-release-policy.mjs';

const KEY = SERVICES[0];
const PFX = `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/${KEY}`;
const IMG = `${PFX}@sha256:${'a'.repeat(64)}`;
const SHA = 'b'.repeat(40);
const URL = `https://github.com/neo-capiro/capirov2/commit/${SHA}`;
const NOW = Date.now();
const CHK = ['build', 'automated-tests', 'retirement-compatibility'].map((n) => ({
  name: n,
  status: 'passed',
  sourceSha: SHA,
  image: IMG,
  url: URL,
}));
const QUAL = {
  schemaVersion: 1,
  service: KEY,
  status: 'qualified',
  image: IMG,
  sourceSha: SHA,
  expiresAt: new Date(NOW + 36e5).toISOString(),
  evidence: [URL],
  reviewer: 'alice',
  reviewedAt: new Date(NOW - 1e3).toISOString(),
  checks: CHK,
  schemaChange: false,
};

test('keyorder fingerprint', () => {
  assert.strictEqual(fingerprint({ b: 1, a: 2 }), fingerprint({ a: 2, b: 1 }));
});

test('taskInput clone/read-only/unknown', () => {
  const td = { family: 'f', containerDefinitions: [{ name: 'c', image: 'x' }], revision: 1 };
  const out = taskInput(td);
  assert.strictEqual(out.revision, undefined);
  assert.notStrictEqual(out.containerDefinitions, td.containerDefinitions);
  assert.throws(() => taskInput({ bar: 1, containerDefinitions: [] }), /Unknown/);
});

test('task registration omits empty or AWS-only tags and preserves user tags', () => {
  const td = { family: 'f', containerDefinitions: [{ name: 'c', image: 'x' }] };
  for (const tags of [undefined, [], [{ key: 'aws:managed', value: 'yes' }]]) {
    const input = taskInput({ ...td, tags });
    assert.equal(Object.hasOwn(input, 'tags'), false);
    assert.equal(fingerprint(input), fingerprint(taskInput(td)));
  }
  const tags = [
    { key: 'aws:managed', value: 'yes' },
    { key: 'owner', value: 'meri' },
  ];
  const input = taskInput({ ...td, tags });
  assert.deepEqual(input.tags, [{ key: 'owner', value: 'meri' }]);
  assert.deepEqual(tags, [
    { key: 'aws:managed', value: 'yes' },
    { key: 'owner', value: 'meri' },
  ]);
});

test('qualification valid vs wrong repo/expiry/missingreview/check', () => {
  assert.ok(validateQualification(QUAL, KEY, IMG, NOW));
  const wrongImage = IMG.replace('/api@', '/api-evil@');
  assert.throws(
    () => validateQualification({ ...QUAL, image: wrongImage }, KEY, wrongImage, NOW),
    /repository/,
  );
  assert.throws(
    () =>
      validateQualification({ ...QUAL, expiresAt: new Date(NOW - 1).toISOString() }, KEY, IMG, NOW),
    /expired/,
  );
  assert.throws(() => validateQualification({ ...QUAL, reviewer: '' }, KEY, IMG, NOW), /reviewer/);
  assert.throws(() => validateQualification({ ...QUAL, checks: [] }, KEY, IMG, NOW), /attestation/);
});

test('schemaChange evidence', () => {
  const q = {
    ...QUAL,
    schemaChange: true,
    freshDatabase: { status: 'passed', url: URL },
    retiredUpgrade: { status: 'passed', url: URL },
    compatibility: { status: 'passed', url: URL },
  };
  assert.ok(validateQualification(q, KEY, IMG, NOW));
  assert.throws(
    () =>
      validateQualification({ ...q, freshDatabase: { status: 'failed', url: URL } }, KEY, IMG, NOW),
    /freshDatabase/,
  );
});

test('candidateTask exact only-image edit preserves env', () => {
  const td = {
    family: `capiro-dev-${KEY}`,
    networkMode: 'awsvpc',
    containerDefinitions: [
      { name: KEY, image: `${PFX}:latest`, environment: [{ name: 'E', value: '1' }] },
    ],
  };
  const out = candidateTask(td, KEY, IMG);
  assert.strictEqual(out.containerDefinitions[0].image, IMG);
  assert.strictEqual(out.containerDefinitions[0].environment[0].value, '1');
  assert.throws(() => candidateTask({ ...td, family: 'bad' }, KEY, IMG), /family/);
});

test('Web promotion refreshes only release identity and rollback preserves baseline values', () => {
  const key = 'web-vnext';
  const prefix = PFX.replace('/api', '/web-vnext');
  const td = {
    family: `capiro-dev-${key}`,
    networkMode: 'awsvpc',
    containerDefinitions: [
      {
        name: key,
        image: `${prefix}@sha256:${'d'.repeat(64)}`,
        portMappings: [{ containerPort: 8080 }],
        environment: [
          { name: 'WEB_SURFACE', value: 'vnext' },
          { name: 'GIT_SHA', value: 'old' },
          { name: 'CAPIRO_WEB_RELEASE_SHA', value: 'old' },
          { name: 'RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED', value: 'false' },
        ],
      },
    ],
  };
  const before = structuredClone(td);
  const out = candidateTask(td, key, IMG.replace('/api@', '/web-vnext@'), SHA);
  const environment = out.containerDefinitions[0].environment;
  for (const name of ['GIT_SHA', 'RELEASE_SHA', 'CAPIRO_WEB_RELEASE_SHA'])
    assert.equal(environment.find((entry) => entry.name === name).value, SHA);
  assert.equal(environment.find((entry) => entry.name === 'WEB_SURFACE').value, 'vnext');
  assert.equal(
    environment.find((entry) => entry.name === 'RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED').value,
    'false',
  );
  assert.deepEqual(td, before);
  assert.deepEqual(
    candidateTask(td, key, td.containerDefinitions[0].image).containerDefinitions,
    td.containerDefinitions,
  );
  assert.throws(
    () => candidateTask(td, key, IMG.replace('/api@', '/web-vnext@'), 'bad'),
    /source SHA/,
  );
  td.containerDefinitions[0].environment.push({ name: 'GIT_SHA', value: 'duplicate' });
  assert.throws(
    () => candidateTask(td, key, IMG.replace('/api@', '/web-vnext@'), SHA),
    /Duplicate/,
  );
  td.containerDefinitions[0].environment.pop();
  td.containerDefinitions[0].secrets = [{ name: 'RELEASE_SHA', valueFrom: 'reference' }];
  assert.throws(() => candidateTask(td, key, IMG.replace('/api@', '/web-vnext@'), SHA), /secret/);
});

test('stable exactly one deployment', () => {
  const svc = {
    serviceName: `capiro-dev-${KEY}`,
    status: 'ACTIVE',
    desiredCount: 2,
    runningCount: 2,
    pendingCount: 0,
    taskDefinition: 't',
    deploymentController: { type: 'ECS' },
    deployments: [{ id: 'd', status: 'PRIMARY', rolloutState: 'COMPLETED', taskDefinition: 't' }],
    deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true } },
  };
  assert.doesNotThrow(() => assertStable(svc, KEY));
  assert.throws(() => assertStable({ ...svc, deployments: [] }, KEY), /deployment/);
});

test('service fingerprint capacity/network/desired drift vs timestamps', () => {
  const base = {
    serviceName: `capiro-dev-${KEY}`,
    desiredCount: 1,
    runningCount: 1,
    pendingCount: 0,
    createdAt: 'T1',
    events: [],
    deployments: [
      {
        capacityProviderStrategy: [{ provider: 'p' }],
        networkConfiguration: { awsvpcConfiguration: { subnets: ['s'] } },
        desiredCount: 1,
        status: 'PRIMARY',
        taskDefinition: 't',
        id: 'd',
        rolloutState: 'COMPLETED',
      },
    ],
  };
  const f1 = serviceFingerprint(base);
  const f2 = serviceFingerprint({ ...base, createdAt: 'T2', events: [{ id: 1 }] });
  assert.strictEqual(f1, f2);
  const f3 = serviceConfigFingerprint(base);
  const f4 = serviceConfigFingerprint({ ...base, desiredCount: 2 });
  assert.notStrictEqual(f3, f4);
});

test('ECS deployment summaries are observations while deployment identity and unknown config stay guarded', () => {
  const base = {
    desiredCount: 1,
    deployments: [{ id: 'd1', status: 'PRIMARY' }],
    currentServiceDeployment: 'arn:old',
    currentServiceRevisions: [{ arn: 'revision-old', runningTaskCount: 1 }],
  };
  const updated = {
    ...base,
    currentServiceDeployment: 'arn:new',
    currentServiceRevisions: [{ arn: 'revision-new', runningTaskCount: 0, pendingTaskCount: 1 }],
  };
  assert.equal(serviceConfigFingerprint(base), serviceConfigFingerprint(updated));
  assert.equal(serviceFingerprint(base), serviceFingerprint(updated));
  assert.notEqual(
    serviceFingerprint(base),
    serviceFingerprint({ ...updated, deployments: [{ id: 'd2', status: 'PRIMARY' }] }),
  );
  assert.notEqual(
    serviceConfigFingerprint(base),
    serviceConfigFingerprint({ ...updated, futureWritableSetting: true }),
  );
});

test('baseline missing/hash drift', () => {
  const b = {
    taskDefinitionArn: 'a',
    serviceHash: 'b',
    configHash: 'c',
    taskHash: 'd',
    imageDigest: 'e',
    desiredCount: 1,
  };
  assert.doesNotThrow(() => assertBaseline(b, b));
  assert.throws(() => assertBaseline(b, { ...b, desiredCount: 2 }), /drift/);
  assert.throws(
    () =>
      assertBaseline(b, {
        taskDefinitionArn: 'a',
        serviceHash: 'b',
        configHash: 'c',
        taskHash: 'd',
        imageDigest: 'e',
      }),
    /drift/,
  );
});
