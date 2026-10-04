import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { sha256Bytes, sha256Stable } from './artifact-collector.mjs';
import { inspectCase17Caller } from './case17-build-authority.mjs';
import { currentCase14ApprovalAuthority } from './case14-approval-capture.mjs';
import { currentCase14PostApprovalSpendScope } from './capture-spend-aggregate.mjs';
import { taskInput } from '../../../scripts/lib/meri-release-policy.mjs';

const execute = promisify(execFile),
  owned = new WeakMap();
const need = (ok) => {
  if (!ok) throw new Error('CASE14_NATIVE_POSTAPPROVAL_UNPROVED');
};
const SOURCE = 'c0f393f863bf73bd4e65e7a94e17c073e7be021e';
const INNER = '48f79bd617b4d42afeb0cd19500014284c2fa1cc281853d6486f354a229b1a81';
const IMAGE =
  '967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:024fcc82a2db7701f4a3e3311598a9a1d0933b3fe4fcf73751bf0e3fb866d8ce';
const RATES = '1c9106e5d98f73b061f0de9918bf33c8fb28b0f0bc5be5ae4bc7d20e0da2a348';
const FAMILY = 'capiro-dev-meri-c2-case14-postapproval-20261004';
const DEFINITION = '96ecf8559569080c0861adbda4c4ec391bbbf7b48968957e626f46fbdbb08293';
/** Normalize only ECS documented empty defaults and the separately verified
 * per-dispatch input, command and registration tag. Everything else is pinned. */
