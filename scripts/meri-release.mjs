#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/** Explicit, one-service production promotion. Importing this module never calls AWS. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, rm, rmdir, open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAwsCli } from './lib/resolve-aws-cli.mjs';
import {
  ACCOUNT,
  REGION,
  CLUSTER,
  SERVICES,
  canonical,
  fingerprint,
  taskInput,
  validateQualification,
  serviceFingerprint,
  serviceConfigFingerprint,
  assertStable,
  candidateTask,
  assertBaseline,
} from './lib/meri-release-policy.mjs';

const fail = (message) => {
  throw new Error(message);
};
const arnFor = (key, arn) =>
  typeof arn === 'string' &&
  new RegExp(
    `^arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/capiro-dev-${key}:[1-9][0-9]*$`,
  ).test(arn);
const imageFor = (key, digest) =>
  `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/capiro/dev/${key}@${digest}`;
const containerFor = (td, key) => {
  const matches = (td.containerDefinitions ?? []).filter((c) => c.name === key);
  if (matches.length !== 1) fail('Expected one exact target container');
  return matches[0];
};

export function releaseOperator({
  aws,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const call = (...args) => aws(args);
  async function identity() {
    if ((await call('sts', 'get-caller-identity')).Account !== ACCOUNT) fail('Wrong AWS account');
  }
  async function service(key) {
    if (!SERVICES.includes(key)) fail('Unsupported service');
    const r = await call(
      'ecs',
      'describe-services',
      '--cluster',
      CLUSTER,
      '--services',
      `capiro-dev-${key}`,
    );
    if (r.failures?.length || r.services?.length !== 1) fail('Missing or ambiguous service');
    return r.services[0];
  }
  async function task(arn, key) {
    if (!arnFor(key, arn)) fail('Unexpected task-definition identity');
    const r = await call(
      'ecs',
      'describe-task-definition',
      '--task-definition',
      arn,
      '--include',
      'TAGS',
    );
    if (r.taskDefinition?.taskDefinitionArn !== arn || r.taskDefinition.status !== 'ACTIVE')
      fail('Task definition not ACTIVE');
    return { ...r.taskDefinition, tags: r.tags ?? [] };
  }
  async function digest(key, imageId, expected) {
    const r = await call(
      'ecr',
      'describe-images',
      '--repository-name',
      `capiro/dev/${key}`,
      '--image-ids',
      imageId,
    );
    if (r.imageDetails?.length !== 1 || r.imageDetails[0].imageDigest !== expected)
      fail('ECR digest/provenance mismatch');
  }
  async function candidate(q) {
    validateQualification(q, q.service, q.image, now());
    const d = q.image.split('@')[1];
    await digest(q.service, `imageTag=${q.sourceSha}`, d);
    await digest(q.service, `imageDigest=${d}`, d);
  }
  async function snapshot(key) {
    const s = await service(key);
    assertStable(s, key);
    const td = await task(s.taskDefinition, key);
    const input = taskInput(td);
    const listing = await call(
      'ecs',
      'list-tasks',
      '--cluster',
      CLUSTER,
      '--service-name',
      s.serviceName,
      '--desired-status',
      'RUNNING',
    );
    if (listing.nextToken || listing.taskArns?.length !== s.desiredCount)
      fail('Incomplete running task list');
    const r = await call(
      'ecs',
      'describe-tasks',
      '--cluster',
      CLUSTER,
      '--tasks',
      ...listing.taskArns,
    );
    if (r.failures?.length || r.tasks?.length !== s.desiredCount)
      fail('Incomplete running task readback');
    const seen = new Set();
    const digests = new Set();
    const addresses = new Set();
    for (const t of r.tasks) {
      if (!listing.taskArns.includes(t.taskArn) || seen.has(t.taskArn))
        fail('Task identity mismatch');
      seen.add(t.taskArn);
      if (
        t.taskDefinitionArn !== s.taskDefinition ||
        t.lastStatus !== 'RUNNING' ||
        t.healthStatus === 'UNHEALTHY'
      )
        fail('Task unhealthy or wrong revision');
      const containers = t.containers ?? [];
      for (const spec of td.containerDefinitions) {
        const matches = containers.filter((c) => c.name === spec.name);
        if (
          matches.length !== 1 ||
          matches[0].lastStatus !== 'RUNNING' ||
          matches[0].healthStatus === 'UNHEALTHY'
        )
          fail('Container not healthy/running');
        const observed = matches[0].imageDigest;
        if (!/^sha256:[0-9a-f]{64}$/.test(observed ?? '')) fail('Missing running image digest');
        // Sidecars are unchanged during promotion and must also be immutable.
        if (spec.name !== key && !spec.image.endsWith(`@${observed}`))
          fail('Unpinned sidecar requires separate qualification');
        if (spec.name === key) digests.add(observed);
      }
      const ips = (t.attachments ?? [])
        .flatMap((a) => a.details ?? [])
        .filter((d) => d.name === 'privateIPv4Address')
        .map((d) => d.value);
      if (ips.length !== 1 || addresses.has(ips[0]))
        fail('Expected unique awsvpc IPv4 task address');
      addresses.add(ips[0]);
    }
    if (digests.size !== 1) fail('Running tasks have mixed image digests');
    if (!s.loadBalancers?.length) fail('This release path requires ALB target health');
    for (const lb of s.loadBalancers) {
      if (lb.containerName !== key || !lb.targetGroupArn || !Number.isInteger(lb.containerPort))
        fail('Unsupported load balancer mapping');
      if (
        !(containerFor(td, key).portMappings ?? []).some(
          (p) => p.containerPort === lb.containerPort,
        )
      )
        fail('Task/load balancer port mismatch');
      const group = await call(
        'elbv2',
        'describe-target-groups',
        '--target-group-arns',
        lb.targetGroupArn,
      );
      if (
        group.TargetGroups?.length !== 1 ||
        group.TargetGroups[0].TargetGroupArn !== lb.targetGroupArn ||
        group.TargetGroups[0].TargetType !== 'ip' ||
        group.TargetGroups[0].Port !== lb.containerPort
      )
        fail('Unexpected target group topology');
      if (key === 'web-vnext' && group.TargetGroups[0].HealthCheckPath !== '/healthz')
        fail('Wrong vNext health path');
      const health = await call(
        'elbv2',
        'describe-target-health',
        '--target-group-arn',
        lb.targetGroupArn,
      );
      for (const ip of addresses) {
        const matches = (health.TargetHealthDescriptions ?? []).filter(
          (h) => h.Target?.Id === ip && h.Target?.Port === lb.containerPort,
        );
        if (matches.length !== 1 || matches[0].TargetHealth?.State !== 'healthy')
          fail('Actual task target is not healthy');
      }
    }
    return {
      service: s,
      task: td,
      baseline: {
        taskDefinitionArn: s.taskDefinition,
        serviceHash: serviceFingerprint(s),
        configHash: serviceConfigFingerprint(s),
        taskHash: fingerprint(input),
        imageDigest: [...digests][0],
        desiredCount: s.desiredCount,
      },
    };
  }
  function manifest(m) {
    if (
      m?.schemaVersion !== 1 ||
      m.account !== ACCOUNT ||
      m.region !== REGION ||
      m.cluster !== CLUSTER ||
      !SERVICES.includes(m.service)
    )
      fail('Invalid manifest target');
    const age = now() - Date.parse(m.preparedAt);
    if (!Number.isFinite(age) || age < 0 || age > 3600000) fail('Manifest expired (one hour)');
    validateQualification(m.qualification, m.service, m.qualification?.image, now());
    if (
      !arnFor(m.service, m.baseline?.taskDefinitionArn) ||
      !/^sha256:[0-9a-f]{64}$/.test(m.baseline?.imageDigest ?? '')
    )
      fail('Invalid baseline');
    for (const k of ['serviceHash', 'configHash', 'taskHash'])
      if (!/^[0-9a-f]{64}$/.test(m.baseline[k] ?? '')) fail('Missing baseline fingerprint');
  }
  async function prepare(q) {
    await identity();
    await candidate(q);
    const live = await snapshot(q.service);
    candidateTask(live.task, q.service, q.image, q.sourceSha); // fail closed on unsupported task config
    await digest(q.service, `imageDigest=${live.baseline.imageDigest}`, live.baseline.imageDigest);
    return {
      schemaVersion: 1,
      account: ACCOUNT,
      region: REGION,
      cluster: CLUSTER,
      service: q.service,
      preparedAt: new Date(now()).toISOString(),
      qualification: q,
      baseline: live.baseline,
    };
  }
  async function register(input, key) {
    const r = await call(
      'ecs',
      'register-task-definition',
      '--cli-input-json',
      JSON.stringify(input),
    );
    const arn = r.taskDefinition?.taskDefinitionArn;
    const registered = taskInput(await task(arn, key));
    if (canonical(registered) !== canonical(input))
      fail('Registered task differs from approved changes');
    return arn;
  }
  async function currentBaseline(m) {
    const live = await snapshot(m.service);
    assertBaseline(m.baseline, live.baseline);
    return live;
  }
  async function promote(m, approvedHash, record = async () => {}) {
    manifest(m);
    if (approvedHash !== fingerprint(m)) fail('Manifest approval hash mismatch');
    await identity();
    await candidate(m.qualification);
    await digest(m.service, `imageDigest=${m.baseline.imageDigest}`, m.baseline.imageDigest);
    const live = await currentBaseline(m); // all qualification/read checks before any AWS mutation
    const config = live.service.deploymentConfiguration;
    const automaticRollback =
      (config.deploymentCircuitBreaker.enable && config.deploymentCircuitBreaker.rollback) ||
      (config.alarms?.enable && config.alarms.rollback);
    if (
      automaticRollback &&
      containerFor(live.task, m.service).image !== imageFor(m.service, m.baseline.imageDigest)
    ) {
      fail(
        'Mutable baseline: ECS automatic rollback could re-pull changed bytes. Separately qualify baseline digest normalization first.',
      );
    }
    const rollback = candidateTask(
      live.task,
      m.service,
      imageFor(m.service, m.baseline.imageDigest),
    );
    const proposed = candidateTask(
      live.task,
      m.service,
      m.qualification.image,
      m.qualification.sourceSha,
    );
    const receipt = {
      schemaVersion: 1,
      manifestHash: approvedHash,
      service: m.service,
      configHash: m.baseline.configHash,
      candidateImage: m.qualification.image,
      candidateTaskHash: fingerprint(proposed),
      rollbackTaskHash: fingerprint(rollback),
      rollbackImage: imageFor(m.service, m.baseline.imageDigest),
      status: 'registering',
      awsMutation: true,
    };
    await record(receipt);
    receipt.rollbackTaskDefinition = await register(rollback, m.service);
    await record(receipt);
    receipt.candidateTaskDefinition = await register(proposed, m.service);
    receipt.status = 'registered-not-promoted';
    await record(receipt);
    await currentBaseline(m); // after registrations; changes leave unused revisions, never update the service
    // ECS UpdateService has no CAS. An exclusive operator change window is still required.
    receipt.status = 'update-outcome-unknown';
    await record(receipt);
    if (serviceFingerprint(await service(m.service)) !== m.baseline.serviceHash) {
      receipt.status = 'drift-not-promoted';
      await record(receipt);
      fail('Deployment drift immediately before update');
    }
    const r = await call(
      'ecs',
      'update-service',
      '--cluster',
      CLUSTER,
      '--service',
      `capiro-dev-${m.service}`,
      '--task-definition',
      receipt.candidateTaskDefinition,
    );
    const primary = r.service?.deployments?.find((d) => d.status === 'PRIMARY');
    if (
      r.service?.taskDefinition !== receipt.candidateTaskDefinition ||
      primary?.taskDefinition !== receipt.candidateTaskDefinition ||
      !primary.id
    )
      fail('Update response requires reconciliation');
    receipt.deploymentId = primary.id;
    receipt.status = 'promoting';
    await record(receipt);
    await wait(receipt, false);
    receipt.status = 'ecs-healthy-manual-acceptance-required';
    await record(receipt);
    return receipt;
  }
  async function wait(receipt, rollback) {
    const expected = rollback ? receipt.rollbackTaskDefinition : receipt.candidateTaskDefinition;
    const deploymentId = rollback ? receipt.rollbackDeploymentId : receipt.deploymentId;
    const expectedDigest = (rollback ? receipt.rollbackImage : receipt.candidateImage).split(
      '@',
    )[1];
    const expectedTaskHash = rollback ? receipt.rollbackTaskHash : receipt.candidateTaskHash;
    const deadline = now() + 25 * 60_000;
    for (let attempt = 0; attempt < 100 && now() < deadline; attempt++) {
      const s = await service(receipt.service);
      if (
        s.taskDefinition !== expected ||
        s.deployments?.find((d) => d.status === 'PRIMARY')?.id !== deploymentId ||
        serviceConfigFingerprint(s) !== receipt.configHash
      )
        fail('Concurrent rollout/configuration detected; no automatic rollback');
      if (s.deployments?.some((d) => d.rolloutState === 'FAILED'))
        fail('ECS rollout failed; guarded manual rollback required');
      if (s.deployments?.length === 1 && s.deployments[0].rolloutState === 'COMPLETED') {
        const live = await snapshot(receipt.service);
        if (
          live.service.taskDefinition !== expected ||
          live.service.deployments[0]?.id !== deploymentId ||
          live.baseline.configHash !== receipt.configHash ||
          live.baseline.taskHash !== expectedTaskHash ||
          live.baseline.imageDigest !== expectedDigest
        )
          fail('Final running digest/deployment mismatch');
        if (serviceFingerprint(await service(receipt.service)) !== serviceFingerprint(live.service))
          fail('Deployment changed during health readback');
        return;
      }
      await sleep(15000);
    }
    fail('Timed out; no automatic rollback. Reconcile before retrying any write.');
  }
  async function rollback(receipt, approvedHash, record = async () => {}) {
    if (
      approvedHash !== fingerprint(receipt) ||
      receipt?.schemaVersion !== 1 ||
      !SERVICES.includes(receipt.service) ||
      !receipt.deploymentId
    )
      fail('Invalid rollback receipt approval');
    if (
      !arnFor(receipt.service, receipt.candidateTaskDefinition) ||
      !arnFor(receipt.service, receipt.rollbackTaskDefinition) ||
      receipt.candidateTaskDefinition === receipt.rollbackTaskDefinition
    )
      fail('Invalid rollback revisions');
    await identity();
    const old = await task(receipt.rollbackTaskDefinition, receipt.service);
    if (
      containerFor(old, receipt.service).image !== receipt.rollbackImage ||
      fingerprint(taskInput(old)) !== receipt.rollbackTaskHash
    )
      fail('Rollback task/image mismatch');
    if (
      fingerprint(taskInput(await task(receipt.candidateTaskDefinition, receipt.service))) !==
      receipt.candidateTaskHash
    )
      fail('Candidate task mismatch');
    const d = receipt.rollbackImage?.split('@')[1];
    if (
      receipt.rollbackImage !== imageFor(receipt.service, d) ||
      !/^sha256:[0-9a-f]{64}$/.test(d ?? '')
    )
      fail('Rollback digest invalid');
    await digest(receipt.service, `imageDigest=${d}`, d);
    const check = async () => {
      const s = await service(receipt.service);
      const primary = s.deployments?.find((x) => x.status === 'PRIMARY');
      if (
        s.taskDefinition !== receipt.candidateTaskDefinition ||
        primary?.id !== receipt.deploymentId ||
        primary.taskDefinition !== receipt.candidateTaskDefinition ||
        serviceConfigFingerprint(s) !== receipt.configHash
      )
        fail('Rollback refused: concurrent deployment/configuration');
      return serviceFingerprint(s);
    };
    const result = { ...receipt, status: 'rollback-update-outcome-unknown' };
    await record(result);
    const before = await check();
    if ((await check()) !== before) fail('Rollback drift');
    const response = await call(
      'ecs',
      'update-service',
      '--cluster',
      CLUSTER,
      '--service',
      `capiro-dev-${receipt.service}`,
      '--task-definition',
      receipt.rollbackTaskDefinition,
    );
    const primary = response.service?.deployments?.find((d) => d.status === 'PRIMARY');
    if (
      response.service?.taskDefinition !== receipt.rollbackTaskDefinition ||
      primary?.taskDefinition !== receipt.rollbackTaskDefinition ||
      !primary.id
    )
      fail('Rollback response requires reconciliation');
    result.rollbackDeploymentId = primary.id;
    result.status = 'rolling-back';
    await record(result);
    await wait(result, true);
    result.status = 'rollback-ecs-healthy-manual-acceptance-required';
    await record(result);
    return result;
  }
  return { prepare, promote, rollback, snapshot };
}

export function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (!['inspect', 'prepare', 'promote', 'rollback'].includes(action))
    fail('Use inspect, prepare, promote, or rollback; see docs/meri/deployment-prerequisite.md');
  const allowed = new Set(
    action === 'inspect'
      ? ['service', 'profile']
      : action === 'prepare'
        ? ['qualification', 'out', 'profile']
        : ['manifest', 'approve', 'confirm', 'receipt', 'profile'],
  );
  const out = { action };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '');
    const value = rest[i + 1];
    if (
      !rest[i]?.startsWith('--') ||
      !allowed.has(key) ||
      Object.hasOwn(out, key) ||
      !value ||
      value.startsWith('--')
    )
      fail('Unknown, duplicate or missing argument');
    out[key] = value;
  }
  for (const key of action === 'inspect'
    ? ['service']
    : action === 'prepare'
      ? ['qualification', 'out']
      : ['manifest', 'approve', 'confirm', 'receipt'])
    if (!out[key]) fail(`Missing --${key}`);
  return out;
}

