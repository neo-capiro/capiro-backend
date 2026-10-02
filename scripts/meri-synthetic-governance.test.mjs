import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, open, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  governanceOperator,
  governanceTask,
  parseArgs,
  assertMainSource,
  TENANTS,
  NAMESPACE,
} from './meri-synthetic-governance.mjs';
import { ACCOUNT, REGION, fingerprint, taskInput } from './lib/meri-release-policy.mjs';

const now = Date.parse('2026-09-27T12:00:00Z');
const oldDigest = `sha256:${'a'.repeat(64)}`;
const newDigest = oldDigest;
const caller = `arn:aws:iam::${ACCOUNT}:user/hermes-cli`;
const uri = (d) => `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/capiro/dev/api@${d}`;
const arn = (n) => `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/capiro-dev-api:${n}`;
const sourceSha = 'c'.repeat(40);
const url = `https://github.com/neo-capiro/capirov2/commit/${sourceSha}`;
const qualification = () => ({
  schemaVersion: 1,
  service: 'api',
  sourceSha,
  image: uri(newDigest),
  status: 'qualified',
  schemaChange: false,
  evidence: [url],
  reviewer: 'fixture-reviewer',
  reviewedAt: new Date(now - 1000).toISOString(),
  checks: ['build', 'automated-tests', 'retirement-compatibility'].map((name) => ({
    name,
    status: 'passed',
    sourceSha,
    image: uri(newDigest),
    url,
  })),
  expiresAt: new Date(now + 3600000).toISOString(),
});

