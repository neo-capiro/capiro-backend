import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { EngagementApiInfraConfig } from '../lib/engagement-api/engagement-api-config';
import {
  ENGAGEMENT_API_DEPLOYMENT_MAXIMUM_PERCENT,
  assertEngagementApiDeploymentDbBudget,
  engagementApiDeploymentTaskCeiling,
  evaluateEngagementApiDbBudget,
} from '../lib/engagement-api/engagement-api-db-budget';

const CDK_ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(CDK_ROOT, 'fixtures/engagement-api.test.json');
const SERVICE_STACK = path.join(
  CDK_ROOT,
  'lib/engagement-api/engagement-api-service-stack.ts',
);

const base = (): EngagementApiInfraConfig =>
  JSON.parse(readFileSync(FIXTURE, 'utf8')) as EngagementApiInfraConfig;

test('the budget constant matches the ECS service rolling-deployment setting', () => {
  const source = readFileSync(SERVICE_STACK, 'utf8');
  assert.equal(ENGAGEMENT_API_DEPLOYMENT_MAXIMUM_PERCENT, 200);
  assert.match(source, /maxHealthyPercent:\s*200/);
});

test('maximumCount=2 budgets four concurrent tasks during replacement', () => {
  assert.equal(engagementApiDeploymentTaskCeiling(2), 4);
  const evaluation = evaluateEngagementApiDbBudget(base());
  assert.equal(evaluation.deploymentTaskCeiling, 4);
  assert.equal(evaluation.projectedPeak, 460);
  assert.deepEqual(evaluation.failures, []);
});

test('a steady-state-safe but deployment-surge-unsafe budget is rejected', () => {
  const cfg = base();
  cfg.dbConnectionBudget = {
    databaseMaxConnections: 100,
    observedSevenDayPeak: 60,
    perTaskPoolMaximum: 10,
    alarmThreshold: 70,
  };
  // Old formula: 60 + 2*10 = 80, exactly the 80% ceiling.
  assert.equal(
    cfg.dbConnectionBudget.observedSevenDayPeak +
      cfg.maximumCount * cfg.dbConnectionBudget.perTaskPoolMaximum,
    80,
  );
  // Correct rollout formula: 60 + 4*10 = 100, unsafe.
  assert.throws(
    () => assertEngagementApiDeploymentDbBudget(cfg),
    /unsafe during rolling deployment|deployment-surge database peak/,
  );
});

test('the committed synthetic fixture is safe under the surge formula', () => {
  assert.doesNotThrow(() => assertEngagementApiDeploymentDbBudget(base()));
});
