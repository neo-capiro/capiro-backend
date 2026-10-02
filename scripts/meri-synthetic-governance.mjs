#!/usr/bin/env node
/** Fixed two-tenant API configuration change. Importing never calls AWS. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, open, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { releaseOperator, persistReceipt } from './meri-release.mjs';
import { resolveAwsCli } from './lib/resolve-aws-cli.mjs';
import {
  ACCOUNT,
  REGION,
  CLUSTER,
  canonical,
  fingerprint,
  taskInput,
  validateQualification,
  serviceFingerprint,
  serviceConfigFingerprint,
  assertBaseline,
} from './lib/meri-release-policy.mjs';

export const TENANTS = Object.freeze([
  'f2d6cf8f-057c-479a-8110-62fe5086d43f',
  '52e91176-08f0-4d89-9633-bc212f5bdbbf',
]);
export const NAMESPACE = 'meri-foundation-20260928';
const SERVICE = 'capiro-dev-api';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const ARN = new RegExp(
  `^arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/capiro-dev-api:[1-9][0-9]*$`,
);
const FLAGS = [
  'MEMORY_GOVERNANCE_LIFECYCLE',
  'MEMORY_GOVERNANCE_CENTER',
  'MEMORY_GOVERNANCE_ENFORCE',
  'MEMORY_CLIENT_REVIEW',
];
const COHORT = 'MEMORY_GOVERNANCE_TENANTS';
const NS = 'MERI_SYNTHETIC_FIXTURE_NAMESPACE';
const fail = (message) => {
  throw new Error(message);
};
const target = (td) => {
  const found = td.containerDefinitions?.filter((c) => c.name === 'api');
  if (found?.length !== 1) fail('Exactly one API container required');
  return found[0];
};

export function governanceTask(td, qualification, at = Date.now()) {
  validateQualification(qualification, 'api', qualification?.image, at);
  if (td.family !== SERVICE || td.networkMode !== 'awsvpc') fail('Wrong API family/network');
  const proposed = taskInput(td),
    api = target(proposed);
  for (const c of proposed.containerDefinitions) {
    if (
      c.environmentFiles !== undefined &&
      (!Array.isArray(c.environmentFiles) || c.environmentFiles.length)
    )
      fail('Opaque environmentFiles refused');
    if (c.environment !== undefined && !Array.isArray(c.environment)) fail('Invalid environment');
    const names = new Set();
    for (const entry of c.environment ?? []) {
      if (
        typeof entry.name !== 'string' ||
        !entry.name ||
        typeof entry.value !== 'string' ||
        names.has(entry.name)
      )
        fail('Invalid or duplicate environment');
      names.add(entry.name);
    }
  }
  if (api.image !== qualification.image)
    fail('Configuration change requires unchanged qualified immutable image');
  const env = api.environment ?? [];
  const controlled = [...FLAGS, COHORT, NS, 'GIT_SHA', 'RELEASE_SHA'];
  if ((api.secrets ?? []).some((s) => controlled.includes(s.name)))
    fail('Secret-backed control refused');
  const value = (name) => env.find((e) => e.name === name)?.value;
  for (const name of FLAGS)
    if (value(name) !== 'enforce') fail('Existing governance flags must remain enforce');
  for (const name of ['GIT_SHA', 'RELEASE_SHA'])
    if (value(name) !== qualification.sourceSha) fail('Live source identity mismatch');
  const old = value(COHORT);
  if (typeof old !== 'string' || !old.trim())
    fail('Explicit existing governance UUID cohort required');
  const ids = old.split(',').map((v) => v.trim());
  if (ids.length > 1000 || ids.some((id) => !UUID.test(id)) || new Set(ids).size !== ids.length)
    fail('All, malformed or duplicate cohort refused');
  const added = TENANTS.filter((id) => !ids.includes(id));
  if (added.length) env.find((e) => e.name === COHORT).value = old + ',' + added.join(',');
  const namespaceAdded = value(NS) === undefined;
  if (namespaceAdded) env.push({ name: NS, value: NAMESPACE });
  else if (value(NS) !== NAMESPACE) fail('Conflicting fixture namespace refused');
  api.environment = env;
  return {
    proposed,
    changes: {
      addedTenantIds: added,
      namespaceAdded,
      priorCohortCount: ids.length,
      priorCohortSha256: fingerprint(old),
    },
    changed: added.length > 0 || namespaceAdded,
  };
}

function principal(identity) {
  if (identity?.Account !== ACCOUNT) fail('Wrong AWS account');
  if (identity.Arn === `arn:aws:iam::${ACCOUNT}:user/hermes-cli`) return identity.Arn;
  const role = new RegExp(`^arn:aws:sts::${ACCOUNT}:assumed-role/([^/]+)/[^/]+$`).exec(
    identity.Arn ?? '',
  );
  if (!role) fail('Unsupported AWS operator identity');
  return `arn:aws:iam::${ACCOUNT}:role/${role[1]}`;
}
function qualificationCopy(q) {
  const keys = [
    'schemaVersion',
    'service',
    'sourceSha',
    'image',
    'status',
    'schemaChange',
    'evidence',
    'reviewer',
    'reviewedAt',
    'checks',
    'expiresAt',
    'freshDatabase',
    'retiredUpgrade',
    'compatibility',
  ];
  if (!q || Object.keys(q).some((k) => !keys.includes(k))) fail('Unexpected qualification fields');
  return structuredClone(q);
}

export function governanceOperator({
  aws,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  beforeWrite = async () => {},
}) {
  const release = releaseOperator({ aws, now, sleep });
  const call = (...args) => aws(args);
  async function identity(expected) {
    const actual = principal(await call('sts', 'get-caller-identity'));
    if (actual !== expected) fail('AWS operator principal changed');
  }
  async function service() {
    const r = await call('ecs', 'describe-services', '--cluster', CLUSTER, '--services', SERVICE);
    if (r.failures?.length || r.services?.length !== 1) fail('Service readback ambiguous');
    return r.services[0];
  }
  async function definition(arn) {
    if (!ARN.test(arn ?? '')) fail('Wrong API task definition');
    const r = await call(
      'ecs',
      'describe-task-definition',
      '--task-definition',
      arn,
      '--include',
      'TAGS',
    );
    if (r.taskDefinition?.taskDefinitionArn !== arn || r.taskDefinition.status !== 'ACTIVE')
      fail('Task definition unavailable');
    return { ...r.taskDefinition, tags: r.tags ?? [] };
  }
  function validateManifest(m, hash) {
    if (
      !m ||
      m.kind !== 'meri-fixed-synthetic-governance-plan' ||
      m.version !== 1 ||
      m.account !== ACCOUNT ||
      m.region !== REGION ||
      m.cluster !== CLUSTER ||
      m.service !== SERVICE ||
      canonical(m.tenants) !== canonical(TENANTS) ||
      m.namespace !== NAMESPACE ||
      !SHA.test(m.operatorSourceSha ?? '') ||
      hash !== fingerprint(m)
    )
      fail('Manifest approval mismatch');
    const age = now() - Date.parse(m.preparedAt);
    if (!Number.isFinite(age) || age < 0 || age > 3600000) fail('Plan expired');
    validateQualification(m.qualification, 'api', m.qualification?.image, now());
    if (!ARN.test(m.baseline?.taskDefinitionArn ?? '') || !HASH.test(m.candidateTaskHash ?? ''))
      fail('Invalid baseline');
  }
  async function inspect(q, expectedCaller, operatorSourceSha) {
    if (!SHA.test(operatorSourceSha ?? '')) fail('Exact operator main SHA required');
    await identity(expectedCaller);
    q = qualificationCopy(q);
    validateQualification(q, 'api', q?.image, now());
    const qualified = await release.prepare(q); // ECR source tag, immutable digest, task/ALB health.
    const live = await release.snapshot('api');
    assertBaseline(qualified.baseline, live.baseline);
    if (live.baseline.imageDigest !== q.image.split('@')[1])
      fail('Qualified image is not currently served');
    const change = governanceTask(live.task, q, now());
    return {
      live,
      change,
      plan: {
        kind: 'meri-fixed-synthetic-governance-plan',
        version: 1,
        account: ACCOUNT,
        region: REGION,
        cluster: CLUSTER,
        service: SERVICE,
        operatorSourceSha,
        callerPrincipal: expectedCaller,
        preparedAt: new Date(now()).toISOString(),
        tenants: TENANTS,
        namespace: NAMESPACE,
        qualification: q,
        baseline: live.baseline,
        candidateTaskHash: fingerprint(change.proposed),
        changes: change.changes,
        changed: change.changed,
      },
    };
  }
  async function current(m) {
    const observed = await inspect(m.qualification, m.callerPrincipal, m.operatorSourceSha);
    assertBaseline(m.baseline, observed.plan.baseline);
    if (
      m.candidateTaskHash !== observed.plan.candidateTaskHash ||
      canonical(m.changes) !== canonical(observed.plan.changes) ||
      m.changed !== observed.plan.changed
    )
      fail('Planned transformation changed');
    return observed;
  }
  async function update(m, receipt, td, status, record) {
    await beforeWrite(m.operatorSourceSha);
    await identity(m.callerPrincipal);
    receipt.status = status + '-outcome-unknown';
    await record(receipt);
    const s = await service();
    const expected = receipt.rollback
      ? receipt.candidateTaskDefinition
      : m.baseline.taskDefinitionArn;
    const deployment = receipt.rollback ? receipt.deploymentId : undefined;
    if (
      s.taskDefinition !== expected ||
      serviceConfigFingerprint(s) !== m.baseline.configHash ||
      (deployment
        ? s.deployments?.find((d) => d.status === 'PRIMARY')?.id !== deployment
        : serviceFingerprint(s) !== m.baseline.serviceHash)
    )
      fail('Immediate service drift; no update');
    // ECS UpdateService has no CAS; root must hold an exclusive API change window.
    const r = await call(
      'ecs',
      'update-service',
      '--cluster',
      CLUSTER,
      '--service',
      SERVICE,
      '--task-definition',
      td,
    );
    const primary = r.service?.deployments?.find((d) => d.status === 'PRIMARY');
    if (
      r.service?.taskDefinition !== td ||
      primary?.taskDefinition !== td ||
      !primary.id ||
      serviceConfigFingerprint(r.service) !== m.baseline.configHash
    )
      fail('Update response ambiguous; reconcile before retry');
    if (receipt.rollback) receipt.rollbackDeploymentId = primary.id;
    else receipt.deploymentId = primary.id;
    receipt.status = status + '-acknowledged';
    await record(receipt);
  }
  async function wait(m, r, record) {
    const td = r.rollback ? m.baseline.taskDefinitionArn : r.candidateTaskDefinition;
    const deployment = r.rollback ? r.rollbackDeploymentId : r.deploymentId;
    const taskHash = r.rollback ? m.baseline.taskHash : m.candidateTaskHash;
    const deadline = now() + 25 * 60000;
    for (let attempt = 0; attempt < 100 && now() < deadline; attempt++) {
      const s = await service();
      if (
        s.taskDefinition !== td ||
        s.deployments?.find((d) => d.status === 'PRIMARY')?.id !== deployment ||
        serviceConfigFingerprint(s) !== m.baseline.configHash
      )
        fail('Concurrent rollout/configuration; no automatic rollback');
      if (s.deployments.some((d) => d.rolloutState === 'FAILED'))
        fail('Rollout failed; guarded manual rollback required');
      if (s.deployments.length === 1 && s.deployments[0].rolloutState === 'COMPLETED') {
        const fresh = await release.snapshot('api');
        if (
          fresh.service.taskDefinition !== td ||
          fresh.service.deployments[0]?.id !== deployment ||
          fresh.baseline.taskHash !== taskHash ||
          fresh.baseline.configHash !== m.baseline.configHash ||
          fresh.baseline.imageDigest !== m.baseline.imageDigest
        )
          fail('Final task/image/health mismatch');
        if (serviceFingerprint(await service()) !== serviceFingerprint(fresh.service))
          fail('Drift during final health check');
        r.status = r.rollback ? 'rollback-ecs-healthy' : 'ecs-healthy';
        r.verifiedAt = new Date(now()).toISOString();
        await record(r);
        return r;
      }
      await sleep(15000);
    }
    fail('Timed out; reconcile receipt before any new write');
  }
  return Object.freeze({
    prepare: async (q, caller, source) => (await inspect(q, caller, source)).plan,
    async apply(m, approvedHash, record) {
      if (typeof record !== 'function') fail('Durable execution recorder required');
      validateManifest(m, approvedHash);
      if (!m.changed) fail('Already configured; no service mutation needed');
      const { change } = await current(m);
      const r = {
        kind: 'meri-fixed-synthetic-governance-receipt',
        version: 1,
        manifestHash: approvedHash,
        status: 'register-outcome-unknown',
        rollback: false,
      };
      await record(r);
      await beforeWrite(m.operatorSourceSha);
      await identity(m.callerPrincipal);
      const response = await call(
        'ecs',
        'register-task-definition',
        '--cli-input-json',
        JSON.stringify(change.proposed),
      );
      r.candidateTaskDefinition = response.taskDefinition?.taskDefinitionArn;
      await record(r);
      if (
        fingerprint(taskInput(await definition(r.candidateTaskDefinition))) !== m.candidateTaskHash
      )
        fail('Registered configuration mismatch');
      r.status = 'registered-not-applied';
      await record(r);
      await current(m);
      await update(m, r, r.candidateTaskDefinition, 'apply', record);
      return wait(m, r, record);
    },
    async rollback(m, manifestHash, input, receiptHash, record) {
      if (typeof record !== 'function') fail('Durable execution recorder required');
      validateManifest(m, manifestHash);
      if (
        receiptHash !== fingerprint(input) ||
        input?.kind !== 'meri-fixed-synthetic-governance-receipt' ||
        input.version !== 1 ||
        input.manifestHash !== manifestHash ||
        input.rollback !== false ||
        !input.deploymentId ||
        !ARN.test(input.candidateTaskDefinition ?? '') ||
        input.candidateTaskDefinition === m.baseline.taskDefinitionArn
      )
        fail('Rollback receipt mismatch');
      await identity(m.callerPrincipal);
      const old = await definition(m.baseline.taskDefinitionArn);
      const original = taskInput(old),
        change = governanceTask(old, m.qualification, now());
      if (
        fingerprint(original) !== m.baseline.taskHash ||
        fingerprint(change.proposed) !== m.candidateTaskHash ||
        fingerprint(taskInput(await definition(input.candidateTaskDefinition))) !==
          m.candidateTaskHash
      )
        fail('Rollback configuration mismatch');
      const r = { ...structuredClone(input), rollback: true, priorReceiptHash: receiptHash };
      await update(m, r, m.baseline.taskDefinitionArn, 'rollback', record);
      return wait(m, r, record);
    },
  });
}

export function parseArgs(argv) {
  const [mode, ...args] = argv;
  const requirements = {
    plan: ['qualification', 'caller', 'out'],
    apply: ['manifest', 'approve', 'confirm', 'receipt'],
    rollback: ['manifest', 'approve', 'prior-receipt', 'rollback-approve', 'confirm', 'receipt'],
  };
  if (!Object.hasOwn(requirements, mode)) fail('Use plan, apply or rollback');
  const allowed = new Set([...requirements[mode], 'profile']);
  const result = { mode };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2),
      value = args[i + 1];
    if (
      !args[i]?.startsWith('--') ||
      !allowed.has(key) ||
      Object.hasOwn(result, key) ||
      !value ||
      value.startsWith('--')
    )
      fail('Unknown/duplicate/missing argument');
    result[key] = value;
  }
  if (requirements[mode].some((k) => !result[k])) fail('Required argument absent');
  if (
    mode !== 'plan' &&
    result.confirm !== `${mode.toUpperCase()}_FIXED_SYNTHETIC_MEMORY_GOVERNANCE`
  )
    fail('Exact fixed confirmation required');
  return result;
}

export async function assertMainSource(expected, exec = promisify(execFile)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const git = async (...args) =>
    (await exec('git', ['-C', root, ...args], { windowsHide: true })).stdout.trim();
  const head = await git('rev-parse', 'HEAD');
  if (
    !SHA.test(head) ||
    head !== (await git('rev-parse', 'origin/main')) ||
    (expected && head !== expected) ||
    (await git('status', '--porcelain')) ||
    !/^https:\/\/github\.com\/neo-capiro\/capirov2(?:\.git)?$/u.test(
      await git('remote', 'get-url', 'origin'),
    )
  )
    fail('Clean exact current main source required');
  if (
    process.env.GITHUB_ACTIONS === 'true' &&
    (process.env.GITHUB_REF !== 'refs/heads/main' ||
      process.env.GITHUB_REPOSITORY !== 'neo-capiro/capirov2' ||
      process.env.GITHUB_SHA !== head)
  )
    fail('Workflow must run exact merged main');
  return head;
}

async function cli() {
  const args = parseArgs(process.argv.slice(2));
  const exec = promisify(execFile);
  const source = await assertMainSource();
  const aws = async (command) => {
    let dir;
    try {
      const safe = [...command],
        index = safe.indexOf('--cli-input-json');
      if (index >= 0) {
        dir = await mkdtemp(path.join(tmpdir(), 'meri-governance-'));
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
    } catch {
      fail(`AWS ${command[0]} ${command[1]} failed; preserve receipt and reconcile without retry`);
    } finally {
      if (dir) {
        await rm(path.join(dir, 'task.json'), { force: true });
        await rmdir(dir);
      }
    }
  };
  const operator = governanceOperator({ aws, beforeWrite: assertMainSource });
  if (args.mode === 'plan') {
    const m = await operator.prepare(
      JSON.parse(await readFile(args.qualification, 'utf8')),
      args.caller,
      source,
    );
    await writeFile(args.out, JSON.stringify(m, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(
      JSON.stringify({ status: 'PREPARED_ONLY', manifestHash: fingerprint(m), changed: m.changed }),
    );
    return;
  }
  const m = JSON.parse(await readFile(args.manifest, 'utf8'));
  const inputs = [args.manifest, args['prior-receipt']].filter(Boolean).map((v) => path.resolve(v));
  if (inputs.includes(path.resolve(args.receipt))) fail('Receipt must preserve original inputs');
  const lock = await open(args.receipt + '.lock', 'wx', 0o600);
  await lock.writeFile(
    JSON.stringify({ manifestHash: args.approve, mode: args.mode, operatorSourceSha: source }),
  );
  await lock.sync();
  await lock.close();
  await writeFile(args.receipt, '{}\n', { flag: 'wx', mode: 0o600 });
  const record = (r) => persistReceipt(args.receipt, r);
  const r =
    args.mode === 'apply'
      ? await operator.apply(m, args.approve, record)
      : await operator.rollback(
          m,
          args.approve,
          JSON.parse(await readFile(args['prior-receipt'], 'utf8')),
          args['rollback-approve'],
          record,
        );
  console.log(JSON.stringify({ status: r.status, receiptHash: fingerprint(r) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  cli().catch(() => {
    console.error(
      'Synthetic governance operation refused or incomplete; inspect retained sanitized receipts, do not retry ambiguous writes.',
    );
    process.exitCode = 1;
  });