function fixture() {
  const td = {
    family: 'capiro-dev-api',
    networkMode: 'awsvpc',
    taskDefinitionArn: arn(1),
    status: 'ACTIVE',
    revision: 1,
    taskRoleArn: 'role',
    tags: [],
    containerDefinitions: [
      {
        name: 'api',
        image: uri(oldDigest),
        environment: [
          'MEMORY_GOVERNANCE_LIFECYCLE',
          'MEMORY_GOVERNANCE_CENTER',
          'MEMORY_GOVERNANCE_ENFORCE',
          'MEMORY_CLIENT_REVIEW',
        ]
          .map((name) => ({ name, value: 'enforce' }))
          .concat([
            { name: 'MEMORY_GOVERNANCE_TENANTS', value: '11111111-1111-4111-8111-111111111111' },
            { name: 'GIT_SHA', value: sourceSha },
            { name: 'RELEASE_SHA', value: sourceSha },
            { name: 'PRESERVE_BLANK', value: '' },
          ]),
        secrets: [{ name: 'DB', valueFrom: 'secret-arn' }],
        portMappings: [{ containerPort: 4000 }],
        essential: true,
      },
    ],
    requiresAttributes: [],
    cpu: '1024',
    memory: '2048',
  };
  const state = {
    td,
    definitions: new Map([[arn(1), td]]),
    calls: [],
    receipts: [],
    hook: () => {},
    revision: 1,
    s: {
      serviceName: 'capiro-dev-api',
      status: 'ACTIVE',
      desiredCount: 1,
      runningCount: 1,
      pendingCount: 0,
      currentServiceDeployment: 'service-deployment-old',
      currentServiceRevisions: [{ arn: 'revision-old', runningTaskCount: 1, pendingTaskCount: 0 }],
      taskDefinition: arn(1),
      deployments: [
        {
          id: 'deployment-1',
          status: 'PRIMARY',
          rolloutState: 'COMPLETED',
          taskDefinition: arn(1),
          desiredCount: 1,
        },
      ],
      deploymentController: { type: 'ECS' },
      deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true } },
      loadBalancers: [
        { containerName: 'api', containerPort: 4000, targetGroupArn: 'target-group' },
      ],
      networkConfiguration: { awsvpcConfiguration: { subnets: ['s1'] } },
      capacityProviderStrategy: [{ capacityProvider: 'FARGATE', weight: 1 }],
    },
  };
  async function aws(args) {
    state.calls.push(structuredClone(args));
    await state.hook(args, state);
    const value = (key) => args[args.indexOf(key) + 1];
    switch (`${args[0]} ${args[1]}`) {
      case 'sts get-caller-identity':
        return { Account: state.account ?? ACCOUNT, Arn: state.caller ?? caller };
      case 'ecr describe-images':
        return {
          imageDetails: [
            {
              imageDigest: value('--image-ids').includes('imageTag=')
                ? (state.tagDigest ?? newDigest)
                : value('--image-ids').split('=')[1],
            },
          ],
        };
      case 'ecs describe-services':
        return { services: [structuredClone(state.s)] };
      case 'ecs describe-task-definition': {
        const t = state.definitions.get(value('--task-definition'));
        return { taskDefinition: structuredClone(t), tags: t?.tags ?? [] };
      }
      case 'ecs list-tasks':
        return { taskArns: ['task-1'] };
      case 'ecs describe-tasks':
        return {
          tasks: [
            {
              taskArn: 'task-1',
              taskDefinitionArn: state.s.taskDefinition,
              lastStatus: 'RUNNING',
              healthStatus: 'HEALTHY',
              containers: [
                {
                  name: 'api',
                  lastStatus: 'RUNNING',
                  healthStatus: 'HEALTHY',
                  imageDigest:
                    state.runningDigest ??
                    state.definitions
                      .get(state.s.taskDefinition)
                      .containerDefinitions[0].image.split('@')[1] ??
                    oldDigest,
                },
              ],
              attachments: [{ details: [{ name: 'privateIPv4Address', value: '10.0.0.1' }] }],
            },
          ],
        };
      case 'elbv2 describe-target-groups':
        return { TargetGroups: [{ TargetGroupArn: 'target-group', TargetType: 'ip', Port: 4000 }] };
      case 'elbv2 describe-target-health':
        return {
          TargetHealthDescriptions: [
            {
              Target: { Id: state.healthIP ?? '10.0.0.1', Port: 4000 },
              TargetHealth: { State: state.health ?? 'healthy' },
            },
          ],
        };
      case 'ecs register-task-definition': {
        const proposed = JSON.parse(value('--cli-input-json'));
        if (Object.hasOwn(proposed, 'tags') && !proposed.tags.length)
          throw new Error('Tags can not be empty.');
        const newArn = arn(++state.revision);
        const stored = {
          ...proposed,
          taskDefinitionArn: newArn,
          status: 'ACTIVE',
          revision: state.revision,
        };
        state.definitions.set(newArn, stored);
        return { taskDefinition: { taskDefinitionArn: newArn } };
      }
      case 'ecs update-service': {
        const target = value('--task-definition');
        state.s.taskDefinition = target;
        state.s.currentServiceDeployment = `service-deployment-${state.calls.length}`;
        state.s.currentServiceRevisions = [
          { arn: target, runningTaskCount: 1, pendingTaskCount: 0 },
        ];
        state.s.deployments = [
          {
            id: `deployment-${state.calls.length}`,
            status: 'PRIMARY',
            rolloutState: 'COMPLETED',
            taskDefinition: target,
            desiredCount: 1,
          },
        ];
        if (state.updateTimeout) throw new Error('accepted but connection timed out');
        return { service: structuredClone(state.s) };
      }
      default:
        throw new Error(`Unexpected AWS call ${args.slice(0, 2)}`);
    }
  }
  state.writeGuards = 0;
  state.beforeWrite = async () => {};
  state.operator = governanceOperator({
    aws,
    now: () => state.now ?? now,
    sleep: async () => {},
    beforeWrite: async () => {
      state.writeGuards++;
      await state.beforeWrite();
    },
  });
  state.record = async (r) => {
    state.receipts.push(structuredClone(r));
  };
  state.mutations = () =>
    state.calls.filter((c) => ['register-task-definition', 'update-service'].includes(c[1]));
  return state;
}

const prepare = (f) => f.operator.prepare(qualification(), caller, sourceSha);
const apply = (f, m) => f.operator.apply(m, fingerprint(m), f.record);

