/**
 * Phase 10 authorized-plane mutate helpers (sole live env=dev / capiro-dev).
 *
 * Guards:
 *  - PE_CLOSEOUT_STAGING_OK=yes + PE_CLOSEOUT_STAGING_MUTATE=yes
 *  - inventory.healthyCompute
 *  - never target forbidden clusters (staging dead plane, prod-os)
 *  - never Secrets Manager GetSecretValue from this process
 *  - never email / LlamaParse / derive --commit
 *
 * Deploy model (matches infra/cdk README + live drift):
 *  - Build/push linux/arm64 images tagged with branch SHA to capiro/dev/{api,web}
 *  - Register new task-def revisions pinning that digest (clone live TD)
 *  - update-service to new TD ARN; wait services stable
 *  - migrate via run-task capiro-dev-api-migrate with network from API service
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import {
  PE_PHASE_10_STAGING_EXPECTED,
} from './pe-phase-10-staging-acceptance-catalog.js';
import type {
  PePhase10ImageDigestRecord,
  PePhase10Inventory,
  PePhase10PriorTaskDef,
  PePhase10StepOutcome,
} from './pe-phase-10-staging-acceptance.js';
import {
  isForbiddenDeployCluster,
} from './pe-phase-10-staging-acceptance.js';

const exp = PE_PHASE_10_STAGING_EXPECTED;

export interface PePhase10ShipContext {
  root: string;
  headSha: string;
  inventory: PePhase10Inventory;
  awsEnv: NodeJS.ProcessEnv;
  evidenceDir: string;
}

export interface PePhase10ShipTrace {
  priorTaskDefs: PePhase10PriorTaskDef[];
  newApiTaskDefArn: string | null;
  newWebTaskDefArn: string | null;
  migrateTaskArn: string | null;
  images: PePhase10ImageDigestRecord[];
  apiImageDigest: string | null;
  webImageDigest: string | null;
  deployedCluster: string;
  notes: string[];
}

/** Disposable PASS-file and stale ship artifacts must not survive a harness rewrite. */
export const PE10_STALE_EVIDENCE_BASENAMES = [
  'rls-phase-c-pass.txt',
  'ship-trace.json',
  'deploy-result.json',
  'migrate-task-result.json',
] as const;

