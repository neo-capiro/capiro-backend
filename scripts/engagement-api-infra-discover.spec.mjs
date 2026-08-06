#!/usr/bin/env node
/**
 * Tests for the engagement-api read-only discovery script.
 *
 * A fake `aws` binary serves fixture JSON and records every invocation, so the
 * read-only guarantee is proven by observing the calls actually made rather
 * than by reading the source and hoping.
 *
 * Run: node scripts/engagement-api-infra-discover.spec.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'engagement-api-infra-discover.sh');

const ACCOUNT = '967807252336';
const REGION = 'us-east-1';
const VPC = 'vpc-0aaaaaaaaaaaaaaaa';
const CLUSTER = `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/capiro-dev`;
const LISTENER = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/capiro-prod-alb/abc/def`;
const MAIN_TG = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/capiro-prod-api/111`;
const GENERIC_PRIORITY = '10';

/** A live-shaped fixture set. Overrides replace whole responses. */
function baseResponses() {
  return {
    'sts get-caller-identity': { Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:user/ci` },
    'ec2 describe-vpcs': { Vpcs: [{ VpcId: VPC }] },
    'ec2 describe-subnets': {
      Subnets: [
        { SubnetId: 'subnet-0a', AvailabilityZone: 'us-east-1a', MapPublicIpOnLaunch: false },
        { SubnetId: 'subnet-0b', AvailabilityZone: 'us-east-1b', MapPublicIpOnLaunch: false },
        { SubnetId: 'subnet-0c', AvailabilityZone: 'us-east-1a', MapPublicIpOnLaunch: true },
      ],
    },
    'ecs describe-clusters': { clusters: [{ status: 'ACTIVE' }] },
    'elbv2 describe-listeners': { Listeners: [{ ListenerArn: LISTENER, Port: 443 }] },
    // Mirrors the live layout recorded in scripts/meri-alb-rules.sh.
    'elbv2 describe-rules': {
      Rules: [
        { RuleArn: 'r9', Priority: '9', Conditions: [{ Field: 'path-pattern', Values: ['/onboard-api/*'] }], Actions: [{ TargetGroupArn: 'tg-onboard' }] },
        { RuleArn: 'r10', Priority: GENERIC_PRIORITY, Conditions: [{ Field: 'path-pattern', Values: ['/api/*'] }], Actions: [{ TargetGroupArn: MAIN_TG }] },
        { RuleArn: 'r13', Priority: '13', Conditions: [{ Field: 'path-pattern', Values: ['/meri-api/*'] }], Actions: [{ TargetGroupArn: 'tg-meri' }] },
        { RuleArn: 'r15', Priority: '15', Conditions: [{ Field: 'path-pattern', Values: ['/webhooks/*'] }], Actions: [{ TargetGroupArn: MAIN_TG }] },
      ],
    },
    'elbv2 describe-target-groups': { TargetGroups: [{ TargetGroupName: 'capiro-prod-api' }] },
    'ecr describe-repositories': { repositories: [{ repositoryName: 'capiro/dev/api' }] },
    'ecs list-services': { serviceArns: [`${CLUSTER.replace('cluster', 'service')}/capiro-dev-api`] },
    'cloudformation list-stacks': {
      StackSummaries: [{ StackName: 'Capiro-dev-Compute', StackStatus: 'UPDATE_ROLLBACK_FAILED' }],
    },
    'rds describe-db-clusters': {
      DBClusters: [{ DBClusterIdentifier: 'capiro-dev-aurora', Engine: 'aurora-postgresql', Status: 'available' }],
    },
  };
}

/** Build a sandbox with a fake `aws` that logs every call it receives. */
function sandbox(responses) {
  const dir = mkdtempSync(path.join(tmpdir(), 'eng-discover-'));
  writeFileSync(path.join(dir, 'responses.json'), JSON.stringify(responses));

  const fake = path.join(dir, 'fake-aws.mjs');
  writeFileSync(
    fake,
    `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const dir = ${JSON.stringify(dir.replace(/\\/g, '/'))};
const args = process.argv.slice(2);
appendFileSync(dir + '/calls.log', args.join(' ') + '\\n');
const responses = JSON.parse(readFileSync(dir + '/responses.json', 'utf8'));
const key = args[0] + ' ' + args[1];
if (!(key in responses)) { process.stderr.write('no fixture for ' + key); process.exit(254); }
const value = responses[key];
if (value === null) { process.stderr.write('simulated failure'); process.exit(255); }
process.stdout.write(JSON.stringify(value));
`,
  );

  // A .cmd-free shim: bash invokes "$AWS_BIN" directly, so point it at a
  // wrapper script that execs node with the fake.
  const shim = path.join(dir, 'aws');
  writeFileSync(shim, `#!/usr/bin/env bash\nexec node ${JSON.stringify(fake)} "$@"\n`, { mode: 0o755 });
  writeFileSync(path.join(dir, 'calls.log'), '');
  mkdirSync(path.join(dir, 'out'), { recursive: true });
  return { dir, shim, outDir: path.join(dir, 'out') };
}

function run(responses, env = {}) {
  const box = sandbox(responses);
  let status = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync('bash', [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        AWS_BIN: box.shim,
        AWS_REGION: REGION,
        CAPIRO_ENV: 'dev',
        EXPECTED_AWS_ACCOUNT_ID: ACCOUNT,
        EXPECTED_VPC_ID: VPC,
        EXPECTED_ECS_CLUSTER_ARN: CLUSTER,
        EXPECTED_HTTPS_LISTENER_ARN: LISTENER,
        EXPECTED_MAIN_API_TARGET_GROUP_ARN: MAIN_TG,
        EXPECTED_GENERIC_API_RULE_PRIORITY: GENERIC_PRIORITY,
        ENGAGEMENT_DISCOVERY_OUT_DIR: box.outDir,
        ...env,
      },
    });
  } catch (error) {
    status = error.status ?? 1;
    stdout = error.stdout?.toString() ?? '';
    stderr = error.stderr?.toString() ?? '';
  }
  const reportPath = path.join(box.outDir, 'discovery.json');
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  const calls = readFileSync(path.join(box.dir, 'calls.log'), 'utf8')
    .split('\n')
    .filter(Boolean);
  return { status, stdout, stderr, report, calls, outDir: box.outDir };
}

