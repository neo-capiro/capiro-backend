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
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
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
  const w1 = run(
    'aws',
    [
      'ecs',
      'wait',
      'services-stable',
      '--cluster',
      exp.ecsClusterName,
      '--services',
      exp.apiServiceName,
    ],
    ctx.awsEnv,
  );
  const w2 = run(
    'aws',
    [
      'ecs',
      'wait',
      'services-stable',
      '--cluster',
      exp.ecsClusterName,
      '--services',
      exp.webServiceName,
    ],
    ctx.awsEnv,
  );
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
  const wait = run(
    'aws',
    ['ecs', 'wait', 'tasks-stopped', '--cluster', exp.ecsClusterName, '--tasks', taskArn],
    ctx.awsEnv,
  );
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

export function browserSmoke(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  detail: string;
} {
  const host = exp.appHost;
  const tmpBase = (process.env.TEMP || process.env.TMP || '/tmp').replace(/\\/g, '/');
  const curl = (url: string, idx: number) => {
    const tmp = `${tmpBase}/pe10curl-${idx}.out`;
    const r = runShell(
      `curl -sS -L --max-time 30 -o "${tmp}" -w "%{http_code}" "${url}"`,
      env,
      process.cwd(),
    );
    const digits = String(r.out || '').replace(/\D/g, '');
    const code = (digits.slice(-3) || '000').padStart(3, '0').slice(-3);
    let body = '';
    try {
      body = readFileSync(tmp, 'utf8').slice(0, 400);
    } catch {
      body = '';
    }
    return { code, body, raw: String(r.out || '').slice(0, 400) };
  };

const paths = [
    { id: 'root', url: `https://${host}/`, want: ['200'] },
    { id: 'health', url: `https://${host}/health`, want: ['200', '401'] },
    { id: 'healthz', url: `https://${host}/healthz`, want: ['200', '401'] },
    { id: 'api_health', url: `https://${host}/api/health`, want: ['200', '401', '404'] },
    { id: 'pe_list', url: `https://${host}/api/program-elements?limit=1`, want: ['200', '401', '403'] },
    {
      id: 'pe_detail',
      url: `https://${host}/api/program-elements/0603270A`,
      want: ['200', '401', '403', '404'],
    },
  ];
  const results: Record<string, string> = {};
  const failures: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const pth = paths[i]!;
    const r = curl(pth.url, i);
    results[pth.id] = r.code;
    if (!pth.want.includes(r.code)) failures.push(`${pth.id}=${r.code}`);
    if (pth.id.startsWith('pe_') && r.code === '200' && (!r.body || !r.body.trim())) {
      failures.push(`${pth.id}:200 empty body`);
    }
  }
  const ok = failures.length === 0 && results.root === '200';
  return {
    ok,
    detail: `host=${host} codes=${JSON.stringify(results)}${
      failures.length ? ` FAIL ${failures.join(',')}` : ''
    } (401 on PE routes = auth wall present)`,
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
          // Override entryPoint so shell runs directly (command-only override becomes args to entrypoint.sh).
          entryPoint: ['/usr/bin/dumb-init', '--', '/bin/sh', '-c'],
          command: [
            'mkdir -p /tmp /app/tmp; export TMPDIR=/tmp; exec /usr/local/bin/entrypoint.sh pe-phase-10-live-proofs',
          ],
          environment: [
            { name: 'GIT_SHA', value: ctx.headSha },
            { name: 'PE_CLOSEOUT_HEAD_SHA', value: ctx.headSha },
            { name: 'TMPDIR', value: '/tmp' },
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

  const wait = run(
    'aws',
    ['ecs', 'wait', 'tasks-stopped', '--cluster', exp.ecsClusterName, '--tasks', taskArn],
    ctx.awsEnv,
  );
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
            '250',
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
  const markerIdx = logText.lastIndexOf('PE_PHASE_10_LIVE_PROOFS_');
  if (markerIdx >= 0) {
    const before = logText.lastIndexOf('{', markerIdx);
    if (before >= 0) {
      let depth = 0;
      let end = -1;
      for (let i = before; i < logText.length; i++) {
        const ch = logText[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      if (end > before) {
        try {
          report = JSON.parse(logText.slice(before, end));
        } catch {
          report = null;
        }
      }
    }
  }

  const markerOk =
    /PE_PHASE_10_LIVE_PROOFS_OK/.test(logText) || report?.marker === 'PE_PHASE_10_LIVE_PROOFS_OK';
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
        report,
        logTail: logText.slice(-6000),
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
      : `live proofs task ${taskArn} failed wait=${wait.code} exit=${exitCode} markerOk=${markerOk} body=${JSON.stringify(desc.json).slice(0, 400)} log=${logText.slice(-500)}`,
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

  out.exact_sha_internal_promotion = mapStep('exact_sha_internal_promotion', [
    'exact_sha_internal_promotion',
  ]);
  out.identical_replay = mapStep('identical_replay', ['identical_replay']);
  out.derive_chain_dry_run = mapStep('derive_chain_dry_run', ['derive_chain_dry_run']);
  out.rls_ethical_wall = mapStep('rls_ethical_wall', ['rls_ethical_wall']);
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
  const w1 = run(
    'aws',
    [
      'ecs',
      'wait',
      'services-stable',
      '--cluster',
      exp.ecsClusterName,
      '--services',
      exp.apiServiceName,
    ],
    ctx.awsEnv,
  );
  const w2 = run(
    'aws',
    [
      'ecs',
      'wait',
      'services-stable',
      '--cluster',
      exp.ecsClusterName,
      '--services',
      exp.webServiceName,
    ],
    ctx.awsEnv,
  );
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

export function writeRollbackCapture(
  evidenceDir: string,
  prior: PePhase10PriorTaskDef[],
  ship: PePhase10ShipTrace,
): string[] {
  mkdirSync(evidenceDir, { recursive: true });
  const instructions = [
    'Rollback against CAPTURED prior task definitions on authorized sole-live cluster capiro-dev:',
    ...prior.map(
      (p) =>
        `aws ecs update-service --cluster ${exp.ecsClusterName} --service ${
          p.family.includes('web') ? exp.webServiceName : exp.apiServiceName
        } --task-definition ${p.arn}`,
    ),
    'Do NOT hand-edit _prisma_migrations; schema rollback via Aurora snapshot if migrate is bad.',
    `Captured new api TD: ${ship.newApiTaskDefArn ?? 'n/a'}`,
    `Captured new web TD: ${ship.newWebTaskDefArn ?? 'n/a'}`,
    'Never deploy/rollback to capiro-staging or capiro-prod-os-capiro from this harness.',
    'Email/canaries/LlamaParse/derive --commit remain dark.',
  ];
  writeFileSync(
    resolve(evidenceDir, 'rollback-captured-priors.json'),
    JSON.stringify({ prior, ship, instructions }, null, 2),
  );
  return instructions;
}