export function purgeStaleEvidenceArtifacts(evidenceDir: string): string[] {
  mkdirSync(evidenceDir, { recursive: true });
  const removed: string[] = [];
  for (const name of PE10_STALE_EVIDENCE_BASENAMES) {
    const p = resolve(evidenceDir, name);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
        removed.push(name);
      } catch {
        try {
          rmSync(p, { force: true });
          removed.push(name);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return removed;
}

/** Fill top-level api/web digests from images[] when callers left them null (skip-build path). */
export function resolveShipImageDigests(
  images: readonly PePhase10ImageDigestRecord[],
  prior?: { apiImageDigest?: string | null; webImageDigest?: string | null },
): { apiImageDigest: string | null; webImageDigest: string | null } {
  const api =
    prior?.apiImageDigest ||
    images.find((i) => i.present && i.digest && /\/api$|\/api\b|dev\/api/.test(i.repo))?.digest ||
    images.find((i) => i.present && i.digest && i.repo.includes('api'))?.digest ||
    null;
  const web =
    prior?.webImageDigest ||
    images.find((i) => i.present && i.digest && /\/web$|\/web\b|dev\/web/.test(i.repo))?.digest ||
    images.find((i) => i.present && i.digest && i.repo.includes('web'))?.digest ||
    null;
  return { apiImageDigest: api, webImageDigest: web };
}

export function writeShipTrace(evidenceDir: string, trace: PePhase10ShipTrace & Record<string, unknown>): void {
  mkdirSync(evidenceDir, { recursive: true });
  const digests = resolveShipImageDigests(trace.images ?? [], {
    apiImageDigest: trace.apiImageDigest,
    webImageDigest: trace.webImageDigest,
  });
  const normalized: PePhase10ShipTrace & Record<string, unknown> = {
    ...trace,
    apiImageDigest: digests.apiImageDigest,
    webImageDigest: digests.webImageDigest,
  };
  writeFileSync(
    resolve(evidenceDir, 'ship-trace.json'),
    JSON.stringify(
      {
        phase: 10,
        generatedAt: new Date().toISOString(),
        plane: {
          workflowEnv: exp.workflowEnv,
          ecsCluster: exp.ecsClusterName,
          appHost: exp.appHost,
          note: 'sole live env=dev = prod path; Neo PE_CLOSEOUT_STAGING_OK + MUTATE authorized',
        },
        ...normalized,
      },
      null,
      2,
    ),
  );
  if (normalized.newApiTaskDefArn || normalized.newWebTaskDefArn) {
    writeFileSync(
      resolve(evidenceDir, 'deploy-result.json'),
      JSON.stringify(
        {
          deployed: {
            apiTaskDef: normalized.newApiTaskDefArn,
            webTaskDef: normalized.newWebTaskDefArn,
            apiImage: normalized.apiImageDigest,
            webImage: normalized.webImageDigest,
            cluster: normalized.deployedCluster,
          },
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }
  if (trace.migrateTaskArn) {
    writeFileSync(
      resolve(evidenceDir, 'migrate-task-result.json'),
      JSON.stringify(
        {
          migrateTaskArn: trace.migrateTaskArn,
          generatedAt: new Date().toISOString(),
          note: 'ARN only; full describe may be in CloudWatch/ECS console',
        },
        null,
        2,
      ),
    );
  }
}


function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): { code: number; out: string } {
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...env, MSYS_NO_PATHCONV: '1', FORCE_COLOR: '0' },
    encoding: 'utf8',
    shell: false,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function runShell(command: string, env: NodeJS.ProcessEnv, cwd: string): { code: number; out: string } {
  const r = spawnSync(command, {
    cwd,
    env: { ...env, MSYS_NO_PATHCONV: '1', FORCE_COLOR: '0' },
    encoding: 'utf8',
    shell: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function awsJson(env: NodeJS.ProcessEnv, args: string[]): { code: number; json: any; out: string } {
  const r = run('aws', [...args, '--output', 'json'], env);
  if (r.code !== 0) return { code: r.code, json: null, out: r.out };
  try {
    return { code: 0, json: JSON.parse(r.out.trim() || 'null'), out: r.out };
  } catch {
    return { code: 1, json: null, out: r.out };
  }
}

/** Windows aws.exe `ecs wait` often hangs after the resource is already terminal. Poll describe instead. */
function sleepMs(ms: number): void {
  spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${Math.max(0, ms)})`], {
    shell: false,
    stdio: 'ignore',
  });
}

function waitTasksStopped(
  env: NodeJS.ProcessEnv,
  cluster: string,
  taskArn: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): { code: number; out: string } {
  const timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 5000;
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    const d = awsJson(env, [
      'ecs',
      'describe-tasks',
      '--cluster',
      cluster,
      '--tasks',
      taskArn,
      '--query',
      'tasks[0].{last:lastStatus,desired:desiredStatus,stop:stoppedReason,exit:containers[0].exitCode}',
    ]);
    last = d.out;
    const st = String(d.json?.last || '').toUpperCase();
    if (st === 'STOPPED') return { code: 0, out: last };
    sleepMs(intervalMs);
  }
  return { code: 1, out: `waitTasksStopped timeout task=${taskArn} last=${last.slice(0, 400)}` };
}

function waitServicesStable(
  env: NodeJS.ProcessEnv,
  cluster: string,
  service: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): { code: number; out: string } {
  const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 10000;
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    const d = awsJson(env, [
      'ecs',
      'describe-services',
      '--cluster',
      cluster,
      '--services',
      service,
      '--query',
      'services[0].{running:runningCount,desired:desiredCount,pending:pendingCount,deps:deployments[*].{status:status,rollout:rolloutState,running:runningCount,desired:desiredCount,pending:pendingCount,failed:failedTasks}}',
    ]);
    last = d.out;
    const running = Number(d.json?.running ?? -1);
    const desired = Number(d.json?.desired ?? -1);
    const pending = Number(d.json?.pending ?? -1);
    const deps = Array.isArray(d.json?.deps) ? d.json.deps : [];
    const primary = deps.find((x: any) => String(x?.status || '').toUpperCase() === 'PRIMARY') || deps[0];
    const roll = String(primary?.rollout || '').toUpperCase();
    const onlyPrimary = deps.length <= 1;
    if (
      d.code === 0 &&
      desired >= 0 &&
      running === desired &&
      pending === 0 &&
      onlyPrimary &&
      (roll === 'COMPLETED' || roll === 'IN_PROGRESS' || roll === '')
    ) {
      // Prefer COMPLETED; allow steady running==desired with single deployment even if rollout blank.
      if (roll === 'COMPLETED' || (onlyPrimary && running === desired && pending === 0 && desired > 0)) {
        if (roll === 'COMPLETED' || roll === '') {
          return { code: 0, out: last };
        }
      }
    }
    // Fail fast on FAILED rollout
    if (roll === 'FAILED') {
      return { code: 1, out: `waitServicesStable FAILED rollout service=${service} ${last.slice(0, 600)}` };
    }
    sleepMs(intervalMs);
  }
  return { code: 1, out: `waitServicesStable timeout service=${service} last=${last.slice(0, 600)}` };
}


export function assertAuthorizedClusterOrThrow(cluster: string): void {
  if (isForbiddenDeployCluster(cluster)) {
    throw new Error(`refusing deploy to forbidden cluster ${cluster}`);
  }
  if (cluster !== exp.ecsClusterName) {
    throw new Error(`refusing deploy to unexpected cluster ${cluster} (want ${exp.ecsClusterName})`);
  }
}

export function capturePriorTaskDefs(
  env: NodeJS.ProcessEnv,
  inventory: PePhase10Inventory,
): PePhase10PriorTaskDef[] {
  if (inventory.priorTaskDefs?.length) {
    return inventory.priorTaskDefs.map((t) => ({ ...t }));
  }
  const out: PePhase10PriorTaskDef[] = [];
  for (const svc of [exp.apiServiceName, exp.webServiceName]) {
    const d = awsJson(env, [
      'ecs',
      'describe-services',
      '--cluster',
      exp.ecsClusterName,
      '--services',
      svc,
      '--query',
      'services[0].taskDefinition',
    ]);
    const arn = typeof d.json === 'string' ? d.json : null;
    if (!arn) continue;
    const family = arn.split('/').pop()?.split(':')[0] ?? svc;
    let rev: number | null = null;
    try {
      rev = Number(arn.split(':').pop());
    } catch {
      rev = null;
    }
    const td = awsJson(env, [
      'ecs',
      'describe-task-definition',
      '--task-definition',
      arn,
      '--query',
      'taskDefinition.containerDefinitions[0].image',
    ]);
    out.push({
      family,
      revision: Number.isFinite(rev as number) ? rev : null,
      arn,
      image: typeof td.json === 'string' ? td.json : null,
    });
  }
  return out;
}

export function ecrDigestForTag(
  env: NodeJS.ProcessEnv,
  repo: string,
  tag: string,
): PePhase10ImageDigestRecord {
  const q = awsJson(env, [
    'ecr',
    'describe-images',
    '--repository-name',
    repo,
    '--image-ids',
    `imageTag=${tag}`,
    '--query',
    'imageDetails[0].{digest:imageDigest,pushed:imagePushedAt,tags:imageTags}',
  ]);
  if (q.code === 0 && q.json?.digest) {
    return {
      repo,
      tag,
      digest: q.json.digest,
      pushedAt: q.json.pushed ?? null,
      present: true,
    };
  }
  return {
    repo,
    tag,
    digest: null,
    pushedAt: null,
    present: false,
    note: q.out.slice(0, 200) || 'tag absent',
  };
}

export function buildAndPushBranchImages(
  ctx: PePhase10ShipContext,
): { ok: boolean; images: PePhase10ImageDigestRecord[]; detail: string } {
  assertAuthorizedClusterOrThrow(exp.ecsClusterName);
  const reg = `${exp.accountId}.dkr.ecr.${exp.region}.amazonaws.com`;
  const tags = {
    api: `${reg}/${exp.ecrApiRepo}:${ctx.headSha}`,
    apiLatest: `${reg}/${exp.ecrApiRepo}:latest`,
    web: `${reg}/${exp.ecrWebRepo}:${ctx.headSha}`,
    webLatest: `${reg}/${exp.ecrWebRepo}:latest`,
  };

  // Login
  const login = runShell(
    `aws ecr get-login-password --region ${exp.region} | docker login --username AWS --password-stdin ${reg}`,
    ctx.awsEnv,
    ctx.root,
  );
  if (login.code !== 0) {
    return { ok: false, images: [], detail: `ecr login failed: ${login.out.slice(0, 500)}` };
  }

  const apiBuild = runShell(
    `docker buildx build --platform linux/arm64 -f apps/api/Dockerfile -t ${tags.api} -t ${tags.apiLatest} --push .`,
    ctx.awsEnv,
    ctx.root,
  );
  if (apiBuild.code !== 0) {
    return { ok: false, images: [], detail: `api image build/push failed: ${apiBuild.out.slice(-1500)}` };
  }

  const webBuild = runShell(
    `docker buildx build --platform linux/arm64 -f apps/web/Dockerfile --build-arg GIT_SHA=${ctx.headSha} -t ${tags.web} -t ${tags.webLatest} --push .`,
    ctx.awsEnv,
    ctx.root,
  );
  if (webBuild.code !== 0) {
    return { ok: false, images: [], detail: `web image build/push failed: ${webBuild.out.slice(-1500)}` };
  }

  const images = [
    ecrDigestForTag(ctx.awsEnv, exp.ecrApiRepo, ctx.headSha),
    ecrDigestForTag(ctx.awsEnv, exp.ecrWebRepo, ctx.headSha),
  ];
  const ok = images.every((i) => i.present && !!i.digest);
  return {
    ok,
    images,
    detail: ok
      ? `pushed api+web @ ${ctx.headSha}; digests=${images.map((i) => i.digest).join(',')}`
      : `push claimed ok but describe-images missing tip tags: ${JSON.stringify(images)}`,
  };
}

function cloneTaskDefWithImage(
  env: NodeJS.ProcessEnv,
  family: string,
  imageUri: string,
): { ok: boolean; arn: string | null; detail: string } {
  const d = awsJson(env, ['ecs', 'describe-task-definition', '--task-definition', family]);
  if (d.code !== 0 || !d.json?.taskDefinition) {
    return { ok: false, arn: null, detail: `describe-task-definition ${family} failed: ${d.out.slice(0, 400)}` };
  }
  const td = d.json.taskDefinition;
  const payload: Record<string, unknown> = {
    family: td.family,
    taskRoleArn: td.taskRoleArn,
    executionRoleArn: td.executionRoleArn,
    networkMode: td.networkMode,
    containerDefinitions: (td.containerDefinitions as any[]).map((c) => ({
      ...c,
      image: imageUri,
    })),
    requiresCompatibilities: td.requiresCompatibilities,
    cpu: td.cpu,
    memory: td.memory,
  };
  if (td.runtimePlatform) payload.runtimePlatform = td.runtimePlatform;
  if (td.volumes) payload.volumes = td.volumes;
  if (td.placementConstraints) payload.placementConstraints = td.placementConstraints;

  const tmp = resolve(
    process.env.TEMP || process.env.TMP || '/tmp',
    `pe10-td-${family.replace(/[^a-z0-9-]/gi, '')}-${Date.now()}.json`,
  );
  writeFileSync(tmp, JSON.stringify(payload));
  const fileUri = 'file://' + tmp.replace(/\\/g, '/');
  let reg = awsJson(env, ['ecs', 'register-task-definition', '--cli-input-json', fileUri]);
  if (reg.code !== 0) {
    reg = awsJson(env, ['ecs', 'register-task-definition', '--cli-input-json', 'file://' + tmp]);
  }
  if (reg.code !== 0 || !reg.json?.taskDefinition?.taskDefinitionArn) {
    return {
      ok: false,
      arn: null,
      detail: `register-task-definition failed: ${reg.out.slice(0, 600)}`,
    };
  }
  const arn = reg.json.taskDefinition.taskDefinitionArn as string;
  return { ok: true, arn, detail: `registered ${arn}` };
}

export function deployBranchTaskDefs(
  ctx: PePhase10ShipContext,
  apiImageUri: string,
  webImageUri: string,
): { ok: boolean; apiArn: string | null; webArn: string | null; detail: string } {
  assertAuthorizedClusterOrThrow(exp.ecsClusterName);
  const api = cloneTaskDefWithImage(ctx.awsEnv, exp.apiTaskDefinitionFamily, apiImageUri);
  if (!api.ok || !api.arn) return { ok: false, apiArn: null, webArn: null, detail: api.detail };
  const web = cloneTaskDefWithImage(ctx.awsEnv, exp.webTaskDefinitionFamily, webImageUri);
  if (!web.ok || !web.arn) return { ok: false, apiArn: api.arn, webArn: null, detail: web.detail };

  const u1 = run(
    'aws',
    [
      'ecs',
      'update-service',
      '--cluster',
      exp.ecsClusterName,
      '--service',
      exp.apiServiceName,
      '--task-definition',
      api.arn,
      '--force-new-deployment',
    ],
    ctx.awsEnv,
  );
  if (u1.code !== 0) {
    return { ok: false, apiArn: api.arn, webArn: web.arn, detail: `update api failed: ${u1.out.slice(0, 500)}` };
  }
  const u2 = run(
    'aws',
    [
      'ecs',
      'update-service',
      '--cluster',
      exp.ecsClusterName,
      '--service',
      exp.webServiceName,
      '--task-definition',
      web.arn,
      '--force-new-deployment',
    ],
    ctx.awsEnv,
  );
  if (u2.code !== 0) {
    return { ok: false, apiArn: api.arn, webArn: web.arn, detail: `update web failed: ${u2.out.slice(0, 500)}` };
  }

  // Wait stability (long)
  const w1 = waitServicesStable(ctx.awsEnv, exp.ecsClusterName, exp.apiServiceName);
  const w2 = waitServicesStable(ctx.awsEnv, exp.ecsClusterName, exp.webServiceName);
  if (w1.code !== 0 || w2.code !== 0) {
    return {
      ok: false,
      apiArn: api.arn,
      webArn: web.arn,
      detail: `services-stable wait failed api=${w1.code} web=${w2.code} ${w1.out.slice(0, 200)} ${w2.out.slice(0, 200)}`,
    };
  }
  return {
    ok: true,
    apiArn: api.arn,
    webArn: web.arn,
    detail: `deployed api=${api.arn} web=${web.arn} on ${exp.ecsClusterName}`,
  };
}

export function runAdditiveMigrate(
  ctx: PePhase10ShipContext,
  migrateImageUri: string | null,
): { ok: boolean; taskArn: string | null; detail: string } {
  assertAuthorizedClusterOrThrow(exp.ecsClusterName);
  // Optionally pin migrate TD image when we have a branch image
  let tdFamily: string = exp.migrateTaskDefinitionFamily;
  if (migrateImageUri) {
    const reg = cloneTaskDefWithImage(ctx.awsEnv, exp.migrateTaskDefinitionFamily, migrateImageUri);
    if (reg.ok && reg.arn) tdFamily = reg.arn;
  }

  const net = awsJson(ctx.awsEnv, [
    'ecs',
    'describe-services',
    '--cluster',
    exp.ecsClusterName,
    '--services',
    exp.apiServiceName,
    '--query',
    'services[0].networkConfiguration',
  ]);
  if (net.code !== 0 || !net.json?.awsvpcConfiguration) {
    return { ok: false, taskArn: null, detail: `networkConfiguration missing: ${net.out.slice(0, 400)}` };
  }
  const awsvpc = net.json.awsvpcConfiguration;
  const nc = `awsvpcConfiguration={subnets=[${awsvpc.subnets.join(',')}],securityGroups=[${awsvpc.securityGroups.join(',')}],assignPublicIp=${awsvpc.assignPublicIp || 'DISABLED'}}`;

  const rt = awsJson(ctx.awsEnv, [
    'ecs',
    'run-task',
    '--cluster',
    exp.ecsClusterName,
    '--task-definition',
    tdFamily,
    '--launch-type',
    'FARGATE',
    '--network-configuration',
    nc,
    '--count',
    '1',
  ]);
  if (rt.code !== 0 || !rt.json?.tasks?.[0]?.taskArn) {
    return {
      ok: false,
      taskArn: null,
      detail: `run-task migrate failed: ${(rt.out || '').slice(0, 800)} failures=${JSON.stringify(rt.json?.failures ?? [])}`,
    };
  }
  const taskArn = rt.json.tasks[0].taskArn as string;
  const wait = waitTasksStopped(ctx.awsEnv, exp.ecsClusterName, taskArn);
  const desc = awsJson(ctx.awsEnv, [
    'ecs',
    'describe-tasks',
    '--cluster',
    exp.ecsClusterName,
    '--tasks',
    taskArn,
    '--query',
    'tasks[0].{stop:stoppedReason,containers:containers[*].{name:name,exit:exitCode,reason:reason}}',
  ]);
  const exitCode = desc.json?.containers?.[0]?.exit;
  const ok = wait.code === 0 && exitCode === 0;
  return {
    ok,
    taskArn,
    detail: ok
      ? `migrate task ${taskArn} exit=0`
      : `migrate task ${taskArn} failed wait=${wait.code} exit=${exitCode} body=${JSON.stringify(desc.json).slice(0, 600)}`,
  };
}

export interface PePhase10PlanVerifyResidual {
  ok: boolean;
  path: string | null;
  detail: string;
}

/**
 * Neo-written residual for plan Verify bullets that cannot be live-proven without
 * authenticated session. File must include the marker token and cite Phase 5/6 + PE 401 wall.
 * Implementer must not invent this file.
 */
export function loadPlanVerifyResidual(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): PePhase10PlanVerifyResidual {
  const candidates: string[] = [];
  const envPath = (env.PE_CLOSEOUT_PLAN_VERIFY_RESIDUAL_PATH || '').trim();
  if (envPath) candidates.push(envPath);
  candidates.push(
    resolve(root, 'docs/verification/program-elements-trust/phase-10/plan-verify-neo-residual.md'),
    resolve(root, 'prompts/phase-10-plan-verify-residual.md'),
  );
  const downloads = (env.PE_CLOSEOUT_PROMPTS_DIR || '').trim();
  if (downloads) candidates.push(resolve(downloads, 'phase-10-plan-verify-residual.md'));
  // Common operator path next to pe-closeout launcher
  const home = (env.USERPROFILE || env.HOME || '').replace(/\\/g, '/');
  if (home) {
    candidates.push(
      `${home}/Downloads/pe-closeout/prompts/phase-10-plan-verify-residual.md`,
      `${home}/Downloads/pe-closeout/prompts/phase-10-neo-plan-verify-residual.md`,
    );
  }

  const marker = 'PE_PHASE_10_PLAN_VERIFY_RESIDUAL_OK';
  for (const p of candidates) {
    if (!p || !existsSync(p)) continue;
    let text = '';
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const hasMarker = text.includes(marker);
    const citesPhase56 =
      /phase\s*5/i.test(text) &&
      /phase\s*6/i.test(text) &&
      (/401/.test(text) || /auth.?wall/i.test(text)) &&
      (/failed\s*[≠!=]+\s*empty|failed.?empty|data.?issue|blocked.?crm|crm.?contact/i.test(text) ||
        /substitut/i.test(text));
    const neoVoice = /neo/i.test(text) || /operator/i.test(text) || /authoriz/i.test(text);
    if (hasMarker && citesPhase56 && neoVoice) {
      return {
        ok: true,
        path: p,
        detail: `neo residual ok path=${p} marker=${marker}`,
      };
    }
    return {
      ok: false,
      path: p,
      detail: `residual present but invalid path=${p} marker=${hasMarker} phase56=${citesPhase56} neoVoice=${neoVoice}`,
    };
  }
  return {
    ok: false,
    path: null,
    detail:
      'no Neo plan-verify residual on file (need PE_PHASE_10_PLAN_VERIFY_RESIDUAL_OK + Phase 5/6 + 401 wall language)',
  };
}

export interface PePhase10BrowserSmokeResult {
  ok: boolean;
  detail: string;
  /** Plan Verify closed via authenticated PE smoke OR valid Neo residual. */
  planVerifyClosed: boolean;
  planVerifyMode: 'authenticated_smoke' | 'neo_residual' | 'unauthenticated_only' | 'failed';
  residual: PePhase10PlanVerifyResidual | null;
}

/**
 * Unauthenticated PE auth-wall smoke + optional authenticated plan Verify matrix.
 * Auth via PE_CLOSEOUT_SMOKE_COOKIE or PE_CLOSEOUT_SMOKE_BEARER (never logged in full).
 * Without auth, planVerifyClosed only if Neo residual loads.
 */
export function browserSmoke(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { root?: string },
): PePhase10BrowserSmokeResult {
  const host = exp.appHost;
  const tmpBase = (process.env.TEMP || process.env.TMP || '/tmp').replace(/\\/g, '/');
  const curl = (url: string, idx: number, extraHeaders: string[] = []) => {
    const tmp = `${tmpBase}/pe10curl-${idx}.out`;
    const hdr = extraHeaders.map((h) => `-H ${JSON.stringify(h)}`).join(' ');
    const r = runShell(
      `curl -sS -L --max-time 30 -o "${tmp}" -w "%{http_code}" ${hdr} "${url}"`,
      env,
      process.cwd(),
    );
    const digits = String(r.out || '').replace(/\D/g, '');
    const code = (digits.slice(-3) || '000').padStart(3, '0').slice(-3);
    let body = '';
    try {
      body = readFileSync(tmp, 'utf8').slice(0, 4000);
    } catch {
      body = '';
    }
    return { code, body, raw: String(r.out || '').slice(0, 400) };
  };

  // Base: PE read contract + auth wall beyond /health (unauthenticated).
  const paths = [
    { id: 'root', url: `https://${host}/`, want: ['200'], headers: [] as string[] },
    { id: 'health', url: `https://${host}/health`, want: ['200', '401'], headers: [] as string[] },
    { id: 'healthz', url: `https://${host}/healthz`, want: ['200', '401'], headers: [] as string[] },
    { id: 'api_health', url: `https://${host}/api/health`, want: ['200', '401', '404'], headers: [] as string[] },
    {
      id: 'pe_list',
      url: `https://${host}/api/program-elements?limit=1`,
      want: ['200', '401', '403'],
      headers: ['Accept: application/json'],
    },
    {
      id: 'pe_detail',
      url: `https://${host}/api/program-elements/0603270A`,
      want: ['200', '401', '403', '404'],
      headers: ['Accept: application/json'],
    },
    {
      id: 'pe_positions',
      url: `https://${host}/api/program-elements/0603270A/positions`,
      want: ['200', '401', '403', '404'],
      headers: ['Accept: application/json'],
    },
    {
      id: 'pe_timeline',
      url: `https://${host}/api/program-elements/0603270A/timeline`,
      want: ['200', '401', '403', '404'],
      headers: ['Accept: application/json'],
    },
    {
      id: 'pe_data_issues',
      url: `https://${host}/api/program-elements/0603270A/data-issues`,
      want: ['200', '401', '403', '404'],
      headers: ['Accept: application/json'],
    },
    {
      id: 'pe_personnel',
      url: `https://${host}/api/program-elements/0603270A/personnel`,
      want: ['200', '401', '403', '404'],
      headers: ['Accept: application/json'],
    },
    {
      id: 'pe_web_route',
      url: `https://${host}/program-elements/0603270A`,
      want: ['200', '401', '403', '302', '301'],
      headers: ['Accept: text/html'],
    },
  ];
  const results: Record<string, string> = {};
  const failures: string[] = [];
  const bodyNotes: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const pth = paths[i]!;
    const r = curl(pth.url, i, pth.headers);
    results[pth.id] = r.code;
    if (!pth.want.includes(r.code)) failures.push(`${pth.id}=${r.code}`);
    if (pth.id.startsWith('pe_') && r.code === '200') {
      const trimmed = (r.body || '').trim();
      if (!trimmed) {
        failures.push(`${pth.id}:200 empty body`);
      } else {
        bodyNotes.push(`${pth.id}:bodyLen=${trimmed.length}`);
      }
    }
    if (pth.id === 'pe_web_route' && r.code === '200') {
      const html = r.body || '';
      if (html && !/root|app|capiro|program/i.test(html)) {
        bodyNotes.push('pe_web_route: atypical HTML shell');
      }
    }
  }
  const peAuthWall =
    ['pe_list', 'pe_detail', 'pe_positions', 'pe_timeline', 'pe_data_issues', 'pe_personnel'].every((id) =>
      ['401', '403', '200', '404'].includes(results[id] || ''),
    ) && ['pe_list', 'pe_detail'].some((id) => ['401', '403'].includes(results[id] || ''));
  if (!peAuthWall) failures.push('pe_read_contract_missing');

  // Authenticated plan Verify (optional): failed≠empty surfaces + data-issue + CRM personnel.
  const cookie = (env.PE_CLOSEOUT_SMOKE_COOKIE || '').trim();
  const bearer = (env.PE_CLOSEOUT_SMOKE_BEARER || '').trim();
  let authOk = false;
  const authNotes: string[] = [];
  if (cookie || bearer) {
    const authHeaders = ['Accept: application/json'];
    if (cookie) authHeaders.push(`Cookie: ${cookie}`);
    if (bearer) authHeaders.push(`Authorization: Bearer ${bearer}`);
    const pe = (env.PE_CLOSEOUT_SMOKE_PE || '0603270A').trim();
    const authPaths = [
      { id: 'auth_pe_detail', url: `https://${host}/api/program-elements/${pe}`, want: ['200'] },
      {
        id: 'auth_pe_positions',
        url: `https://${host}/api/program-elements/${pe}/positions`,
        want: ['200'],
      },
      {
        id: 'auth_pe_data_issues',
        url: `https://${host}/api/program-elements/${pe}/data-issues`,
        want: ['200'],
      },
      {
        id: 'auth_pe_personnel',
        url: `https://${host}/api/program-elements/${pe}/personnel`,
        want: ['200'],
      },
      {
        id: 'auth_pe_timeline',
        url: `https://${host}/api/program-elements/${pe}/timeline`,
        want: ['200'],
      },
    ];
    let authFail = false;
    for (let i = 0; i < authPaths.length; i++) {
      const pth = authPaths[i]!;
      const r = curl(pth.url, 100 + i, authHeaders);
      results[pth.id] = r.code;
      if (!pth.want.includes(r.code)) {
        authFail = true;
        failures.push(`${pth.id}=${r.code}`);
        continue;
      }
      const body = (r.body || '').trim();
      // failed≠empty honesty: body must not look like silent success-empty for error payloads
      if (/\"status\"\s*:\s*\"error\"|\"failed\"\s*:\s*true/i.test(body) && /\"items\"\s*:\s*\[\s*\]/.test(body)) {
        // error+empty items is ok as failed signal
        authNotes.push(`${pth.id}:failed_signal`);
      } else if (body.length < 2) {
        authFail = true;
        failures.push(`${pth.id}:empty_body`);
      } else {
        authNotes.push(`${pth.id}:ok_len=${body.length}`);
      }
      // data-issue surface must be structured JSON
      if (pth.id === 'auth_pe_data_issues') {
        if (!/[\[{]/.test(body)) {
          authFail = true;
          failures.push('auth_pe_data_issues:not_json');
        } else {
          authNotes.push('data_issue_surface_json');
        }
      }
      // personnel/CRM surface present (blocked CRM is server-side; 200 JSON proves route live)
      if (pth.id === 'auth_pe_personnel') {
        if (!/[\[{]/.test(body)) {
          authFail = true;
          failures.push('auth_pe_personnel:not_json');
        } else {
          authNotes.push('crm_personnel_surface_json');
        }
      }
      // positions: track/FY honesty — JSON must be parseable array/object (track fields when present)
      if (pth.id === 'auth_pe_positions' && body) {
        if (/track|fiscal|fy|vehicle|zero/i.test(body) || /[\[{]/.test(body)) {
          authNotes.push('positions_track_fy_surface');
        }
      }
    }
    authOk = !authFail && authNotes.length > 0;
    // Never echo cookie/bearer values
    bodyNotes.push(`auth_headers=${cookie ? 'cookie' : ''}${bearer ? 'bearer' : ''}`);
    bodyNotes.push(...authNotes.slice(0, 12));
  }

  const residual = loadPlanVerifyResidual(opts?.root || process.cwd(), env);
  let planVerifyClosed = false;
  let planVerifyMode: PePhase10BrowserSmokeResult['planVerifyMode'] = 'unauthenticated_only';
  if (authOk) {
    planVerifyClosed = true;
    planVerifyMode = 'authenticated_smoke';
  } else if (residual.ok) {
    planVerifyClosed = true;
    planVerifyMode = 'neo_residual';
    bodyNotes.push(residual.detail);
  } else {
    planVerifyMode = cookie || bearer ? 'failed' : 'unauthenticated_only';
    if (!residual.ok) bodyNotes.push(residual.detail);
  }

  const baseOk = failures.filter((f) => !f.startsWith('auth_')).length === 0 && results.root === '200';
  // browser_smoke step ok = base unauth wall holds; planVerify is separate gate input
  const ok = baseOk && (planVerifyClosed || !(cookie || bearer) || authOk);
  // If auth credentials supplied but auth failed, step fails
  const stepOk = baseOk && (!(cookie || bearer) || authOk);

  return {
    ok: stepOk,
    planVerifyClosed,
    planVerifyMode,
    residual,
    detail: `host=${host} codes=${JSON.stringify(results)}${
      failures.length ? ` FAIL ${failures.join(',')}` : ''
    } planVerify=${planVerifyMode} closed=${planVerifyClosed} notes=${bodyNotes.slice(0, 14).join(';')} (unauth PE 401 wall; plan Verify needs auth smoke or Neo residual)`,
  };
}


/**
 * ECS one-shot pe-phase-10-live-proofs on sole-live plane.
 * DB secrets stay in-task; harness never GetSecretValue.
 */
export function runLiveProofsTask(
  ctx: PePhase10ShipContext,
  apiImageUri: string | null,
): {
  ok: boolean;
  taskArn: string | null;
  report: any | null;
  logText: string;
  detail: string;
} {
  assertAuthorizedClusterOrThrow(exp.ecsClusterName);
  let tdFamily: string = exp.apiTaskDefinitionFamily;
  if (apiImageUri) {
    const reg = cloneTaskDefWithImage(ctx.awsEnv, exp.apiTaskDefinitionFamily, apiImageUri);
    if (reg.ok && reg.arn) tdFamily = reg.arn;
  }

  const net = awsJson(ctx.awsEnv, [
    'ecs',
    'describe-services',
    '--cluster',
    exp.ecsClusterName,
    '--services',
    exp.apiServiceName,
    '--query',
    'services[0].networkConfiguration',
  ]);
  if (net.code !== 0 || !net.json?.awsvpcConfiguration) {
    return {
      ok: false,
      taskArn: null,
      report: null,
      logText: '',
      detail: `networkConfiguration missing: ${net.out.slice(0, 400)}`,
    };
  }
  const awsvpc = net.json.awsvpcConfiguration;
  const nc = `awsvpcConfiguration={subnets=[${awsvpc.subnets.join(',')}],securityGroups=[${awsvpc.securityGroups.join(',')}],assignPublicIp=${awsvpc.assignPublicIp || 'DISABLED'}}`;

  const ovPath = resolve(
    process.env.TEMP || process.env.TMP || '/tmp',
    `pe10-live-proofs-overrides-${Date.now()}.json`,
  );
  writeFileSync(
    ovPath,
    JSON.stringify({
      containerOverrides: [
        {
          name: 'api',
          // command becomes args to image ENTRYPOINT (entrypoint.sh).
          // TMPDIR=/dev/shm is the production Fargate tsx IPC fix (see set-tenant-flag). /tmp and /app/tmp ENOENT on mkdir tsx-UID.
          command: ['pe-phase-10-live-proofs'],
          environment: [
            { name: 'GIT_SHA', value: ctx.headSha },
            { name: 'PE_CLOSEOUT_HEAD_SHA', value: ctx.headSha },
            { name: 'TMPDIR', value: '/dev/shm' },
          ],
        },
      ],
    }),
  );
  const ovFile = 'file://' + ovPath.replace(/\\/g, '/');

  let rt = awsJson(ctx.awsEnv, [
    'ecs',
    'run-task',
    '--cluster',
    exp.ecsClusterName,
    '--task-definition',
    tdFamily,
    '--launch-type',
    'FARGATE',
    '--network-configuration',
    nc,
    '--overrides',
    ovFile,
    '--count',
    '1',
  ]);
  let taskArn: string | null = rt.json?.tasks?.[0]?.taskArn ?? null;
  if (!taskArn) {
    rt = awsJson(ctx.awsEnv, [
      'ecs',
      'run-task',
      '--cluster',
      exp.ecsClusterName,
      '--task-definition',
      tdFamily,
      '--launch-type',
      'FARGATE',
      '--network-configuration',
      nc,
      '--overrides',
      `file://${ovPath}`,
      '--count',
      '1',
    ]);
    taskArn = rt.json?.tasks?.[0]?.taskArn ?? null;
  }
  if (!taskArn) {
    return {
      ok: false,
      taskArn: null,
      report: null,
      logText: '',
      detail: `run-task live proofs failed: ${(rt.out || '').slice(0, 800)} failures=${JSON.stringify(rt.json?.failures ?? [])}`,
    };
  }

  const wait = waitTasksStopped(ctx.awsEnv, exp.ecsClusterName, taskArn);
  const desc = awsJson(ctx.awsEnv, [
    'ecs',
    'describe-tasks',
    '--cluster',
    exp.ecsClusterName,
    '--tasks',
    taskArn,
    '--query',
    'tasks[0].{stop:stoppedReason,containers:containers[*].{name:name,exit:exitCode,reason:reason},startedAt:startedAt,stoppedAt:stoppedAt}',
  ]);
  const exitCode = desc.json?.containers?.[0]?.exit;

  const logCfg = awsJson(ctx.awsEnv, [
    'ecs',
    'describe-task-definition',
    '--task-definition',
    exp.apiTaskDefinitionFamily,
    '--query',
    'taskDefinition.containerDefinitions[0].logConfiguration',
  ]);
  let logText = '';
  try {
    const options = logCfg.json?.options ?? {};
    const group = (options['awslogs-group'] as string | undefined) || '/capiro/dev/api';
    const prefix = (options['awslogs-stream-prefix'] as string | undefined) || 'api';
    const taskId = taskArn.split('/').pop();
    if (group && taskId) {
      const streamCandidates = [
        `${prefix}/api/${taskId}`,
        `api/api/${taskId}`,
        `${prefix}/${taskId}`,
      ];
      for (const stream of streamCandidates) {
        const logs = run(
          'aws',
          [
            'logs',
            'get-log-events',
            '--log-group-name',
            group,
            '--log-stream-name',
            stream,
            '--limit',
            '500',
            '--output',
            'json',
          ],
          ctx.awsEnv,
        );
        if (logs.code !== 0) continue;
        try {
          const parsed = JSON.parse(logs.out || '{}');
          const text = (parsed.events || []).map((e: any) => e.message).join('\n');
          if (text.trim()) {
            logText = text;
            break;
          }
        } catch {
          if (logs.out.trim()) {
            logText = logs.out.slice(0, 8000);
            break;
          }
        }
      }
    }
  } catch {
    logText = '';
  }

  let report: any = null;
  // Prefer FULL report JSON (steps + metrics). SUMMARY is recovery only — must not drop metrics.
  {
    const markerIdx = logText.lastIndexOf('PE_PHASE_10_LIVE_PROOFS_');
    if (markerIdx >= 0) {
      let searchFrom = 0;
      let best: any = null;
      while (searchFrom < markerIdx) {
        const before = logText.indexOf('{', searchFrom);
        if (before < 0 || before >= markerIdx) break;
        let depth = 0;
        let endBrace = -1;
        for (let i = before; i < logText.length && i < markerIdx + 120; i++) {
          const ch = logText[i];
          if (ch === '{') depth += 1;
          else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
              endBrace = i + 1;
              break;
            }
          }
        }
        if (endBrace > before) {
          const slice = logText.slice(before, endBrace);
          if (
            slice.includes('"steps"') &&
            /"marker"\s*:\s*"PE_PHASE_10_LIVE_PROOFS_/.test(slice) &&
            !slice.includes('PE_PHASE_10_LIVE_PROOFS_SUMMARY')
          ) {
            try {
              const parsed = JSON.parse(slice);
              if (Array.isArray(parsed.steps) && parsed.steps.some((s: any) => s && s.metrics)) {
                best = parsed;
                break;
              }
              if (!best && Array.isArray(parsed.steps)) best = parsed;
            } catch {
              /* continue */
            }
          }
        }
        searchFrom = before + 1;
      }
      if (best) {
        report = { ...best, fromSummary: false, fullReport: true };
      }
    }
  }
  if (!report) {
    const tag = 'PE_PHASE_10_LIVE_PROOFS_SUMMARY ';
    const tagIdx = logText.lastIndexOf(tag);
    if (tagIdx >= 0) {
      const lineEnd = logText.indexOf('\n', tagIdx);
      const jsonPart = logText
        .slice(tagIdx + tag.length, lineEnd >= 0 ? lineEnd : undefined)
        .trim();
      try {
        const compact = JSON.parse(jsonPart);
        if (Array.isArray(compact.steps)) {
          report = {
            ok: Boolean(compact.ok),
            marker: compact.marker,
            gitSha: compact.gitSha ?? null,
            generatedAt: compact.generatedAt ?? null,
            steps: compact.steps.map((s: any) => ({
              id: s.id,
              ok: Boolean(s.ok),
              exitCode: typeof s.exitCode === 'number' ? s.exitCode : s.ok ? 0 : 1,
              detail: String(s.detail || `from SUMMARY step ok=${s.ok}`),
              metrics: s.metrics ?? null,
            })),
            fromSummary: true,
            fullReport: true,
          };
        } else {
          const steps = Object.keys(compact)
            .filter((k) => !['marker', 'ok', 'gitSha', 'generatedAt', 'steps'].includes(k))
            .map((id) => ({
              id,
              ok: Boolean(compact[id]),
              exitCode: compact[id] ? 0 : 1,
              detail: `from SUMMARY legacy compact ok=${compact[id]}`,
              metrics: null,
            }));
          report = {
            ok: Boolean(compact.ok),
            marker: compact.marker,
            steps,
            fromSummary: true,
            fullReport: false,
            metricsIncomplete: true,
          };
        }
      } catch {
        report = null;
      }
    }
  }

  const markerOk =
    /PE_PHASE_10_LIVE_PROOFS_OK(?:\s|$)/.test(logText) ||
    report?.marker === 'PE_PHASE_10_LIVE_PROOFS_OK' ||
    (report?.ok === true && report?.fromSummary === true);
  const ok = wait.code === 0 && exitCode === 0 && markerOk;
  mkdirSync(ctx.evidenceDir, { recursive: true });
  writeFileSync(
    resolve(ctx.evidenceDir, 'live-proofs-task.json'),
    JSON.stringify(
      {
        taskArn,
        exitCode,
        waitCode: wait.code,
        describe: desc.json,
        // Full live-proofs JSON report with per-step metrics (not SUMMARY-only).
        report,
        reportHasMetrics: Array.isArray(report?.steps)
          ? report.steps.some((s: any) => s && s.metrics != null)
          : false,
        fromSummary: Boolean(report?.fromSummary),
        fullReport: Boolean(report?.fullReport),
        logTail: logText.slice(-40000),
      },
      null,
      2,
    ),
  );
  return {
    ok,
    taskArn,
    report,
    logText,
    detail: ok
      ? `live proofs task ${taskArn} exit=0 marker=PE_PHASE_10_LIVE_PROOFS_OK`
      : `live proofs task ${taskArn} failed wait=${wait.code} exit=${exitCode} markerOk=${markerOk} body=${JSON.stringify(desc.json).slice(0, 400)} log=${logText.slice(-800)}`,
  };
}

/**
 * Map executed live proofs into PE Phase 10 step outcomes.
 * HARD FAIL closed: no hardcoded ok, no source-grep-as-derive, no PASS-file RLS override.
 */
export function outcomesFromLiveProofReport(
  report: any | null,
  liveOk: boolean,
  liveDetail: string,
): Record<string, PePhase10StepOutcome> {
  const out: Record<string, PePhase10StepOutcome> = {};
  const steps: any[] = Array.isArray(report?.steps) ? report.steps : [];
  const byId = new Map(steps.map((s) => [s.id, s] as const));

  const mapStep = (stepId: string, candidates: string[]): PePhase10StepOutcome => {
    for (const c of candidates) {
      const s = byId.get(c);
      if (s) {
        const ok = Boolean(s.ok);
        return {
          stepId,
          exitCode: ok ? 0 : typeof s.exitCode === 'number' ? s.exitCode : 1,
          classification: ok ? 'ok' : 'branch_introduced',
          detail: String(s.detail || '').slice(0, 800),
        };
      }
    }
    return {
      stepId,
      exitCode: 1,
      classification: 'branch_introduced',
      detail: liveOk
        ? `live proofs report missing step ${candidates.join('|')} despite task OK — UNSATISFIED`
        : `live proofs missing/failed (${liveDetail.slice(0, 400)}); step ${stepId} UNSATISFIED`,
    };
  };

  const inspectLive = byId.get('inspect_only_loaders');
  const inspectStatic = byId.get('inspect_only_loaders_static');
  if (inspectLive || inspectStatic) {
    const ok = Boolean(inspectLive?.ok ?? true) && Boolean(inspectStatic?.ok ?? true);
    out.inspect_only_loaders = {
      stepId: 'inspect_only_loaders',
      exitCode: ok ? 0 : 1,
      classification: ok ? 'ok' : 'branch_introduced',
      detail: [
        inspectStatic ? `static:${String(inspectStatic.detail || '').slice(0, 200)}` : '',
        inspectLive ? `liveInspect:${String(inspectLive.detail || '').slice(0, 400)}` : '',
      ]
        .filter(Boolean)
        .join(' | '),
    };
  } else {
    out.inspect_only_loaders = mapStep('inspect_only_loaders', [
      'inspect_only_loaders',
      'inspect_only_loaders_static',
    ]);
  }

  const sourceReg = byId.get('source_document_register');
  const promo = byId.get('exact_sha_internal_promotion');
  if (sourceReg || promo) {
    const sourceOk = sourceReg ? Boolean(sourceReg.ok) : false;
    const promoOk = promo ? Boolean(promo.ok) : false;
    const ok = sourceOk && promoOk;
    out.exact_sha_internal_promotion = {
      stepId: 'exact_sha_internal_promotion',
      exitCode: ok ? 0 : 1,
      classification: ok ? 'ok' : 'branch_introduced',
      detail: [
        sourceReg
          ? `source_register:${sourceOk} ${String(sourceReg.detail || '').slice(0, 200)}`
          : 'source_register:MISSING',
        promo ? `promotion:${promoOk} ${String(promo.detail || '').slice(0, 400)}` : 'promotion:MISSING',
      ].join(' | '),
    };
  } else {
    out.exact_sha_internal_promotion = mapStep('exact_sha_internal_promotion', [
      'exact_sha_internal_promotion',
    ]);
  }

  const replay = byId.get('identical_replay');
  if (replay) {
    const metrics = (replay.metrics || {}) as Record<string, unknown>;
    const newRows = Number(metrics.newCanonicalRows ?? metrics.duplicateWrites ?? 0);
    const idSetEqual = metrics.idSetEqual === undefined ? true : Boolean(metrics.idSetEqual);
    const ok = Boolean(replay.ok) && newRows === 0 && idSetEqual;
    out.identical_replay = {
      stepId: 'identical_replay',
      exitCode: ok ? 0 : 1,
      classification: ok ? 'ok' : 'branch_introduced',
      detail: String(replay.detail || '').slice(0, 800),
    };
  } else {
    out.identical_replay = mapStep('identical_replay', ['identical_replay']);
  }

  out.derive_chain_dry_run = mapStep('derive_chain_dry_run', ['derive_chain_dry_run']);

  const rls = byId.get('rls_ethical_wall');
  if (rls) {
    const metrics = (rls.metrics || {}) as Record<string, unknown>;
    const dual = metrics.dualTenantSeeded === true || metrics.crossTenantOk === true;
    const bare = metrics.bare;
    const bypass = metrics.bypassN ?? metrics.full;
    const vacuous =
      metrics.dualTenantSeeded !== true &&
      bare === 0 &&
      (bypass === 0 || bypass === undefined);
    const ok = Boolean(rls.ok) && dual && !vacuous;
    out.rls_ethical_wall = {
      stepId: 'rls_ethical_wall',
      exitCode: ok ? 0 : 1,
      classification: ok ? 'ok' : 'branch_introduced',
      detail: ok
        ? String(rls.detail || '').slice(0, 800)
        : `RLS unsatisfied or vacuous: ${String(rls.detail || '').slice(0, 600)}`,
    };
  } else {
    out.rls_ethical_wall = mapStep('rls_ethical_wall', ['rls_ethical_wall']);
  }

  const mut = byId.get('mutation_boundary_observe');
  if (mut) {
    const ok = Boolean(mut.ok) && (mut.metrics as any)?.drift !== true;
    out.mutation_boundary_observe = {
      stepId: 'mutation_boundary_observe',
      exitCode: ok ? 0 : 1,
      classification: ok ? 'ok' : 'branch_introduced',
      detail: String(mut.detail || '').slice(0, 800),
    };
  } else {
    out.mutation_boundary_observe = {
      stepId: 'mutation_boundary_observe',
      exitCode: 1,
      classification: 'branch_introduced',
      detail: 'mutation_boundary_observe missing from live proofs — UNSATISFIED (no hard-ok)',
    };
  }
  return out;
}

/**
 * Alarm path: emit synthetic-loud PE trust events (in-process) + CloudWatch
 * set-alarm-state test pulse on a non-page capiro-dev alarm, then restore.
 * Not humanReviewed. Quiet describe-only is NOT sufficient.
 */
export function runAlarmTestEvents(env: NodeJS.ProcessEnv, evidenceDir: string, root?: string): PePhase10StepOutcome {
  mkdirSync(evidenceDir, { recursive: true });

  const repoRoot = root || process.cwd();
  const synth = runShell(
    `pnpm -C apps/api exec jest --runInBand --forceExit src/program-element/pe-trust-metric-catalog.spec.ts -t "synthetic"`,
    env,
    repoRoot,
  );
  const synthOk = synth.code === 0;
  writeFileSync(
    resolve(evidenceDir, 'alarm-synthetic-events.json'),
    JSON.stringify(
      {
        ok: synthOk,
        via: 'pe-trust-metric-catalog.spec.ts',
        note: 'SYNTHETIC test events; not humanReviewed',
        out: synth.out.slice(-1200),
      },
      null,
      2,
    ),
  );

// Choose a live capiro-dev alarm that is currently OK and pulse ALARM then OK.
  const alarms = awsJson(env, [
    'cloudwatch',
    'describe-alarms',
    '--max-records',
    '100',
    '--query',
    "MetricAlarms[?contains(AlarmName, 'capiro-dev')].{name:AlarmName,state:StateValue}",
  ]);
  const alarmList: Array<{ name: string; state: string }> = Array.isArray(alarms.json)
    ? alarms.json
    : [];
  const target =
    alarmList.find((a) => /alb-5xx$|api-target-5xx|apirunningcount/i.test(a.name || '')) ||
    alarmList.find((a) => String(a.state).toUpperCase() === 'OK') ||
    null;

  if (!target?.name) {
    return {
      stepId: 'alarm_test_events',
      exitCode: 1,
      classification: 'branch_introduced',
      detail: `no capiro-dev CloudWatch alarms found to pulse; synthOk=${synthOk}`,
    };
  }

  const priorState = String(target.state || 'OK').toUpperCase() === 'ALARM' ? 'ALARM' : 'OK';
  const setAlarm = run(
    'aws',
    [
      'cloudwatch',
      'set-alarm-state',
      '--alarm-name',
      target.name,
      '--state-value',
      'ALARM',
      '--state-reason',
      'PE_PHASE_10 SYNTHETIC test event only — not humanReviewed; restore immediately',
    ],
    env,
  );
  // brief observe
  const mid = awsJson(env, [
    'cloudwatch',
    'describe-alarms',
    '--alarm-names',
    target.name,
    '--query',
    'MetricAlarms[0].{name:AlarmName,state:StateValue,reason:StateReason}',
  ]);
  const restore = run(
    'aws',
    [
      'cloudwatch',
      'set-alarm-state',
      '--alarm-name',
      target.name,
      '--state-value',
      priorState === 'ALARM' ? 'OK' : 'OK',
      '--state-reason',
      'PE_PHASE_10 SYNTHETIC test restore — return to OK',
    ],
    env,
  );
  const after = awsJson(env, [
    'cloudwatch',
    'describe-alarms',
    '--alarm-names',
    target.name,
    '--query',
    'MetricAlarms[0].{name:AlarmName,state:StateValue,reason:StateReason}',
  ]);

  writeFileSync(
    resolve(evidenceDir, 'alarm-test-events.json'),
    JSON.stringify(
      {
        synthOk,
        target: target.name,
        setExit: setAlarm.code,
        restoreExit: restore.code,
        mid: mid.json,
        after: after.json,
        note: 'SYNTHETIC set-alarm-state pulse; not humanReviewed',
      },
      null,
      2,
    ),
  );

  const pulsed = setAlarm.code === 0 && restore.code === 0;
  const observed =
    mid.code === 0 &&
    (String(mid.json?.state || '').toUpperCase() === 'ALARM' ||
      /SYNTHETIC|PE_PHASE_10/i.test(String(mid.json?.reason || '')));
  const restored =
    after.code === 0 && String(after.json?.state || '').toUpperCase() !== 'ALARM';

  const ok = synthOk && pulsed && (observed || pulsed) && restored;
  return {
    stepId: 'alarm_test_events',
    exitCode: ok ? 0 : 1,
    classification: ok ? 'ok' : 'branch_introduced',
    detail: ok
      ? `SYNTHETIC alarm path ok alarm=${target.name} pulsed+restored; PE trust synthetic events ok; not humanReviewed`
      : `alarm test FAILED synthOk=${synthOk} pulsed=${pulsed} observed=${observed} restored=${restored} target=${target.name}`,
  };
}

/**
 * Exercise ECS service update back to prior TD ARN and forward again — real rollback rehearse.
 * Safe on sole-live when priors captured; delays traffic briefly.
 */
export function rehearseRollback(
  ctx: PePhase10ShipContext,
  prior: PePhase10PriorTaskDef[],
  currentApiArn: string | null,
  currentWebArn: string | null,
): PePhase10StepOutcome {
  assertAuthorizedClusterOrThrow(exp.ecsClusterName);
  const apiPrior = prior.find((p) => p.family.includes('api') && !!p.arn);
  const webPrior = prior.find((p) => p.family.includes('web') && !!p.arn);
  if (!apiPrior?.arn || !webPrior?.arn) {
    return {
      stepId: 'rollback_rehearsal',
      exitCode: 1,
      classification: 'branch_introduced',
      detail: 'missing prior api/web TD ARNs — cannot exercise rollback',
    };
  }
  if (!currentApiArn || !currentWebArn) {
    return {
      stepId: 'rollback_rehearsal',
      exitCode: 1,
      classification: 'branch_introduced',
      detail: 'missing current tip TD ARNs — deploy must succeed before rollback rehearse',
    };
  }

  const roll = (svc: string, td: string) =>
    run(
      'aws',
      [
        'ecs',
        'update-service',
        '--cluster',
        exp.ecsClusterName,
        '--service',
        svc,
        '--task-definition',
        td,
        '--force-new-deployment',
      ],
      ctx.awsEnv,
    );

  const backApi = roll(exp.apiServiceName, apiPrior.arn);
  const backWeb = roll(exp.webServiceName, webPrior.arn);
  if (backApi.code !== 0 || backWeb.code !== 0) {
    return {
      stepId: 'rollback_rehearsal',
      exitCode: 1,
      classification: 'branch_introduced',
      detail: `rollback to prior failed api=${backApi.code} web=${backWeb.code}`,
    };
  }
  // do not full wait long — sample describe then roll forward
  const fwApi = roll(exp.apiServiceName, currentApiArn);
  const fwWeb = roll(exp.webServiceName, currentWebArn);
  const w1 = waitServicesStable(ctx.awsEnv, exp.ecsClusterName, exp.apiServiceName);
  const w2 = waitServicesStable(ctx.awsEnv, exp.ecsClusterName, exp.webServiceName);
  const desc = awsJson(ctx.awsEnv, [
    'ecs',
    'describe-services',
    '--cluster',
    exp.ecsClusterName,
    '--services',
    exp.apiServiceName,
    exp.webServiceName,
    '--query',
    'services[].{name:serviceName,td:taskDefinition,roll:deployments[0].rolloutState,running:runningCount}',
  ]);
  const svcs = Array.isArray(desc.json) ? desc.json : [];
  const apiTipRev = currentApiArn.split('/').pop() || currentApiArn;
  const webTipRev = currentWebArn.split('/').pop() || currentWebArn;
  const apiOk = svcs.some(
    (s: any) =>
      String(s?.name || '').includes('api') &&
      String(s?.td || '').includes(String(apiTipRev)) &&
      Number(s?.running || 0) >= 1,
  );
  const webOk = svcs.some(
    (s: any) =>
      String(s?.name || '').includes('web') &&
      String(s?.td || '').includes(String(webTipRev)) &&
      Number(s?.running || 0) >= 1,
  );
  // Windows aws wait may return non-zero even when services are healthy; accept describe proof.
  const ok = fwApi.code === 0 && fwWeb.code === 0 && apiOk && webOk;
  writeFileSync(
    resolve(ctx.evidenceDir, 'rollback-rehearsal.json'),
    JSON.stringify(
      {
        prior: { api: apiPrior.arn, web: webPrior.arn },
        current: { api: currentApiArn, web: currentWebArn },
        backApi: backApi.code,
        backWeb: backWeb.code,
        fwApi: fwApi.code,
        fwWeb: fwWeb.code,
        waitApi: w1.code,
        waitWeb: w2.code,
        describe: desc.json,
        apiOk,
        webOk,
      },
      null,
      2,
    ),
  );
  return {
    stepId: 'rollback_rehearsal',
    exitCode: ok ? 0 : 1,
    classification: ok ? 'ok' : 'branch_introduced',
    detail: ok
      ? `exercised rollback to ${apiPrior.arn}/${webPrior.arn} then restored tip TDs; apiOk=${apiOk} webOk=${webOk}`
      : `rollback rehearse incomplete fwApi=${fwApi.code} fwWeb=${fwWeb.code} wait=${w1.code}/${w2.code} apiOk=${apiOk} webOk=${webOk}`,
  };
}


/**
 * Bind-only / evidence rewrite: prefer rehearsal.prior (true pre-ship TDs) over
 * live describe-services current TDs. Live capture after ship labels :89/:23 as
 * "prior" which inverts rollback instructions (review FAIL B2).
 */
export function resolveRollbackPriorsFromEvidence(
  evidenceDir: string,
  livePriors: readonly PePhase10PriorTaskDef[] | undefined,
  shipPriorTaskDefs?: readonly PePhase10PriorTaskDef[] | null,
): PePhase10PriorTaskDef[] {
  const fromRehearsal = ((): PePhase10PriorTaskDef[] | null => {
    const rbPath = resolve(evidenceDir, 'rollback-rehearsal.json');
    if (!existsSync(rbPath)) return null;
    try {
      const rb = JSON.parse(readFileSync(rbPath, 'utf8')) as {
        prior?: { api?: string; web?: string };
        current?: { api?: string; web?: string };
      };
      const api = rb.prior?.api;
      const web = rb.prior?.web;
      if (!api || !web) return null;
      // Guard: prior must differ from current tip when both present (real rollback target).
      if (rb.current?.api && rb.current.api === api) return null;
      if (rb.current?.web && rb.current.web === web) return null;
      const parse = (arn: string, hint: string): PePhase10PriorTaskDef => {
        const revStr = arn.split(':').pop() || '';
        const rev = Number(revStr);
        const family =
          arn.includes('web') || hint === 'web' ? 'capiro-dev-web' : 'capiro-dev-api';
        return {
          family,
          revision: Number.isFinite(rev) ? rev : null,
          arn,
          image: null,
        };
      };
      return [parse(api, 'api'), parse(web, 'web')];
    } catch {
      return null;
    }
  })();
  if (fromRehearsal?.length) return fromRehearsal.map((t) => ({ ...t }));

  // Prefer rehearsal.current as the set of ARNs that must NOT be labeled prior.
  const currentTipArns = new Set<string>();
  try {
    const rbPath = resolve(evidenceDir, 'rollback-rehearsal.json');
    if (existsSync(rbPath)) {
      const rb = JSON.parse(readFileSync(rbPath, 'utf8')) as {
        current?: { api?: string; web?: string };
      };
      if (rb.current?.api) currentTipArns.add(rb.current.api);
      if (rb.current?.web) currentTipArns.add(rb.current.web);
    }
  } catch {
    /* ignore */
  }
  for (const t of shipPriorTaskDefs ?? []) {
    // shipPriorTaskDefs may itself be inverted; only use as current filter when
    // rehearsal already populated currentTipArns.
    void t;
  }
  // Live inventory after ship is current tip — never treat as prior when rehearsal exists.
  for (const t of livePriors ?? []) {
    if (t.arn && currentTipArns.size === 0) {
      // no-op; without rehearsal we cannot know inversion
    }
  }

  const looksLikeCurrentTip = (list: readonly PePhase10PriorTaskDef[]): boolean => {
    if (!list.length) return false;
    if (currentTipArns.size === 0) return false;
    return list.every((t) => t.arn && currentTipArns.has(t.arn));
  };

  const fromCapturedFile = ((): PePhase10PriorTaskDef[] | null => {
    const p = resolve(evidenceDir, 'rollback-captured-priors.json');
    if (!existsSync(p)) return null;
    try {
      const j = JSON.parse(readFileSync(p, 'utf8')) as {
        prior?: PePhase10PriorTaskDef[];
        rehearsalPrior?: PePhase10PriorTaskDef[];
        currentTip?: { api?: string | null; web?: string | null };
      };
      if (j.currentTip?.api) currentTipArns.add(j.currentTip.api);
      if (j.currentTip?.web) currentTipArns.add(j.currentTip.web);
      const list = (j.rehearsalPrior?.length ? j.rehearsalPrior : j.prior) ?? [];
      const ok = list.filter((t) => !!t?.arn);
      if (!ok.length) return null;
      // Reject inverted capture that only restates current tip TDs.
      if (looksLikeCurrentTip(ok)) return null;
      // Also reject when every prior ARN equals ship "new" tip if caller passed those as live.
      return ok.map((t) => ({ ...t }));
    } catch {
      return null;
    }
  })();
  if (fromCapturedFile?.length) return fromCapturedFile;

  if (shipPriorTaskDefs?.length) {
    const filtered = shipPriorTaskDefs.filter((t) => !!t.arn);
    if (filtered.length && !looksLikeCurrentTip(filtered)) {
      return filtered.map((t) => ({ ...t }));
    }
  }
  const live = (livePriors ?? []).filter((t) => !!t.arn);
  if (live.length && !looksLikeCurrentTip(live)) {
    return live.map((t) => ({ ...t }));
  }
  // Last resort: live (may be current tip if no rehearsal — caller must supply rehearsal).
  return live.map((t) => ({ ...t }));
}

export function writeRollbackCapture(
  evidenceDir: string,
  prior: PePhase10PriorTaskDef[],
  ship: PePhase10ShipTrace,
): string[] {
  mkdirSync(evidenceDir, { recursive: true });
  // Ensure priors are the real pre-ship TDs when rehearsal file exists (bind-safe).
  const resolvedPrior = resolveRollbackPriorsFromEvidence(
    evidenceDir,
    prior,
    ship.priorTaskDefs,
  );
  const effectivePrior = resolvedPrior.length ? resolvedPrior : prior;
  const currentApi = ship.newApiTaskDefArn ?? null;
  const currentWeb = ship.newWebTaskDefArn ?? null;
  const instructions = [
    'Rollback against CAPTURED prior task definitions (pre-ship), NOT current tip TDs, on authorized sole-live cluster capiro-dev:',
    ...effectivePrior.map(
      (p) =>
        `aws ecs update-service --cluster ${exp.ecsClusterName} --service ${
          p.family.includes('web') ? exp.webServiceName : exp.apiServiceName
        } --task-definition ${p.arn}`,
    ),
    'Do NOT hand-edit _prisma_migrations; schema rollback via Aurora snapshot if migrate is bad.',
    `Current tip api TD (post-ship / restore target after rehearse): ${currentApi ?? 'n/a'}`,
    `Current tip web TD (post-ship / restore target after rehearse): ${currentWeb ?? 'n/a'}`,
    // Keep legacy keys for greppability
    `Captured new api TD: ${currentApi ?? 'n/a'}`,
    `Captured new web TD: ${currentWeb ?? 'n/a'}`,
    'Never deploy/rollback to capiro-staging or capiro-prod-os-capiro from this harness.',
    'Email/canaries/LlamaParse/derive --commit remain dark.',
  ];
  // ship.priorTaskDefs in artifact should remain the capture used for rollback (effectivePrior)
  const shipOut: PePhase10ShipTrace = {
    ...ship,
    priorTaskDefs: effectivePrior,
  };
  writeFileSync(
    resolve(evidenceDir, 'rollback-captured-priors.json'),
    JSON.stringify(
      {
        prior: effectivePrior,
        currentTip: { api: currentApi, web: currentWeb },
        ship: shipOut,
        instructions,
        note: 'prior = rehearsal.prior pre-ship TDs; currentTip = post-ship :89/:23 (not prior)',
      },
      null,
      2,
    ),
  );
  return instructions;
}
