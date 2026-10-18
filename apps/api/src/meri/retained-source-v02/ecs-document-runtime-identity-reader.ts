import {
  RetainedDocumentRuntimeIdentityReader,
  type RetainedDocumentRuntimeIdentity,
} from './document-runtime-qualification.js';

const TASK_ARN = /^arn:aws:ecs:us-east-1:967807252336:task\/capiro-dev\/[0-9a-f]{32}$/;
const TASK_DEFINITION_ARN = /^arn:aws:ecs:us-east-1:967807252336:task-definition\/capiro-preview-first-chat-core:[1-9][0-9]*$/;
const SHA = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SOURCE_HEAD = /^[a-f0-9]{40}$/;
const DOCKER_ID = /^[a-f0-9]{64}$/;
const METADATA_MAX_BYTES = 1024 * 1024;

/** The metadata endpoint supplies a current task/container selector only. It
 * does not prove the image's reviewed source or effective configuration. */
export interface CurrentCoreTaskSelector {
  taskArn: string;
  taskDefinitionArn: string;
  containerName: 'core';
  dockerId: string;
}

/** Deployment-owned readback must observe the selected current ECS task and
 * container from a separate trusted control-plane source on EVERY call. Its
 * source head must come from the qualified immutable image-to-source build
 * record, and configurationSha256 from a documented current effective-config
 * measurement. Never derive either from task env, tags, OCI labels or headers.
 * There is deliberately no default implementation or Nest provider. */
export abstract class TrustedCoreDeploymentReadbackPort {
  abstract readCurrentTask(selector: CurrentCoreTaskSelector, signal: AbortSignal): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Current Core runtime identity unavailable');
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const candidate = record(value);
  if (Object.keys(candidate).length !== keys.length || !keys.every((key) => Object.hasOwn(candidate, key)))
    throw new Error('Current Core runtime identity unavailable');
  return candidate;
}

function metadataBase(uri: string | undefined): string {
  if (typeof uri !== 'string' || !/^http:\/\/169\.254\.170\.2\/v4\/[A-Za-z0-9-]{1,128}\/?$/.test(uri))
    throw new Error('Current ECS metadata endpoint unavailable');
  let url: URL;
  try { url = new URL(uri); } catch { throw new Error('Current ECS metadata endpoint unavailable'); }
  // ECS injects this locator. It cannot carry source, image or config claims.
  // Refuse all redirects and alternate hosts, credentials, ports or paths.
  if (url.protocol !== 'http:' || url.hostname !== '169.254.170.2' || url.port ||
      url.username || url.password || url.search || url.hash ||
      !/^\/v4\/[A-Za-z0-9-]{1,128}\/?$/.test(url.pathname))
    throw new Error('Current ECS metadata endpoint unavailable');
  return url.href.replace(/\/$/, '');
}

async function readMetadata(url: string, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('Current ECS metadata unavailable');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > METADATA_MAX_BYTES || !response.body)
    throw new Error('Current ECS metadata unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > METADATA_MAX_BYTES) {
        await reader.cancel();
        throw new Error('Current ECS metadata unavailable');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

function readbackWithinDeadline(port: TrustedCoreDeploymentReadbackPort,
  selector: CurrentCoreTaskSelector): Promise<unknown> {
  const abort = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abort.abort();
      reject(new Error('Current Core deployment readback timed out'));
    }, 5_000);
    Promise.resolve().then(() => port.readCurrentTask(selector, abort.signal)).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function currentSelector(container: Record<string, unknown>, task: Record<string, unknown>): CurrentCoreTaskSelector {
  const taskArn = task.TaskARN;
  const revision = task.Revision;
  const taskDefinitionArn = `arn:aws:ecs:us-east-1:967807252336:task-definition/${task.Family}:${revision}`;
  if (typeof taskArn !== 'string' || !TASK_ARN.test(taskArn) ||
      !TASK_DEFINITION_ARN.test(taskDefinitionArn) ||
      task.Cluster !== 'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev' && task.Cluster !== 'capiro-dev' ||
      task.DesiredStatus !== 'RUNNING' || task.KnownStatus !== 'RUNNING' ||
      container.Name !== 'core' || container.KnownStatus !== 'RUNNING' ||
      typeof container.DockerId !== 'string' || !DOCKER_ID.test(container.DockerId))
    throw new Error('Current Core ECS task unavailable');
  const listed = task.Containers;
  if (!Array.isArray(listed) || listed.filter((item) => {
    const row = record(item);
    return row.DockerId === container.DockerId && row.Name === 'core' && row.KnownStatus === 'RUNNING';
  }).length !== 1) throw new Error('Current Core ECS container unavailable');
  return { taskArn, taskDefinitionArn, containerName: 'core', dockerId: container.DockerId };
}

/** Fresh link-local ECS metadata is cross-checked against independently read
 * deployment evidence for the same task and Docker container. This adapter is
 * inert until a real trusted readback port is implemented and registered by
 * the deployment owner; the existing document receiver therefore stays 503. */
export class EcsRetainedDocumentRuntimeIdentityReader extends RetainedDocumentRuntimeIdentityReader {
  constructor(
    private readonly readback: TrustedCoreDeploymentReadbackPort,
    private readonly getMetadataUri: () => string | undefined = () => process.env.ECS_CONTAINER_METADATA_URI_V4,
    private readonly fetchFn: typeof fetch = fetch,
  ) { super(); }

  async readCurrent(): Promise<RetainedDocumentRuntimeIdentity> {
    const base = metadataBase(this.getMetadataUri());
    const container = await readMetadata(base, this.fetchFn);
    const task = await readMetadata(`${base}/task`, this.fetchFn);
    const selector = currentSelector(container, task);
    const evidence = exact(await readbackWithinDeadline(this.readback, selector), [
      'taskArn', 'taskDefinitionArn', 'containerName', 'dockerId',
      'sourceHead', 'imageDigest', 'configurationSha256',
    ]);
    if (evidence.taskArn !== selector.taskArn || evidence.taskDefinitionArn !== selector.taskDefinitionArn ||
        evidence.containerName !== selector.containerName || evidence.dockerId !== selector.dockerId ||
        typeof evidence.sourceHead !== 'string' || !SOURCE_HEAD.test(evidence.sourceHead) ||
        typeof evidence.imageDigest !== 'string' || !IMAGE_DIGEST.test(evidence.imageDigest) ||
        typeof evidence.configurationSha256 !== 'string' || !SHA.test(evidence.configurationSha256))
      throw new Error('Current Core runtime identity unavailable');
    return {
      sourceHead: evidence.sourceHead,
      imageDigest: evidence.imageDigest,
      configurationSha256: evidence.configurationSha256,
    };
  }
}
