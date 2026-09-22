import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const activation = readFileSync(
  join(__dirname, '../../../../scripts/activate-legiwatch-phase9.sh'),
  'utf8',
);
const ingestionSchedule = readFileSync(
  join(__dirname, '../../../../infra/cdk/lib/ingestion-schedule.ts'),
  'utf8',
);
const phase9Jobs = readFileSync(
  join(__dirname, '../live-hearings/phase9/legiwatch-phase9-jobs.service.ts'),
  'utf8',
);
const runtimeMigration = readFileSync(
  join(
    __dirname,
    '../../prisma/migrations/20280920070000_legiwatch_florida_runtime_jobs/migration.sql',
  ),
  'utf8',
);

const CALENDAR_RULE = 'capiro-dev-legiwatch-florida-calendar';
const EVENT_ROLE_ARN = 'arn:aws:iam::123456789012:role/capiro-dev-legiwatch-phase9-events';

type MockState = {
  rules: Record<string, { rule: Record<string, unknown>; targets: Array<Record<string, unknown>> }>;
  calls: string[][];
  failEnable?: string;
  failed?: boolean;
  failPutTargets?: string;
  failedPutTargets?: boolean;
  denyDescribe?: string;
};

function runEnableShadow(
  options: {
    failEnable?: string;
    failPutTargets?: string;
    denyDescribe?: string;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'legiwatch-phase9-aws-'));
  const statePath = join(dir, 'state.json');
  const awsPath = join(dir, 'aws');
  const originalRule = {
    Name: CALENDAR_RULE,
    Arn: `arn:aws:events:us-east-1:123456789012:rule/${CALENDAR_RULE}`,
    ScheduleExpression: 'rate(15 minutes)',
    State: 'ENABLED',
    Description: 'legacy Florida calendar',
    EventBusName: 'default',
  };
  const originalTargets = [
    { Id: 'legacy-primary', Arn: 'arn:aws:ecs:us-east-1:123456789012:cluster/legacy' },
    { Id: 'legacy-audit', Arn: 'arn:aws:sqs:us-east-1:123456789012:legacy-audit' },
  ];
  const state: MockState = {
    rules: { [CALENDAR_RULE]: { rule: originalRule, targets: originalTargets } },
    calls: [],
    ...options,
  };
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(
    awsPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.MOCK_AWS_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const argv = process.argv.slice(2);
const services = new Set(['ecs', 'iam', 'events']);
const serviceIndex = argv.findIndex((part) => services.has(part));
const service = argv[serviceIndex];
const action = argv[serviceIndex + 1];
const arg = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const out = (value) => { if (value !== undefined) process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); };
state.calls.push(argv); save();
if (service === 'ecs') {
  const query = arg('--query') || '';
  if (action === 'describe-clusters') out('arn:aws:ecs:us-east-1:123456789012:cluster/capiro-dev');
  else if (action === 'describe-services' && query.includes('taskDefinition')) {
    out(arg('--services').includes('intel') ? 'arn:aws:ecs:us-east-1:123456789012:task-definition/intel-source:1' : 'arn:aws:ecs:us-east-1:123456789012:task-definition/api-source:1');
  } else if (action === 'describe-services') out({ subnets: ['subnet-a'], securityGroups: ['sg-a'], assignPublicIp: 'DISABLED' });
  else if (action === 'describe-task-definition' && query.includes('containerDefinitions')) out(arg('--task-definition').includes('intel') ? 'intel' : 'api');
  else if (action === 'describe-task-definition') out('arn:aws:ecs:us-east-1:123456789012:task-definition/' + arg('--task-definition') + ':7');
  else if (action === 'run-task') out('arn:aws:ecs:us-east-1:123456789012:task/runtime-registration');
  else if (action === 'describe-tasks') out('0');
  process.exit(0);
}
if (service === 'iam' && action === 'get-role') { out('${EVENT_ROLE_ARN}'); process.exit(0); }
if (service !== 'events') process.exit(0);
const name = arg('--name') || arg('--rule');
const row = () => state.rules[name];
if (action === 'describe-rule') {
  if (state.denyDescribe === name) { process.stderr.write('AccessDeniedException: denied\\n'); process.exit(254); }
  if (!row()) { process.stderr.write('ResourceNotFoundException: rule not found\\n'); process.exit(254); }
  out(row().rule); process.exit(0);
}
if (action === 'list-targets-by-rule') {
  const targets = row()?.targets || [];
  out(arg('--output') === 'text' ? (targets.map((target) => target.Id).join('\\t') || 'None') : { Targets: targets });
  process.exit(0);
}
if (action === 'disable-rule' || action === 'enable-rule') {
  if (action === 'enable-rule' && state.failEnable === name && !state.failed) {
    state.failed = true; save(); process.stderr.write('simulated enable failure\\n'); process.exit(42);
  }
  state.rules[name] ||= { rule: { Name: name }, targets: [] };
  state.rules[name].rule.State = action === 'enable-rule' ? 'ENABLED' : 'DISABLED'; save(); process.exit(0);
}
if (action === 'put-rule') {
  let rule;
  const cli = arg('--cli-input-json');
  if (cli) rule = JSON.parse(fs.readFileSync(cli.replace(/^file:\\/\\//, ''), 'utf8'));
  else rule = { Name: name, ScheduleExpression: arg('--schedule-expression'), State: arg('--state'), Description: arg('--description') };
  state.rules[rule.Name] ||= { rule: {}, targets: [] };
  state.rules[rule.Name].rule = rule; save(); out({ RuleArn: 'mock' }); process.exit(0);
}
if (action === 'remove-targets') {
  const start = argv.indexOf('--ids') + 1; const ids = [];
  for (let i = start; i < argv.length && !argv[i].startsWith('--'); i++) ids.push(argv[i]);
  state.rules[name].targets = state.rules[name].targets.filter((target) => !ids.includes(target.Id)); save();
  out({ FailedEntryCount: 0, FailedEntries: [] }); process.exit(0);
}
if (action === 'put-targets') {
  if (state.failPutTargets === name && !state.failedPutTargets) {
    state.failedPutTargets = true; save();
    out({ FailedEntryCount: 1, FailedEntries: [{ ErrorCode: 'InternalException' }] }); process.exit(0);
  }
  const targets = JSON.parse(arg('--targets'));
  state.rules[name] ||= { rule: { Name: name }, targets: [] };
  for (const target of targets) {
    state.rules[name].targets = state.rules[name].targets.filter((existing) => existing.Id !== target.Id);
    state.rules[name].targets.push(target);
  }
  save(); out({ FailedEntryCount: 0, FailedEntries: [] }); process.exit(0);
}
if (action === 'delete-rule') { delete state.rules[name]; save(); process.exit(0); }
process.exit(0);
`,
  );
  chmodSync(awsPath, 0o755);
  const result = spawnSync(
    'bash',
    [join(__dirname, '../../../../scripts/activate-legiwatch-phase9.sh'), 'enable-shadow'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        MOCK_AWS_STATE: statePath,
        CONFIRM: 'ENABLE_LEGIWATCH_PHASE9_SHADOW',
        CAPIRO_ENV: 'dev',
        CAPIRO_API_SERVICE: 'capiro-dev-api',
        CAPIRO_INTEL_SERVICE: 'capiro-dev-intel-api',
      },
    },
  );
  const finalState = JSON.parse(readFileSync(statePath, 'utf8')) as MockState;
  rmSync(dir, { recursive: true, force: true });
  return { result, finalState, originalRule, originalTargets };
}

describe('Florida Phase 9 schedule ownership', () => {
  it('executes adoption with a reconstructed role and exactly one replacement target', () => {
    const { result, finalState } = runEnableShadow();
    expect(result.status).toBe(0);
    const adopted = finalState.rules[CALENDAR_RULE]!;
    expect(adopted.rule).toMatchObject({
      Name: CALENDAR_RULE,
      ScheduleExpression: 'rate(10 minutes)',
      State: 'ENABLED',
    });
    expect(adopted.targets).toHaveLength(1);
    expect(adopted.targets[0]).toMatchObject({
      Id: 'florida-calendar',
      RoleArn: EVENT_ROLE_ARN,
    });
    expect(ingestionSchedule).toContain("id: 'LegiwatchFloridaCalendar'");
    expect(ingestionSchedule).toContain('managedOutOfBand: true');
    expect(activation).toContain('PREFIX="capiro-${ENVIRONMENT}-legiwatch"');
    expect(activation).toContain('"florida-calendar|rate(10 minutes)|api|florida-calendar|adopt"');
    expect(activation).not.toMatch(/florida-calendar-(?:v2|phase9)/);
  });

  it('restores the legacy cadence, description, targets, and enabled state after a later failure', () => {
    const { result, finalState, originalRule, originalTargets } = runEnableShadow({
      failEnable: 'capiro-dev-legiwatch-central-discovery',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('original adopted rule metadata, targets, and state restored');
    expect(finalState.rules[CALENDAR_RULE]!.rule).toEqual(
      expect.objectContaining({
        Name: originalRule.Name,
        ScheduleExpression: originalRule.ScheduleExpression,
        State: originalRule.State,
        Description: originalRule.Description,
        EventBusName: originalRule.EventBusName,
      }),
    );
    expect(finalState.rules[CALENDAR_RULE]!.targets).toEqual(originalTargets);
    const runtimeTasks = finalState.calls.filter(
      (call) => call.includes('ecs') && call.includes('run-task'),
    );
    expect(runtimeTasks).toHaveLength(2);
    const lastOverridesIndex = runtimeTasks[1]!.indexOf('--overrides');
    const lastOverrides = JSON.parse(runtimeTasks[1]![lastOverridesIndex + 1]!);
    const registrations = JSON.parse(
      lastOverrides.containerOverrides[0].environment.find(
        (entry: { name: string }) => entry.name === 'LEGIWATCH_RUNTIME_REGISTRATIONS_JSON',
      ).value,
    );
    expect(registrations.every((row: { enabled: boolean }) => row.enabled === false)).toBe(true);
  });

  it('rolls back when EventBridge reports a partial target-write failure', () => {
    const { result, finalState, originalRule, originalTargets } = runEnableShadow({
      failPutTargets: CALENDAR_RULE,
    });
    expect(result.status).not.toBe(0);
    expect(finalState.rules[CALENDAR_RULE]!.rule).toEqual(
      expect.objectContaining({
        ScheduleExpression: originalRule.ScheduleExpression,
        State: originalRule.State,
        Description: originalRule.Description,
      }),
    );
    expect(finalState.rules[CALENDAR_RULE]!.targets).toEqual(originalTargets);
  });

  it('aborts before registration or mutation when the adopted rule cannot be inspected', () => {
    const { result, finalState } = runEnableShadow({ denyDescribe: CALENDAR_RULE });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('AccessDeniedException');
    expect(finalState.calls.some((call) => call.includes('ecs') && call.includes('run-task'))).toBe(
      false,
    );
    expect(
      finalState.calls.some(
        (call) =>
          call.includes('events') &&
          ['put-rule', 'put-targets', 'remove-targets', 'disable-rule'].some((action) =>
            call.includes(action),
          ),
      ),
    ).toBe(false);
  });

  it('registers independent calendar and archive jobs dark before activation', () => {
    expect(activation).toContain('"florida-archive|rate(30 minutes)|api|florida-archive"');
    expect(phase9Jobs).toContain("'florida-calendar'");
    expect(phase9Jobs).toContain("'florida-archive'");
    expect(phase9Jobs).toContain('includeArchive: false');
    expect(phase9Jobs).toContain('catalog: true');
    expect(runtimeMigration).toContain(
      "('florida-calendar', 'florida_calendar', 'disabled', false, false,  600, 1800",
    );
    expect(runtimeMigration).toContain(
      "('florida-archive',  'florida_archive',  'disabled', false, false, 1800, 5400",
    );
  });
});