export function case14PostApprovalDefinitionSha256(definition) {
  const d = taskInput(definition);
  delete d.tags;
  d.enableFaultInjection ??= false;
  d.placementConstraints ??= [];
  d.volumes ??= [];
  for (const c of d.containerDefinitions) {
    delete c.command;
    c.cpu ??= 0;
    for (const k of ['mountPoints', 'portMappings', 'systemControls', 'volumesFrom']) c[k] ??= [];
    c.environment = (c.environment ?? []).filter(x => !['C2_CASE14_POSTAPPROVAL_INPUT_B64', 'C2_CASE14_POSTAPPROVAL_INPUT_SHA256'].includes(x.name)).sort((a,b) => a.name.localeCompare(b.name));
    c.secrets = (c.secrets ?? []).sort((a,b) => a.name.localeCompare(b.name));
  }
  return sha256Stable(d);
}
const TASK = /^arn:aws:ecs:us-east-1:967807252336:task\/capiro-dev\/[a-f0-9]{32}$/u;
const READS = new Set([
  'sts get-caller-identity',
  'ecs describe-tasks',
  'ecs describe-task-definition',
  'logs get-log-events',
]);
async function aws(args) {
  need(process.platform === 'win32' && READS.has(args.slice(0, 2).join(' ')));
  try {
    const { stdout } = await execute(
      'C:/Program Files/Amazon/AWSCLIV2/aws.exe',
      [
        ...args,
        '--profile',
        'capiro-dev',
        '--region',
        'us-east-1',
        '--output',
        'json',
        '--no-cli-pager',
      ],
      { windowsHide: true, timeout: 45000, maxBuffer: 8 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } catch {
    throw new Error('CASE14_NATIVE_POSTAPPROVAL_READ_FAILED');
  }
}

/** Pure source/input/task comparison. This does not mint an outcome capability. */
export function inspectCase14PostApprovalTask({ task, definition, tags, approval, scope }) {
  const dispatch = scope.dispatch;
  need(dispatch && task.taskArn === dispatch.taskArn && task.taskDefinitionArn === dispatch.taskDefinitionArn &&
    task.startedBy === dispatch.startedBy && tags?.filter(x => x.key === 'MeriC2RegistrationOwner').length === 1 &&
    tags.find(x => x.key === 'MeriC2RegistrationOwner').value === dispatch.registrationMarker);
  need(case14PostApprovalDefinitionSha256(definition) === DEFINITION);
  need(
    TASK.test(task?.taskArn ?? '') &&
      task.lastStatus === 'STOPPED' &&
      task.containers?.length === 1 &&
      task.containers[0].exitCode === 0,
  );
  need(
    task.taskDefinitionArn === definition.taskDefinitionArn &&
      definition.family === FAMILY &&
      definition.containerDefinitions?.length === 1 &&
      !definition.taskRoleArn &&
      definition.status === 'INACTIVE',
  );
  const c = definition.containerDefinitions[0];
  need(
    c.image === IMAGE &&
      task.containers[0].image === IMAGE &&
      task.containers[0].imageDigest === IMAGE.split('@')[1],
  );
  need(
    isDeepStrictEqual(c.entryPoint, [
      '/usr/bin/dumb-init',
      '--',
      'node',
      '--input-type=module',
      '-e',
    ]) &&
      c.command?.length === 1 &&
      sha256Bytes(c.command[0]) === INNER &&
      !c.environmentFiles?.length,
  );
  need(
    !task.overrides?.taskRoleArn &&
      !task.overrides?.containerOverrides?.some(
        (x) => x.command?.length || x.environment?.length || x.environmentFiles?.length,
      ),
  );
  need(
    isDeepStrictEqual((c.secrets ?? []).map((x) => x.name).sort(), [
      'DB_HOST',
      'DB_PASSWORD',
      'DB_PORT',
      'DB_USER',
    ]),
  );
  const rows = c.environment ?? [];
  need(new Set(rows.map((x) => x.name)).size === rows.length);
  const env = Object.fromEntries(rows.map((x) => [x.name, x.value]));
  need(
    env.GIT_SHA === SOURCE &&
      env.RELEASE_SHA === SOURCE &&
      env.MERI_SYNTHETIC_FIXTURE_NAMESPACE === 'meri-foundation-20260928',
  );
  need(!rows.some((x) => /API_KEY|ACCESS_KEY|SESSION_TOKEN|DATABASE_URL/u.test(x.name)));
  const bytes = Buffer.from(env.C2_CASE14_POSTAPPROVAL_INPUT_B64 ?? '', 'base64');
  need(
    bytes.length > 0 &&
      bytes.length <= 32768 &&
      sha256Bytes(bytes) === env.C2_CASE14_POSTAPPROVAL_INPUT_SHA256,
  );
  need(sha256Bytes(bytes) === dispatch.inputByteSha256);
  const input = JSON.parse(bytes);
  need(
    input.kind === 'case14-postapproval-native-setup-input' &&
      input.version === 1 &&
      input.sourceSha === SOURCE &&
      input.captureRunId === scope.captureRunId &&
      input.approvalEvidenceSha256 === sha256Stable(approval) &&
      isDeepStrictEqual(input.approvedOwner, approval.after.fixtureEvidence) &&
      isDeepStrictEqual(input.approvalWindow, scope.approvalWindow) &&
      isDeepStrictEqual(input.limits, {
        maxAttempts: 32,
        maxTokens: 500000,
        maxCostMicros: 14000000,
      }) &&
      sha256Stable(input.rateEvidence) === RATES,
  );
  need(
    input.ctx?.tenantId === approval.reviewer.tenantId &&
      input.ctx.userId === approval.reviewer.userId &&
      input.ctx.role === 'user_admin' &&
      input.clientId === approval.after.fixtureEvidence.clientId,
  );
  const created = Date.parse(task.createdAt), started = Date.parse(task.startedAt), stopped = Date.parse(task.stoppedAt);
  need(scope.approvalWindow.startedAtMs <= created && created <= started && started <= stopped && stopped <= scope.approvalWindow.deadlineAtMs);
  const log = c.logConfiguration;
  need(
    log?.logDriver === 'awslogs' &&
      log.options?.['awslogs-region'] === 'us-east-1' &&
      typeof log.options['awslogs-group'] === 'string' &&
      typeof log.options['awslogs-stream-prefix'] === 'string',
  );
  return {
    input,
    inputByteSha256: sha256Bytes(bytes),
    logGroup: log.options['awslogs-group'],
    logStream:
      log.options['awslogs-stream-prefix'] + '/' + c.name + '/' + task.taskArn.split('/').at(-1),
  };
}

export function inspectCase14PostApprovalReceipts({ receipts, input, inputByteSha256 }) {
  need(
    Array.isArray(receipts) &&
      receipts.length >= 12 &&
      receipts.length <= 100 &&
      receipts.every((x) => x.sourceSha === SOURCE && x.inputByteSha256 === inputByteSha256) &&
      !receipts.some((x) => ['FAILURE', 'FATAL'].includes(x.phase)),
  );
  const complete = receipts.filter((x) => x.phase === 'COMPLETE');
  need(complete.length === 1);
  const value = complete[0].value,
    stages = ['projection-terminal', 'recall-plan', 'recall-bind', 'budget-plan', 'budget-install'];
  need(
    value.kind === 'case14-postapproval-native-setup' &&
      value.status === 'RECALL_BOUND_AND_BUDGET_INSTALLED' &&
      value.sourceSha === SOURCE &&
      value.captureRunId === input.captureRunId &&
      value.approvalEvidenceSha256 === input.approvalEvidenceSha256 &&
      value.inputContentSha256 === sha256Stable(input) &&
      isDeepStrictEqual(value.approvalWindow, input.approvalWindow) &&
      isDeepStrictEqual(value.completed, stages) &&
      value.adapterProviderCalls === 0 &&
      value.reviewDecisions === 0 &&
      value.synthesisSubmissions === 0 &&
      value.aggregateJournalMutations === 0 &&
      value.liveAcceptance === 'NOT_RUN' &&
      value.acceptanceAuthority === false,
  );
  const verified = receipts.filter((x) => x.phase === 'VERIFIED');
  need(
    isDeepStrictEqual(
      verified.map((x) => x.stage),
      stages,
    ),
  );
  const p = value.results['projection-terminal'];
  need(
    p.status === 'BOTH_APPROVAL_PROJECTION_BRANCHES_PERSISTED' &&
      p.captureRunId === input.captureRunId &&
      p.approvalEvidenceSha256 === input.approvalEvidenceSha256 &&
      isDeepStrictEqual(p.canonicalOwner, input.approvedOwner) &&
      sha256Stable(p) === verified[0].receiptSha256 &&
      isDeepStrictEqual(p, verified[0].proof) &&
      p.providerCalls === 0 &&
      p.databaseWrites === 0 &&
      p.providerUsageMeasured === false &&
      p.approvalBilledActualMicros === null &&
      p.clio.legacyDimensions === 1536 &&
      p.embedding.dimensions === 1024 &&
      p.outbox.status === 'completed' &&
      p.outbox.attempts === 0 &&
      p.exactOutboxRows === 1 &&
      p.otherOutboxRows === 0,
  );
  for (const stage of stages.slice(1)) {
    const r = receipts.filter((x) => x.phase === 'RECEIPT' && x.stage === stage);
    need(r.length === 1 && r[0].childExitCode === 0);
    const bytes = Buffer.from(r[0].data, 'base64');
    need(bytes.length === r[0].bytes && sha256Bytes(bytes) === r[0].sha256);
    need(
      isDeepStrictEqual(JSON.parse(bytes), value.results[stage]) &&
        verified.find((x) => x.stage === stage).receiptSha256 === r[0].sha256,
    );
  }
  const installed = value.results['budget-install'];
  need(
    installed.status === 'PROVIDER_QUALIFICATION_INSTALLED' &&
      installed.captureRunId === input.captureRunId &&
      installed.maxCostMicros === 14000000 &&
      installed.rateEvidenceSha256 === RATES,
  );
  return structuredClone(value);
}

/** Re-read actual cloud task identity and logs after the single owned RPC. No
 * JSON result, local file or callback can mint this completed-setup authority. */
export async function readCase14PostApprovalTaskAuthority({
  spendReservation,
  approvalOutcome,
  taskArn,
}) {
  const scope = currentCase14PostApprovalSpendScope(spendReservation, approvalOutcome);
  const approval = currentCase14ApprovalAuthority(approvalOutcome);
  need(TASK.test(taskArn));
  need(scope.dispatch?.taskArn === taskArn);
  inspectCase17Caller(await aws(['sts', 'get-caller-identity']));
  const tasks = await aws(['ecs', 'describe-tasks', '--cluster', 'capiro-dev', '--tasks', taskArn]);
  need(!tasks.failures?.length && tasks.tasks?.length === 1);
  const task = tasks.tasks[0],
    td = await aws([
      'ecs',
      'describe-task-definition',
      '--task-definition',
      task.taskDefinitionArn,
      '--include', 'TAGS',
    ]);
  const binding = inspectCase14PostApprovalTask({
    task,
    definition: td.taskDefinition,
    tags: td.tags,
    approval,
    scope,
  });
  const events = [];
  let token,
    complete = false;
  for (let page = 0; page < 20; page++) {
    const result = await aws([
      'logs',
      'get-log-events',
      '--log-group-name',
      binding.logGroup,
      '--log-stream-name',
      binding.logStream,
      '--start-from-head',
      '--no-paginate',
      ...(token ? ['--next-token', token] : []),
    ]);
    need(Array.isArray(result.events) && typeof result.nextForwardToken === 'string');
    events.push(...result.events);
    need(events.length <= 5000);
    if (token === result.nextForwardToken) {
      complete = true;
      break;
    }
    token = result.nextForwardToken;
  }
  need(complete);
  const receipts = events
    .flatMap((e) => e.message.split('\n'))
    .filter((x) => x.startsWith('C2_CASE14_POSTAPPROVAL '))
    .map((x) => JSON.parse(x.slice('C2_CASE14_POSTAPPROVAL '.length)));
  const value = inspectCase14PostApprovalReceipts({ ...binding, receipts });
  const proof = {
    taskArn,
    taskDefinition: task.taskDefinitionArn,
    scriptSha256: INNER,
    inputByteSha256: binding.inputByteSha256,
    observedAt: new Date().toISOString(),
    taskReadbackSha256: sha256Stable(task),
    definitionSha256: sha256Stable(td.taskDefinition),
    logEventsSha256: sha256Stable(events),
    value,
  };
  const authority = Object.freeze({
    kind: 'meri-case14-owned-postapproval-task',
    captureRunId: scope.captureRunId,
    proofSha256: sha256Stable(proof),
  });
  owned.set(authority, { spendReservation, approvalOutcome, proof });
  return authority;
}
export function currentCase14PostApprovalTaskAuthority(
  authority,
  spendReservation,
  approvalOutcome,
) {
  const a = owned.get(authority);
  need(
    a &&
      a.spendReservation === spendReservation &&
      a.approvalOutcome === approvalOutcome &&
      sha256Stable(a.proof) === authority.proofSha256,
  );
  return structuredClone(a.proof);
}
