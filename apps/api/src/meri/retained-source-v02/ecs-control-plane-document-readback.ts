import {
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  type DescribeTaskDefinitionCommandOutput,
  type DescribeTasksCommandOutput,
  type ListTasksCommandOutput,
} from '@aws-sdk/client-ecs';
import {
  type CurrentCoreTaskSelector,
  TrustedCoreDeploymentReadbackPort,
} from './ecs-document-runtime-identity-reader.js';

const CLUSTER = 'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev';
const SERVICE = 'service:capiro-preview-first-chat-core';
const SERVICE_NAME = 'capiro-preview-first-chat-core';
const FAMILY = 'capiro-preview-first-chat-core';
const IMAGE = /^967807252336\.dkr\.ecr\.us-east-1\.amazonaws\.com\/capiro\/preview-core@(sha256:[a-f0-9]{64})$/;
const SHA = /^[a-f0-9]{64}$/;
const SOURCE = /^[a-f0-9]{40}$/;

/** The ECS client is deliberately a deployment-owned dependency. The current
 * preview task role has no ECS Describe permission, and no permission is added
 * by this source. */
export interface CoreEcsDescribePort {
  listServiceTasks(signal: AbortSignal): Promise<ListTasksCommandOutput>;
  describeTask(taskArn: string, signal: AbortSignal): Promise<DescribeTasksCommandOutput>;
  describeTaskDefinition(taskDefinitionArn: string, signal: AbortSignal): Promise<DescribeTaskDefinitionCommandOutput>;
}

export class AwsSdkCoreEcsDescribePort implements CoreEcsDescribePort {
  constructor(private readonly ecs: ECSClient) {}

  listServiceTasks(signal: AbortSignal): Promise<ListTasksCommandOutput> {
    return this.ecs.send(new ListTasksCommand({
      cluster: CLUSTER, serviceName: SERVICE_NAME, desiredStatus: 'RUNNING', maxResults: 100,
    }), { abortSignal: signal });
  }

  describeTask(taskArn: string, signal: AbortSignal): Promise<DescribeTasksCommandOutput> {
    return this.ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: [taskArn] }), { abortSignal: signal });
  }

  describeTaskDefinition(taskDefinitionArn: string, signal: AbortSignal): Promise<DescribeTaskDefinitionCommandOutput> {
    return this.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefinitionArn }),
      { abortSignal: signal });
  }
}

/** Separate reviewed immutable build record, keyed by the actual ECS digest.
 * Neither task environment, OCI labels nor ECR tags may provide sourceHead. */
export abstract class QualifiedCoreImageProvenancePort {
  abstract readForDigest(imageDigest: string, signal: AbortSignal): Promise<unknown>;
}

/** Independent measurement of the selected task's current effective config.
 * Its defined measurement must include the task definition and separately
 * governed feature/config inputs. Reading task environment alone is not an
 * implementation of this port. */
export abstract class CurrentCoreEffectiveConfigurationPort {
  abstract readForTask(selector: CurrentCoreTaskSelector, imageDigest: string,
    signal: AbortSignal): Promise<unknown>;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Current Core deployment readback unavailable');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || !keys.every((key) => Object.hasOwn(row, key)))
    throw new Error('Current Core deployment readback unavailable');
  return row;
}

/** The task's group string is not service membership: RunTask may supply it.
 * ECS ListTasks with a serviceName filter is the independent service index.
 * Fail closed on truncated pages instead of accepting an incomplete index. */
async function assertServiceMembership(ecs: CoreEcsDescribePort,
  selector: CurrentCoreTaskSelector, signal: AbortSignal): Promise<void> {
  const response = await ecs.listServiceTasks(signal);
  if (response.nextToken != null || !Array.isArray(response.taskArns) ||
      response.taskArns.filter((arn) => arn === selector.taskArn).length !== 1)
    throw new Error('Current Core ECS service membership unavailable');
}

