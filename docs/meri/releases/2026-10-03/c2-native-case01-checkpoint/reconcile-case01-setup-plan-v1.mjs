import assert from 'node:assert/strict';
import { readFileSync, readdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { aws } from '../meri-fresh-20261003/auth-preflight.mjs';
const parent = 'C:/dev/main/outputs/meri-c2-20261003';
const root = parent + '/case01-native-setup-plan-v1';
const read = name => JSON.parse(readFileSync(root + '/' + name, 'utf8'));
const result = read('result.json');
const files = readdirSync(root);
assert.equal(result.mode, 'plan');
assert.equal(result.taskArn, null);
assert.equal(result.cleanup.taskDefinitionInactive, true);
assert.equal(files.some(name => /^(task-input|task-start|inner-receipt)/u.test(name)), false);
const definition = 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meri-c2-case01-setup-20261003:1';
assert.equal(result.taskDefinition, definition);
const definitionReadback = aws(['ecs', 'describe-task-definition', '--task-definition', definition]);
assert.equal(definitionReadback.taskDefinition.taskDefinitionArn, definition);
assert.equal(definitionReadback.taskDefinition.status, 'INACTIVE');
const taskLists = [];
for (const desiredStatus of ['RUNNING', 'STOPPED']) {
  const value = aws(['ecs','list-tasks','--cluster','capiro-dev','--family','capiro-dev-meri-c2-case01-setup-20261003','--desired-status',desiredStatus,'--max-results','100']);
  assert.equal(value.nextToken, undefined);
  assert.deepEqual(value.taskArns, []);
  taskLists.push({ desiredStatus, value });
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const evidence = {
  at: new Date().toISOString(), status: 'RECONCILED_PRE_RUN_TASK_FAILURE',
  priorResultSha256: sha(readFileSync(root + '/result.json')),
  priorDispatcherSha256: sha(readFileSync(parent + '/run-case01-native-setup-v3.mjs')),
  priorTaskDefinition: definition, definitionStatus: definitionReadback.taskDefinition.status,
  taskLists, localRunTaskInputAbsent: true,
  conclusion: 'Retained dispatcher source and saved ordering show the task-input hash assertion failed before runDispatched and before RunTask. Live family lists are empty and the registered definition is INACTIVE.',
  providerCalls: 0, databaseTaskLaunches: 0, fixtureWrites: 0,
  priorFailurePreserved: true, retryExecuted: false,
  nextAction: 'A separately reviewed dispatcher correction may start a new plan in a new exclusive directory; never rerun or overwrite the failed plan.',
};
const output = parent + '/case01-native-setup-plan-v1-reconciliation.json';
const fd = openSync(output, 'wx');
try { writeFileSync(fd, JSON.stringify(evidence, null, 2) + '\n'); fsyncSync(fd); }
finally { closeSync(fd); }
console.log(JSON.stringify({status:evidence.status, output, taskDefinitionStatus:evidence.definitionStatus, cloudTasksObserved:0}));