test('fresh plan uses actual running/ALB/source proof, no mutation and no raw cohort or secret', async () => {
  const f = fixture(),
    m = await prepare(f);
  assert.equal(f.mutations().length, 0);
  assert.equal(m.baseline.imageDigest, oldDigest);
  assert.deepEqual(m.changes.addedTenantIds, TENANTS);
  assert.equal(m.changes.namespaceAdded, true);
  assert(!JSON.stringify(m).includes('11111111-1111-4111-8111-111111111111'));
  assert(!JSON.stringify(m).includes('secret-arn'));
});
test('apply preserves all task/service fields except two fixed controls and rollback restores original TD', async () => {
  const f = fixture(),
    original = structuredClone(f.td),
    m = await prepare(f),
    r = await apply(f, m);
  assert.equal(r.status, 'ecs-healthy');
  assert.equal(f.mutations().length, 2);
  assert.equal(f.writeGuards, 2);
  assert.equal(f.receipts[0].status, 'register-outcome-unknown');
  assert(f.receipts.some((x) => x.status === 'apply-outcome-unknown'));
  const candidate = taskInput(f.definitions.get(r.candidateTaskDefinition));
  assert.deepEqual(candidate, governanceTask(original, qualification(), now).proposed);
  assert.equal(candidate.containerDefinitions[0].image, original.containerDefinitions[0].image);
  const restored = await f.operator.rollback(m, fingerprint(m), r, fingerprint(r), f.record);
  assert.equal(restored.status, 'rollback-ecs-healthy');
  assert.equal(f.s.taskDefinition, arn(1));
  assert.deepEqual(f.definitions.get(arn(1)), original);
  assert.equal(f.mutations().filter((c) => c[1] === 'register-task-definition').length, 1);
});
test('tampered manifest, expired plan and wrong principal refuse before mutation', async () => {
  for (const mode of ['hash', 'expiry', 'principal']) {
    const f = fixture(),
      m = await prepare(f);
    if (mode === 'hash') m.namespace = 'foreign';
    if (mode === 'expiry') f.now = now + 3600001;
    if (mode === 'principal') f.caller = `arn:aws:iam::${ACCOUNT}:user/not-authorized`;
    await assert.rejects(
      f.operator.apply(m, mode === 'hash' ? 'f'.repeat(64) : fingerprint(m), f.record),
    );
    assert.equal(f.mutations().length, 0);
  }
});
test('baseline drift in service scale/network/primary or task secret/env is blocked', async () => {
  for (const fault of [
    (f) => (f.s.desiredCount = 2),
    (f) => (f.s.networkConfiguration.awsvpcConfiguration.subnets = ['foreign']),
    (f) => (f.s.deployments[0].id = 'foreign'),
    (f) => (f.td.containerDefinitions[0].secrets[0].valueFrom = 'changed'),
    (f) => f.td.containerDefinitions[0].environment.push({ name: 'OTHER', value: 'changed' }),
  ]) {
    const f = fixture(),
      m = await prepare(f);
    fault(f);
    await assert.rejects(apply(f, m));
    assert.equal(f.mutations().length, 0);
  }
});
test('unhealthy actual task target and changed source tag reject planning', async () => {
  for (const fault of [
    (f) => (f.health = 'unhealthy'),
    (f) => (f.healthIP = '10.0.0.99'),
    (f) => (f.tagDigest = `sha256:${'b'.repeat(64)}`),
    (f) => (f.runningDigest = `sha256:${'b'.repeat(64)}`),
  ]) {
    const f = fixture();
    fault(f);
    await assert.rejects(prepare(f));
    assert.equal(f.mutations().length, 0);
  }
});
test('registered unexpected task mutation never updates service', async () => {
  const f = fixture(),
    m = await prepare(f);
  f.hook = async (args) => {
    if (args[1] === 'describe-task-definition' && f.revision > 1)
      f.definitions.get(arn(2)).memory = '4096';
  };
  await assert.rejects(apply(f, m));
  assert.equal(f.mutations().length, 1);
  assert.equal(f.s.taskDefinition, arn(1));
});
test('post-registration and immediate pre-update drift reject without service update', async () => {
  for (const immediate of [false, true]) {
    const f = fixture(),
      m = await prepare(f);
    if (immediate)
      f.beforeWrite = async () => {
        if (f.writeGuards === 2) f.s.deployments[0].id = 'concurrent';
      };
    else
      f.hook = async (args) => {
        if (args[1] === 'register-task-definition')
          f.s.networkConfiguration.awsvpcConfiguration.subnets = ['concurrent'];
      };
    await assert.rejects(apply(f, m));
    assert.equal(f.mutations().filter((c) => c[1] === 'update-service').length, 0);
  }
});
test('unknown update outcome retains durable uncertainty, never retries or auto rolls back', async () => {
  const f = fixture(),
    m = await prepare(f);
  f.updateTimeout = true;
  await assert.rejects(apply(f, m));
  assert.equal(f.mutations().filter((c) => c[1] === 'update-service').length, 1);
  assert.equal(f.receipts.at(-1).status, 'apply-outcome-unknown');
});
test('durable receipt failure and clean-source refusal prevent mutations', async () => {
  for (const source of [false, true]) {
    const f = fixture(),
      m = await prepare(f);
    if (source)
      f.beforeWrite = async () => {
        throw Error('dirty source');
      };
    else
      f.record = async () => {
        throw Error('disk full');
      };
    await assert.rejects(apply(f, m));
    assert.equal(f.mutations().length, 0);
  }
});
test('rollback refuses forged receipts or a different active deployment/configuration', async () => {
  for (const kind of ['hash', 'deployment', 'scale', 'task']) {
    const f = fixture(),
      m = await prepare(f),
      r = await apply(f, m),
      n = f.mutations().length;
    if (kind === 'deployment') f.s.deployments[0].id = 'other';
    if (kind === 'scale') f.s.desiredCount = 2;
    if (kind === 'task') f.definitions.get(arn(1)).memory = '8192';
    await assert.rejects(
      f.operator.rollback(
        m,
        fingerprint(m),
        r,
        kind === 'hash' ? '0'.repeat(64) : fingerprint(r),
        f.record,
      ),
    );
    assert.equal(f.mutations().length, n);
  }
});
test('already configured plan refuses unnecessary registration and service rollout', async () => {
  const f = fixture();
  f.td.containerDefinitions[0].environment.find(
    (e) => e.name === 'MEMORY_GOVERNANCE_TENANTS',
  ).value += ',' + TENANTS.join(',');
  f.td.containerDefinitions[0].environment.push({
    name: 'MERI_SYNTHETIC_FIXTURE_NAMESPACE',
    value: NAMESPACE,
  });
  const m = await prepare(f);
  assert.equal(m.changed, false);
  await assert.rejects(apply(f, m));
  assert.equal(f.mutations().length, 0);
});
test('CLI accepts only fixed confirmation and bounded explicit files, no arbitrary environment input', () => {
  assert.equal(
    parseArgs(['plan', '--qualification', 'q', '--caller', caller, '--out', 'p']).mode,
    'plan',
  );
  assert.throws(() =>
    parseArgs([
      'apply',
      '--manifest',
      'p',
      '--approve',
      'a',
      '--confirm',
      'anything',
      '--receipt',
      'r',
    ]),
  );
  assert.throws(() =>
    parseArgs([
      'plan',
      '--qualification',
      'q',
      '--caller',
      caller,
      '--out',
      'p',
      '--env',
      'MEMORY_GOVERNANCE_TENANTS=all',
    ]),
  );
});