function currentDigest(response: DescribeTasksCommandOutput, selector: CurrentCoreTaskSelector): string {
  if (response.failures?.length || response.tasks?.length !== 1)
    throw new Error('Current Core ECS task unavailable');
  const task = response.tasks[0]!;
  if (task.taskArn !== selector.taskArn || task.clusterArn !== CLUSTER ||
      task.taskDefinitionArn !== selector.taskDefinitionArn || task.group !== SERVICE ||
      task.launchType !== 'FARGATE' || task.desiredStatus !== 'RUNNING' || task.lastStatus !== 'RUNNING')
    throw new Error('Current Core ECS task unavailable');
  const selected = task.containers?.filter((container) =>
    container.name === selector.containerName && container.runtimeId === selector.dockerId);
  if (selected?.length !== 1 || selected[0]!.lastStatus !== 'RUNNING' ||
      typeof selected[0]!.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(selected[0]!.imageDigest))
    throw new Error('Current Core ECS container unavailable');
  return selected[0]!.imageDigest;
}

function assertTaskDefinition(response: DescribeTaskDefinitionCommandOutput,
  selector: CurrentCoreTaskSelector, digest: string): void {
  const task = response.taskDefinition;
  if (!task || task.taskDefinitionArn !== selector.taskDefinitionArn || task.family !== FAMILY ||
      task.status !== 'ACTIVE' || !Number.isSafeInteger(task.revision) || (task.revision ?? 0) < 1)
    throw new Error('Current Core task definition unavailable');
  const selected = task.containerDefinitions?.filter((container) => container.name === 'core');
  if (selected?.length !== 1 || typeof selected[0]!.image !== 'string')
    throw new Error('Current Core task definition unavailable');
  const image = IMAGE.exec(selected[0]!.image);
  if (!image || image[1] !== digest)
    throw new Error('Current Core image digest unavailable');
}

/** Concrete ECS control-plane half of the existing trusted readback seam.
 * It is intentionally not registered as a Nest provider. The two external
 * evidence ports must be independently implemented and current; missing or
 * mismatched observations keep retained documents at 503. */
export class EcsControlPlaneDocumentReadback extends TrustedCoreDeploymentReadbackPort {
  constructor(
    private readonly ecs: CoreEcsDescribePort,
    private readonly provenance: QualifiedCoreImageProvenancePort,
    private readonly configuration: CurrentCoreEffectiveConfigurationPort,
  ) { super(); }

  async readCurrentTask(selector: CurrentCoreTaskSelector, signal: AbortSignal): Promise<unknown> {
    await assertServiceMembership(this.ecs, selector, signal);
    const digest = currentDigest(await this.ecs.describeTask(selector.taskArn, signal), selector);
    assertTaskDefinition(await this.ecs.describeTaskDefinition(selector.taskDefinitionArn, signal), selector, digest);
    const build = exact(await this.provenance.readForDigest(digest, signal), ['imageDigest', 'sourceHead']);
    if (build.imageDigest !== digest || typeof build.sourceHead !== 'string' || !SOURCE.test(build.sourceHead))
      throw new Error('Qualified Core image provenance unavailable');
    const config = exact(await this.configuration.readForTask(selector, digest, signal),
      ['taskArn', 'taskDefinitionArn', 'imageDigest', 'configurationSha256']);
    if (config.taskArn !== selector.taskArn || config.taskDefinitionArn !== selector.taskDefinitionArn ||
        config.imageDigest !== digest || typeof config.configurationSha256 !== 'string' ||
        !SHA.test(config.configurationSha256))
      throw new Error('Current Core effective configuration unavailable');
    if (currentDigest(await this.ecs.describeTask(selector.taskArn, signal), selector) !== digest)
      throw new Error('Current Core ECS image changed during readback');
    await assertServiceMembership(this.ecs, selector, signal);
    return {
      taskArn: selector.taskArn,
      taskDefinitionArn: selector.taskDefinitionArn,
      containerName: selector.containerName,
      dockerId: selector.dockerId,
      sourceHead: build.sourceHead,
      imageDigest: digest,
      configurationSha256: config.configurationSha256,
    };
  }
}
