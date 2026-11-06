import { LEGIWATCH_IMPACT_REFRESH_JOB } from '../ingestion-schedule';
import { FIRST_CHAT_CORE_LIVE } from './first-chat-core';

const account = '967807252336';
const region = 'us-east-1';
const cloneHost = 'capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com';
const ruleName = 'capiro-preview-legiwatch-impact-refresh';

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Refresh configuration object required');
  return value as Record<string, any>;
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function uniqueValues(input: unknown, pattern: RegExp, maximum: number): string[] {
  requireValue(Array.isArray(input) && input.length > 0 && input.length <= maximum &&
    new Set(input).size === input.length && input.every((value) => typeof value === 'string' && pattern.test(value)),
  'Explicit distinct private network identifiers required');
  return input;
}
function envMap(input: unknown): Record<string, string> {
  requireValue(Array.isArray(input) && input.every((item) => item && typeof item.name === 'string' &&
    typeof item.value === 'string') && new Set(input.map((item) => item.name)).size === input.length,
  'Unique string environment entries required');
  return Object.fromEntries(input.map((item) => [item.name, item.value]));
}

/** Emits AWS API request bodies from an inspected registered worker task.
 * Validation is local; image qualification and AWS readback remain release gates. */
export function firstChatCoreLegiwatchRefreshPlan(input: unknown, expected: {
  environment: { name: string; value: string }[];
  secretArns: Record<string, string>;
}) {
  const binding = record(input);
  const names = ['taskDefinition', 'sourceHead', 'imageDigest', 'clusterArn', 'invocationRoleArn', 'subnetIds', 'securityGroupIds'];
  requireValue(Object.keys(binding).length === names.length && names.every((name) => Object.hasOwn(binding, name)),
    'Exact refresh binding fields required');
  requireValue(typeof binding.sourceHead === 'string' && /^[a-f0-9]{40}$/.test(binding.sourceHead), 'Exact source commit required');
  requireValue(typeof binding.imageDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(binding.imageDigest), 'Exact qualified image digest required');
  requireValue(binding.clusterArn === `arn:aws:ecs:${region}:${account}:cluster/capiro-dev`, 'Existing preview cluster required');
  const rolePattern = new RegExp(`^arn:aws:iam::${account}:role/[A-Za-z0-9+=,.@_/-]+$`);
  requireValue(typeof binding.invocationRoleArn === 'string' && rolePattern.test(binding.invocationRoleArn), 'Explicit invocation role ARN required');
  const subnets = uniqueValues(binding.subnetIds, /^subnet-[a-f0-9]{8,17}$/, 16);
  const securityGroups = uniqueValues(binding.securityGroupIds, /^sg-[a-f0-9]{8,17}$/, 5);
  const task = record(binding.taskDefinition);
  requireValue(task.family === 'capiro-preview-legiwatch-impact', 'Dedicated preview LegiWatch task family required');
  requireValue(typeof task.taskDefinitionArn === 'string' && new RegExp(
    `^arn:aws:ecs:${region}:${account}:task-definition/capiro-preview-legiwatch-impact:[1-9][0-9]*$`,
  ).test(task.taskDefinitionArn), 'Registered same-account preview task ARN required');
  requireValue(task.runtimePlatform?.cpuArchitecture === 'ARM64' && task.runtimePlatform?.operatingSystemFamily === 'LINUX',
    'ARM64 Linux worker required');
  requireValue(task.cpu === '512' && task.memory === '1024', 'Existing worker resource ceiling required');
  requireValue(task.networkMode === 'awsvpc' && Array.isArray(task.requiresCompatibilities) && task.requiresCompatibilities.includes('FARGATE'),
    'Fargate awsvpc worker required');
  for (const name of ['taskRoleArn', 'executionRoleArn'])
    requireValue(typeof task[name] === 'string' && rolePattern.test(task[name]), 'Explicit same-account task roles required');
  requireValue(Array.isArray(task.containerDefinitions) && task.containerDefinitions.length === 1, 'One reviewed worker container required');
  const container = record(task.containerDefinitions[0]);
  requireValue(typeof container.name === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(container.name) && container.essential === true,
    'Named essential worker container required');
  requireValue(container.entryPoint === undefined, 'Qualified image entrypoint must be preserved');
  requireValue(container.image === `${account}.dkr.ecr.${region}.amazonaws.com/capiro/preview-core@${binding.imageDigest}`,
    'Exact preview image digest required');
  const environment = envMap(container.environment);
  requireValue(environment.DB_HOST === cloneHost && environment.DB_NAME === 'capiro' && environment.DB_PORT === '5432',
    'Existing preview clone database required');
  requireValue(environment.RELEASE_SHA === binding.sourceHead, 'Worker source commit mismatch');
  for (const name of ['DATABASE_URL', 'DB_USER', 'DB_PASSWORD'])
    requireValue(environment[name] === undefined, 'Database credentials must use task secret references');
  for (const entry of expected.environment)
    requireValue(environment[entry.name] === entry.value, 'Worker provider/model binding mismatch');
  const credentials = container.secrets;
  requireValue(Array.isArray(credentials) && credentials.every((item) => item && typeof item.name === 'string' &&
    typeof item.valueFrom === 'string') && new Set(credentials.map((item) => item.name)).size === credentials.length,
  'Unique task secret references required');
  const secrets: Record<string, string> = Object.fromEntries(credentials.map((item) => [item.name, item.valueFrom]));
  for (const [name, arn] of Object.entries(expected.secretArns))
    requireValue(secrets[name] === arn, 'Worker source credential binding mismatch');
  for (const [name, field] of [['DB_USER', 'username'], ['DB_PASSWORD', 'password']])
    requireValue(secrets[name!] === `${FIRST_CHAT_CORE_LIVE.dbAppSecretArn}:${field}::`,
      'Existing application database secret field references required');
  for (const name of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DATABASE_URL', 'RELEASE_SHA', ...expected.environment.map((entry) => entry.name)])
    requireValue(secrets[name] === undefined, 'Validated runtime settings may not be overridden by secrets');
  const invocationRoleName = binding.invocationRoleArn.split('/').at(-1)!;
  const network = { subnets, securityGroups, assignPublicIp: 'DISABLED' };
  const overrides = { containerOverrides: [{ name: container.name,
    command: LEGIWATCH_IMPACT_REFRESH_JOB.command,
    environment: Object.entries(LEGIWATCH_IMPACT_REFRESH_JOB.environment).map(([name, value]) => ({ name, value })),
  }] };
  return {
    putRuleRequest: { Name: ruleName, ScheduleExpression: `rate(${LEGIWATCH_IMPACT_REFRESH_JOB.rateMinutes} minutes)`,
      State: 'DISABLED', Description: LEGIWATCH_IMPACT_REFRESH_JOB.description },
    putTargetsRequest: { Rule: ruleName, Targets: [{ Id: LEGIWATCH_IMPACT_REFRESH_JOB.id,
      Arn: binding.clusterArn, RoleArn: binding.invocationRoleArn,
      RetryPolicy: { MaximumEventAgeInSeconds: 900, MaximumRetryAttempts: 0 },
      EcsParameters: { TaskDefinitionArn: task.taskDefinitionArn, TaskCount: 1, LaunchType: 'FARGATE',
        PlatformVersion: 'LATEST', NetworkConfiguration: { awsvpcConfiguration: {
          Subnets: subnets, SecurityGroups: securityGroups, AssignPublicIp: 'DISABLED',
        } } },
      Input: JSON.stringify(overrides),
    }] },
    runTaskRequest: { cluster: binding.clusterArn, taskDefinition: task.taskDefinitionArn, count: 1,
      launchType: 'FARGATE', platformVersion: 'LATEST', networkConfiguration: { awsvpcConfiguration: network }, overrides },
    putInvocationRolePolicyRequest: { RoleName: invocationRoleName, PolicyName: 'LegiwatchImpactRefreshTask', PolicyDocument: JSON.stringify({
      Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['ecs:RunTask'], Resource: task.taskDefinitionArn,
          Condition: { ArnEquals: { 'ecs:cluster': binding.clusterArn } } },
        { Effect: 'Allow', Action: ['iam:PassRole'], Resource: [...new Set([task.taskRoleArn, task.executionRoleArn])],
          Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } } },
      ],
    }) },
    enableRuleRequest: { Name: ruleName },
    disableRuleRequest: { Name: ruleName },
  };
}