// ────────────────────────────────────────────────────────────── happy path

test('a clean environment discovers successfully and writes evidence', () => {
  const result = run(baseResponses());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ENGAGEMENT_API_DISCOVERY_CLEAN/);
  assert.ok(result.report);
  assert.equal(result.report.readOnly, true);
  assert.deepEqual(result.report.stopConditions, []);
  assert.equal(result.report.account, ACCOUNT);
  assert.equal(result.report.previewRulePriority, '6');
  assert.equal(result.report.genericApiRulePriority, GENERIC_PRIORITY);
  assert.ok(existsSync(path.join(result.outDir, 'discovery.sha256')));
});

test('only private subnets are recorded, across two AZs', () => {
  const { report } = run(baseResponses());
  assert.deepEqual(
    report.privateSubnets.map((s) => s.id),
    ['subnet-0a', 'subnet-0b'],
  );
  assert.equal(new Set(report.privateSubnets.map((s) => s.az)).size, 2);
});

test('no secret value is recorded in the evidence', () => {
  const { report } = run(baseResponses());
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /SecretString|"password"|BEGIN [A-Z ]*PRIVATE KEY/i);
});

// ──────────────────────────────────────────────────── read-only enforcement

test('every AWS call made is read-only', () => {
  const { calls } = run(baseResponses());
  assert.ok(calls.length > 0, 'the script made no AWS calls at all');
  for (const call of calls) {
    const operation = call.split(' ')[1];
    assert.match(
      operation,
      /^(describe|list|get|lookup)-/,
      `non read-only AWS call was made: ${call}`,
    );
  }
});

test('the script routes every AWS call through the read-only guard', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const direct = source
    .split('\n')
    .filter((line) => line.includes('"$AWS_BIN"') && !line.trim().startsWith('#'));
  // Exactly one: the invocation inside aws_ro itself.
  assert.equal(direct.length, 1, `AWS_BIN is invoked outside aws_ro:\n${direct.join('\n')}`);
});

test('a mutating operation is refused before it runs', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const probe = `${source}\naws_ro elbv2 create-rule --listener-arn x\n`;
  const dir = mkdtempSync(path.join(tmpdir(), 'eng-ro-'));
  const probePath = path.join(dir, 'probe.sh');
  writeFileSync(probePath, probe);

  const box = sandbox(baseResponses());
  let status = 0;
  let stderr = '';
  try {
    execFileSync('bash', [probePath], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        AWS_BIN: box.shim,
        AWS_REGION: REGION,
        CAPIRO_ENV: 'dev',
        EXPECTED_AWS_ACCOUNT_ID: ACCOUNT,
        EXPECTED_VPC_ID: VPC,
        EXPECTED_ECS_CLUSTER_ARN: CLUSTER,
        EXPECTED_HTTPS_LISTENER_ARN: LISTENER,
        EXPECTED_MAIN_API_TARGET_GROUP_ARN: MAIN_TG,
        EXPECTED_GENERIC_API_RULE_PRIORITY: GENERIC_PRIORITY,
        ENGAGEMENT_DISCOVERY_OUT_DIR: box.outDir,
      },
    });
  } catch (error) {
    status = error.status ?? 1;
    stderr = error.stderr?.toString() ?? '';
  }
  assert.notEqual(status, 0);
  assert.match(stderr, /refusing non read-only AWS call: elbv2 create-rule/);
  const calls = readFileSync(path.join(box.dir, 'calls.log'), 'utf8');
  assert.doesNotMatch(calls, /create-rule/, 'the mutating call reached the aws binary');
});

