import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  inspectCase14ApprovalCostCensus,
  consumeCase14ApprovalCostAuthority,
  assertCase14ApprovalCostAuthority,
  refreshCase14ApprovalCostAuthority,
} from '../case14-approval-cost-authority.mjs';
const observed = JSON.parse(
  readFileSync('C:/dev/main/outputs/meri-c2-20261003/case14-cost-census-source-v1.private.json'),
);
const NOW = Date.parse('2026-10-04T05:12:14.897Z'),
  deadline = NOW + 900000;
test('recorded current configuration and completed nightly leave bounded approval window', () => {
  const result = inspectCase14ApprovalCostCensus(observed, deadline, NOW);
  assert.equal(result.activeRelevantStandaloneTasks, 0);
  assert.equal(result.nextNightlyAt, '2026-10-05T04:30:00.000Z');
});
test('runtime, schedule, worker, source, census and overlap changes reject', () => {
  const changes = [
    (x) => {
      x.services.services[0].taskDefinition += '0';
    },
    (x) => {
      x.services.services[0].pendingCount = 1;
    },
    (x) => {
      x.definition.taskDefinition.containerDefinitions[0].environment.push({
        name: 'AWS_MAX_ATTEMPTS',
        value: '9',
      });
    },
    (x) => {
      x.definition.taskDefinition.containerDefinitions[0].image += '0';
    },
    (x) => {
      x.rule.State = 'DISABLED';
    },
    (x) => {
      x.rule.ScheduleExpression = 'rate(1 minute)';
    },
    (x) => {
      x.targets.Targets.push(x.targets.Targets[0]);
    },
    (x) => {
      x.nightlyDefinition.taskDefinition.containerDefinitions[0].command = ['unexpected'];
    },
    (x) => {
      x.broadRule.State = 'ENABLED';
    },
    (x) => {
      x.tasks.push({
        ...x.tasks[0],
        taskArn: 'test',
        group: 'family:capiro-dev-api-migrate',
        taskDefinitionArn:
          'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api-migrate:136',
        lastStatus: 'PENDING',
      });
    },
    (x) => {
      x.tasks.push({
        ...x.tasks[0],
        taskArn: 'test',
        group: 'family:capiro-dev-meri-any',
        taskDefinitionArn:
          'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meri-any:1',
        lastStatus: 'RUNNING',
      });
    },
    (x) => {
      x.tasks.find((t) => t.group === 'service:capiro-dev-api').containers[0].imageDigest =
        'sha256:' + 'f'.repeat(64);
    },
    (x) => {
      x.tasks.find((t) => t.group === 'service:capiro-dev-api').overrides = {
        containerOverrides: [
          { name: 'api', environment: [{ name: 'AWS_MAX_ATTEMPTS', value: '8' }] },
        ],
      };
    },
    (x) => {
      x.tasks.push(x.tasks[0]);
    },
    (x) => {
      x.caller.Account = 'other';
    },
  ];
  for (const change of changes) {
    const x = structuredClone(observed);
    change(x);
    assert.throws(() => inspectCase14ApprovalCostCensus(x, deadline, NOW));
  }
  for (const end of [NOW, NOW + 900001, NaN])
    assert.throws(() => inspectCase14ApprovalCostCensus(observed, end, NOW));
  assert.throws(() =>
    inspectCase14ApprovalCostCensus(
      observed,
      Date.parse('2026-10-05T04:31:00Z'),
      Date.parse('2026-10-05T04:20:00Z'),
    ),
  );
});
test('passing pure checks or copying a digest never mints a spend authority', async () => {
  const fake = {
    kind: 'meri-case14-native-approval-cost-bound',
    approvalBoundSha256: 'a'.repeat(64),
  };
  assert.throws(() =>
    consumeCase14ApprovalCostAuthority(fake, '00000000-0000-4000-8000-000000000001'),
  );
  assert.throws(() => assertCase14ApprovalCostAuthority(fake));
  await assert.rejects(refreshCase14ApprovalCostAuthority(fake));
});
