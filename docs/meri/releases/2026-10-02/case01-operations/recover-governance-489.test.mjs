import {createRecovery,definitionProjection} from './recover-governance-489.mjs';
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
} from 'file:///C:/dev/cap-meri-migration-history-guard/scripts/meri-synthetic-governance.mjs';
import { ACCOUNT, REGION, fingerprint, taskInput } from 'file:///C:/dev/cap-meri-migration-history-guard/scripts/lib/meri-release-policy.mjs';

const now = Date.parse('2026-09-27T12:00:00Z');
const oldDigest = `sha256:${'a'.repeat(64)}`;
const newDigest = oldDigest;
const caller = `arn:aws:iam::${ACCOUNT}:user/hermes-cli`;
const uri = (d) => `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/capiro/dev/api@${d}`;
const arn = (n) => `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/capiro-dev-api:${n}`;
const sourceSha = 'c11c83fe1759183254b24d11a9087ccc89595a73';
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
    taskDefinitionArn: arn(488),
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
    definitions: new Map([[arn(488), td]]),
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
      taskDefinition: arn(488),
      deployments: [
        {
          id: 'deployment-1',
          status: 'PRIMARY',
          rolloutState: 'COMPLETED',
          taskDefinition: arn(488),
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
  state.aws = aws;
  return state;
}


async function setup() {
 const f=fixture(); const m=await f.operator.prepare(qualification(),caller,sourceSha);
 const candidate={...governanceTask(f.td,m.qualification,now).proposed,taskDefinitionArn:arn(489),status:'ACTIVE',revision:489};
 candidate.containerDefinitions[0].environment.reverse(); f.definitions.set(arn(489),candidate);
 f.main=sourceSha;
 f.original={plan:m,receipt:{kind:'meri-fixed-synthetic-governance-receipt',version:1,manifestHash:fingerprint(m),status:'register-outcome-unknown',rollback:false,candidateTaskDefinition:arn(489)}};
 f.recovery=createRecovery({aws:f.aws,originals:async()=>structuredClone(f.original),currentMain:async()=>f.main,selfHash:async()=>'a'.repeat(64),now:()=>now,sleep:async()=>{}});
 return f;
}
test('reordered environment passes; changed, missing, extra, duplicate and invalid entries do not',()=>{
 const original=fixture().td, swapped=structuredClone(original);
 swapped.containerDefinitions[0].environment.reverse();
 assert.equal(fingerprint(definitionProjection(original)),fingerprint(definitionProjection(swapped)));
 for(const mutation of [e=>e[0].value='different',e=>e.pop(),e=>e.push({name:'ADDED',value:'new'})]){
  const changed=structuredClone(original);mutation(changed.containerDefinitions[0].environment);
  assert.notEqual(fingerprint(definitionProjection(original)),fingerprint(definitionProjection(changed)));
 }
 for(const mutation of [e=>e.push(e[0]),e=>e[0].name='',e=>e[0].value=1]){
  const invalid=structuredClone(original);mutation(invalid.containerDefinitions[0].environment);
  assert.throws(()=>definitionProjection(invalid),/ENVIRONMENT_INVALID/);
 }
 const command=structuredClone(original);command.containerDefinitions[0].command=['other'];
 assert.notEqual(fingerprint(definitionProjection(original)),fingerprint(definitionProjection(command)));
});
test('reuses489, sends exactly one update after durable intent, binds ack and verifies health',async()=>{
 const f=await setup(),plan=await f.recovery.prepare();
 const result=await f.recovery.run(plan,fingerprint(plan),f.record);
 assert.equal(result.status,'ecs-healthy');assert.equal(result.updateSubmissions,1);
 assert.deepEqual(f.mutations().map(c=>c[1]),['update-service']);
 assert.equal(f.mutations()[0].at(-1),arn(489));
 assert.deepEqual(f.receipts.map(r=>r.status),['READY','UPDATE_INTENT','UPDATE_ACKNOWLEDGED','ecs-healthy']);
});
test('changed source, candidate or original receipt refuses before any update',async()=>{
 for(const mutation of [f=>f.main='d'.repeat(40),f=>f.definitions.get(arn(489)).containerDefinitions[0].environment[0].value='altered',f=>f.original.receipt.status='ecs-healthy']){
  const f=await setup(),plan=await f.recovery.prepare();mutation(f);
  await assert.rejects(f.recovery.run(plan,fingerprint(plan),f.record));assert.equal(f.mutations().length,0);
 }
});
test('journal failure prevents update, unknown update ack stays uncertain without retry',async()=>{
 const f=await setup(),plan=await f.recovery.prepare();
 await assert.rejects(f.recovery.run(plan,fingerprint(plan),async r=>{if(r.status==='UPDATE_INTENT')throw Error('owned persistence failure');}));assert.equal(f.mutations().length,0);
 const second=await setup(),p=await second.recovery.prepare();second.updateTimeout=true;
 await assert.rejects(second.recovery.run(p,fingerprint(p),second.record));
 assert.equal(second.mutations().length,1);assert.equal(second.receipts.at(-1).status,'RECONCILIATION_REQUIRED');
 assert.equal(second.receipts.at(-1).updateSubmissions,1);
});
test('actual waiter fails unhealthy targets or concurrent primary without retrying service update',async()=>{
 for(const mode of ['health','primary']){
  const f=await setup(),plan=await f.recovery.prepare();
  f.hook=async(args,s)=>{if(s.s.taskDefinition===arn(489)){if(mode==='health')s.health='unhealthy';else s.s.deployments[0].id='foreign-primary';}};
  await assert.rejects(f.recovery.run(plan,fingerprint(plan),f.record));
  assert.equal(f.mutations().length,1);assert.equal(f.receipts.at(-1).status,'RECONCILIATION_REQUIRED');
 }
});
