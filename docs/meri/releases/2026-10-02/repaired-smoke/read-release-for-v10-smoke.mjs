import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { releaseOperator } from 'file:///C:/dev/cap-meri-outcomes-validation/scripts/meri-release.mjs';
import { validateQualification } from 'file:///C:/dev/cap-meri-outcomes-validation/scripts/lib/meri-release-policy.mjs';

// Attended task-specific observation only. No cloud mutation is callable here.
const [qualificationPath, promotionPath, outputPath, mergedSourceSha] = process.argv.slice(2);
assert.match(mergedSourceSha ?? '', /^[a-f0-9]{40}$/);
const q = JSON.parse(await readFile(qualificationPath, 'utf8'));
const promotion = JSON.parse(await readFile(promotionPath, 'utf8'));
const execute = promisify(execFile);
const calls = [];
const taskIdsByService = new Map();
const allow = new Set(['sts get-caller-identity', 'ecs describe-services', 'ecs describe-task-definition', 'ecs list-tasks', 'ecs describe-tasks', 'elbv2 describe-target-groups', 'elbv2 describe-target-health', 'ecr describe-images']);
const aws = async (args) => {
  const operation = args.slice(0, 2).join(' ');
  assert(allow.has(operation), 'read-only operation required');
  try {
    const { stdout } = await execute('C:/Program Files/Amazon/AWSCLIV2/aws.exe', [...args, '--region', 'us-east-1', '--output', 'json', '--no-cli-pager'], { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    calls.push({ operation, exitCode: 0 });
    const result = JSON.parse(stdout);
    if (operation === 'ecs list-tasks') taskIdsByService.set(args[args.indexOf('--service-name') + 1], result.taskArns);
    return result;
  } catch {
    throw new Error(`Read-only ${operation} failed; raw AWS output withheld`);
  }
};
const identity = await aws(['sts', 'get-caller-identity']);
assert.equal(identity.Account, '967807252336');
assert.equal(identity.Arn, 'arn:aws:iam::967807252336:user/hermes-cli');
assert.equal(q.service, 'api');
assert.equal(q.status, 'qualified');
assert.equal(q.sourceSha, '4aad73b881c2f33ebb0bc41ddf61514a34010ad7');
validateQualification(q, q.service, q.image);
const targets = {
  api: { source: q.sourceSha, digest: q.image.split('@')[1] },
  'meriv2-orchestrator': { source: 'bae902c734eea220b4c6299423119e7bdaac2f6b', digest: 'sha256:94f49d77dd2770b4da93a1f1d8f7b112e7f4533c2c860be5eb42f1bbdddb095b', task: 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-meriv2-orchestrator:89' },
  'web-vnext': { source: '940fe9354f95630c6acb0f20f75ced26ea9e75f4', digest: 'sha256:bb114117e1ac5bad398a34c2272280b0b55abbcb0502cb5b6b95356f213bdfdb', task: 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-web-vnext:386' },
};
const tenantSlugs = ['meri-foundation-20260928-t1', 'meri-foundation-20260928-t2'];
const operator = releaseOperator({ aws });
const services = {};
for (const [name, expected] of Object.entries(targets)) {
  const state = await operator.snapshot(name);
  const containers = state.task.containerDefinitions.filter(c => c.name === name);
  assert.equal(containers.length, 1);
  const container = containers[0];
  assert(!container.environmentFiles?.length);
  const entries = container.environment ?? [];
  assert.equal(new Set(entries.map(e => e.name)).size, entries.length);
  const env = Object.fromEntries(entries.map(e => [e.name, e.value]));
  assert.equal(env.GIT_SHA, expected.source);
  assert.equal(env.RELEASE_SHA, expected.source);
  assert.equal(state.baseline.imageDigest, expected.digest);
  if (expected.task) assert.equal(state.baseline.taskDefinitionArn, expected.task);
  const primary = state.service.deployments.filter(d => d.status === 'PRIMARY');
  assert.equal(primary.length, 1);
  assert.equal(primary[0].rolloutState, 'COMPLETED');
  const ecr = await aws(['ecr', 'describe-images', '--repository-name', `capiro/dev/${name}`, '--image-ids', `imageTag=${expected.source}`]);
  assert.equal(ecr.imageDetails.length, 1);
  assert.equal(ecr.imageDetails[0].imageDigest, expected.digest);
  if (name !== 'web-vnext') {
    const cohorts = (env.MERIV3_CANARY_TENANT_SLUGS ?? '').split(',').map(x => x.trim()).filter(Boolean);
    assert.equal(new Set(cohorts).size, cohorts.length);
    assert(tenantSlugs.every(s => cohorts.includes(s)));
  }
  const flag = 'RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED';
  assert(!(container.secrets ?? []).some(s => s.name === flag));
  assert(['', 'false', '0'].includes(env[flag] ?? ''));
  services[name] = { sourceSha: expected.source, imageDigest: expected.digest, taskDefinitionArn: state.baseline.taskDefinitionArn, primaryDeploymentId: primary[0].id, healthy: true, desired: state.service.desiredCount, running: state.service.runningCount, pending: state.service.pendingCount, taskArns: taskIdsByService.get(`capiro-dev-${name}`), rpToolsDark: true };
}
// Match the exact source operator's durable promotion receipt.
assert.equal(promotion.service, 'api');
assert.equal(promotion.status, 'ecs-healthy-manual-acceptance-required');
assert.equal(promotion.candidateTaskDefinition, services.api.taskDefinitionArn);
assert.equal(promotion.candidateImage, q.image);
assert.equal(promotion.deploymentId, services.api.primaryDeploymentId);
const flagPath = 'C:/dev/cap-meri-foundation-evidence/oct02-release-path/synthetic-canary-independent-final-readback-v2.json';
const flagBytes = await readFile(flagPath);
const old = JSON.parse(flagBytes.toString('utf8'));
assert.equal(old.verdict, 'PASS');
assert.equal(old.flagAuthority.actualExitCode, 0);
assert.equal(old.flagAuthority.after.length, 2);
assert.deepEqual(old.flagAuthority.after.map(entry => entry.tenantSlug).sort(), [...tenantSlugs].sort());
for (const entry of old.flagAuthority.after) {
  assert(tenantSlugs.includes(entry.tenantSlug));
  assert.deepEqual(entry.state, { present: true, value: true });
}
const result = {
  verdict: 'PASS', environment: 'capiro-dev', origin: 'https://os.capiro.ai', attemptId: 'v10-remaining-t2', mergedSourceSha,
  observedAtEpoch: Date.now() / 1000, policySha: '39590a3bfc57ce03b0411ff7912a7c8d99deb70c', machineMapDate: '2026-09-30',
  approvedTenantSlugs: tenantSlugs, syntheticCohortsVerified: true,
  syntheticFlagEvidence: { status: 'LAST_AUTHORITATIVE_APPLY', receiptSha256: createHash('sha256').update(flagBytes).digest('hex'), freshDbQuery: false },
  services, calls, externalWrites: 0,
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ verdict: result.verdict, outputPath, readCalls: calls.length, externalWrites: 0, services }));
