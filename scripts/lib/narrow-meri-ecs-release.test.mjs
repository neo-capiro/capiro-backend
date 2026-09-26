import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertBaselineUnchanged, assertServiceState, assertTargetImage,
  cloneWithOnlyImageChanged, parseEcrImage, validateManifest,
} from './narrow-meri-ecs-release.mjs';

const account = '123456789012';
const region = 'us-east-1';
const apiDigest = `sha256:${'a'.repeat(64)}`;
const orchestratorDigest = `sha256:${'b'.repeat(64)}`;
const apiImage = `${account}.dkr.ecr.${region}.amazonaws.com/capiro/dev/api@${apiDigest}`;

test('candidate requires the exact repository and immutable digest', () => {
  assert.equal(assertTargetImage(apiImage, account, region, 'api').digest, apiDigest);
  assert.throws(() => assertTargetImage(apiImage.replace('@sha256:', ':sha256-'), account, region, 'api'), /immutable/);
  assert.throws(() => assertTargetImage(apiImage.replace('/api@', '/api-other@'), account, region, 'api'), /valid ECR tag or sha256 digest/);
  assert.throws(() => assertTargetImage(apiImage, account, region, 'orchestrator'), /exact/);
  assert.equal(parseEcrImage(apiImage.replace(`@${apiDigest}`, ':known-tag'), account, region, 'capiro/dev/api').tag, 'known-tag');
});

test('clone changes only the exact application container image', () => {
  const source = {
    family: 'capiro-dev-api', taskDefinitionArn: 'discarded', revision: 446,
    taskRoleArn: 'arn:aws:iam::123456789012:role/task',
    executionRoleArn: 'arn:aws:iam::123456789012:role/execution',
    networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'],
    cpu: '512', memory: '1024', tags: [],
    containerDefinitions: [{
      name: 'api', image: 'old', environment: [{ name: 'FLAG', value: 'unchanged' }],
      secrets: [{ name: 'SECRET', valueFrom: 'arn:secret' }],
    }, { name: 'sidecar', image: 'sidecar-image', environment: [{ name: 'X', value: 'Y' }] }],
  };
  const copy = cloneWithOnlyImageChanged(source, 'api', apiImage);
  assert.equal(copy.containerDefinitions[0].image, apiImage);
  assert.equal(copy.containerDefinitions[1].image, 'sidecar-image');
  assert.deepEqual(copy.containerDefinitions[0].environment, source.containerDefinitions[0].environment);
  assert.deepEqual(copy.containerDefinitions[0].secrets, source.containerDefinitions[0].secrets);
  assert.equal(copy.taskRoleArn, source.taskRoleArn);
  assert.equal(copy.executionRoleArn, source.executionRoleArn);
  assert.equal(copy.taskDefinitionArn, undefined);
  assert.equal(copy.revision, undefined);
  assert.equal(copy.tags, undefined);
  assert.equal(source.containerDefinitions[0].image, 'old');
  assert.throws(() => cloneWithOnlyImageChanged({ ...source, containerDefinitions: [] }, 'api', apiImage), /exactly one/);
});

const service = {
  serviceName: 'capiro-dev-api', status: 'ACTIVE', taskDefinition: 'arn:task:api:446',
  desiredCount: 2, runningCount: 2, pendingCount: 0,
  deployments: [{ id: 'deployment-1', status: 'PRIMARY', rolloutState: 'COMPLETED' }],
};
const tasks = [1, 2].map(() => ({ lastStatus: 'RUNNING', healthStatus: 'HEALTHY',
  taskDefinitionArn: 'arn:task:api:446' }));

test('steady service check rejects unhealthy, pending and mixed task revisions', () => {
  assert.equal(assertServiceState(service, tasks, 'api'), true);
  assert.throws(() => assertServiceState({ ...service, pendingCount: 1 }, tasks, 'api'), /steady/);
  assert.throws(() => assertServiceState(service, [{ ...tasks[0], healthStatus: 'UNHEALTHY' }, tasks[1]], 'api'), /healthy/);
  assert.throws(() => assertServiceState(service, [{ ...tasks[0], taskDefinitionArn: 'other' }, tasks[1]], 'api'), /healthy/);
});

const apiBaseline = { taskDefinitionArn: `arn:aws:ecs:${region}:${account}:task-definition/capiro-dev-api:446`, desiredCount: 2, runningCount: 2,
  pendingCount: 0, runningTaskCount: 2, deploymentId: 'deployment-1', imageDigest: apiDigest,
  healthyTargetCount: 2, unknownHealthCount: 0 };
const orchestratorBaseline = { taskDefinitionArn: `arn:aws:ecs:${region}:${account}:task-definition/capiro-dev-meriv2-orchestrator:81`, desiredCount: 1,
  runningCount: 1, pendingCount: 0, runningTaskCount: 1, deploymentId: 'deployment-2',
  imageDigest: orchestratorDigest, healthyTargetCount: null, unknownHealthCount: 1 };
const baseline = { api: apiBaseline, orchestrator: orchestratorBaseline };

test('both services must match prepare baseline immediately before update', () => {
  assert.equal(assertBaselineUnchanged(baseline, structuredClone(baseline)), true);
  assert.throws(() => assertBaselineUnchanged(baseline, {
    ...baseline, orchestrator: { ...orchestratorBaseline, imageDigest: apiDigest },
  }), /orchestrator imageDigest drifted/);
  assert.throws(() => assertBaselineUnchanged(baseline, {
    ...baseline, api: { ...apiBaseline, taskDefinitionArn: 'new' },
  }), /api taskDefinitionArn drifted/);
});

test('execution manifest requires exact rollback pin and fresh preparation', () => {
  const manifest = { marker: 'NARROW_MERI_ECS_RELEASE_V1', preparedAt: new Date().toISOString(),
    account, region, cluster: 'capiro-dev', profile: 'capiro-dev', service: 'api', targetImage: apiImage, baseline };
  assert.equal(validateManifest(manifest, account, region, 'api', apiBaseline.taskDefinitionArn), true);
  assert.throws(() => validateManifest(manifest, account, region, 'api', 'other'), /Rollback pin/);
  assert.throws(() => validateManifest({ ...manifest, preparedAt: '2020-01-01T00:00:00Z' },
    account, region, 'api', apiBaseline.taskDefinitionArn), /stale/);
  assert.equal(validateManifest({ ...manifest, preparedAt: '2020-01-01T00:00:00Z' },
    account, region, 'api', apiBaseline.taskDefinitionArn, { allowOlderForRollback: true }), true);
});
