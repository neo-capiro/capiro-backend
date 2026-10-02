import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, open, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { releaseOperator, parseArgs, persistReceipt } from './meri-release.mjs';
import { ACCOUNT, REGION, fingerprint, taskInput } from './lib/meri-release-policy.mjs';

const now = Date.parse('2026-09-27T12:00:00Z');
const oldDigest = `sha256:${'a'.repeat(64)}`;
const newDigest = `sha256:${'b'.repeat(64)}`;
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
        environment: [{ name: 'MERI_GLOBAL_OFF', value: 'true' }],
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
        return { Account: state.account ?? ACCOUNT };
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
  state.operator = releaseOperator({ aws, now: () => now, sleep: async () => {} });
  state.record = async (r) => {
    state.receipts.push(structuredClone(r));
  };
  state.mutations = () =>
    state.calls.filter((c) => ['register-task-definition', 'update-service'].includes(c[1]));
  return state;
}

test('prepare is read-only, secret-free and binds exact candidate to baseline', async () => {
  const f = fixture();
  const m = await f.operator.prepare(qualification());
  assert.equal(f.mutations().length, 0);
  assert.equal(m.baseline.imageDigest, oldDigest);
  assert(!JSON.stringify(m).includes('secret-arn'));
  assert(!JSON.stringify(m).includes('MERI_GLOBAL_OFF'));
});
test('promotion binds release identity, preserves other task fields and verifies actual task health', async () => {
  const f = fixture();
  const m = await f.operator.prepare(qualification());
  const r = await f.operator.promote(m, fingerprint(m), f.record);
  assert.equal(r.status, 'ecs-healthy-manual-acceptance-required');
  const proposed = taskInput(f.definitions.get(r.candidateTaskDefinition));
  const env = proposed.containerDefinitions[0].environment;
  assert.equal(env.find((entry) => entry.name === 'GIT_SHA').value, sourceSha);
  assert.equal(env.find((entry) => entry.name === 'RELEASE_SHA').value, sourceSha);
  proposed.containerDefinitions[0].environment = env.filter(
    (entry) => !['GIT_SHA', 'RELEASE_SHA'].includes(entry.name),
  );
  proposed.containerDefinitions[0].image = uri(oldDigest);
  assert.deepEqual(proposed, taskInput(f.td));
  assert.deepEqual(taskInput(f.definitions.get(r.rollbackTaskDefinition)), taskInput(f.td));
  assert.equal(f.mutations().length, 3);
  assert(f.calls.some((c) => c[0] === 'elbv2' && c[1] === 'describe-target-health'));
});
for (const [name, change] of [
  [
    'wrong account',
    (f) => {
      f.account = '111111111111';
    },
  ],
  [
    'SHA tag moved',
    (f) => {
      f.tagDigest = oldDigest;
    },
  ],
  [
    'task/config drift',
    (f) => {
      f.td.containerDefinitions[0].environment[0].value = 'false';
    },
  ],
  [
    'force deployment same revision',
    (f) => {
      f.s.deployments[0].id = 'another-owner';
    },
  ],
  [
    'capacity provider drift',
    (f) => {
      f.s.capacityProviderStrategy[0].weight = 2;
    },
  ],
  [
    'scaling drift',
    (f) => {
      f.s.desiredCount = 2;
    },
  ],
  [
    'active deployment',
    (f) => {
      f.s.deployments[0].rolloutState = 'IN_PROGRESS';
    },
  ],
  [
    'healthy unrelated target only',
    (f) => {
      f.healthIP = '10.0.0.9';
    },
  ],
  [
    'unhealthy task target',
    (f) => {
      f.health = 'unhealthy';
    },
  ],
])
  test(`${name} blocks before any mutation`, async () => {
    const f = fixture();
    const m = await f.operator.prepare(qualification());
    change(f);
    await assert.rejects(f.operator.promote(m, fingerprint(m), f.record));
    assert.equal(f.mutations().length, 0);
  });
