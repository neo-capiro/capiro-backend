import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNER, EXPECTED_SOURCE_SHA, makeAfter, checkEntry, checkPlan, nextTargets,
} from './pin-committee-updates.mjs';

const now = Date.parse('2026-10-06T16:00:00Z');
const prefix = '967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:';
const image = prefix + 'a'.repeat(64);
const url = `https://github.com/neo-capiro/capirov2/commit/${EXPECTED_SOURCE_SHA}`;
const qualification = {
  schemaVersion: 1, service: 'api', status: 'qualified', sourceSha: EXPECTED_SOURCE_SHA,
  image, schemaChange: false, reviewer: 'Test fixture only',
  reviewedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
  evidence: [url],
  checks: ['build', 'automated-tests', 'retirement-compatibility'].map((name) => ({
    name, status: 'passed', sourceSha: EXPECTED_SOURCE_SHA, image, url,
  })),
};
function fixture() {
  const before = {
    family: 'capiro-dev-legiwatch-phase9-api', taskRoleArn: 'unchanged-task-role',
    executionRoleArn: 'unchanged-execution-role', networkMode: 'awsvpc',
    cpu: '1024', memory: '3072', requiresCompatibilities: ['FARGATE'],
    tags: [{ key: 'owner', value: 'preserve-me' }],
    containerDefinitions: [{ name: 'api', image: prefix + 'b'.repeat(64),
      environment: [{ name: 'GIT_SHA', value: 'old' }, { name: 'CAPTURE_FLAG', value: 'unchanged' }],
      secrets: [{ name: 'DATABASE_URL', valueFrom: 'secret-reference-only' }],
      logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': 'unchanged' } },
      command: ['unchanged-default'],
    }],
  };
  const target = {
    Id: 'committee-updates', Arn: 'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev',
    RoleArn: 'unchanged-event-role',
    Input: JSON.stringify({ containerOverrides: [{ name: 'api', command: ['legiwatch-phase9-job', 'committee-updates'] }] }),
    EcsParameters: {
      TaskDefinitionArn: 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-legiwatch-phase9-api:92',
      TaskCount: 1, LaunchType: 'FARGATE',
      NetworkConfiguration: { awsvpcConfiguration: { subnets: ['unchanged'], securityGroups: ['unchanged'], assignPublicIp: 'DISABLED' } },
    },
  };
  const entry = {
    name: OWNER, rule: { Name: OWNER, State: 'ENABLED', ScheduleExpression: 'rate(30 minutes)' },
    targets: [target], before, after: makeAfter(before, qualification),
  };
  return { createdAt: new Date(now).toISOString(), qualification, entries: [entry] };
}

test('fake manifest preserves all config and target fields apart from the reviewed image/SHA/TD pin', () => {
  const plan = fixture();
  checkPlan(plan, qualification, now);
  const entry = plan.entries[0];
  const expected = structuredClone(entry.before);
  expected.containerDefinitions[0].image = image;
  expected.containerDefinitions[0].environment = [
    { name: 'CAPTURE_FLAG', value: 'unchanged' },
    { name: 'GIT_SHA', value: EXPECTED_SOURCE_SHA },
    { name: 'RELEASE_SHA', value: EXPECTED_SOURCE_SHA },
  ];
  assert.deepEqual(entry.after, expected);
  const arn = 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-legiwatch-phase9-api:101';
  const next = nextTargets(entry, arn);
  const expectedTargets = structuredClone(entry.targets);
  expectedTargets[0].EcsParameters.TaskDefinitionArn = arn;
  assert.deepEqual(next, expectedTargets);
  assert.match(entry.targets[0].EcsParameters.TaskDefinitionArn, /:92$/);
});

for (const mutate of [
  (p) => { p.entries[0].name = 'capiro-dev-legiwatch-source-probe'; },
  (p) => { p.entries[0].rule.Name = 'capiro-dev-legiwatch-source-probe'; },
  (p) => { p.entries[0].rule.State = 'DISABLED'; },
  (p) => { p.entries.push(structuredClone(p.entries[0])); },
  (p) => { p.entries[0].targets[0].Id = 'source-probe'; },
  (p) => { p.entries[0].targets[0].Input = JSON.stringify({ containerOverrides: [{ name: 'api', command: ['legiwatch-phase9-job', 'source-probe'] }] }); },
  (p) => { p.entries[0].targets[0].Arn = 'arn:aws:ecs:us-east-1:000000000000:cluster/capiro-dev'; },
  (p) => { p.entries[0].after.memory = '4096'; },
  (p) => { p.entries[0].after.containerDefinitions[0].secrets = []; },
  (p) => { p.entries[0].after.containerDefinitions[0].environment[0].value = 'changed'; },
]) {
  test(`rejects cross-owner or configuration drift: ${mutate.toString()}`, () => {
    const plan = fixture(); mutate(plan);
    assert.throws(() => checkPlan(plan, qualification, now));
  });
}

test('rejects expired/future plans and unreviewed candidate source', () => {
  assert.throws(() => checkPlan(fixture(), qualification, now + 3600001));
  assert.throws(() => checkPlan(fixture(), qualification, now - 1));
  const wrong = structuredClone(qualification);
  wrong.sourceSha = 'c'.repeat(40);
  wrong.checks.forEach((check) => { check.sourceSha = wrong.sourceSha; });
  assert.throws(() => checkPlan({ ...fixture(), qualification: wrong }, wrong, now), /Unreviewed source/);
});

test('rejects task family change and duplicate environment names', () => {
  const plan = fixture(), entry = plan.entries[0];
  entry.before.family = 'capiro-dev-api';
  assert.throws(() => checkEntry(entry, qualification), /task family/);
  const before = fixture().entries[0].before;
  before.containerDefinitions[0].environment.push({ name: 'GIT_SHA', value: 'duplicate' });
  assert.throws(() => makeAfter(before, qualification), /Duplicate/);
  assert.throws(() => nextTargets(fixture().entries[0], 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:101'));
});
