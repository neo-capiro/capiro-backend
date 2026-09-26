/** Pure policy checks for the one-service-at-a-time Meri ECS release. */
export const SERVICES = Object.freeze({
  api: Object.freeze({ name: 'capiro-dev-api', repository: 'capiro/dev/api', container: 'api' }),
  orchestrator: Object.freeze({
    name: 'capiro-dev-meriv2-orchestrator',
    repository: 'capiro/dev/meriv2-orchestrator',
    container: 'meriv2-orchestrator',
  }),
});

const DIGEST = /^sha256:[0-9a-f]{64}$/i;
const REGISTER_FIELDS = [
  'family', 'taskRoleArn', 'executionRoleArn', 'networkMode', 'containerDefinitions',
  'volumes', 'placementConstraints', 'requiresCompatibilities', 'cpu', 'memory',
  'tags', 'pidMode', 'ipcMode', 'proxyConfiguration', 'inferenceAccelerators',
  'ephemeralStorage', 'runtimePlatform', 'enableFaultInjection',
];

export function serviceConfig(key) {
  const config = SERVICES[key];
  if (!config) throw new Error('Service must be exactly api or orchestrator.');
  return config;
}

export function expectedRegistry(account, region) {
  if (!/^\d{12}$/.test(String(account))) throw new Error('Expected a 12-digit AWS account.');
  if (region !== 'us-east-1') throw new Error('This helper is pinned to us-east-1.');
  return `${account}.dkr.ecr.${region}.amazonaws.com`;
}

export function parseEcrImage(image, account, region, repository) {
  const prefix = `${expectedRegistry(account, region)}/${repository}`;
  if (typeof image !== 'string' || !image.startsWith(prefix)) {
    throw new Error(`Image must use the exact ${repository} ECR repository in the selected account.`);
  }
  const suffix = image.slice(prefix.length);
  if (suffix.startsWith('@') && DIGEST.test(suffix.slice(1))) {
    return { repository, digest: suffix.slice(1).toLowerCase(), tag: null };
  }
  if (suffix.startsWith(':') && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(suffix.slice(1))) {
    return { repository, digest: null, tag: suffix.slice(1) };
  }
  throw new Error('Image must have a valid ECR tag or sha256 digest.');
}

export function assertTargetImage(image, account, region, key) {
  const parsed = parseEcrImage(image, account, region, serviceConfig(key).repository);
  if (!parsed.digest) throw new Error('Candidate image must be pinned by immutable @sha256 digest.');
  return parsed;
}

export function targetContainer(taskDefinition, key) {
  const name = serviceConfig(key).container;
  const matches = (taskDefinition.containerDefinitions ?? []).filter((item) => item.name === name);
  if (matches.length !== 1) throw new Error(`Task definition must contain exactly one ${name} container.`);
  return matches[0];
}

export function cloneWithOnlyImageChanged(taskDefinition, key, image) {
  const proposed = Object.fromEntries(
    REGISTER_FIELDS.filter((field) => taskDefinition[field] !== undefined)
      .map((field) => [field, structuredClone(taskDefinition[field])]),
  );
  if (!proposed.family) throw new Error('Live task definition has no family.');
  if (!Array.isArray(proposed.containerDefinitions)) throw new Error('No container definitions.');
  if (Array.isArray(proposed.tags) && proposed.tags.length === 0) delete proposed.tags;
  targetContainer(proposed, key).image = image;
  return proposed;
}

export function assertServiceState(service, tasks, key) {
  const name = serviceConfig(key).name;
  if (service?.serviceName !== name || service.status !== 'ACTIVE') {
    throw new Error(`${name} is not an ACTIVE service.`);
  }
  const desired = Number(service.desiredCount);
  if (!Number.isInteger(desired) || desired < 1 || service.runningCount !== desired || service.pendingCount !== 0) {
    throw new Error(`${name} is not at a nonzero steady task count.`);
  }
  const deployments = service.deployments ?? [];
  if (deployments.length !== 1 || deployments[0].status !== 'PRIMARY' ||
      !['COMPLETED', undefined].includes(deployments[0].rolloutState)) {
    throw new Error(`${name} has an unsettled ECS deployment.`);
  }
  if (tasks.length !== desired || tasks.some((task) =>
    task.lastStatus !== 'RUNNING' || task.taskDefinitionArn !== service.taskDefinition ||
    task.healthStatus === 'UNHEALTHY')) {
    throw new Error(`${name} running tasks are not healthy and on the service task definition.`);
  }
  return true;
}

export function assertBaselineUnchanged(baseline, live) {
  for (const key of Object.keys(SERVICES)) {
    const before = baseline[key];
    const now = live[key];
    if (!before || !now) throw new Error(`Missing ${key} service baseline.`);
    for (const field of [
      'taskDefinitionArn', 'desiredCount', 'runningCount', 'pendingCount',
      'deploymentId', 'imageDigest', 'healthyTargetCount', 'unknownHealthCount',
    ]) {
      if (before[field] !== now[field]) {
        throw new Error(`${key} ${field} drifted after preparation; prepare again.`);
      }
    }
    if (before.runningTaskCount !== now.runningTaskCount) {
      throw new Error(`${key} running task count drifted after preparation; prepare again.`);
    }
  }
  return true;
}

export function validateManifest(manifest, account, region, key, rollbackArn, options = {}) {
  if (manifest?.marker !== 'NARROW_MERI_ECS_RELEASE_V1' ||
      manifest.account !== account || manifest.region !== region ||
      manifest.cluster !== 'capiro-dev' || manifest.service !== key ||
      typeof manifest.profile !== 'string' ||
      !manifest.baseline?.api || !manifest.baseline?.orchestrator) {
    throw new Error('Manifest does not match this exact account, region, cluster and service.');
  }
  assertTargetImage(manifest.targetImage, account, region, key);
  for (const serviceKey of Object.keys(SERVICES)) {
    const snapshot = manifest.baseline[serviceKey];
    if (typeof snapshot.taskDefinitionArn !== 'string' ||
        !snapshot.taskDefinitionArn.startsWith(`arn:aws:ecs:${region}:${account}:task-definition/`) ||
        !DIGEST.test(snapshot.imageDigest) ||
        !Number.isInteger(snapshot.desiredCount) || snapshot.desiredCount < 1 ||
        snapshot.runningCount !== snapshot.desiredCount || snapshot.pendingCount !== 0 ||
        snapshot.runningTaskCount !== snapshot.desiredCount ||
        typeof snapshot.deploymentId !== 'string') {
      throw new Error(`Manifest ${serviceKey} baseline is incomplete or invalid.`);
    }
  }
  if (rollbackArn !== manifest.baseline[key].taskDefinitionArn) {
    throw new Error('Rollback pin must exactly match the prepared live task-definition ARN.');
  }
  const prepared = Date.parse(manifest.preparedAt);
  if (!Number.isFinite(prepared) || prepared > Date.now() + 60_000 ||
      (!options.allowOlderForRollback && Date.now() - prepared > 60 * 60_000)) {
    throw new Error('Manifest is stale or has an invalid prepare time (execute maximum age: one hour).');
  }
  return true;
}