test('write source proof refuses dirty, changed main, foreign origin and mismatched workflow identity', async () => {
  const keys = ['GITHUB_ACTIONS', 'GITHUB_REF', 'GITHUB_REPOSITORY', 'GITHUB_SHA'];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const fault of [null, 'dirty', 'main', 'origin', 'ref', 'repo', 'workflow-sha']) {
      Object.assign(process.env, {
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: fault === 'ref' ? 'refs/heads/feature' : 'refs/heads/main',
        GITHUB_REPOSITORY: fault === 'repo' ? 'foreign/repo' : 'neo-capiro/capirov2',
        GITHUB_SHA: fault === 'workflow-sha' ? 'd'.repeat(40) : sourceSha,
      });
      const exec = async (_bin, args) => {
        const key = args.slice(2).join(' ');
        const map = {
          'rev-parse HEAD': sourceSha,
          'rev-parse origin/main': fault === 'main' ? 'd'.repeat(40) : sourceSha,
          'status --porcelain': fault === 'dirty' ? ' M changed' : '',
          'remote get-url origin':
            fault === 'origin'
              ? 'https://github.com/other/repo.git'
              : 'https://github.com/neo-capiro/capirov2.git',
        };
        return { stdout: map[key] };
      };
      if (fault) await assert.rejects(assertMainSource(sourceSha, exec));
      else assert.equal(await assertMainSource(sourceSha, exec), sourceSha);
    }
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});
