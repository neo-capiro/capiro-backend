#!/usr/bin/env node
/** Source-only checks for the manual onboarding listener rule script. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'onboard-alb-rules.sh');
const snapshot = JSON.parse(readFileSync(path.join(path.dirname(script), '..', 'infra', 'routing', 'capiro-prod-alb-snapshot.json'), 'utf8'));
const account = '967807252336';
const region = 'us-east-1';
const listenerArn = snapshot.listenerArn;
const targetArn = snapshot.targetGroupArns['onboard-api'];

function bashPath(value) {
  return process.platform === 'win32'
    ? value.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`).replace(/\\/g, '/')
    : value;
}

function rule(priority, field, value, id, target = targetArn) {
  return {
    RuleArn: `${listenerArn.replace(':listener/', ':listener-rule/')}/${snapshot.ruleArnSuffixes[id]}`,
    Priority: String(priority),
    Conditions: [{ Field: field, Values: [value] }],
    Actions: [{ Type: 'forward', TargetGroupArn: target }],
  };
}

const host = (priority) => rule(priority, 'host-header', 'onboarding.capiro.ai', 'onboard-host');
const apiPath = (priority) => rule(priority, 'path-pattern', '/onboard-api/*', 'onboard-path');

function fixture(t, rules) {
  const dir = mkdtempSync(path.join(tmpdir(), 'onboard-alb-'));
  if (path.dirname(dir) !== tmpdir()) throw new Error('unexpected test fixture directory');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  const callsFile = path.join(dir, 'calls.log');
  writeFileSync(stateFile, JSON.stringify({ Rules: rules }));
  writeFileSync(callsFile, '');

  const fakeAws = path.join(dir, 'fake-aws.mjs');
  writeFileSync(fakeAws, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const stateFile = ${JSON.stringify(stateFile.replace(/\\/g, '/'))};
const callsFile = ${JSON.stringify(callsFile.replace(/\\/g, '/'))};
const args = process.argv.slice(2);
appendFileSync(callsFile, args.join(' ') + '\\n');
const [service, operation] = args;
if (service !== 'elbv2') process.exit(90);
if (operation === 'describe-load-balancers') {
  process.stdout.write('arn:aws:elasticloadbalancing:${region}:${account}:loadbalancer/app/capiro-prod-alb/alb');
  process.exit(0);
}
if (operation === 'describe-listeners') {
  process.stdout.write(${JSON.stringify(listenerArn)});
  process.exit(0);
}
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
if (operation === 'describe-rules') {
  process.stdout.write(JSON.stringify(state));
  process.exit(0);
}
if (operation === 'delete-rule') {
  const arn = args[args.indexOf('--rule-arn') + 1];
  const remaining = state.Rules.filter((item) => item.RuleArn !== arn);
  if (remaining.length === state.Rules.length) process.exit(91);
  writeFileSync(stateFile, JSON.stringify({ Rules: remaining }));
  process.exit(0);
}
process.exit(92);
`);
  const bashEnv = path.join(dir, 'bash-env.sh');
  // The script sets MSYS_NO_PATHCONV=1. Pass Node a native Windows path, not
  // /c/...: with that flag Node would resolve /c as C:\\c.
  writeFileSync(bashEnv, `aws() { node "${fakeAws.replace(/\\/g, '/')}" "$@"; }\n`);

  function run(args, overrides = {}) {
    let status = 0;
    let output = '';
    try {
      output = execFileSync('bash', [bashPath(script), ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          BASH_ENV: bashPath(bashEnv),
          ALB_NAME: 'capiro-prod-alb',
          REGION: region,
          HOST: 'onboarding.capiro.ai',
          PATH_PATTERN: '/onboard-api/*',
          HOST_PRIORITY: '9',
          PATH_PRIORITY: '16',
          ...overrides,
        },
      });
    } catch (error) {
      status = error.status ?? (error.code === 'ETIMEDOUT' ? 124 : 1);
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    return {
      status,
      output,
      calls: readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean),
      rules: JSON.parse(readFileSync(stateFile, 'utf8')).Rules,
    };
  }

  return { run };
}

test('delete refuses the old live 8/9 layout without deleting either rule', (t) => {
  const box = fixture(t, [host(8), apiPath(9)]);
  const result = box.run(['--delete']);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /priority 9 is not the exact onboard rule/);
  assert.equal(result.calls.filter((call) => call.startsWith('elbv2 delete-rule')).length, 0);
  assert.deepEqual(result.rules, [host(8), apiPath(9)]);
});

test('delete refuses a partial or mismatched 9/16 pair before deleting either rule', (t) => {
  const otherTarget = targetArn.replace('capiro-dev-onboardapi', 'capiro-other-onboard');
  const box = fixture(t, [host(9), rule(16, 'path-pattern', '/onboard-api/*', 'onboard-path', otherTarget)]);
  const result = box.run(['--delete']);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /priority 16 is not the exact onboard rule/);
  assert.equal(result.calls.filter((call) => call.startsWith('elbv2 delete-rule')).length, 0);
  assert.equal(result.rules.length, 2);
});

test('delete refuses a replacement physical rule even when its target and shape match', (t) => {
  const replacement = { ...host(9), RuleArn: `${host(9).RuleArn}-replacement` };
  const box = fixture(t, [replacement, apiPath(16)]);
  const result = box.run(['--delete']);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /priority 9 is not the exact onboard rule/);
  assert.equal(result.calls.filter((call) => call.startsWith('elbv2 delete-rule')).length, 0);
  assert.deepEqual(result.rules, [replacement, apiPath(16)]);
});

test('delete accepts only the exact 9/16 physical pair', (t) => {
  const box = fixture(t, [host(9), apiPath(16)]);
  const result = box.run(['--delete']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /deleted exact onboard rules at priorities 9 and 16/);
  assert.deepEqual(result.rules, []);
  assert.deepEqual(
    result.calls.filter((call) => call.startsWith('elbv2 delete-rule')).map((call) => call.split(' --region')[0]),
    [host(9), apiPath(16)].map((item) => `elbv2 delete-rule --rule-arn ${item.RuleArn}`),
  );
});

test('create and delete refuse priority overrides before any AWS call', (t) => {
  const box = fixture(t, [host(9), apiPath(16)]);
  for (const [args, overrides] of [
    [['--delete'], { HOST_PRIORITY: '8' }],
    [['--delete'], { PATH_PRIORITY: '9' }],
    [['--create', targetArn], { HOST_PRIORITY: '8' }],
    [['--create', targetArn], { PATH_PRIORITY: '9' }],
  ]) {
    const result = box.run(args, overrides);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /refusing priority override/);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.rules, [host(9), apiPath(16)]);
  }
});
