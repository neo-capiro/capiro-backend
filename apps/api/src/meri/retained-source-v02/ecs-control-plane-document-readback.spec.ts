import {
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  type DescribeTaskDefinitionCommandOutput,
  type DescribeTasksCommandOutput,
} from '@aws-sdk/client-ecs';
import type { CurrentCoreTaskSelector } from './ecs-document-runtime-identity-reader.js';
import {
  AwsSdkCoreEcsDescribePort,
  EcsControlPlaneDocumentReadback,
  type CoreEcsDescribePort,
  type CurrentCoreEffectiveConfigurationPort,
  type QualifiedCoreImageProvenancePort,
} from './ecs-control-plane-document-readback.js';

const taskArn = `arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/${'a'.repeat(32)}`;
const taskDefinitionArn = 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-preview-first-chat-core:8';
const dockerId = `${'d'.repeat(32)}1234567890`;
const digest = `sha256:${'b'.repeat(64)}`;
const sourceHead = 'c'.repeat(40);
const configurationSha256 = 'e'.repeat(64);
const selector: CurrentCoreTaskSelector = { taskArn, taskDefinitionArn, containerName: 'core', dockerId };
const task = {
  taskArn, taskDefinitionArn,
  clusterArn: 'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev',
  group: 'service:capiro-preview-first-chat-core', launchType: 'FARGATE',
  desiredStatus: 'RUNNING', lastStatus: 'RUNNING',
  containers: [{ name: 'core', runtimeId: dockerId, lastStatus: 'RUNNING', imageDigest: digest }],
};
const definition = {
  taskDefinitionArn, family: 'capiro-preview-first-chat-core', revision: 8, status: 'ACTIVE',
  containerDefinitions: [{ name: 'core',
    image: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-core@${digest}` }],
};
const build = { imageDigest: digest, sourceHead };
const config = { taskArn, taskDefinitionArn, imageDigest: digest, configurationSha256 };
const signal = new AbortController().signal;

function harness(changes: {
  task?: unknown; secondTask?: unknown; definition?: unknown; build?: unknown; config?: unknown;
} = {}) {
  const selected = (key: keyof typeof changes, fallback: unknown) =>
    Object.hasOwn(changes, key) ? changes[key] : fallback;
  let readCount = 0;
  const describeTask = jest.fn(async () => ({
    $metadata: {}, tasks: [++readCount === 1
      ? selected('task', task) : selected('secondTask', selected('task', task))],
  } as DescribeTasksCommandOutput));
  const describeTaskDefinition = jest.fn(async () => ({ $metadata: {},
    taskDefinition: selected('definition', definition) } as DescribeTaskDefinitionCommandOutput));
  const readForDigest = jest.fn(async () => selected('build', build));
  const readForTask = jest.fn(async () => selected('config', config));
  const reader = new EcsControlPlaneDocumentReadback(
    { describeTask, describeTaskDefinition } as CoreEcsDescribePort,
    { readForDigest } as QualifiedCoreImageProvenancePort,
    { readForTask } as CurrentCoreEffectiveConfigurationPort,
  );
  return { reader, describeTask, describeTaskDefinition, readForDigest, readForTask };
}

describe('Core ECS independent control-plane readback', () => {
  it('binds the current running container, digest-pinned task definition, reviewed build and current config', async () => {
    const h = harness();
    await expect(h.reader.readCurrentTask(selector, signal)).resolves.toEqual({
      ...selector, sourceHead, imageDigest: digest, configurationSha256,
    });
    expect(h.describeTask).toHaveBeenCalledTimes(2);
    expect(h.describeTask).toHaveBeenNthCalledWith(1, taskArn, signal);
    expect(h.describeTaskDefinition).toHaveBeenCalledWith(taskDefinitionArn, signal);
    expect(h.readForDigest).toHaveBeenCalledWith(digest, signal);
    expect(h.readForTask).toHaveBeenCalledWith(selector, digest, signal);
  });

  it.each([
    ['wrong selected task', { ...task, taskArn: taskArn.replace('a'.repeat(32), 'f'.repeat(32)) }],
    ['stopping task', { ...task, desiredStatus: 'STOPPED' }],
    ['wrong service', { ...task, group: 'service:unreviewed' }],
    ['wrong container runtime', { ...task, containers: [{ ...task.containers[0], runtimeId: 'f'.repeat(64) }] }],
    ['ambiguous container runtime', { ...task, containers: [task.containers[0], task.containers[0]] }],
    ['no digest', { ...task, containers: [{ ...task.containers[0], imageDigest: undefined }] }],
  ])('rejects %s before provenance and config', async (_label, changed) => {
    const h = harness({ task: changed });
    await expect(h.reader.readCurrentTask(selector, signal)).rejects.toThrow();
    expect(h.readForDigest).not.toHaveBeenCalled();
    expect(h.readForTask).not.toHaveBeenCalled();
  });

  it.each([
    ['mutable image tag', { ...definition, containerDefinitions: [{ name: 'core', image: 'capiro/preview-core:latest' }] }],
    ['different digest', { ...definition, containerDefinitions: [{ name: 'core', image:
      `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-core@sha256:${'f'.repeat(64)}` }] }],
    ['wrong family', { ...definition, family: 'other' }],
    ['retired definition', { ...definition, status: 'INACTIVE' }],
  ])('rejects %s before provenance and config', async (_label, changed) => {
    const h = harness({ definition: changed });
    await expect(h.reader.readCurrentTask(selector, signal)).rejects.toThrow();
    expect(h.readForDigest).not.toHaveBeenCalled();
    expect(h.readForTask).not.toHaveBeenCalled();
  });

  it.each([
    ['missing build', null, config],
    ['mismatched build digest', { ...build, imageDigest: `sha256:${'f'.repeat(64)}` }, config],
    ['unreviewed extra source field', { ...build, RELEASE_SHA: sourceHead }, config],
    ['missing config', build, null],
    ['wrong config task', build, { ...config, taskArn: taskArn.replace('a'.repeat(32), 'f'.repeat(32)) }],
    ['wrong config digest', build, { ...config, imageDigest: `sha256:${'f'.repeat(64)}` }],
  ])('rejects %s', async (_label, changedBuild, changedConfig) => {
    const h = harness({ build: changedBuild, config: changedConfig });
    await expect(h.reader.readCurrentTask(selector, signal)).rejects.toThrow();
  });

  it('refuses a task that changes or stops while provenance and config are read', async () => {
    const h = harness({ secondTask: { ...task, lastStatus: 'STOPPED' } });
    await expect(h.reader.readCurrentTask(selector, signal)).rejects.toThrow();
    expect(h.describeTask).toHaveBeenCalledTimes(2);
  });

  it('sends read-only ECS commands with the exact cluster and selected ARNs', async () => {
    const send = jest.fn(async (_command: unknown, _options: unknown) => ({ $metadata: {} }));
    const port = new AwsSdkCoreEcsDescribePort({ send } as unknown as ECSClient);
    await port.describeTask(taskArn, signal);
    await port.describeTaskDefinition(taskDefinitionArn, signal);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(DescribeTasksCommand);
    expect((send.mock.calls[0]![0] as DescribeTasksCommand).input).toEqual({
      cluster: 'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev', tasks: [taskArn],
    });
    expect(send.mock.calls[1]![0]).toBeInstanceOf(DescribeTaskDefinitionCommand);
    expect((send.mock.calls[1]![0] as DescribeTaskDefinitionCommand).input).toEqual({ taskDefinition: taskDefinitionArn });
    expect(send.mock.calls[0]![1]).toEqual({ abortSignal: signal });
  });
});
