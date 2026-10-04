import { createHash } from 'node:crypto';
import { DescribeTasksCommand, DescribeTaskDefinitionCommand, ECSClient,
  type TaskDefinition } from '@aws-sdk/client-ecs';
import { case12SetupHash, validateCase12SetupBudgetPlan,
  type Case12SetupBudgetPlan } from './meri-case12-setup-budget.js';

const ACCOUNT = '967807252336', REGION = 'us-east-1';
const CLUSTER = `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/capiro-dev`;
const TENANT = 'f2d6cf8f-057c-479a-8110-62fe5086d43f';
const FAMILY = 'capiro-dev-meri-c2-case12-setup';
const INPUT_VARIABLE = 'MERI_CASE12_NATIVE_SETUP_INPUT';
const SLOT = 'case12NativeSetupAdmission';
const HASH = /^[a-f0-9]{64}$/u, GIT = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const need = (ok: unknown): void => {if (!ok) throw new Error('meri_case12_native_setup_admission_denied');};
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const bytesHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {for (const child of Object.values(value)) frozen(child); Object.freeze(value);}
  return value;
}

/** Same projection is used by the operator to pin the immutable definition.
 * Service-generated dates/status/revision are verified separately. */
export function case12NativeTaskDefinitionHash(definition: TaskDefinition): string {
  const fields = ['family', 'taskRoleArn', 'executionRoleArn', 'networkMode', 'containerDefinitions',
    'volumes', 'placementConstraints', 'requiresCompatibilities', 'cpu', 'memory', 'pidMode', 'ipcMode',
    'proxyConfiguration', 'inferenceAccelerators', 'ephemeralStorage', 'runtimePlatform', 'enableFaultInjection'];
  return case12SetupHash(Object.fromEntries(fields.filter(key => (definition as any)[key] !== undefined)
    .map(key => [key, snapshot((definition as any)[key])])));
}

interface NativeEnvelope {
  kind: 'meri-case12-ecs-native-setup'; version: 1;
  taskDefinitionArn: string; taskDefinitionSha256: string; containerName: string;
  startedBy: string; registrationMarker: string; releaseGitRevision: string;
  setupRunId: string; reservationId: string; fixtureInstanceId: string;
  setupPlanSha256: string; providerPlanSha256: string;
  preHoldCheckpointSha256: string; postHoldCheckpointSha256: string; costAuthoritySha256: string;
}

async function metadata() {
  const uri = new URL(process.env.ECS_CONTAINER_METADATA_URI_V4 ?? '');
  need(uri.protocol === 'http:' && uri.hostname === '169.254.170.2' && !uri.port &&
    !uri.username && !uri.password && !uri.search && !uri.hash && /^\/v4\/[a-zA-Z0-9_-]+$/.test(uri.pathname));
  const response = await fetch(uri.href + '/task', {signal: AbortSignal.timeout(3000), redirect: 'error'});
  need(response.status === 200);
  // Metadata is a bounded local native response, never an operator supplied URL.
  const body = await response.text(); need(Buffer.byteLength(body) <= 128 * 1024);
  const value = JSON.parse(body); need(record(value)); return value;
}

/** Operator-helper composition only; no route or CLI calls this automatically.
 * A compact packet and deterministic provider plan are data, not admission.
 * The fixed native ECS reads must authenticate this exact immutable helper first.
 * The Windows operator separately owns the real hold, census and one dispatch. */
