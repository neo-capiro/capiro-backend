import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

// Produces reviewable JSON only. Registration, migration and enabling are
// separate release steps. Inputs are current AWS snapshots kept outside Git.
const options = Object.fromEntries(
  [
    'tenant',
    'intel-image',
    'api-image',
    'intel-worker',
    'source-worker',
    'emitter-target',
    'source-target',
    'out',
  ].map((name) => [name, { type: 'string' }]),
);
const { values: v } = parseArgs({ options });
for (const key of Object.keys(options)) if (!v[key]) throw new Error(`--${key} is required`);
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.tenant))
  throw new Error('One explicit tenant UUID required');
const prefix = '967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/';
for (const [key, repo] of [
  ['intel-image', 'intel-api'],
  ['api-image', 'api'],
])
  if (!new RegExp(`^${prefix.replaceAll('.', '\\.')}${repo}@sha256:[a-f0-9]{64}$`).test(v[key]))
    throw new Error(`${key} must be an immutable capiro-dev digest`);
const read = (key) => JSON.parse(readFileSync(resolve(v[key]), 'utf8').replace(/^\uFEFF/, ''));
const strip = (definition) => {
  for (const key of [
    'taskDefinitionArn',
    'revision',
    'status',
    'requiresAttributes',
    'compatibilities',
    'registeredAt',
    'registeredBy',
    'deregisteredAt',
  ])
    delete definition[key];
  if (definition.containerDefinitions.length !== 1)
    throw new Error('Review multiple containers manually');
  return definition;
};
const environment = (container, values) => {
  container.environment = [
    ...(container.environment ?? []).filter((e) => !(e.name in values)),
    ...Object.entries(values).map(([name, value]) => ({ name, value })),
  ];
};
const legacyWorker = strip(read('intel-worker'));
legacyWorker.family = 'capiro-dev-intel-api-alert-worker';
const legacy = legacyWorker.containerDefinitions[0];
legacy.image = v['intel-image'];
delete legacy.entryPoint;
delete legacy.healthCheck;
legacy.command = ['task', 'emit-bill-alerts'];
environment(legacy, { LEGIWATCH_RECORD_ALERT_SOURCE_TYPES: '' });
const legacyTarget = read('emitter-target');
legacyTarget.Targets[0].EcsParameters.TaskDefinitionArn =
  'REPLACE_WITH_REGISTERED_LEGACY_ALERT_WORKER_REVISION';
// The existing emission and daily/weekly digest overrides keep this container
// name. Only their pinned task revision changes; cadences remain unchanged.
const worker = strip(read('intel-worker'));
worker.family = 'capiro-dev-intel-api-legiwatch-reports';
const intel = worker.containerDefinitions[0];
intel.name = 'legiwatch-reports';
intel.image = v['intel-image'];
delete intel.entryPoint;
delete intel.healthCheck;
intel.command = ['task', 'run-report-updates', v.tenant];
environment(intel, {
  LEGIWATCH_RECORD_ALERT_SOURCE_TYPES: 'state_bill',
  TRACKER_ALERTS_ENABLED: 'false',
  REPORT_APP_ORIGIN: 'https://os.capiro.ai',
});
if (!(intel.secrets ?? []).some((s) => s.name === 'INTERNAL_SERVICE_SECRET'))
  throw new Error('Inbox adapter secret reference is missing');
if (intel.logConfiguration?.options)
  intel.logConfiguration.options['awslogs-stream-prefix'] = 'legiwatch-reports';
const source = strip(read('source-worker'));
if (source.family !== 'capiro-dev-api-sync-legiscan-bills')
  throw new Error('The existing API source drain is required');
source.containerDefinitions[0].image = v['api-image'];
environment(source.containerDefinitions[0], { LEGISCAN_REPORT_REFRESH_TENANT: v.tenant });
const target = read('emitter-target').Targets[0];
if (target.Arn !== 'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev')
  throw new Error('Unexpected cluster');
target.Id = 'legiwatch-report-updates';
target.Input = JSON.stringify({
  containerOverrides: [{ name: intel.name, command: intel.command }],
});
target.EcsParameters.TaskDefinitionArn = 'REPLACE_WITH_REGISTERED_IMMUTABLE_WORKER_REVISION';
const sourceTarget = read('source-target');
sourceTarget.Targets[0].EcsParameters.TaskDefinitionArn =
  'REPLACE_WITH_REGISTERED_SOURCE_DRAIN_REVISION';
const output = resolve(v.out);
mkdirSync(output, { recursive: true });
for (const [name, value] of Object.entries({
  'report-worker.json': worker,
  'legacy-alert-worker.json': legacyWorker,
  'legacy-emitter-target.json': legacyTarget,
  'source-drain.json': source,
  'report-target.json': { Targets: [target] },
  'source-target.json': sourceTarget,
  'report-rule.json': {
    Name: 'capiro-dev-legiwatch-report-updates',
    Description: 'Tenant-scoped LegiWatch daily drafts and reviewed published-record delivery',
    ScheduleExpression: 'rate(5 minutes)',
    State: 'DISABLED',
  },
  'release-plan.json': {
    tenantId: v.tenant,
    images: { api: v['api-image'], intel: v['intel-image'] },
    sequence: [
      'API migration',
      'Intel migration',
      'API HTTP rollout',
      'Intel HTTP rollout',
      'register source drain and report worker',
      'pin existing Intel emission and digest targets to the fenced legacy worker',
      'update source target after checking no drain is running',
      'publish vNext',
      'verify flags remain off',
      'explicit workspace activation and controlled draft cycle',
    ],
    rollback: [
      'disable report EventBridge rule',
      'disable report delivery and report capability flags for this tenant',
      'restore recorded source target and HTTP task revisions',
      'retain additive schema and immutable history',
    ],
    deliveryEnabled: false,
    staffDeliveryEnabled: false,
  },
}))
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
console.log(JSON.stringify({ output, state: 'reviewable_disabled_plan', cloudWrites: false }));