export async function persistReceipt(file, value, io = { open, rename, rm }) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await io.open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await io.rename(temp, file); // same-directory atomic replacement; old receipt survives a failed rename
  } finally {
    if (handle) await handle.close();
    await io.rm(temp, { force: true });
  }
}

async function cli() {
  const usage = 'Usage: node scripts/meri-release.mjs <inspect|prepare|promote|rollback> [action options]; inspect --service <service>; prepare --qualification <file> --out <file>; promote|rollback --manifest <file> --approve <file> --confirm <token> --receipt <file>';
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    console.log(usage);
    return;
  }
  if (argv.length === 0) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const input =
    args.action === 'inspect'
      ? null
      : JSON.parse(await readFile(args.qualification ?? args.manifest, 'utf8'));
  if (
    ['promote', 'rollback'].includes(args.action) &&
    args.confirm !== `${args.action.toUpperCase()}_CAPIRO_PRODUCTION_${input.service}`
  )
    fail('Exact production/service confirmation required');
  const exec = promisify(execFile);
  const aws = async (command) => {
    let dir;
    try {
      const safe = [...command];
      const index = safe.indexOf('--cli-input-json');
      if (index >= 0) {
        dir = await mkdtemp(path.join(tmpdir(), 'meri-release-'));
        const file = path.join(dir, 'task.json');
        await writeFile(file, safe[index + 1], { mode: 0o600, flag: 'wx' });
        safe[index + 1] = `file://${file.replaceAll('\\', '/')}`;
      }
      const { stdout } = await exec(
        resolveAwsCli(),
        [
          ...safe,
          '--region',
          REGION,
          ...(args.profile ? ['--profile', args.profile] : []),
          '--output',
          'json',
          '--no-cli-pager',
        ],
        { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
      );
      return JSON.parse(stdout || '{}');
    } catch (error) {
      // AWS errors may contain task environment or sensitive command arguments.
      throw new Error(
        `AWS ${command[0]} ${command[1]} failed (code ${error.code ?? 'unknown'}); inspect privately; do not blindly retry writes`,
      );
    } finally {
      if (dir) {
        await rm(path.join(dir, 'task.json'), { force: true });
        await rmdir(dir);
      }
    }
  };
  const operator = releaseOperator({ aws });
  if (args.action === 'inspect') {
    if ((await aws(['sts', 'get-caller-identity'])).Account !== ACCOUNT) fail('Wrong AWS account');
    const live = await operator.snapshot(args.service);
    console.log(
      JSON.stringify({
        action: 'inspected-not-qualified',
        observedAt: new Date().toISOString(),
        service: args.service,
        baseline: live.baseline,
        taskImage: containerFor(live.task, args.service).image,
        deploymentConfiguration: live.service.deploymentConfiguration,
        awsMutation: false,
      }),
    );
  } else if (args.action === 'prepare') {
    const m = await operator.prepare(input);
    await writeFile(args.out, `${JSON.stringify(m, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(
      JSON.stringify({
        action: 'prepared-not-deployed',
        manifestHash: fingerprint(m),
        manifest: args.out,
      }),
    );
  } else {
    // Never overwrite an existing release receipt or approval manifest.
    if (path.resolve(args.manifest) === path.resolve(args.receipt))
      fail('Receipt cannot overwrite manifest');
    await writeFile(args.receipt, '{}\n', { flag: 'wx', mode: 0o600 });
    const record = (r) => persistReceipt(args.receipt, r);
    const result = await operator[args.action](input, args.approve, record);
    console.log(JSON.stringify(result));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