export async function createCase12NativeSetupAdmission(rawInput: string, suppliedPlan: unknown) {
  need(typeof rawInput === 'string' && Buffer.byteLength(rawInput) <= 7000);
  const input = JSON.parse(rawInput), plan = frozen(snapshot(validateCase12SetupBudgetPlan(suppliedPlan)));
  need(record(input) && record(input.native));
  const native: NativeEnvelope = frozen(snapshot(input.native));
  need(Object.keys(native).sort().join('|') === ['kind','version','taskDefinitionArn','taskDefinitionSha256',
    'containerName','startedBy','registrationMarker','releaseGitRevision','setupRunId','reservationId',
    'fixtureInstanceId','setupPlanSha256','providerPlanSha256','preHoldCheckpointSha256',
    'postHoldCheckpointSha256','costAuthoritySha256'].sort().join('|'));
  for (const [key, value] of Object.entries(native))
    if (key !== 'kind' && key !== 'version') need(typeof value === 'string');
  need(native.kind === 'meri-case12-ecs-native-setup' && native.version === 1 &&
    GIT.test(native.releaseGitRevision) && process.env.GIT_SHA === native.releaseGitRevision &&
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE === 'meri-foundation-20260928' &&
    process.env[INPUT_VARIABLE] === rawInput && /^c12-/.test(native.startedBy) &&
    UUID.test(native.startedBy.slice(4)) && UUID.test(native.registrationMarker) &&
    /^arn:aws:ecs:us-east-1:967807252336:task-definition\/capiro-dev-meri-c2-case12-setup(?:-[a-z0-9-]+)?:[1-9][0-9]*$/.test(native.taskDefinitionArn) &&
    typeof native.containerName === 'string' &&
    /^[a-zA-Z0-9_-]{1,64}$/.test(native.containerName));
  for (const key of ['taskDefinitionSha256','setupPlanSha256','providerPlanSha256','preHoldCheckpointSha256',
    'postHoldCheckpointSha256','costAuthoritySha256'] as const) need(HASH.test(native[key]));
  need(native.setupRunId === plan.runId && native.reservationId === plan.aggregateReservationId &&
    native.fixtureInstanceId === plan.fixtureInstanceId && native.setupPlanSha256 === plan.setupPlanSha256 &&
    native.providerPlanSha256 === case12SetupHash(plan) && native.preHoldCheckpointSha256 === plan.aggregateCheckpointSha256 &&
    native.preHoldCheckpointSha256 !== native.postHoldCheckpointSha256 && plan.tenantId === TENANT);
  const startedAt = Date.now();
  need(startedAt >= Date.parse(plan.admittedAt) && startedAt < Date.parse(plan.deadlineAt));
  const self = await metadata();
  need([CLUSTER, 'capiro-dev'].includes(self.Cluster) && self.ServiceName === undefined &&
    typeof self.TaskARN === 'string' && /^arn:aws:ecs:us-east-1:967807252336:task\/capiro-dev\/[a-f0-9]{32}$/.test(self.TaskARN) &&
    typeof self.Family === 'string' &&
    ((typeof self.Revision === 'string' && /^[1-9][0-9]*$/.test(self.Revision)) ||
      (typeof self.Revision === 'number' && Number.isSafeInteger(self.Revision) && self.Revision > 0)) &&
    Array.isArray(self.Containers));
  const ecs = new ECSClient({region: REGION, maxAttempts: 1});
  try {
    const tasks = await ecs.send(new DescribeTasksCommand({cluster: CLUSTER, tasks: [self.TaskARN], include: ['TAGS']}),
      {abortSignal: AbortSignal.timeout(5000)});
    need(!tasks.failures?.length && tasks.tasks?.length === 1);
    const task = tasks.tasks![0]!;
    need(task.taskArn === self.TaskARN && task.clusterArn === CLUSTER &&
      task.taskDefinitionArn === native.taskDefinitionArn && task.startedBy === native.startedBy &&
      task.launchType === 'FARGATE' && task.desiredStatus === 'RUNNING' && task.lastStatus === 'RUNNING' &&
      task.group === `family:${native.taskDefinitionArn.split('/').pop()!.replace(/:\d+$/, '')}` &&
      task.tags?.filter(tag => tag.key === 'meri-case12-setup-owner' && tag.value === native.registrationMarker).length === 1 &&
      task.containers?.length === 1 && task.containers[0]!.name === native.containerName &&
      task.containers[0]!.imageDigest === 'sha256:' + plan.imageSha256);
    const expectedOverrides = {containerOverrides: [{name: native.containerName,
      environment: [{name: INPUT_VARIABLE, value: rawInput}]}]};
    need(Buffer.byteLength(JSON.stringify(expectedOverrides), 'utf8') <= 8192 && record(task.overrides));
    // ECS DescribeTasks adds this empty service default even when omitted by RunTask.
    // Only absent/empty is equivalent; all actual overrides remain exact.
    const actualOverrides = snapshot(task.overrides);
    if (Object.hasOwn(actualOverrides, 'inferenceAcceleratorOverrides')) {
      need(Array.isArray(actualOverrides.inferenceAcceleratorOverrides) &&
        actualOverrides.inferenceAcceleratorOverrides.length === 0);
      delete actualOverrides.inferenceAcceleratorOverrides;
    }
    need(case12SetupHash(actualOverrides) === case12SetupHash(expectedOverrides));
    const definitionResult = await ecs.send(new DescribeTaskDefinitionCommand({taskDefinition: native.taskDefinitionArn, include: ['TAGS']}),
      {abortSignal: AbortSignal.timeout(5000)});
    const definition = definitionResult.taskDefinition;
    need(definition?.taskDefinitionArn === native.taskDefinitionArn && definition.status === 'ACTIVE' &&
      case12NativeTaskDefinitionHash(definition) === native.taskDefinitionSha256 &&
      definitionResult.tags?.filter(tag => tag.key === 'meri-case12-setup-owner' && tag.value === native.registrationMarker).length === 1 &&
      definition.containerDefinitions?.length === 1 && definition.containerDefinitions[0]!.name === native.containerName &&
      definition.containerDefinitions[0]!.restartPolicy?.enabled !== true &&
      definition.containerDefinitions[0]!.image === `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/capiro/dev/api@sha256:${plan.imageSha256}`);
    const containers = self.Containers.filter((c: any) => c.Name === native.containerName);
    need(containers.length === 1 && containers[0].ImageID === 'sha256:' + plan.imageSha256 &&
      (!Object.hasOwn(containers[0], 'RestartCount') || containers[0].RestartCount === 0) &&
      String(self.Family) + ':' + String(self.Revision) === native.taskDefinitionArn.split('/').pop());
    need(Date.now() - startedAt < 60_000 && Date.now() < Date.parse(plan.deadlineAt));
    const proof = frozen({...native, kind: 'meri-case12-native-task-admission', version: 1,
      inputByteSha256: bytesHash(rawInput), taskArn: task.taskArn!, clusterArn: task.clusterArn!,
      imageSha256: plan.imageSha256, sourceSha256: plan.sourceSha256, observedAt: new Date().toISOString()});
    const handle = Object.freeze({}), authenticatedAt = Date.now(); let consumed = false;
    return Object.freeze({admission: handle, proof,
      async consumeNativeSetupAdmissionInTx(tx: {$queryRawUnsafe(query: string, ...values: unknown[]): Promise<any[]>},
        opaque: unknown, bindings: any): Promise<Case12SetupBudgetPlan> {
        need(opaque === handle && !consumed); consumed = true;
        need(Date.now() - authenticatedAt < 60_000 && record(bindings?.plan) && record(bindings?.recipe) &&
          bindings.plan.planSha256 === plan.setupPlanSha256 && bindings.plan.recipeSha256 === plan.recipeSha256 &&
          bindings.plan.orderedDefinitionSha256 === plan.orderedDefinitionSha256 &&
          bindings.recipe.fixtureInstanceId === plan.fixtureInstanceId && bindings.recipe.ctx?.tenantId === TENANT &&
          bindings.recipe.ctx?.userId === plan.proposerUserId && bindings.recipe.reviewerUserId === plan.reviewerUserId);
        const rows = await tx.$queryRawUnsafe('SELECT settings_jsonb AS settings, clock_timestamp() AS now FROM tenants WHERE id=$1::uuid FOR UPDATE', TENANT);
        const fixture = rows[0]?.settings?.meriFoundationFixture, now = new Date(rows[0]?.now).getTime();
        need(rows.length === 1 && record(fixture) && fixture.fixtureNamespace === 'meri-foundation-20260928' &&
          Number.isFinite(now) && now >= Date.parse(plan.admittedAt) && now < Date.parse(plan.deadlineAt) &&
          ![SLOT,'case12MemorySetup','case12SetupProviderBudget'].some(key => Object.hasOwn(fixture, key)));
        const receipt = {...proof, admittedAt: new Date(now).toISOString(), captureAuthority: false, liveAcceptance: 'NOT_RUN'};
        const changed = await tx.$queryRawUnsafe(
          `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,${SLOT}}',$1::jsonb,true)
           WHERE id=$2::uuid AND NOT (settings_jsonb->'meriFoundationFixture' ? '${SLOT}')
           RETURNING settings_jsonb #> '{meriFoundationFixture,${SLOT}}' AS admission`, JSON.stringify(receipt), TENANT);
        need(changed.length === 1 && case12SetupHash(changed[0].admission) === case12SetupHash(receipt));
        return plan;
      }});
  } finally {ecs.destroy();}
}
