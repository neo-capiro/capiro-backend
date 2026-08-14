#!/usr/bin/env node
/**
 * Tests for the fail-closed engagement-api ALB preview rule manager.
 *
 * A fake, STATEFUL `aws` binary backs every test: create-rule and delete-rule
 * actually mutate an in-memory rule list, so "idempotent", "second create
 * refuses", and "delete only the exact rule" are proven against real state
 * transitions rather than static fixtures.
 *
 * Run: node scripts/engagement-api-alb-rules.spec.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'engagement-api-alb-rules.sh');
const FIXTURES = path.join(ROOT, 'scripts', 'fixtures', 'engagement-api-alb');

const ACCOUNT = '967807252336';
const REGION = 'us-east-1';
const LISTENER_ARN = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/capiro-prod-alb/aaa/bbb`;
const ENGAGEMENT_TG = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/capiro-dev-engagement-api/444`;
const MAIN_TG = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/capiro-prod-api/111`;
const GENERIC_PRIORITY = '10';

const baselineRules = () => JSON.parse(readFileSync(path.join(FIXTURES, 'baseline-clean.json'), 'utf8')).Rules;
const targetGroupFixture = () => JSON.parse(readFileSync(path.join(FIXTURES, 'target-group.json'), 'utf8'));

/** A stateful fake `aws` covering sts, describe-rules/target-groups, create-rule, delete-rule. */
function sandbox({ rules = baselineRules(), targetGroups = targetGroupFixture(), account = ACCOUNT } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'eng-alb-'));
  mkdirSync(path.join(dir, 'out'), { recursive: true });
  writeFileSync(path.join(dir, 'calls.log'), '');
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ rules, targetGroups, account, nextId: 100 }));

  const posix = (p) => p.replace(/\\/g, '/');
  const fakeAws = path.join(dir, 'fake-aws.mjs');
  writeFileSync(
    fakeAws,
    `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const dir = ${JSON.stringify(posix(dir))};
const args = process.argv.slice(2);
appendFileSync(dir + '/calls.log', args.join(' ') + '\\n');
const stateFile = dir + '/state.json';
const state = JSON.parse(readFileSync(stateFile, 'utf8'));

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function multiFlag(name) {
  const i = args.indexOf(name);
  if (i < 0) return [];
  const out = [];
  for (let k = i + 1; k < args.length && !args[k].startsWith('--'); k += 1) out.push(args[k]);
  return out;
}

const [service, operation] = args;

if (service === 'sts' && operation === 'get-caller-identity') {
  process.stdout.write(state.account);
  process.exit(0);
}

if (service === 'elbv2' && operation === 'describe-rules') {
  process.stdout.write(JSON.stringify({ Rules: state.rules }));
  process.exit(0);
}

if (service === 'elbv2' && operation === 'describe-target-groups') {
  const wanted = multiFlag('--target-group-arns');
  const found = state.targetGroups.TargetGroups.filter((g) => wanted.includes(g.TargetGroupArn));
  process.stdout.write(JSON.stringify({ TargetGroups: found }));
  process.exit(0);
}

if (service === 'elbv2' && operation === 'create-rule') {
  const priority = flag('--priority');
  const conditions = JSON.parse(flag('--conditions'));
  const actions = JSON.parse(flag('--actions'));
  const id = 'r' + state.nextId;
  state.nextId += 1;
  const rule = {
    RuleArn: 'arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener-rule/app/capiro-prod-alb/aaa/bbb/' + id,
    Priority: priority,
    Conditions: conditions,
    Actions: actions,
  };
  state.rules.push(rule);
  writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ Rules: [rule] }));
  process.exit(0);
}

if (service === 'elbv2' && operation === 'delete-rule') {
  const ruleArn = flag('--rule-arn');
  const before = state.rules.length;
  state.rules = state.rules.filter((r) => r.RuleArn !== ruleArn);
  if (state.rules.length === before) { process.stderr.write('rule not found'); process.exit(254); }
  writeFileSync(stateFile, JSON.stringify(state));
  process.exit(0);
}

if (service === 'elbv2' && operation === 'modify-rule') {
  process.stderr.write('modify-rule should never be called');
  process.exit(1);
}

process.stderr.write('no fixture for ' + service + ' ' + operation);
process.exit(254);
`,
  );

  const shim = path.join(dir, 'aws');
  writeFileSync(shim, `#!/usr/bin/env bash\nexec node ${JSON.stringify(fakeAws)} "$@"\n`, { mode: 0o755 });

  return { dir, shim, outDir: path.join(dir, 'out'), stateFile: path.join(dir, 'state.json') };
}

