/** Pure release policy. Hermes draft independently corrected and fault-tested. */
import { createHash } from 'node:crypto';

export const ACCOUNT = '967807252336';
export const REGION = 'us-east-1';
export const CLUSTER = 'capiro-dev';
export const SERVICES = Object.freeze([
  'api',
  'meriv2-orchestrator',
  'workspace',
  'api-strategy',
  'web',
  'web-vnext',
  'engagement-api',
  'intel-api',
  'onboard-api',
]);
const fail = (message) => {
  throw new Error(message);
};
function keyCheck(key) {
  if (!SERVICES.includes(key)) fail('Unsupported service');
}
const prefix = (key) => `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/capiro/dev/${key}`;
export function canonical(value) {
  function sort(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(sort);
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sort(v[k])]),
    );
  }
  return JSON.stringify(sort(value));
}
export const fingerprint = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const WRITABLE = new Set([
  'family',
  'taskRoleArn',
  'executionRoleArn',
  'networkMode',
  'containerDefinitions',
  'volumes',
  'placementConstraints',
  'requiresCompatibilities',
  'cpu',
  'memory',
  'tags',
  'pidMode',
  'ipcMode',
  'proxyConfiguration',
  'inferenceAccelerators',
  'ephemeralStorage',
  'runtimePlatform',
  'enableFaultInjection',
]);
const READONLY = new Set([
  'taskDefinitionArn',
  'revision',
  'status',
  'registeredAt',
  'registeredBy',
  'deregisteredAt',
  'compatibilities',
  'requiresAttributes',
]);
export function taskInput(td) {
  if (!td || typeof td !== 'object' || Array.isArray(td)) fail('Missing task definition');
  for (const key of Object.keys(td))
    if (!WRITABLE.has(key) && !READONLY.has(key)) fail(`Unknown task-definition field: ${key}`);
  const copy = Object.fromEntries(
    Object.entries(td)
      .filter(([k]) => WRITABLE.has(k))
      .map(([k, v]) => [k, structuredClone(v)]),
  );
  if (
    !copy.family ||
    !Array.isArray(copy.containerDefinitions) ||
    !copy.containerDefinitions.length
  )
    fail('Incomplete task definition');
  copy.tags = (copy.tags ?? []).filter((t) => !t.key.startsWith('aws:'));
  return copy;
}
const evidenceUrl = (url) =>
  typeof url === 'string' &&
  /^https:\/\/github\.com\/neo-capiro\/capirov2\/(?:commit\/[0-9a-f]{40}|blob\/[0-9a-f]{40}\/[^\s?#]+|actions\/runs\/[0-9]+(?:\/attempts\/[0-9]+)?)$/.test(
    url,
  );
export function validateQualification(q, key, image, now = Date.now()) {
  keyCheck(key);
  if (
    !q ||
    q.schemaVersion !== 1 ||
    q.service !== key ||
    q.status !== 'qualified' ||
    q.image !== image
  )
    fail('Qualification target/status mismatch');
  if (!/^[0-9a-f]{40}$/.test(q.sourceSha ?? '')) fail('Exact source SHA required');
  if (
    typeof image !== 'string' ||
    !image.startsWith(`${prefix(key)}@`) ||
    !/^sha256:[0-9a-f]{64}$/.test(image.slice(prefix(key).length + 1))
  )
    fail('Exact repository and immutable image digest required');
  const expiry = Date.parse(q.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expiry) || expiry <= now || expiry > now + 86400000)
    fail('Qualification expired or exceeds 24 hours');
  if (!Array.isArray(q.evidence) || !q.evidence.length || !q.evidence.every(evidenceUrl))
    fail('Versioned repository/run evidence required');
  const reviewed = Date.parse(q.reviewedAt);
  if (
    typeof q.reviewer !== 'string' ||
    !q.reviewer.trim() ||
    !Number.isFinite(reviewed) ||
    reviewed > now ||
    now - reviewed > 86400000
  )
    fail('Current named reviewer attestation required');
  for (const name of ['build', 'automated-tests', 'retirement-compatibility']) {
    const checks = (q.checks ?? []).filter((c) => c.name === name);
    if (
      checks.length !== 1 ||
      checks[0].status !== 'passed' ||
      checks[0].sourceSha !== q.sourceSha ||
      checks[0].image !== image ||
      !evidenceUrl(checks[0].url)
    )
      fail(`Missing candidate-bound ${name} attestation`);
  }
  if (typeof q.schemaChange !== 'boolean') fail('Explicit schema-change classification required');
  if (q.schemaChange) {
    for (const field of ['freshDatabase', 'retiredUpgrade', 'compatibility']) {
      if (q[field]?.status !== 'passed' || !evidenceUrl(q[field]?.url))
        fail(`Missing passing ${field} evidence`);
    }
  }
  return true;
}
// Preserve all unknown service fields conservatively. Only known observation
// metadata is excluded; adding a writable field cannot silently evade drift checks.
const VOLATILE = new Set([
  'runningCount',
  'pendingCount',
  'events',
  'createdAt',
  'createdBy',
  'taskSets',
  'deployments',
  'serviceArn',
  'clusterArn',
]);
function serviceConfig(s) {
  if (!s || typeof s !== 'object') fail('Missing service');
  return Object.fromEntries(
    Object.entries(s).filter(([k]) => !VOLATILE.has(k) && k !== 'taskDefinition'),
  );
}
export const serviceConfigFingerprint = (s) => fingerprint(serviceConfig(s));
export const serviceFingerprint = (s) =>
  fingerprint({
    ...serviceConfig(s),
    taskDefinition: s.taskDefinition,
    deployments: (s.deployments ?? []).map((d) => ({
      id: d.id,
      status: d.status,
      taskDefinition: d.taskDefinition,
      rolloutState: d.rolloutState,
      desiredCount: d.desiredCount,
      networkConfiguration: d.networkConfiguration,
      platformVersion: d.platformVersion,
      capacityProviderStrategy: d.capacityProviderStrategy,
      serviceConnectConfiguration: d.serviceConnectConfiguration,
      volumeConfigurations: d.volumeConfigurations,
    })),
  });
