const mockSend = jest.fn(), mockDestroy = jest.fn();
jest.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: jest.fn().mockImplementation(() => ({send: (...args: any[]) => mockSend(...args), destroy: mockDestroy})),
  DescribeTasksCommand: class {kind = 'tasks'; constructor(public input: unknown) {}},
  DescribeTaskDefinitionCommand: class {kind = 'definition'; constructor(public input: unknown) {}},
}));
import { randomUUID } from 'node:crypto';
import { ECSClient } from '@aws-sdk/client-ecs';
import { assertCase12NativeTaskOverrides, case12NativeTaskDefinitionHash, createCase12NativeSetupAdmission } from './meri-case12-native-setup-admission.js';
import { case12SetupCost, case12SetupHash, validateCase12SetupBudgetPlan } from './meri-case12-setup-budget.js';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const env = {...process.env}; let fetchSpy: jest.SpyInstance;
beforeEach(() => {jest.resetAllMocks(); jest.useFakeTimers().setSystemTime(NOW);
  fetchSpy = jest.spyOn(globalThis, 'fetch');
  jest.mocked(ECSClient).mockImplementation(() => ({send: (...args: any[]) => mockSend(...args), destroy: mockDestroy}) as never);
});
afterEach(() => {fetchSpy.mockRestore(); jest.useRealTimers(); process.env = {...env};});
function fixture() {
  const plan = validateCase12SetupBudgetPlan({version: 1, caseId: '12', fixtureNamespace: 'meri-foundation-20260928',
    fixtureInstanceId: randomUUID(), runId: randomUUID(), aggregateReservationId: randomUUID(),
    tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f', proposerUserId: randomUUID(), reviewerUserId: randomUUID(), clientId: randomUUID(),
    setupPlanSha256: '1'.repeat(64), recipeSha256: '2'.repeat(64), orderedDefinitionSha256: '3'.repeat(64),
    sourceSha256: '4'.repeat(64), imageSha256: '5'.repeat(64), aggregateCheckpointSha256: '6'.repeat(64), rateEvidenceSha256: '7'.repeat(64),
    admittedAt: new Date(NOW - 1000).toISOString(), deadlineAt: new Date(NOW + 600_000).toISOString(), ratesExpiresAt: new Date(NOW + 700_000).toISOString(),
    rates: {openai_embeddings: {inputPerM: 0.02, outputPerM: 0}, bedrock_embeddings: {inputPerM: 0.02, outputPerM: 0}},
    maxCostMicros: 510 * 2 * case12SetupCost(0.02, 8192),
    rows: Array.from({length: 510}, (_, i) => ({candidateId: `00000000-0000-5000-8000-${String(i).padStart(12, '0')}`,
      logicalId: i === 0 ? 'MA510' : `MA510-DISTRACTOR-${String(i).padStart(4, '0')}`, candidatePayloadSha256: '8'.repeat(64),
      requests: {openai_embeddings: {bodySha256: '9'.repeat(64), inputBytes: 100}, bedrock_embeddings: {bodySha256: 'a'.repeat(64), inputBytes: 100}}}))});
  const family = 'capiro-dev-meri-c2-case12-setup-local-test', arn = `arn:aws:ecs:us-east-1:967807252336:task-definition/${family}:1`;
  const clusterArn = 'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev', taskArn = 'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/' + 'a'.repeat(32);
  const container = {name: 'api', image: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:${plan.imageSha256}`,
    command: ['node', 'scripts/local-test-only-no-dispatch.mjs'], environment: [{name: 'GIT_SHA', value: 'b'.repeat(40)}]};
  const definition = {taskDefinitionArn: arn, family, revision: 1, status: 'ACTIVE' as const, containerDefinitions: [container]};
  const native = {kind: 'meri-case12-ecs-native-setup', version: 1, taskDefinitionArn: arn,
    taskDefinitionSha256: case12NativeTaskDefinitionHash(definition), containerName: 'api',
    startedBy: 'c12-' + randomUUID(), registrationMarker: randomUUID(), releaseGitRevision: 'b'.repeat(40),
    setupRunId: plan.runId, reservationId: plan.aggregateReservationId, fixtureInstanceId: plan.fixtureInstanceId,
    setupPlanSha256: plan.setupPlanSha256, providerPlanSha256: case12SetupHash(plan),
    preHoldCheckpointSha256: plan.aggregateCheckpointSha256, postHoldCheckpointSha256: 'c'.repeat(64), costAuthoritySha256: 'd'.repeat(64)};
  const raw = JSON.stringify({native}), tags = [{key: 'meri-case12-setup-owner', value: native.registrationMarker}];
  const task = {taskArn, clusterArn, taskDefinitionArn: arn, startedBy: native.startedBy, launchType: 'FARGATE',
    desiredStatus: 'RUNNING', lastStatus: 'RUNNING', group: 'family:' + family, tags,
    containers: [{name: 'api', imageDigest: 'sha256:' + plan.imageSha256}],
    overrides: {containerOverrides: [{name: 'api', environment: [{name: 'MERI_CASE12_NATIVE_SETUP_INPUT', value: raw}]}]}};
  const meta = {Cluster: clusterArn, TaskARN: taskArn, Family: family, Revision: '1',
    Containers: [{Name: 'api', ImageID: 'sha256:' + plan.imageSha256}]};
  process.env.GIT_SHA = native.releaseGitRevision; process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = plan.fixtureNamespace;
  process.env.MERI_CASE12_NATIVE_SETUP_INPUT = raw; process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://169.254.170.2/v4/owned-test';
  fetchSpy.mockImplementation(async () => new Response(JSON.stringify(meta), {status: 200}));
  mockSend.mockImplementation(async cmd => cmd.kind === 'tasks' ? {tasks: [task], failures: []} : {taskDefinition: definition, tags});
  const bindings = {recipe: {fixtureInstanceId: plan.fixtureInstanceId, ctx: {tenantId: plan.tenantId, userId: plan.proposerUserId}, reviewerUserId: plan.reviewerUserId},
    plan: {planSha256: plan.setupPlanSha256, recipeSha256: plan.recipeSha256, orderedDefinitionSha256: plan.orderedDefinitionSha256}};
  const state: any = {fixtureNamespace: plan.fixtureNamespace};
  const tx = {$queryRawUnsafe: jest.fn(async (query: string, ...args: any[]) => {
    if (query.startsWith('SELECT')) return [{settings: {meriFoundationFixture: state}, now: new Date(NOW)}];
    const admission = JSON.parse(args[0]); state.case12NativeSetupAdmission = admission; return [{admission}];
  })};
  return {plan, raw, native, task, meta, definition, container, bindings, state, tx};
}

test('fixed native reads bind self/input/image/config before one locked durable consume', async () => {
  const h = fixture(), owner = await createCase12NativeSetupAdmission(h.raw, h.plan);
  expect(ECSClient).toHaveBeenCalledWith({region: 'us-east-1', maxAttempts: 1});
  expect(fetchSpy).toHaveBeenCalledWith('http://169.254.170.2/v4/owned-test/task', expect.objectContaining({redirect: 'error'}));
  expect(mockSend).toHaveBeenCalledTimes(2); expect(h.tx.$queryRawUnsafe).not.toHaveBeenCalled();
  await expect(owner.consumeNativeSetupAdmissionInTx(h.tx, {}, h.bindings)).rejects.toThrow('denied');
  expect(await owner.consumeNativeSetupAdmissionInTx(h.tx, owner.admission, h.bindings)).toEqual(h.plan);
  expect(h.state.case12NativeSetupAdmission).toMatchObject({taskArn: h.task.taskArn, kind: 'meri-case12-native-task-admission', captureAuthority: false});
  await expect(owner.consumeNativeSetupAdmissionInTx(h.tx, owner.admission, h.bindings)).rejects.toThrow('denied');
  expect(h.tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
});
test.each(['metadata-host','metadata-task','metadata-image','foreign-cluster','service','restart',
  'wrong-startedBy','wrong-image','wrong-definition','changed-env','changed-command','missing-tag','not-running','wrong-plan'])(
  '%s fails before any durable consume', async fault => {
    const h = fixture();
    if (fault === 'metadata-host') process.env.ECS_CONTAINER_METADATA_URI_V4 = 'https://example.com/v4/owned';
    if (fault === 'metadata-task') h.meta.TaskARN = h.task.taskArn.replace('a'.repeat(32), 'b'.repeat(32));
    if (fault === 'metadata-image') h.meta.Containers[0]!.ImageID = 'sha256:' + '0'.repeat(64);
    if (fault === 'foreign-cluster') h.meta.Cluster += '-foreign';
    if (fault === 'service') Object.assign(h.meta, {ServiceName: 'capiro-dev-api'});
    if (fault === 'restart') Object.assign(h.meta.Containers[0]!, {RestartCount: 1});
    if (fault === 'wrong-startedBy') h.task.startedBy = 'c12-' + randomUUID();
    if (fault === 'wrong-image') h.task.containers[0]!.imageDigest = 'sha256:' + '0'.repeat(64);
    if (fault === 'wrong-definition') h.task.taskDefinitionArn += '0';
    if (fault === 'changed-env') h.task.overrides.containerOverrides[0]!.environment.push({name: 'OTHER', value: 'changed'});
    if (fault === 'changed-command') h.container.command.push('changed');
    if (fault === 'missing-tag') h.task.tags = [];
    if (fault === 'not-running') h.task.lastStatus = 'STOPPED';
    const plan = fault === 'wrong-plan' ? {...h.plan, sourceSha256: '0'.repeat(64)} : h.plan;
    await expect(createCase12NativeSetupAdmission(h.raw, plan)).rejects.toThrow('denied');
    expect(h.tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
test.each(['existing-claim','expired','changed-binding','lost-cas-readback'])(
  '%s consumes handle once and cannot retry a failed native admission', async fault => {
    const h = fixture(), owner = await createCase12NativeSetupAdmission(h.raw, h.plan);
    if (fault === 'existing-claim') h.state.case12MemorySetup = {};
    if (fault === 'expired') jest.setSystemTime(NOW + 600_001);
    if (fault === 'changed-binding') h.bindings.plan.planSha256 = '0'.repeat(64);
    if (fault === 'lost-cas-readback') h.tx.$queryRawUnsafe.mockImplementationOnce(async () => [{settings: {meriFoundationFixture: h.state}, now: new Date(NOW)}] as any).mockImplementationOnce(async () => []);
    await expect(owner.consumeNativeSetupAdmissionInTx(h.tx, owner.admission, h.bindings)).rejects.toThrow('denied');
    const calls = h.tx.$queryRawUnsafe.mock.calls.length;
    await expect(owner.consumeNativeSetupAdmissionInTx(h.tx, owner.admission, h.bindings)).rejects.toThrow('denied');
    expect(h.tx.$queryRawUnsafe).toHaveBeenCalledTimes(calls);
  });
test.each(['postHoldCheckpointSha256','costAuthoritySha256','preHoldCheckpointSha256','providerPlanSha256',
  'taskDefinitionSha256','setupPlanSha256','releaseGitRevision','startedBy','registrationMarker','taskDefinitionArn'])(
  'array-valued %s is rejected before metadata or AWS reads', async field => {
    const h = fixture(), input = JSON.parse(h.raw); input.native[field] = [input.native[field]];
    const raw = JSON.stringify(input); process.env.MERI_CASE12_NATIVE_SETUP_INPUT = raw;
    await expect(createCase12NativeSetupAdmission(raw, h.plan)).rejects.toThrow('denied');
    expect(fetchSpy).not.toHaveBeenCalled(); expect(mockSend).not.toHaveBeenCalled();
  });


// Actual @aws-sdk/client-ecs 3.1141.0 DescribeTasks read on 2026-10-04:
// the owned IAM probe omitted inference overrides at RunTask; ECS returned [].
// Only the service-added empty field is reused below; identity/metadata/SQL stay doubles.
const observedEcsOverrides = {"containerOverrides":[{"name":"meri-c12-iam-read-probe"}],"inferenceAcceleratorOverrides":[]};
test('real SDK empty inference default permits exact native admission and one consume', async () => {
  const h = fixture();
  Object.assign(h.task.overrides, {inferenceAcceleratorOverrides: observedEcsOverrides.inferenceAcceleratorOverrides});
  const owner = await createCase12NativeSetupAdmission(h.raw, h.plan);
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(await owner.consumeNativeSetupAdmissionInTx(h.tx, owner.admission, h.bindings)).toEqual(h.plan);
  await expect(owner.consumeNativeSetupAdmissionInTx(h.tx, owner.admission, h.bindings)).rejects.toThrow('denied');
});
test.each([
  ['nonempty-inference', {inferenceAcceleratorOverrides: [{deviceName: 'changed', deviceType: 'changed'}]}],
  ['null-inference', {inferenceAcceleratorOverrides: null}],
  ['object-inference', {inferenceAcceleratorOverrides: {length: 0}}],
  ['string-inference', {inferenceAcceleratorOverrides: ''}],
  ['task-role', {taskRoleArn: 'arn:aws:iam::967807252336:role/other'}],
  ['execution-role', {executionRoleArn: 'arn:aws:iam::967807252336:role/other'}],
  ['cpu', {cpu: '512'}],
  ['memory', {memory: '1024'}],
  ['ephemeral-storage', {ephemeralStorage: {sizeInGiB: 30}}],
  ['unknown-empty', {unknown: []}],
])('real empty inference default does not admit %s override', async (_name, additional) => {
  const h = fixture();
  Object.assign(h.task.overrides, {inferenceAcceleratorOverrides: []}, additional);
  await expect(createCase12NativeSetupAdmission(h.raw, h.plan)).rejects.toThrow('denied');
  expect(mockSend).toHaveBeenCalledTimes(1);expect(h.tx.$queryRawUnsafe).not.toHaveBeenCalled();
});
test.each(['cpu','memory','command','environment','environmentFiles','extraContainer'])(
  'empty inference default does not hide changed container %s', async field => {
    const h = fixture();Object.assign(h.task.overrides, {inferenceAcceleratorOverrides: []});
    const c = h.task.overrides.containerOverrides[0]!;
    if(field==='environment') c.environment.push({name: 'FOREIGN', value: 'value'});
    else if(field==='extraContainer') h.task.overrides.containerOverrides.push({name: 'other', environment: []});
    else Object.assign(c, {[field]: field==='command'?['execute','again']:field==='environmentFiles'?[]:1});
    await expect(createCase12NativeSetupAdmission(h.raw, h.plan)).rejects.toThrow('denied');
    expect(mockSend).toHaveBeenCalledTimes(1);expect(h.tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });


test('pure exact inspector accepts actual retained SDK override bytes without authority', () => {
  const expected = {containerOverrides: observedEcsOverrides.containerOverrides};
  expect(() => assertCase12NativeTaskOverrides(observedEcsOverrides, expected)).not.toThrow();
  expect(() => assertCase12NativeTaskOverrides(expected, expected)).not.toThrow();
  for(const value of [null, '', {}, {length:0}, undefined, [{deviceName:'changed'}]])
    expect(() => assertCase12NativeTaskOverrides({...expected,inferenceAcceleratorOverrides:value},expected)).toThrow('denied');
  for(const key of ['taskRoleArn','executionRoleArn','cpu','command','environment','unknown'])
    expect(() => assertCase12NativeTaskOverrides({...observedEcsOverrides,[key]:[]},expected)).toThrow('denied');
});