function run(command, box, env = {}) {
  let status = 0;
  let out = '';
  try {
    out = execFileSync('bash', [SCRIPT, command], {
      cwd: ROOT,
      encoding: 'utf8',
      // Windows nested bash+fake-aws can hang after long parent runs; bound each call.
      timeout: 120_000,
      env: {
        ...process.env,
        AWS_BIN: box.shim,
        AWS_REGION: REGION,
        EXPECTED_AWS_ACCOUNT_ID: ACCOUNT,
        HTTPS_LISTENER_ARN: LISTENER_ARN,
        ENGAGEMENT_TARGET_GROUP_ARN: ENGAGEMENT_TG,
        MAIN_API_TARGET_GROUP_ARN: MAIN_TG,
        GENERIC_API_RULE_PRIORITY: GENERIC_PRIORITY,
        ENGAGEMENT_ALB_OUT_DIR: box.outDir,
        ...env,
      },
    });
  } catch (error) {
    status = error.status ?? (error.code === 'ETIMEDOUT' ? 124 : 1);
    out = `${error.stdout ?? ''}${error.stderr ?? ''}${error.code === 'ETIMEDOUT' ? '\nETIMEDOUT\n' : ''}`;
  }
  const calls = readFileSync(path.join(box.dir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
  const state = JSON.parse(readFileSync(box.stateFile, 'utf8'));
  return { status, out, calls, state, outDir: box.outDir };
}

const CREATE_TOKEN = `${ACCOUNT}:${REGION}:6`;

// ─────────────────────────────────────────────────────────────────── list

test('list is read-only and describes every rule', () => {
  const box = sandbox();
  const result = run('list', box);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /priority=9/);
  assert.match(result.out, /priority=10/);
  for (const call of result.calls) {
    if (call.startsWith('aws ')) continue;
    assert.match(call, /^(sts get-caller-identity|elbv2 describe-)/);
  }
});

test('list makes no mutating call', () => {
  const box = sandbox();
  run('list', box);
  assert.ok(!box_calls(box).some((c) => /create-rule|delete-rule|modify-rule/.test(c)));
});

function box_calls(box) {
  return readFileSync(path.join(box.dir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
}

// ───────────────────────────────────────────────────────── verify-baseline

test('verify-baseline passes on a clean environment', () => {
  const result = run('verify-baseline', sandbox());
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /ENGAGEMENT_ALB_BASELINE_CLEAN/);
});

test('NC required: occupied priority refusal', () => {
  const rules = baselineRules();
  rules.push({
    RuleArn: 'arn:x/occupied',
    Priority: '6',
    Conditions: [{ Field: 'path-pattern', Values: ['/something/*'] }],
    Actions: [{ Type: 'forward', TargetGroupArn: 'arn:x/other' }],
  });
  const result = run('verify-baseline', sandbox({ rules }));
  assert.equal(result.status, 2);
  assert.match(result.out, /priority 6 is unoccupied/);
});

test('NC required: wrong account refusal', () => {
  const result = run('verify-baseline', sandbox({ account: '111111111111' }));
  assert.equal(result.status, 2);
  assert.match(result.out, /does not match expected/);
});

test('NC required: wrong region refusal', () => {
  const box = sandbox();
  const result = run('verify-baseline', box, { AWS_REGION: 'eu-west-1' });
  assert.equal(result.status, 2);
  assert.match(result.out, /does not match the region embedded in/);
});

test('NC required: wrong target group refusal', () => {
  const targetGroups = { TargetGroups: [{ TargetGroupArn: ENGAGEMENT_TG, TargetGroupName: 'capiro-dev-onboard', Port: 8080 }] };
  const result = run('verify-baseline', sandbox({ targetGroups }));
  assert.equal(result.status, 2);
  assert.match(result.out, /target group belongs to engagement-api/);
});

test('NC required: generic API rule drift refusal', () => {
  const rules = baselineRules();
  const generic = rules.find((r) => r.Priority === '10');
  generic.Actions = [{ Type: 'forward', TargetGroupArn: 'arn:x/drifted' }];
  const result = run('verify-baseline', sandbox({ rules }));
  assert.equal(result.status, 2);
  assert.match(result.out, /generic API rule forwards only to the main API target group/);
});

test('NC required: canonical (path-only) Engagement rule refusal', () => {
  const rules = baselineRules();
  rules.push({
    RuleArn: 'arn:x/canonical-engagement',
    Priority: '7',
    Conditions: [{ Field: 'path-pattern', Values: ['/api/engagement/*'] }],
    Actions: [{ Type: 'forward', TargetGroupArn: MAIN_TG }],
  });
  const result = run('verify-baseline', sandbox({ rules }));
  assert.equal(result.status, 2);
  assert.match(result.out, /no existing rule matches \/api\/engagement\/\*/);
});

test('NC required (5.11): a Recall rule pointed at engagement-api refuses', () => {
  const rules = baselineRules();
  rules.push({
    RuleArn: 'arn:x/recall-hijack',
    Priority: '16',
    Conditions: [{ Field: 'path-pattern', Values: ['/webhooks/recall'] }],
    Actions: [{ Type: 'forward', TargetGroupArn: ENGAGEMENT_TG }],
  });
  const result = run('verify-baseline', sandbox({ rules }));
  assert.equal(result.status, 2);
  assert.match(result.out, /no rule routes \/webhooks\/recall to engagement-api/);
});

// ────────────────────────────────────────────────────────── create-preview

test('create-preview refuses without the confirmation token', () => {
  const box = sandbox();
  const result = run('create-preview', box);
  assert.equal(result.status, 1);
  assert.match(result.out, /CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE/);
  assert.ok(!box_calls(box).some((c) => c.includes('create-rule')));
});

test('create-preview refuses a wrong confirmation token', () => {
  const box = sandbox();
  const result = run('create-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE: 'yes-please' });
  assert.equal(result.status, 1);
  assert.ok(!box_calls(box).some((c) => c.includes('create-rule')));
});

test('NC required: exact create payload — path AND header, single target group, no rewrite, no weighting', () => {
  const box = sandbox();
  const result = run('create-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE: CREATE_TOKEN });
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /ENGAGEMENT_PREVIEW_RULE_CREATED/);

  const created = result.state.rules.find((r) => r.Priority === '6');
  assert.ok(created);
  assert.deepEqual(created.Conditions, [
    { Field: 'path-pattern', PathPatternConfig: { Values: ['/api/engagement/*'] } },
    { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'X-Capiro-Engagement-Preview', Values: ['v3'] } },
  ]);
  assert.deepEqual(created.Actions, [{ Type: 'forward', TargetGroupArn: ENGAGEMENT_TG }]);

  const outFile = path.join(box.outDir, 'preview-rule-created.json');
  assert.ok(readFileSync(outFile, 'utf8').length > 0, 'no evidence file written');
});

test('NC required: second create refuses rather than duplicating', () => {
  const box = sandbox();
  run('create-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE: CREATE_TOKEN });
  const before = run('list', box).state.rules.length;

  const second = run('create-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE: CREATE_TOKEN });
  assert.equal(second.status, 2);
  assert.match(second.out, /already occupied/);
  assert.equal(second.state.rules.length, before, 'a duplicate rule was created');
});

test('create-preview refuses when ENGAGEMENT_TARGET_GROUP_ARN is not engagement-api/4500', () => {
  const targetGroups = { TargetGroups: [{ TargetGroupArn: ENGAGEMENT_TG, TargetGroupName: 'capiro-dev-onboard', Port: 8080 }] };
  const box = sandbox({ targetGroups });
  const result = run('create-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE: CREATE_TOKEN });
  assert.equal(result.status, 2);
  assert.match(result.out, /does not resolve to an engagement-api target group/);
  assert.ok(!box_calls(box).some((c) => c.includes('create-rule')));
});

test('create-preview refuses on generic-rule drift, even with a valid token', () => {
  const rules = baselineRules();
  rules.find((r) => r.Priority === '10').Actions = [{ Type: 'forward', TargetGroupArn: 'arn:x/drifted' }];
  const box = sandbox({ rules });
  const result = run('create-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE: CREATE_TOKEN });
  assert.equal(result.status, 2);
  assert.ok(!box_calls(box).some((c) => c.includes('create-rule')));
});

// ────────────────────────────────────────────────────────── verify-preview

test('verify-preview passes only after the exact rule exists', () => {
  const box = sandbox();
  const before = run('verify-preview', box);
  assert.equal(before.status, 2, 'verify-preview should not pass before creation');

  run('create-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE: CREATE_TOKEN });
  const after = run('verify-preview', box);
  assert.equal(after.status, 0, after.out);
  assert.match(after.out, /ENGAGEMENT_PREVIEW_RULE_VERIFIED/);
});

test('NC required: header omitted is not the exact match', () => {
  const rules = baselineRules();
  rules.push({
    RuleArn: 'arn:x/no-header',
    Priority: '6',
    Conditions: [{ Field: 'path-pattern', Values: ['/api/engagement/*'] }],
    Actions: [{ Type: 'forward', TargetGroupArn: ENGAGEMENT_TG }],
  });
  const result = run('verify-preview', sandbox({ rules }));
  assert.equal(result.status, 2);
  assert.match(result.out, /not the exact expected shape/);
});

test('NC required: header VALUE case change is not the exact match', () => {
  const rules = baselineRules();
  rules.push({
    RuleArn: 'arn:x/wrong-case',
    Priority: '6',
    Conditions: [
      { Field: 'path-pattern', Values: ['/api/engagement/*'] },
      { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'X-Capiro-Engagement-Preview', Values: ['V3'] } },
    ],
    Actions: [{ Type: 'forward', TargetGroupArn: ENGAGEMENT_TG }],
  });
  const result = run('verify-preview', sandbox({ rules }));
  assert.equal(result.status, 2);
  assert.match(result.out, /not the exact expected shape/);
});

test('a rewritten or weighted rule is not the exact match', () => {
  const rewritten = baselineRules();
  rewritten.push({
    RuleArn: 'arn:x/rewrite',
    Priority: '6',
    Conditions: [
      { Field: 'path-pattern', Values: ['/api/engagement/*'] },
      { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'X-Capiro-Engagement-Preview', Values: ['v3'] } },
    ],
    Actions: [{ Type: 'redirect', TargetGroupArn: ENGAGEMENT_TG }],
  });
  assert.equal(run('verify-preview', sandbox({ rules: rewritten })).status, 2);

  const weighted = baselineRules();
  weighted.push({
    RuleArn: 'arn:x/weighted',
    Priority: '6',
    Conditions: [
      { Field: 'path-pattern', Values: ['/api/engagement/*'] },
      { Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: 'X-Capiro-Engagement-Preview', Values: ['v3'] } },
    ],
    Actions: [
      {
        Type: 'forward',
        ForwardConfig: {
          TargetGroups: [{ TargetGroupArn: ENGAGEMENT_TG }, { TargetGroupArn: MAIN_TG }],
        },
      },
    ],
  });
  assert.equal(run('verify-preview', sandbox({ rules: weighted })).status, 2);
});

test('verify-preview and list are idempotent — repeated calls agree', () => {
  const box = sandbox();
  run('create-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE: CREATE_TOKEN });
  const first = run('verify-preview', box);
  const second = run('verify-preview', box);
  assert.equal(first.status, second.status);
  assert.equal(first.state.rules.length, second.state.rules.length);
});

// ────────────────────────────────────────────────────────── delete-preview

test('delete-preview refuses without the confirmation token', () => {
  const box = sandbox();
  run('create-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE: CREATE_TOKEN });
  const before = run('list', box).state.rules.length;

  const result = run('delete-preview', box);
  assert.equal(result.status, 1);
  assert.equal(run('list', box).state.rules.length, before, 'a rule disappeared without confirmation');
});

test('NC required: exact delete behavior — deletes only the confirmed ARN', () => {
  const box = sandbox();
  run('create-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE: CREATE_TOKEN });
  const created = run('list', box).state.rules.find((r) => r.Priority === '6');

  const result = run('delete-preview', box, {
    CONFIRM_ENGAGEMENT_PREVIEW_RULE_DELETE: created.RuleArn,
  });
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /ENGAGEMENT_PREVIEW_RULE_DELETED/);
  assert.ok(!result.state.rules.some((r) => r.RuleArn === created.RuleArn));
  // Every other rule survives untouched.
  assert.equal(result.state.rules.length, baselineRules().length);
});

test('NC required: no delete of an unknown/unconfirmed rule', () => {
  const box = sandbox();
  run('create-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE: CREATE_TOKEN });
  const before = run('list', box).state.rules.length;

  const result = run('delete-preview', box, {
    CONFIRM_ENGAGEMENT_PREVIEW_RULE_DELETE: 'arn:aws:elasticloadbalancing:us-east-1:967807252336:listener-rule/app/capiro-prod-alb/aaa/bbb/made-up',
  });
  assert.equal(result.status, 2);
  assert.match(result.out, /does not equal the exact expected rule/);
  assert.equal(run('list', box).state.rules.length, before, 'an unconfirmed rule was deleted');
  assert.ok(!box_calls(box).some((c) => c.includes('delete-rule')), 'delete-rule was called despite the mismatch');
});

test('NC required: a drifted existing rule refuses deletion', () => {
  const box = sandbox();
  run('create-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE: CREATE_TOKEN });
  const created = run('list', box).state.rules.find((r) => r.Priority === '6');

  // Drift the rule in place (e.g. someone hand-edited it in the console) —
  // same ARN, different shape. Deletion by that exact ARN must still refuse.
  const state = JSON.parse(readFileSync(box.stateFile, 'utf8'));
  const rule = state.rules.find((r) => r.RuleArn === created.RuleArn);
  rule.Actions = [{ Type: 'forward', TargetGroupArn: MAIN_TG }]; // now forwards to main API
  writeFileSync(box.stateFile, JSON.stringify(state));

  const result = run('delete-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_DELETE: created.RuleArn });
  assert.equal(result.status, 2);
  assert.match(result.out, /may have drifted — refusing to delete/);
  assert.ok(run('list', box).state.rules.some((r) => r.RuleArn === created.RuleArn), 'the drifted rule was deleted anyway');
});

test('a healthy generic rule survives delete-preview', () => {
  const box = sandbox();
  run('create-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE: CREATE_TOKEN });
  const created = run('list', box).state.rules.find((r) => r.Priority === '6');
  const result = run('delete-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_DELETE: created.RuleArn });
  assert.equal(result.status, 0);
  const generic = result.state.rules.find((r) => r.Priority === GENERIC_PRIORITY);
  assert.ok(generic);
  assert.equal(generic.Actions[0].TargetGroupArn, MAIN_TG);
});

// ─────────────────────────────────────────────────────── modify-rule never

test('NC required: no command ever issues a modify-rule call', () => {
  const box = sandbox();
  run('list', box);
  run('verify-baseline', box);
  run('create-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE: CREATE_TOKEN });
  run('verify-preview', box);
  const created = run('list', box).state.rules.find((r) => r.Priority === '6');
  run('delete-preview', box, { CONFIRM_ENGAGEMENT_PREVIEW_RULE_DELETE: created.RuleArn });

  assert.ok(!box_calls(box).some((c) => c.includes('modify-rule')));
});

// ───────────────────────────────────────────────────── UI-aware requirement

test('the header is documented as routing metadata, never authorization, in the script header', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.match(source, /header is routing metadata, not authorization/i);
});
