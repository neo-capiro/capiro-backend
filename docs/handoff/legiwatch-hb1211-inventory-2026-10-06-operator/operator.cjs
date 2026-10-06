'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process'),
  crypto = require('node:crypto');
const { hash } = require('./runtime.cjs');
const ROOT = process.env.HB1211_REPO_ROOT || 'C:/dev/main/legiwatch-qa-20261005';
const BASE = __dirname;
function validateBinding(binding) {
  if (!binding || !/^[a-f0-9]{40}$/.test(binding.sourceSha ?? ''))
    throw Error('EXPLICIT_REVIEWED_SOURCE_REQUIRED');
  if (
    !/^967807252336\.dkr\.ecr\.us-east-1\.amazonaws\.com\/capiro\/dev\/api@sha256:[a-f0-9]{64}$/.test(
      binding.image ?? '',
    )
  )
    throw Error('EXPLICIT_REVIEWED_IMAGE_REQUIRED');
  return binding;
}
const RULE = 'capiro-dev-sync-legiscan-bills';
const FAMILY = 'capiro-dev-api-sync-legiscan-bills';
const CONTAINER = 'api-sync-legiscan-bills';
const CLUSTER = 'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev';
const registerKeys = [
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
];
function buildDefinition(td, runtime, mode, approval = {}, binding) {
  const { sourceSha: SOURCE, image: IMAGE } = validateBinding(binding);
  if (
    td.family !== FAMILY ||
    td.containerDefinitions?.length !== 1 ||
    td.containerDefinitions[0].name !== CONTAINER ||
    td.networkMode !== 'awsvpc' ||
    td.runtimePlatform?.cpuArchitecture !== 'ARM64'
  )
    throw Error('UNEXPECTED_EXISTING_OWNER');
  if (!['preview', 'retrieve', 'apply', 'verify'].includes(mode))
    throw Error('EXPLICIT_MODE_REQUIRED');
  const request = Object.fromEntries(
    registerKeys.filter((k) => td[k] !== undefined).map((k) => [k, structuredClone(td[k])]),
  );
  const c = request.containerDefinitions[0],
    env = Object.fromEntries((c.environment ?? []).map((e) => [e.name, e.value]));
  if (
    (c.environment ?? []).some((e) => e.name.startsWith('HB1211_')) ||
    new Set((c.environment ?? []).map((e) => e.name)).size !== (c.environment ?? []).length
  )
    throw Error('UNEXPECTED_OWNER_OVERRIDE');
  if (env.LEGISCAN_DOCUMENT_EVIDENCE_ENABLED !== 'true')
    throw Error('EXISTING_OWNER_GATE_DISABLED');
  for (const name of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'LEGISCAN_API_KEY'])
    if (!(c.secrets ?? []).some((s) => s.name === name))
      throw Error('EXISTING_SECRET_REFERENCE_MISSING');
  request.family = 'capiro-dev-api-hb1211-dataset-reviewed';
  c.image = IMAGE;
  c.entryPoint = ['/usr/bin/dumb-init', '--', 'node', '--import', 'tsx', '-e'];
  c.command = [
    runtime +
      '\nmain().catch(e=>{console.error("HB1211_DATASET_FAILED "+(/^[A-Z0-9_]+$/.test(e?.message??"")?e.message:"UNEXPECTED_RUNTIME_FAILURE"));process.exitCode=1;});',
  ];
  const changes = {
    GIT_SHA: SOURCE,
    RELEASE_SHA: SOURCE,
    HB1211_DATASET_MODE: mode,
    HB1211_DATASET_SOURCE_SHA: SOURCE,
    HB1211_DATASET_IMAGE: IMAGE,
  };
  if (mode === 'apply' || mode === 'retrieve') {
    if (
      !/^[a-f0-9]{64}$/.test(approval.planHash ?? '') ||
      !Number.isFinite(Date.parse(approval.expiresAt)) ||
      Date.now() >= Date.parse(approval.expiresAt) ||
      Date.parse(approval.expiresAt) - Date.now() > 2 * 3600000
    )
      throw Error('EXACT_UNEXPIRED_DB_APPROVAL_REQUIRED');
    Object.assign(changes, {
      HB1211_DATASET_APPROVED_PLAN: approval.planHash,
      HB1211_DATASET_EXPIRES_AT: approval.expiresAt,
    });
    if (mode === 'apply') {
      if (!/^[a-f0-9-]{36}$/.test(approval.candidateId ?? ''))
        throw Error('EXACT_CANDIDATE_REQUIRED');
      changes.HB1211_DATASET_CANDIDATE_ID = approval.candidateId;
    }
  }
  c.environment = [
    ...(c.environment ?? []).filter((e) => !Object.hasOwn(changes, e.name)),
    ...Object.entries(changes).map(([name, value]) => ({ name, value })),
  ];
  return request;
}
const aws = (args) =>
  JSON.parse(
    cp.execFileSync(
      'aws',
      [...args, '--profile', 'capiro-dev', '--region', 'us-east-1', '--output', 'json'],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
async function checkQualification(q, reviewedSourceSha) {
  if (!/^[a-f0-9]{40}$/.test(reviewedSourceSha ?? ''))
    throw Error('EXPLICIT_REVIEWED_SOURCE_REQUIRED');
  const { pathToFileURL } = require('node:url');
  const { validateQualification } = await import(
    pathToFileURL(path.join(ROOT, 'scripts/lib/meri-release-policy.mjs')).href
  );
  validateQualification(q, 'api', q?.image);
  if (q.sourceSha !== reviewedSourceSha || q.schemaChange !== false)
    throw Error('QUALIFICATION_SOURCE_MISMATCH');
  return validateBinding({ sourceSha: q.sourceSha, image: q.image });
}
function validateServing(service, td, images, binding) {
  const { sourceSha: SOURCE, image: IMAGE } = validateBinding(binding);
  const c = td.containerDefinitions.find((c) => c.name === 'api');
  if (
    service.runningCount !== service.desiredCount ||
    service.desiredCount < 1 ||
    service.pendingCount !== 0 ||
    service.deployments?.length !== 1 ||
    service.deployments[0].rolloutState !== 'COMPLETED' ||
    c?.image !== IMAGE
  )
    throw Error('SERVING_BASELINE_DRIFT');
  const env = Object.fromEntries((c.environment ?? []).map((e) => [e.name, e.value]));
  if (env.GIT_SHA !== SOURCE || env.RELEASE_SHA !== SOURCE) throw Error('SERVING_SOURCE_DRIFT');
  if (images.length !== 1 || IMAGE.split('@')[1] !== images[0].imageDigest)
    throw Error('SOURCE_IMAGE_TAG_DRIFT');
}
function assertBeforeLaunch(read, baselineHash, binding) {
  const { sourceSha: SOURCE } = validateBinding(binding);
  const rule = read(['events', 'describe-rule', '--name', RULE]);
  const targets = read(['events', 'list-targets-by-rule', '--rule', RULE]).Targets;
  if (targets.length !== 1) throw Error('OWNER_CHANGED_AFTER_REGISTRATION');
  const definition = read([
    'ecs',
    'describe-task-definition',
    '--task-definition',
    targets[0].EcsParameters.TaskDefinitionArn,
  ]).taskDefinition;
  if (hash({ rule, targets, definition }) !== baselineHash)
    throw Error('OWNER_CHANGED_AFTER_REGISTRATION');
  const service = read([
    'ecs',
    'describe-services',
    '--cluster',
    'capiro-dev',
    '--services',
    'capiro-dev-api',
  ]).services[0];
  const td = read([
    'ecs',
    'describe-task-definition',
    '--task-definition',
    service.taskDefinition,
  ]).taskDefinition;
  const images = read([
    'ecr',
    'describe-images',
    '--repository-name',
    'capiro/dev/api',
    '--image-ids',
    'imageTag=' + SOURCE,
  ]).imageDetails;
  validateServing(service, td, images, binding);
}
async function main() {
  const mode = process.argv[2] ?? 'prepare';
  if (!['prepare', 'preview', 'retrieve', 'apply', 'verify'].includes(mode))
    throw Error('UNKNOWN_OPERATION');
  if (aws(['sts', 'get-caller-identity']).Account !== '967807252336') throw Error('WRONG_ACCOUNT');
  const qualificationPath =
    process.env.HB1211_QUALIFICATION_PATH || path.join(BASE, 'qualification.json');
  const q = JSON.parse(fs.readFileSync(qualificationPath));
  const binding = await checkQualification(q, process.env.HB1211_REVIEWED_SOURCE_SHA);
  const { sourceSha: SOURCE, image: IMAGE } = binding;
  const service = aws([
    'ecs',
    'describe-services',
    '--cluster',
    'capiro-dev',
    '--services',
    'capiro-dev-api',
  ]).services[0];
  const serviceTd = aws([
    'ecs',
    'describe-task-definition',
    '--task-definition',
    service.taskDefinition,
  ]).taskDefinition;
  const images = aws([
    'ecr',
    'describe-images',
    '--repository-name',
    'capiro/dev/api',
    '--image-ids',
    'imageTag=' + SOURCE,
  ]).imageDetails;
  validateServing(service, serviceTd, images, binding);
  const rule = aws(['events', 'describe-rule', '--name', RULE]);
  const targets = aws(['events', 'list-targets-by-rule', '--rule', RULE]).Targets;
  if (
    rule.State !== 'ENABLED' ||
    rule.ScheduleExpression !== 'cron(30 * * * ? *)' ||
    targets.length !== 1
  )
    throw Error('OWNER_RULE_DRIFT');
  const target = targets[0],
    ep = target.EcsParameters;
  if (
    target.Id !== 'sync-legiscan-bills-fargate-target' ||
    target.Arn !== CLUSTER ||
    ep?.TaskCount !== 1 ||
    ep.LaunchType !== 'FARGATE'
  )
    throw Error('OWNER_TARGET_DRIFT');
  const input = JSON.parse(target.Input ?? '{}');
  if (
    JSON.stringify(input) !==
    JSON.stringify({
      containerOverrides: [{ name: CONTAINER, command: ['sync-legiscan-bills'], environment: [] }],
    })
  )
    throw Error('OWNER_COMMAND_DRIFT');
  const td = aws([
    'ecs',
    'describe-task-definition',
    '--task-definition',
    ep.TaskDefinitionArn,
  ]).taskDefinition;
  const runtime = fs.readFileSync(path.join(BASE, 'runtime.cjs'), 'utf8');
  const baseline = { rule, targets, definition: td };
  const proof = {
    sourceSha: SOURCE,
    image: IMAGE,
    baselineHash: hash(baseline),
    operatorHash: hash(fs.readFileSync(__filename, 'utf8')),
    runtimeHash: hash(runtime),
    qualificationHash: hash(q),
    taskDefinition: td.taskDefinitionArn,
    at: new Date().toISOString(),
  };
  if (mode === 'prepare') {
    const request = buildDefinition(td, runtime, 'preview', {}, binding);
    fs.writeFileSync(
      path.join(BASE, 'prepared-preview-definition.json'),
      JSON.stringify(request, null, 2),
      { flag: 'wx' },
    );
    fs.writeFileSync(
      path.join(BASE, 'prepared-plan.json'),
      JSON.stringify({ ...proof, requestHash: hash(request), mutation: false }, null, 2),
      { flag: 'wx' },
    );
    console.log(JSON.stringify({ ...proof, mode, mutation: false }));
    return;
  }
  const prepared = JSON.parse(fs.readFileSync(path.join(BASE, 'prepared-plan.json')));
  if (
    prepared.baselineHash !== proof.baselineHash ||
    prepared.operatorHash !== proof.operatorHash ||
    prepared.runtimeHash !== proof.runtimeHash ||
    prepared.qualificationHash !== proof.qualificationHash
  )
    throw Error('PREPARED_PLAN_DRIFT');
  if (Date.now() - Date.parse(prepared.at) > 2 * 3600000) throw Error('PREPARED_PLAN_EXPIRED');
  const receiptPath = path.join(BASE, mode + '-launch-receipt.json');
  if (fs.existsSync(receiptPath)) throw Error('RECORDED_OUTCOME_DO_NOT_REPLAY');
  if (process.env.HB1211_APPROVED_OPERATOR_HASH !== hash(prepared))
    throw Error('OPERATOR_REVIEW_REQUIRED');
  const approval = ['retrieve', 'apply'].includes(mode)
    ? JSON.parse(fs.readFileSync(path.join(BASE, 'approved-' + mode + '-plan.json')))
    : {};
  const request = buildDefinition(td, runtime, mode, approval, binding);
  const awsvpc = ep.NetworkConfiguration?.awsvpcConfiguration;
  if (
    !awsvpc?.Subnets?.length ||
    !awsvpc.SecurityGroups?.length ||
    !['ENABLED', 'DISABLED'].includes(awsvpc.AssignPublicIp)
  )
    throw Error('NETWORK_UNQUALIFIED');
  fs.writeFileSync(path.join(BASE, mode + '-definition.json'), JSON.stringify(request, null, 2), {
    flag: 'wx',
  });
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({ status: 'registration-outcome-unknown', ...proof, mode }),
    { flag: 'wx' },
  );
  const registered = aws([
    'ecs',
    'register-task-definition',
    '--cli-input-json',
    'file://' + path.join(BASE, mode + '-definition.json'),
  ]).taskDefinition;
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({
      status: 'launch-outcome-unknown',
      ...proof,
      mode,
      taskDefinition: registered.taskDefinitionArn,
    }),
  );
  assertBeforeLaunch(aws, proof.baselineHash, binding);
  await checkQualification(JSON.parse(fs.readFileSync(qualificationPath)), binding.sourceSha);
  if (hash(JSON.parse(fs.readFileSync(qualificationPath))) !== proof.qualificationHash)
    throw Error('QUALIFICATION_CHANGED_AFTER_REGISTRATION');
  const runRequest = {
    cluster: CLUSTER,
    taskDefinition: registered.taskDefinitionArn,
    launchType: 'FARGATE',
    count: 1,
    clientToken: crypto.randomUUID(),
    startedBy: 'hb1211-dataset-' + mode,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: awsvpc.Subnets,
        securityGroups: awsvpc.SecurityGroups,
        assignPublicIp: awsvpc.AssignPublicIp,
      },
    },
  };
  if (ep.PlatformVersion !== undefined) runRequest.platformVersion = ep.PlatformVersion;
  fs.writeFileSync(
    path.join(BASE, mode + '-run-request.json'),
    JSON.stringify(runRequest, null, 2),
  );
  const run = aws([
    'ecs',
    'run-task',
    '--cli-input-json',
    'file://' + path.join(BASE, mode + '-run-request.json'),
  ]);
  fs.writeFileSync(path.join(BASE, mode + '-run-result.json'), JSON.stringify(run, null, 2));
  if (run.failures?.length || run.tasks?.length !== 1) throw Error('LAUNCH_NOT_CONFIRMED');
  const receipt = {
    status: 'launched',
    ...proof,
    mode,
    taskDefinition: registered.taskDefinitionArn,
    taskArn: run.tasks[0].taskArn,
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
module.exports = {
  buildDefinition,
  validateServing,
  checkQualification,
  assertBeforeLaunch,
  validateBinding,
};
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
