import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Private, single-owner adaptation of the reviewed api-ingestors pin helper.
// Run from the repository root. No reads/writes occur when imported by tests.
const { fingerprint, taskInput, validateQualification } = await import(
  pathToFileURL(path.resolve('scripts/lib/meri-release-policy.mjs'))
);
export const OWNER = 'capiro-dev-legiwatch-committee-updates';
export const EXPECTED_SOURCE_SHA = '2d727bec0483a48dd261d36e3c1719eadd96a23b';
const ACCOUNT = '967807252336';
const REGION = 'us-east-1';
const FAMILY = 'capiro-dev-legiwatch-phase9-api';
const IMAGE_PREFIX = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/capiro/dev/api@sha256:`;
const COMMAND = ['legiwatch-phase9-job', 'committee-updates'];
const BASE = path.dirname(fileURLToPath(import.meta.url));
const PLAN = path.join(BASE, 'committee-updates-pin-plan.json');
const RECEIPT = path.join(BASE, 'committee-updates-pin-receipt.json');
const QUALIFICATION = path.join(BASE, 'api-qualification.json');
const fail = (message) => { throw new Error(message); };
const equal = (a, b) => fingerprint(a) === fingerprint(b);

export function checkQualification(q, now = Date.now()) {
  validateQualification(q, 'api', q?.image, now);
  if (q.sourceSha !== EXPECTED_SOURCE_SHA) fail('Unreviewed source SHA');
}

export function makeAfter(before, q) {
  if (before.family !== FAMILY || before.containerDefinitions?.length !== 1)
    fail('Unexpected task family or container count');
  const original = before.containerDefinitions[0];
  if (original.name !== 'api' || !original.image?.startsWith(IMAGE_PREFIX))
    fail('Unexpected API container/image');
  if (new Set((original.environment ?? []).map((e) => e.name)).size !== (original.environment ?? []).length)
    fail('Duplicate environment variable');
  const after = structuredClone(before);
  const container = after.containerDefinitions[0];
  container.image = q.image;
  const environment = new Map((container.environment ?? []).map((e) => [e.name, e.value]));
  for (const key of ['GIT_SHA', 'RELEASE_SHA']) environment.set(key, q.sourceSha);
  container.environment = [...environment].map(([name, value]) => ({ name, value }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return after;
}

export function checkEntry(entry, q) {
  if (entry.name !== OWNER || entry.rule?.Name !== OWNER || entry.rule?.State !== 'ENABLED' || entry.targets?.length !== 1)
    fail('Only the enabled committee-updates owner is allowed');
  const target = entry.targets[0];
  if (target.Id !== 'committee-updates' ||
      target.Arn !== `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/capiro-dev` ||
      !new RegExp(`^arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/${FAMILY}:\\d+$`).test(target.EcsParameters?.TaskDefinitionArn))
    fail('Unexpected owner target');
  const input = JSON.parse(target.Input);
  if (input.containerOverrides?.length !== 1 || input.containerOverrides[0].name !== 'api' ||
      !equal(input.containerOverrides[0].command, COMMAND)) fail('Unexpected owner command');
  if (!equal(entry.after, makeAfter(entry.before, q))) fail('Non-image task configuration change');
}

export function checkPlan(plan, q, now = Date.now()) {
  checkQualification(q, now);
  if (!equal(plan.qualification, q)) fail('Qualification changed');
  const age = now - Date.parse(plan.createdAt);
  if (!Number.isFinite(age) || age < 0 || age > 3600000) fail('Plan expired or invalid');
  if (plan.entries?.length !== 1) fail('Exactly one owner is allowed');
  checkEntry(plan.entries[0], q);
}

export function nextTargets(entry, registeredArn) {
  if (!new RegExp(`^arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/${FAMILY}:\\d+$`).test(registeredArn))
    fail('Unexpected registered task ARN');
  const next = structuredClone(entry.targets);
  next[0].EcsParameters.TaskDefinitionArn = registeredArn;
  return next;
}

async function main() {
  const mode = process.argv[2];
  if (!['prepare', 'apply'].includes(mode)) fail('Use prepare or apply <reviewed-plan-hash>');
  const q = JSON.parse(fs.readFileSync(QUALIFICATION));
  checkQualification(q);
  const aws = (args) => JSON.parse(cp.execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf8' }));
  if (aws(['sts', 'get-caller-identity']).Account !== ACCOUNT) fail('Account mismatch');
  const digest = q.image.slice(q.image.indexOf('@') + 1);
  const images = aws(['ecr', 'describe-images', '--repository-name', 'capiro/dev/api', '--image-ids', `imageDigest=${digest}`]).imageDetails;
  if (images?.length !== 1 || images[0].imageDigest !== digest) fail('Qualified ECR image unavailable');
  const rule = () => aws(['events', 'describe-rule', '--name', OWNER]);
  const targets = () => aws(['events', 'list-targets-by-rule', '--rule', OWNER]).Targets;
  const input = (arn) => {
    const response = aws(['ecs', 'describe-task-definition', '--task-definition', arn, '--include', 'TAGS']);
    const td = taskInput({ ...response.taskDefinition, tags: response.tags ?? [] });
    for (const container of td.containerDefinitions) container.environment?.sort((a, b) => a.name.localeCompare(b.name));
    return td;
  };
  if (fs.existsSync(RECEIPT)) fail('Existing receipt: do not retry an unknown/completed write');
  if (mode === 'prepare') {
    if (fs.existsSync(PLAN)) fail('Existing plan: use a separately reviewed fresh evidence directory');
    const r = rule(), t = targets();
    if (t?.length !== 1) fail('Unexpected target count');
    const before = input(t[0].EcsParameters.TaskDefinitionArn);
    const entry = { name: OWNER, rule: r, targets: t, before, after: makeAfter(before, q) };
    const plan = { createdAt: new Date().toISOString(), qualification: q, entries: [entry] };
    checkPlan(plan, q);
    const hash = fingerprint(plan);
    fs.writeFileSync(PLAN, JSON.stringify({ hash, plan }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ hash, owner: OWNER, baseline: t[0].EcsParameters.TaskDefinitionArn, sourceSha: q.sourceSha, image: q.image }));
    return;
  }
  const { hash, plan } = JSON.parse(fs.readFileSync(PLAN));
  if (process.argv[3] !== hash || fingerprint(plan) !== hash) fail('Reviewed hash mismatch');
  checkPlan(plan, q);
  const entry = plan.entries[0];
  const checkDrift = () => {
    if (!equal(rule(), entry.rule) || !equal(targets(), entry.targets) ||
        !equal(input(entry.targets[0].EcsParameters.TaskDefinitionArn), entry.before)) fail('Baseline drift');
  };
  checkDrift();
  const receipt = { hash, owner: OWNER, startedAt: new Date().toISOString(), status: 'registration-outcome-unknown' };
  fs.writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  const save = () => fs.writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2));
  const registerFile = path.join(BASE, 'committee-updates-register.json');
  fs.writeFileSync(registerFile, JSON.stringify(entry.after));
  const td = aws(['ecs', 'register-task-definition', '--cli-input-json', `file://${registerFile}`]).taskDefinition;
  receipt.registeredTask = td.taskDefinitionArn;
  receipt.status = 'registered-not-pinned'; save();
  if (!equal(input(td.taskDefinitionArn), entry.after)) fail('Registered task mismatch');
  checkPlan(plan, q); checkDrift();
  const next = nextTargets(entry, td.taskDefinitionArn);
  const targetFile = path.join(BASE, 'committee-updates-targets.json');
  fs.writeFileSync(targetFile, JSON.stringify(next));
  receipt.before = entry.targets; receipt.after = next;
  receipt.status = 'target-write-outcome-unknown'; save();
  const response = aws(['events', 'put-targets', '--rule', OWNER, '--targets', `file://${targetFile}`]);
  if (response.FailedEntryCount || !equal(targets(), next) || !equal(rule(), entry.rule)) fail('Target update/readback failed');
  receipt.status = 'pinned'; receipt.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: receipt.status, owner: OWNER, taskDefinition: td.taskDefinitionArn, completedAt: receipt.completedAt }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
