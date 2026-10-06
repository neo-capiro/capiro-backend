const { test } = require('node:test'),
  assert = require('node:assert/strict');
const operator = require('./operator.cjs');
const SOURCE = 'a'.repeat(40),
  IMAGE = '967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:' + 'b'.repeat(64),
  BINDING = { sourceSha: SOURCE, image: IMAGE };
const buildDefinition = (td, runtime, mode, approval) =>
  operator.buildDefinition(td, runtime, mode, approval, BINDING);
const validateServing = (s, t, i) => operator.validateServing(s, t, i, BINDING);
const checkQualification = (q) => operator.checkQualification(q, SOURCE);
const assertBeforeLaunch = (read, h) => operator.assertBeforeLaunch(read, h, BINDING);
const td = () => ({
  family: 'capiro-dev-api-sync-legiscan-bills',
  taskRoleArn: 'role-existing',
  executionRoleArn: 'exec-existing',
  cpu: '1024',
  memory: '2048',
  networkMode: 'awsvpc',
  runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
  requiresCompatibilities: ['FARGATE'],
  volumes: [],
  containerDefinitions: [
    {
      name: 'api-sync-legiscan-bills',
      image: 'old-qualified',
      command: ['sync-legiscan-bills'],
      readonlyRootFilesystem: true,
      logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': 'existing' } },
      secrets: ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'LEGISCAN_API_KEY'].map((name) => ({
        name,
        valueFrom: 'existing-reference:' + name,
      })),
      environment: [
        { name: 'LEGISCAN_DOCUMENT_EVIDENCE_ENABLED', value: 'true' },
        { name: 'LEGISCAN_MONTHLY_BUDGET', value: '28000' },
        { name: 'LEGISCAN_HARD_CAP', value: '30000' },
        { name: 'LEGIWATCH_PUBLISHED_RECORD_REFRESH_ENABLED', value: 'true' },
        { name: 'LEGISCAN_REPORT_REFRESH_TENANT', value: 'existing-private-scope' },
      ],
    },
  ],
});
const approval = () => ({
  planHash: 'a'.repeat(64),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  candidateId: '12345678-1234-1234-1234-123456789abc',
});
test('one-off definition preserves resources, roles, secrets, logs and every existing flag', () => {
  const before = td(),
    copy = structuredClone(before),
    after = buildDefinition(before, 'reviewed runtime', 'preview');
  assert.deepEqual(before, copy);
  for (const key of [
    'taskRoleArn',
    'executionRoleArn',
    'cpu',
    'memory',
    'networkMode',
    'runtimePlatform',
    'requiresCompatibilities',
    'volumes',
  ])
    assert.deepEqual(after[key], before[key]);
  for (const key of ['secrets', 'readonlyRootFilesystem', 'logConfiguration'])
    assert.deepEqual(after.containerDefinitions[0][key], before.containerDefinitions[0][key]);
  for (const e of before.containerDefinitions[0].environment)
    assert.deepEqual(
      after.containerDefinitions[0].environment.find((x) => x.name === e.name),
      e,
    );
  assert.equal(after.family, 'capiro-dev-api-hb1211-dataset-reviewed');
});
test('refuses wrong owner, disabled source gate, missing secret reference and inherited private override', () => {
  for (const mutate of [
    (x) => (x.family = 'other'),
    (x) => (x.containerDefinitions[0].environment[0].value = 'false'),
    (x) => x.containerDefinitions[0].secrets.pop(),
    (x) =>
      x.containerDefinitions[0].environment.push({ name: 'HB1211_DATASET_MODE', value: 'apply' }),
  ]) {
    const x = td();
    mutate(x);
    assert.throws(() => buildDefinition(x, '', 'preview'));
  }
});
test('retrieval and apply independently require exact bounded approval; apply also binds candidate ID', () => {
  for (const mode of ['retrieve', 'apply']) {
    assert.throws(() => buildDefinition(td(), '', mode));
    assert.throws(() =>
      buildDefinition(td(), '', mode, {
        ...approval(),
        expiresAt: new Date(Date.now() + 3 * 3600000).toISOString(),
      }),
    );
    const req = buildDefinition(td(), '', mode, approval());
    assert.equal(
      req.containerDefinitions[0].environment.find((x) => x.name === 'HB1211_DATASET_MODE').value,
      mode,
    );
    assert.equal(
      req.containerDefinitions[0].environment.some((x) => x.name === 'LEGIWATCH_RESEARCH_APPLY'),
      false,
    );
  }
  assert.throws(() => buildDefinition(td(), '', 'apply', { ...approval(), candidateId: 'wrong' }));
});
test('serving source/digest, completed deployment, and immutable source tag must all agree', () => {
  const s = {
      runningCount: 2,
      desiredCount: 2,
      pendingCount: 0,
      deployments: [{ rolloutState: 'COMPLETED' }],
    },
    t = {
      containerDefinitions: [
        {
          name: 'api',
          image: IMAGE,
          environment: [
            { name: 'GIT_SHA', value: SOURCE },
            { name: 'RELEASE_SHA', value: SOURCE },
          ],
        },
      ],
    },
    images = [{ imageDigest: IMAGE.split('@')[1] }];
  validateServing(s, t, images);
  assert.throws(() => validateServing({ ...s, pendingCount: 1 }, t, images));
  assert.throws(() => validateServing(s, t, [{ imageDigest: 'wrong' }]));
  const drift = structuredClone(t);
  drift.containerDefinitions[0].environment[0].value = 'wrong';
  assert.throws(() => validateServing(s, drift, images));
});
test('operator never edits scheduled owner and records unknown outcomes before writes', () => {
  const code = require('node:fs').readFileSync(__dirname + '/operator.cjs', 'utf8');
  assert.ok(!code.includes("'put-targets'"));
  assert.ok(!code.includes("'update-service'"));
  assert.ok(!code.includes("'put-rule'"));
  assert.ok(
    code.indexOf("status:'registration-outcome-unknown'") <
      code.indexOf("'register-task-definition'"),
  );
  assert.ok(code.indexOf("status:'launch-outcome-unknown'") < code.indexOf("'run-task'"));
  assert.ok(code.includes('RECORDED_OUTCOME_DO_NOT_REPLAY'));
});
test('post-registration owner drift blocks launch even when originally reviewed', () => {
  const definition = td(),
    rule = { Name: 'owner', State: 'ENABLED' },
    targets = [{ EcsParameters: { TaskDefinitionArn: 'baseline:1' } }],
    { hash } = require('./runtime.cjs');
  const baselineHash = hash({ rule, targets, definition });
  const read = (args) =>
    args[0] === 'events'
      ? args[1] === 'describe-rule'
        ? { ...rule, State: 'DISABLED' }
        : { Targets: targets }
      : { taskDefinition: definition };
  assert.throws(() => assertBeforeLaunch(read, baselineHash), /CHANGED_AFTER_REGISTRATION/);
});
test('standard candidate-bound qualification accepts exact source and rejects a substituted image/source', async () => {
  const url = 'https://github.com/neo-capiro/capirov2/commit/' + SOURCE,
    q = {
      schemaVersion: 1,
      service: 'api',
      status: 'qualified',
      sourceSha: SOURCE,
      image: IMAGE,
      schemaChange: false,
      reviewer: 'Fixture reviewer',
      reviewedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      evidence: [url],
      checks: ['build', 'automated-tests', 'retirement-compatibility'].map((name) => ({
        name,
        status: 'passed',
        sourceSha: SOURCE,
        image: IMAGE,
        url,
      })),
    };
  await checkQualification(q);
  await assert.rejects(checkQualification({ ...q, sourceSha: 'c'.repeat(40) }));
  await assert.rejects(checkQualification({ ...q, image: IMAGE.replace('sha256:b', 'sha256:c') }));
});
test('no implicit source or image binding exists; qualification needs separately reviewed SHA', async () => {
  assert.throws(
    () => operator.buildDefinition(td(), '', 'preview'),
    /EXPLICIT_REVIEWED_SOURCE_REQUIRED/,
  );
  assert.throws(
    () => operator.buildDefinition(td(), '', 'preview', {}, { sourceSha: SOURCE }),
    /EXPLICIT_REVIEWED_IMAGE_REQUIRED/,
  );
  await assert.rejects(
    operator.checkQualification({ sourceSha: SOURCE, image: IMAGE }),
    /EXPLICIT_REVIEWED_SOURCE_REQUIRED/,
  );
  const definition = buildDefinition(td(), '', 'preview'),
    e = Object.fromEntries(
      definition.containerDefinitions[0].environment.map((x) => [x.name, x.value]),
    );
  assert.equal(e.HB1211_DATASET_SOURCE_SHA, SOURCE);
  assert.equal(e.HB1211_DATASET_IMAGE, IMAGE);
  assert.equal(e.GIT_SHA, e.HB1211_DATASET_SOURCE_SHA);
  assert.equal(e.RELEASE_SHA, e.HB1211_DATASET_SOURCE_SHA);
});
