import {
  EcsRetainedDocumentRuntimeIdentityReader,
  type CurrentCoreTaskSelector,
  type TrustedCoreDeploymentReadbackPort,
} from './ecs-document-runtime-identity-reader.js';
import { qualifyDocumentTextOnlyRuntime } from './document-runtime-qualification.js';

const uri = 'http://169.254.170.2/v4/170b79d4-31ca-4d9c-9908-5ab64c959972';
const taskArn = `arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/${'a'.repeat(32)}`;
const taskDefinitionArn = 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-preview-first-chat-core:8';
const dockerId = 'd'.repeat(64);
const pins = {
  sourceHead: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
  configurationSha256: 'c'.repeat(64),
};
const container = { DockerId: dockerId, Name: 'core', KnownStatus: 'RUNNING',
  // Untrusted local claims cannot supply the qualified pins.
  Labels: { RELEASE_SHA: 'f'.repeat(40) }, ImageID: `sha256:${'e'.repeat(64)}` };
const task = { TaskARN: taskArn, Cluster: 'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev',
  Family: 'capiro-preview-first-chat-core', Revision: '8', DesiredStatus: 'RUNNING', KnownStatus: 'RUNNING',
  Containers: [{ ...container }] };
const evidence = { taskArn, taskDefinitionArn, containerName: 'core', dockerId, ...pins };
const allocation = { allocationSha256: 'e'.repeat(64), profileVersion: '1.1.0' as const, chargeMicrousd: 1 as const,
  documentPricing: { mode: 'source_text_only' as const, route: '/api/clio/tools/read_client_documents' as const,
    coreSourceCommit: pins.sourceHead, coreImageDigest: pins.imageDigest,
    configurationSha256: pins.configurationSha256 } };

function harness(options: { container?: unknown; task?: unknown; evidence?: unknown; uri?: string } = {}) {
  const currentContainer = options.container ?? container;
  const currentTask = options.task ?? task;
  const fetchFn = jest.fn(async (url: string) =>
    new Response(JSON.stringify(url.endsWith('/task') ? currentTask : currentContainer))) as unknown as typeof fetch;
  const readCurrentTask = jest.fn(async (_selector: CurrentCoreTaskSelector, _signal: AbortSignal) =>
    Object.hasOwn(options, 'evidence') ? options.evidence : evidence);
  const reader = new EcsRetainedDocumentRuntimeIdentityReader(
    { readCurrentTask } as TrustedCoreDeploymentReadbackPort,
    () => options.uri ?? uri, fetchFn,
  );
  return { reader, fetchFn: fetchFn as jest.Mock, readCurrentTask };
}

describe('ECS document runtime identity adapter', () => {
  it('uses fresh ECS metadata only to select the running container, then independently reads exact pins', async () => {
    const { reader, fetchFn, readCurrentTask } = harness();
    expect(await reader.readCurrent()).toEqual(pins);
    expect(qualifyDocumentTextOnlyRuntime(allocation, await reader.readCurrent())).toMatch(/^[a-f0-9]{64}$/);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(fetchFn.mock.calls.map((call: unknown[]) => call[0])).toEqual([uri, `${uri}/task`, uri, `${uri}/task`]);
    expect(readCurrentTask).toHaveBeenCalledTimes(2);
    expect(readCurrentTask.mock.calls[0]![0]).toEqual({ taskArn, taskDefinitionArn, containerName: 'core', dockerId });
    expect(readCurrentTask.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    expect(fetchFn.mock.calls.every((call: unknown[]) => (call[1] as RequestInit).redirect === 'error')).toBe(true);
  });

  it.each([
    'https://169.254.170.2/v4/example', 'http://metadata.example/v4/example',
    'http://169.254.170.2:80/v4/example', 'http://169.254.170.2/v4/example?source=a',
    'http://169.254.170.2/v4/example/task', 'http://user@169.254.170.2/v4/example',
  ])('rejects a noncanonical metadata locator %s before fetch or readback', async (badUri) => {
    const { reader, fetchFn, readCurrentTask } = harness({ uri: badUri });
    await expect(reader.readCurrent()).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(readCurrentTask).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong task ARN', { ...task, TaskARN: taskArn.replace('capiro-dev', 'another') }],
    ['wrong family', { ...task, Family: 'capiro-api' }],
    ['stopping task', { ...task, DesiredStatus: 'STOPPED' }],
    ['wrong cluster', { ...task, Cluster: 'another' }],
    ['mismatched Docker ID', { ...task, Containers: [{ ...container, DockerId: 'f'.repeat(64) }] }],
    ['ambiguous Docker ID', { ...task, Containers: [container, container] }],
  ])('refuses %s without calling the trusted readback', async (_label, changedTask) => {
    const { reader, readCurrentTask } = harness({ task: changedTask });
    await expect(reader.readCurrent()).rejects.toThrow();
    expect(readCurrentTask).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong container', { ...container, Name: 'worker' }],
    ['stopped container', { ...container, KnownStatus: 'STOPPED' }],
    ['missing Docker ID', { ...container, DockerId: undefined }],
  ])('refuses %s without calling the trusted readback', async (_label, changedContainer) => {
    const { reader, readCurrentTask } = harness({ container: changedContainer });
    await expect(reader.readCurrent()).rejects.toThrow();
    expect(readCurrentTask).not.toHaveBeenCalled();
  });

  it.each([
    ['task ARN', { ...evidence, taskArn: taskArn.replace('a'.repeat(32), 'b'.repeat(32)) }],
    ['task definition', { ...evidence, taskDefinitionArn: taskDefinitionArn.replace(':8', ':9') }],
    ['container runtime ID', { ...evidence, dockerId: 'f'.repeat(64) }],
    ['image digest', { ...evidence, imageDigest: 'latest' }],
    ['source head', { ...evidence, sourceHead: 'not-a-commit' }],
    ['configuration hash', { ...evidence, configurationSha256: 'bad' }],
    ['unreviewed extra claim', { ...evidence, RELEASE_SHA: pins.sourceHead }],
  ])('refuses %s from the independent port', async (_label, changedEvidence) => {
    await expect(harness({ evidence: changedEvidence }).reader.readCurrent()).rejects.toThrow();
  });

  it('does not synthesize identity from task labels, image ID or process environment', async () => {
    const { reader } = harness({ evidence: null });
    await expect(reader.readCurrent()).rejects.toThrow();
  });

  it('refuses oversized metadata while streaming, before independent readback', async () => {
    const fetchFn = jest.fn(async () => new Response('x'.repeat(1024 * 1024 + 1))) as unknown as typeof fetch;
    const readCurrentTask = jest.fn(async () => evidence);
    const reader = new EcsRetainedDocumentRuntimeIdentityReader(
      { readCurrentTask } as TrustedCoreDeploymentReadbackPort, () => uri, fetchFn,
    );
    await expect(reader.readCurrent()).rejects.toThrow();
    expect(readCurrentTask).not.toHaveBeenCalled();
  });

  it('enforces a deadline even if the independent readback ignores its abort signal', async () => {
    jest.useFakeTimers();
    try {
      const { reader, readCurrentTask } = harness();
      readCurrentTask.mockImplementation(async () => new Promise(() => {}));
      const result = expect(reader.readCurrent()).rejects.toThrow('timed out');
      await jest.advanceTimersByTimeAsync(0);
      expect(readCurrentTask).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(5_000);
      await result;
    } finally {
      jest.useRealTimers();
    }
  });
});