// ─────────────────────────────────────────────────────────── stop conditions

test('usage error when a required variable is missing', () => {
  const result = run(baseResponses(), { EXPECTED_VPC_ID: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EXPECTED_VPC_ID is required/);
});

test('NC-2.3-A wrong account stops discovery', () => {
  const responses = baseResponses();
  responses['sts get-caller-identity'] = { Account: '111111111111', Arn: 'arn:aws:iam::111111111111:user/x' };
  const result = run(responses);
  assert.equal(result.status, 2);
  assert.match(result.report.stopConditions.join('\n'), /does not match expected/);
});

test('NC-2.3-B occupied preview priority stops discovery', () => {
  const responses = baseResponses();
  responses['elbv2 describe-rules'].Rules.push({
    RuleArn: 'r6',
    Priority: '6',
    Conditions: [{ Field: 'path-pattern', Values: ['/something/*'] }],
    Actions: [{ TargetGroupArn: 'tg-other' }],
  });
  const result = run(responses);
  assert.equal(result.status, 2);
  assert.match(result.report.stopConditions.join('\n'), /preview priority 6 is already occupied/);
});

test('NC-2.3-C multiple possible live listeners stops discovery', () => {
  const responses = baseResponses();
  responses['elbv2 describe-listeners'] = {
    Listeners: [{ ListenerArn: LISTENER }, { ListenerArn: `${LISTENER}-second` }],
  };
  const result = run(responses);
  assert.equal(result.status, 2);
  assert.match(result.report.stopConditions.join('\n'), /exactly one HTTPS listener, found 2/);
});

test('an existing /api/engagement rule stops discovery', () => {
  const responses = baseResponses();
  responses['elbv2 describe-rules'].Rules.push({
    RuleArn: 'r7',
    Priority: '7',
    Conditions: [{ Field: 'path-pattern', Values: ['/api/engagement/*'] }],
    Actions: [{ TargetGroupArn: 'tg-other' }],
  });
  const result = run(responses);
  assert.equal(result.status, 2);
  assert.match(result.report.stopConditions.join('\n'), /already exists/);
});

test('generic rule drift stops discovery', () => {
  const responses = baseResponses();
  responses['elbv2 describe-rules'].Rules[1].Actions = [{ TargetGroupArn: 'tg-somewhere-else' }];
  const result = run(responses);
  assert.equal(result.status, 2);
  assert.match(
    result.report.stopConditions.join('\n'),
    /does not forward solely to the expected main API target group/,
  );
});

test('a missing generic rule stops discovery', () => {
  const responses = baseResponses();
  responses['elbv2 describe-rules'].Rules = responses['elbv2 describe-rules'].Rules.filter(
    (rule) => rule.Priority !== GENERIC_PRIORITY,
  );
  const result = run(responses);
  assert.equal(result.status, 2);
  assert.match(result.report.stopConditions.join('\n'), /was not found/);
});

test('an unknown engagement-api resource stops discovery rather than being adopted', () => {
  const responses = baseResponses();
  responses['ecr describe-repositories'].repositories.push({
    repositoryName: 'capiro/dev/engagement-api',
  });
  const result = run(responses);
  assert.equal(result.status, 2);
  assert.match(result.report.stopConditions.join('\n'), /ecrRepositories/);
});

test('an inactive ECS cluster stops discovery', () => {
  const responses = baseResponses();
  responses['ecs describe-clusters'] = { clusters: [{ status: 'INACTIVE' }] };
  const result = run(responses);
  assert.equal(result.status, 2);
  assert.match(result.report.stopConditions.join('\n'), /cluster is INACTIVE/);
});

test('too few availability zones stops discovery', () => {
  const responses = baseResponses();
  responses['ec2 describe-subnets'].Subnets = [
    { SubnetId: 'subnet-0a', AvailabilityZone: 'us-east-1a', MapPublicIpOnLaunch: false },
  ];
  const result = run(responses);
  assert.equal(result.status, 2);
  assert.match(result.report.stopConditions.join('\n'), /two private subnets across two AZs/);
});

test('evidence is written even when a stop condition fires', () => {
  const responses = baseResponses();
  responses['ecs describe-clusters'] = { clusters: [{ status: 'INACTIVE' }] };
  const result = run(responses);
  assert.ok(result.report, 'no discovery.json was written on the failure path');
  assert.ok(existsSync(path.join(result.outDir, 'discovery.sha256')));
  assert.match(result.stderr, /NOT_APPROVED/);
});
