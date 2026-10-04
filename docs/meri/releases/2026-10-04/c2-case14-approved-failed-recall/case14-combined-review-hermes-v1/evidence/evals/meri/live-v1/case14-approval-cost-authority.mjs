import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { sha256Stable, stableJson } from './artifact-collector.mjs';
import { fingerprint, taskInput } from '../../../scripts/lib/meri-release-policy.mjs';
import { inspectCase17Caller } from './case17-build-authority.mjs';
import { assertWindowsArtifactStorage } from './windows-artifact-storage.mjs';

const execute = promisify(execFile), authorities = new WeakMap();
const need = (ok) => { if (!ok) throw new Error('CASE14_APPROVAL_COST_UNPROVED'); };
const EVIDENCE_HASH = 'fac6ae10ca139a3d4dc8583e621c3b5f70b9e72214a05825a988c55964d3f56c';
const evidence = JSON.parse(readFileSync(new URL('./case14-approval-cost-evidence.json', import.meta.url)));
need(sha256Stable(evidence) === EVIDENCE_HASH);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const READS = new Set(['sts get-caller-identity', 'ecs describe-services', 'ecs describe-task-definition',
  'ecs list-tasks', 'ecs describe-tasks', 'events describe-rule', 'events list-targets-by-rule']);
async function aws(args) {
  need(process.platform === 'win32' && READS.has(args.slice(0, 2).join(' ')));
  try {
    const { stdout } = await execute('C:/Program Files/Amazon/AWSCLIV2/aws.exe',
      [...args, '--profile', 'capiro-dev', '--region', 'us-east-1', '--output', 'json', '--no-cli-pager'],
      { windowsHide: true, timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch { throw new Error('CASE14_APPROVAL_COST_READ_FAILED'); }
}

/** Pure validation; JSON passing these checks cannot mint spend authority. */
export function inspectCase14ApprovalCostCensus(census, deadlineAtMs, now = Date.now()) {
  need(Number.isSafeInteger(deadlineAtMs) && deadlineAtMs > now && deadlineAtMs <= now + 900000);
  need(now >= Date.parse(evidence.observedAt) && deadlineAtMs < Date.parse(evidence.expiresAt));
  inspectCase17Caller(census.caller);
  const s = census.services;
  need(!s.failures?.length && s.services?.length === 1);
  const api = s.services[0];
  need(api.serviceName === 'capiro-dev-api' && api.taskDefinition === evidence.apiTaskDefinition &&
    api.desiredCount === 2 && api.runningCount === 2 && api.pendingCount === 0 && api.deployments?.length === 1 &&
    api.deployments[0].status === 'PRIMARY' && api.deployments[0].rolloutState === 'COMPLETED');
  const td = census.definition.taskDefinition, containers = td?.containerDefinitions;
  need(td?.taskDefinitionArn === evidence.apiTaskDefinition && td.status === 'ACTIVE' && containers?.length === 1);
  const c = containers[0];
  need(c.name === 'api' && c.image === `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@${evidence.apiImage}` &&
    !c.environmentFiles?.length && sha256Stable(c.environment) === evidence.apiEnvironmentSha256);
  need(fingerprint(census.rule) === evidence.nightly.ruleSha256 && census.rule.State === 'ENABLED' &&
    census.rule.ScheduleExpression === 'cron(30 4 * * ? *)');
  need(census.targets.Targets?.length === 1 && !census.targets.NextToken &&
    fingerprint(census.targets.Targets[0]) === evidence.nightly.targetSha256);
  need(census.nightlyDefinition.taskDefinition.status === 'ACTIVE' &&
    fingerprint(taskInput({ ...census.nightlyDefinition.taskDefinition, tags: census.nightlyDefinition.tags })) === evidence.nightly.taskInputSha256);
  need(census.broadRule.Name === 'capiro-dev-memory-projection-worker' && census.broadRule.State === 'DISABLED');
  const next = new Date(now); next.setUTCHours(4, 30, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  need(deadlineAtMs + 60000 < next.getTime());
  need(Array.isArray(census.tasks) && census.tasks.length > 0 && new Set(census.tasks.map(t => t.taskArn)).size === census.tasks.length);
  const apiTasks = census.tasks.filter(t => t.group === 'service:capiro-dev-api');
  need(apiTasks.length === 2 && apiTasks.every(t => t.lastStatus === 'RUNNING' && t.desiredStatus === 'RUNNING' &&
    t.taskDefinitionArn === evidence.apiTaskDefinition && t.containers?.length === 1 && t.containers[0].imageDigest === evidence.apiImage &&
    !t.overrides?.containerOverrides?.some(o => o.command?.length || o.environment?.length || o.environmentFiles?.length)));
  // Relevant ordinary API / Meri standalone tasks could project this memory.
  // Unrelated services and scheduled jobs do not make this a whole-account lock.
  const overlap = census.tasks.filter(t => !t.group?.startsWith('service:') &&
    (/\/capiro-dev-(?:api-migrate|memory-projection-worker|meri-)/u.test(t.taskDefinitionArn ?? '') ||
      t.startedBy === 'events-rule/capiro-dev-refresh-memory-graph'));
  need(overlap.length === 0);
  return { nextNightlyAt: next.toISOString(), activeRelevantStandaloneTasks: 0,
    apiTasks: apiTasks.map(t => t.taskArn).sort(), broadProjectionWorker: 'DISABLED' };
}

async function readCensus(deadlineAtMs) {
  const [caller, services, definition, rule, targets, nightlyDefinition, broadRule, list] = await Promise.all([
    aws(['sts', 'get-caller-identity']),
    aws(['ecs', 'describe-services', '--cluster', 'capiro-dev', '--services', 'capiro-dev-api']),
    aws(['ecs', 'describe-task-definition', '--task-definition', evidence.apiTaskDefinition]),
    aws(['events', 'describe-rule', '--name', evidence.nightly.rule]),
    aws(['events', 'list-targets-by-rule', '--rule', evidence.nightly.rule]),
    aws(['ecs', 'describe-task-definition', '--task-definition', evidence.nightly.taskDefinition, '--include', 'TAGS']),
    aws(['events', 'describe-rule', '--name', 'capiro-dev-memory-projection-worker']),
    aws(['ecs', 'list-tasks', '--cluster', 'capiro-dev', '--desired-status', 'RUNNING']),
  ]);
  need(Array.isArray(list.taskArns) && list.taskArns.length > 0 && list.taskArns.length <= 100 && !list.nextToken);
  // ECS desired RUNNING includes provisioning and pending tasks as well.
  const tasks = await aws(['ecs', 'describe-tasks', '--cluster', 'capiro-dev', '--tasks', ...list.taskArns]);
  need(!tasks.failures?.length && tasks.tasks?.length === list.taskArns.length);
  const census = { caller, services, definition, rule, targets, nightlyDefinition, broadRule, tasks: tasks.tasks };
  const result = inspectCase14ApprovalCostCensus(census, deadlineAtMs);
  return { observedAtMs: Date.now(), censusSha256: sha256Stable(census), ...result };
}

/** Fixed reviewed provider envelope plus fresh native AWS reads. No callbacks,
 * result injection, JSON restoration, provider dispatch, or journal mutation. */
export async function readCase14ApprovalCostAuthority(config, artifactStorage) {
  assertWindowsArtifactStorage(artifactStorage, artifactStorage?.root);
  need(config?.caseId === '14' && UUID.test(config.captureRunId ?? '') &&
    sha256Stable(config.recipe) === evidence.scope.recipeSha256 && config.reviewer?.role === 'user_admin' &&
    config.reviewer.userId === evidence.scope.reviewerUserId && config.reviewer.tenantId === evidence.scope.tenantId &&
    config.deployment?.apiSha === evidence.sourceSha && config.deployment.webSha === evidence.sourceSha);
  const deadlineAtMs = Date.now() + 900000, census = await readCensus(deadlineAtMs);
  const proof = { kind: 'meri-case14-native-approval-cost-bound', version: 1, caseId: '14',
    captureRunId: config.captureRunId, scopeSha256: sha256Stable(config), ...evidence.scope,
    approvalCeilingMicros: 1000000, recallCeilingMicros: 14000000, combinedCeilingMicros: 15000000,
    reviewedEvidenceSha256: EVIDENCE_HASH, deadlineAtMs, initialCensus: census };
  const authority = Object.freeze({ kind: proof.kind, approvalBoundSha256: sha256Stable(proof) });
  artifactStorage.writeBytes('case14-approval/cost-bound.json', Buffer.from(stableJson({ ...proof, ...authority })));
  authorities.set(authority, { proof, storage: artifactStorage, census, consumed: false, reads: 0 });
  return authority;
}

export function consumeCase14ApprovalCostAuthority(authority, captureRunId) {
  const a = authorities.get(authority);
  need(a && !a.consumed && a.proof.captureRunId === captureRunId);
  assertCase14ApprovalCostAuthority(authority);
  a.consumed = true;
  return Object.freeze({ ...structuredClone(a.proof), approvalBoundSha256: authority.approvalBoundSha256 });
}
export function assertCase14ApprovalCostAuthority(authority) {
  const a = authorities.get(authority), now = Date.now();
  need(a && now < a.proof.deadlineAtMs && now >= a.census.observedAtMs && now - a.census.observedAtMs < 60000);
}
export async function refreshCase14ApprovalCostAuthority(authority) {
  const a = authorities.get(authority);
  need(a && a.consumed && Date.now() < a.proof.deadlineAtMs);
  a.census = await readCensus(a.proof.deadlineAtMs);
  a.storage.writeBytes(`case14-approval/cost-census-${++a.reads}.json`, Buffer.from(stableJson(a.census)));
  assertCase14ApprovalCostAuthority(authority);
}