test('wrong approval hash and expired manifest block without AWS mutation', async () => {
  const f = fixture();
  const m = await f.operator.prepare(qualification());
  await assert.rejects(f.operator.promote(m, 'wrong'), /approval hash/);
  m.preparedAt = new Date(now - 3600001).toISOString();
  await assert.rejects(f.operator.promote(m, fingerprint(m)), /expired/);
  assert.equal(f.mutations().length, 0);
});
test('unqualified source blocked; schema changes require three rehearsal records', async () => {
  const f = fixture();
  const q = qualification();
  q.schemaChange = true;
  await assert.rejects(f.operator.prepare(q), /freshDatabase/);
  assert.equal(f.mutations().length, 0);
});
test('mutable baseline refuses promotion despite a healthy observed digest', async () => {
  const f = fixture();
  f.td.containerDefinitions[0].image = uri(oldDigest).split('@')[0] + ':latest';
  const m = await f.operator.prepare(qualification());
  await assert.rejects(f.operator.promote(m, fingerprint(m), f.record), /Mutable baseline/);
  assert.equal(f.mutations().length, 0);
});
test('mutable baseline without automatic rollback uses observed digest for explicit rollback', async () => {
  const f = fixture();
  f.td.containerDefinitions[0].image = uri(oldDigest).split('@')[0] + ':latest';
  f.s.deploymentConfiguration.deploymentCircuitBreaker = { enable: false, rollback: false };
  const m = await f.operator.prepare(qualification());
  const r = await f.operator.promote(m, fingerprint(m), f.record);
  assert.equal(
    f.definitions.get(r.rollbackTaskDefinition).containerDefinitions[0].image,
    uri(oldDigest),
  );
  assert.deepEqual(f.s.deploymentConfiguration.deploymentCircuitBreaker, {
    enable: false,
    rollback: false,
  });
  await f.operator.rollback(r, fingerprint(r), f.record);
  assert.equal(f.definitions.get(f.s.taskDefinition).containerDefinitions[0].image, uri(oldDigest));
});
test('alarm automatic rollback also refuses mutable baseline', async () => {
  const f = fixture();
  f.td.containerDefinitions[0].image = uri(oldDigest).split('@')[0] + ':latest';
  f.s.deploymentConfiguration.deploymentCircuitBreaker = { enable: false, rollback: false };
  f.s.deploymentConfiguration.alarms = { enable: true, rollback: true, alarmNames: ['health'] };
  const m = await f.operator.prepare(qualification());
  await assert.rejects(f.operator.promote(m, fingerprint(m)), /Mutable baseline/);
  assert.equal(f.mutations().length, 0);
});
test('drift after registration leaves unused revisions, never updates service', async () => {
  const f = fixture();
  const m = await f.operator.prepare(qualification());
  f.hook = (args) => {
    if (args[1] === 'register-task-definition') f.s.deployments[0].id = 'other';
  };
  await assert.rejects(f.operator.promote(m, fingerprint(m), f.record), /drift/);
  assert.equal(f.mutations().filter((c) => c[1] === 'update-service').length, 0);
  assert.equal(f.receipts.at(-1).status, 'registered-not-promoted');
});
test('drift in last pre-update read prevents update', async () => {
  const f = fixture();
  const m = await f.operator.prepare(qualification());
  let reads = 0;
  f.hook = (args) => {
    if (args[1] === 'describe-services' && ++reads === 3) f.s.deployments[0].id = 'other';
  };
  await assert.rejects(f.operator.promote(m, fingerprint(m), f.record), /immediately before/);
  assert.equal(f.mutations().filter((c) => c[1] === 'update-service').length, 0);
});
test('lost update response is durably unknown and never blindly retried/rolled back', async () => {
  const f = fixture();
  const m = await f.operator.prepare(qualification());
  f.updateTimeout = true;
  await assert.rejects(f.operator.promote(m, fingerprint(m), f.record), /timed out/);
  assert.equal(f.receipts.at(-1).status, 'update-outcome-unknown');
  assert.equal(f.mutations().filter((c) => c[1] === 'update-service').length, 1);
});
test('same-revision concurrent deployment during wait is not reported successful', async () => {
  const f = fixture();
  const m = await f.operator.prepare(qualification());
  f.hook = (args) => {
    if (args[1] === 'describe-services' && f.receipts.at(-1)?.status === 'promoting')
      f.s.deployments[0].id = 'other';
  };
  await assert.rejects(f.operator.promote(m, fingerprint(m), f.record), /Concurrent/);
  assert.equal(f.mutations().filter((c) => c[1] === 'update-service').length, 1);
});
test('different revision with same digest during final snapshot is rejected', async () => {
  const f = fixture();
  const m = await f.operator.prepare(qualification());
  let reads = 0;
  f.hook = (args) => {
    if (
      args[1] === 'describe-services' &&
      f.receipts.at(-1)?.status === 'promoting' &&
      ++reads === 2
    ) {
      const td = structuredClone(f.definitions.get(f.s.taskDefinition));
      td.taskDefinitionArn = arn(99);
      f.definitions.set(arn(99), td);
      f.s.taskDefinition = arn(99);
      f.s.deployments[0].taskDefinition = arn(99);
    }
  };
  await assert.rejects(f.operator.promote(m, fingerprint(m), f.record), /Final running/);
});
test('guarded explicit rollback uses pinned bytes and persists observed deployment identity', async () => {
  const f = fixture();
  const m = await f.operator.prepare(qualification());
  const r = await f.operator.promote(m, fingerprint(m), f.record);
  const result = await f.operator.rollback(r, fingerprint(r), f.record);
  assert.equal(result.status, 'rollback-ecs-healthy-manual-acceptance-required');
  assert(result.rollbackDeploymentId);
  assert(f.receipts.some((r) => r.status === 'rollback-update-outcome-unknown'));
  assert.equal(f.definitions.get(f.s.taskDefinition).containerDefinitions[0].image, uri(oldDigest));
});
test('rollback refuses changed deployment and changed flags/config', async () => {
  const f = fixture();
  const m = await f.operator.prepare(qualification());
  const r = await f.operator.promote(m, fingerprint(m), f.record);
  const count = f.mutations().length;
  f.s.deployments[0].id = 'other';
  await assert.rejects(f.operator.rollback(r, fingerprint(r)), /concurrent/);
  assert.equal(f.mutations().length, count);
});
test('rollback timeout preserves unknown receipt and never repeats write', async () => {
  const f = fixture();
  const m = await f.operator.prepare(qualification());
  const r = await f.operator.promote(m, fingerprint(m), f.record);
  f.updateTimeout = true;
  await assert.rejects(f.operator.rollback(r, fingerprint(r), f.record), /timed out/);
  assert.equal(f.receipts.at(-1).status, 'rollback-update-outcome-unknown');
  assert.equal(f.mutations().filter((c) => c[1] === 'update-service').length, 2);
});
test('receipt replacement is atomic; failed replacement preserves previous complete receipt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'meri-receipt-test-'));
  const file = path.join(dir, 'receipt.json');
  try {
    await writeFile(file, '{}');
    await persistReceipt(file, { status: 'registered', rollback: arn(2) });
    await assert.rejects(
      persistReceipt(
        file,
        { status: 'promoting' },
        {
          open,
          rm,
          rename: async () => {
            throw new Error('interrupted');
          },
        },
      ),
      /interrupted/,
    );
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
      status: 'registered',
      rollback: arn(2),
    });
    await persistReceipt(file, { status: 'healthy' }, { open, rm, rename });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).status, 'healthy');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('CLI rejects ambiguous action, unknown flags, missing values and duplicates', () => {
  for (const args of [
    [],
    ['deploy'],
    ['prepare', '--out', 'x'],
    ['prepare', '--qualification', 'x', '--out', 'y', '--force', 'yes'],
    ['prepare', '--out', 'x', '--out', 'y'],
  ])
    assert.throws(() => parseArgs(args));
  assert.equal(
    parseArgs(['prepare', '--qualification', 'q.json', '--out', 'm.json']).action,
    'prepare',
  );
});