export function assertStable(s, key) {
  keyCheck(key);
  if (
    s?.serviceName !== `capiro-dev-${key}` ||
    s.status !== 'ACTIVE' ||
    s.deploymentController?.type !== 'ECS'
  )
    fail('Wrong service or deployment controller');
  if (
    !Number.isInteger(s.desiredCount) ||
    s.desiredCount < 1 ||
    s.desiredCount > 100 ||
    s.runningCount !== s.desiredCount ||
    s.pendingCount !== 0
  )
    fail('Service is not steady');
  if (
    s.deployments?.length !== 1 ||
    s.deployments[0].status !== 'PRIMARY' ||
    s.deployments[0].rolloutState !== 'COMPLETED' ||
    !s.deployments[0].id ||
    s.deployments[0].taskDefinition !== s.taskDefinition
  )
    fail('Active/incomplete deployment');
  const config = s.deploymentConfiguration;
  const breaker = config?.deploymentCircuitBreaker;
  if (typeof breaker?.enable !== 'boolean' || typeof breaker?.rollback !== 'boolean')
    fail('Explicit circuit-breaker settings required');
  if ((config.strategy && config.strategy !== 'ROLLING') || config.lifecycleHooks?.length)
    fail('Only ordinary rolling ECS deployments are supported');
  if (
    config.alarms &&
    (typeof config.alarms.enable !== 'boolean' || typeof config.alarms.rollback !== 'boolean')
  )
    fail('Explicit alarm rollback settings required');
}
export function candidateTask(td, key, image, sourceSha) {
  keyCheck(key);
  if (td.family !== `capiro-dev-${key}` || td.networkMode !== 'awsvpc')
    fail('Wrong task family/network mode');
  if (
    typeof image !== 'string' ||
    !image.startsWith(`${prefix(key)}@`) ||
    !/^sha256:[0-9a-f]{64}$/.test(image.slice(prefix(key).length + 1))
  )
    fail('Wrong target repository/digest');
  const copy = taskInput(td);
  if (copy.containerDefinitions.some((c) => c.environmentFiles?.length))
    fail('Mutable environment files require separate release qualification');
  const matches = copy.containerDefinitions.filter((c) => c.name === key);
  if (matches.length !== 1) fail('Expected exactly one named target container');
  const current = matches[0];
  if (typeof current.image !== 'string' || !current.image.startsWith(prefix(key)))
    fail('Wrong baseline repository');
  const suffix = current.image.slice(prefix(key).length);
  if (!/^(?:@sha256:[0-9a-f]{64}|:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/.test(suffix))
    fail('Wrong baseline repository/tag');
  if (key === 'web-vnext') {
    const surface = (current.environment ?? []).filter((e) => e.name === 'WEB_SURFACE');
    if (
      surface.length !== 1 ||
      surface[0].value !== 'vnext' ||
      !(current.portMappings ?? []).some((p) => p.containerPort === 8080)
    )
      fail('Wrong vNext surface/port');
  }
  current.image = image;
  // A promotion must report the source actually packaged in its immutable image.
  // Rollback omits sourceSha and keeps the baseline's original identity fields.
  if (sourceSha !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(sourceSha)) fail('Invalid release source SHA');
    const names = ['GIT_SHA', 'RELEASE_SHA'];
    if (key === 'web-vnext') names.push('CAPIRO_WEB_RELEASE_SHA');
    const environment = current.environment ?? [];
    for (const name of names) {
      if (environment.filter((entry) => entry.name === name).length > 1)
        fail(`Duplicate release identity field: ${name}`);
      if ((current.secrets ?? []).some((entry) => entry.name === name))
        fail(`Release identity conflicts with secret: ${name}`);
      const existing = environment.find((entry) => entry.name === name);
      if (existing) existing.value = sourceSha;
      else environment.push({ name, value: sourceSha });
    }
    current.environment = environment;
  }
  return copy;
}
export function assertBaseline(before, after) {
  for (const key of [
    'taskDefinitionArn',
    'serviceHash',
    'configHash',
    'taskHash',
    'imageDigest',
    'desiredCount',
  ]) {
    if (before?.[key] === undefined || before[key] !== after?.[key]) fail(`Baseline drift: ${key}`);
  }
}
