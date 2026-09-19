import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScheduledIngestionJobs } from '../lib/constructs/scheduled-ingestion-jobs';
import { INGESTION_JOBS } from '../lib/ingestion-schedule';

describe('Funding Opportunities production ingestion schedules', () => {
  test('SAM, DIBBS, SBIR, and forecast schedules use the quota-safe daily matrix', () => {
    const samDod = INGESTION_JOBS.find((job) => job.id === 'SyncSamOpportunities')!;
    expect(samDod.enabled).toBe(false);
    const samAll = INGESTION_JOBS.find((job) => job.id === 'SyncSamOpportunitiesAllFederal')!;
    expect(samAll.command).toEqual(['sync-sam-opportunities-all-federal', '--skip-descriptions']);
    expect(samAll.cron).toMatchObject({ minute: '15', hour: '0' });
    expect(samAll.enabled).toBe(true);

    const dibbs = INGESTION_JOBS.find((job) => job.id === 'SyncTangoDibbs')!;
    expect(dibbs.cron).toMatchObject({ minute: '5', hour: '0' });
    expect(dibbs.enabled).toBe(true);
    const sbir = INGESTION_JOBS.find((job) => job.id === 'SyncTangoSbir')!;
    expect(sbir.cron).toMatchObject({ minute: '20', hour: '1' });
    expect(sbir.enabled).toBe(true);

    const source = INGESTION_JOBS.find((job) => job.id === 'SyncTangoForecasts')!;
    expect(source.command).toEqual(['sync-tango-forecasts', '--commit', '--limit=5000']);
    expect(source.cron).toMatchObject({ minute: '0', hour: '2' });
    expect(source.environment).toEqual({ TANGO_REQUEST_CEILING_PER_RUN: '30' });
    expect(source.enabled).toBe(true);
    const dispatcher = readFileSync(
      resolve(__dirname, '../../../apps/api/scripts/entrypoint-dispatcher.inc'),
      'utf8',
    );
    expect(dispatcher).toContain(
      'sync-tango-forecasts) shift; exec ./node_modules/.bin/tsx scripts/sync-tango-forecasts.ts',
    );
  });
});

test('renders optional scheduled environment into the ECS container override', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'ScheduleStack');
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 1, natGateways: 1 });
  const cluster = new ecs.Cluster(stack, 'Cluster', { vpc });
  const taskDefinition = new ecs.FargateTaskDefinition(stack, 'TaskDefinition', {
    cpu: 256,
    memoryLimitMiB: 512,
  });
  taskDefinition.addContainer('Api', {
    image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22'),
  });

  new ScheduledIngestionJobs(stack, 'Schedules', {
    envName: 'test',
    cluster,
    taskDefinition,
    containerName: 'Api',
    securityGroup: new ec2.SecurityGroup(stack, 'SecurityGroup', { vpc }),
    jobs: [
      {
        id: 'SyncTangoForecasts',
        command: ['sync-tango-forecasts', '--commit'],
        cron: { minute: '0', hour: '2' },
        tier: 'daily',
        description: 'test',
        environment: { TANGO_REQUEST_CEILING_PER_RUN: '30' },
      },
    ],
  });

  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::Events::Rule', {
    Targets: [
      {
        Input: JSON.stringify({
          containerOverrides: [
            {
              name: 'Api',
              command: ['sync-tango-forecasts', '--commit'],
              environment: [{ name: 'TANGO_REQUEST_CEILING_PER_RUN', value: '30' }],
            },
          ],
        }),
      },
    ],
  });
});

describe('District Nexus R4 operational hardening: schedule registration without premature enablement', () => {
  const dispatcher = readFileSync(
    resolve(__dirname, '../../../apps/api/scripts/entrypoint-dispatcher.inc'),
    'utf8',
  );

  test('ACS, CBP, LODES, and Tango-subaward jobs are registered but SHIP DISABLED', () => {
    const ids = [
      'SyncDistrictEconomicAcs',
      'SyncDistrictEconomicCbp',
      'SyncDistrictEconomicLodes',
      'SyncTangoSubawards',
    ];
    for (const id of ids) {
      const job = INGESTION_JOBS.find((j) => j.id === id);
      expect(job).toBeDefined();
      expect(job!.enabled).toBe(false);
    }
  });

  test('each new job dispatches to a command the entrypoint actually registers', () => {
    // ACS/CBP/LODES were registered before this PR using a no-args dispatch
    // shape (no `shift`/`"$@"` — these scripts read DRY_RUN from the
    // environment, not CLI flags); Tango subawards uses the standard
    // shift+$@ shape (it DOES take --commit/--allow-full). Match on the
    // shared part both shapes have in common rather than assuming one
    // template fits every command.
    for (const id of [
      'SyncDistrictEconomicAcs',
      'SyncDistrictEconomicCbp',
      'SyncDistrictEconomicLodes',
      'SyncTangoSubawards',
    ]) {
      const job = INGESTION_JOBS.find((j) => j.id === id)!;
      expect(dispatcher).toMatch(
        new RegExp(
          `${job.command[0]}\\)\\s*(shift;\\s*)?exec \\./node_modules/\\.bin/tsx scripts/${job.command[0]}\\.ts`,
        ),
      );
    }
  });

  test('no two new jobs collide on the same cron minute+hour', () => {
    const ids = [
      'SyncDistrictEconomicAcs',
      'SyncDistrictEconomicCbp',
      'SyncDistrictEconomicLodes',
      'SyncTangoSubawards',
    ];
    const slots = ids.map((id) => {
      const job = INGESTION_JOBS.find((j) => j.id === id)!;
      return `${job.cron.day ?? '*'}-${job.cron.hour}-${job.cron.minute}`;
    });
    expect(new Set(slots).size).toBe(slots.length);
  });

  test('Tango subawards schedule command deliberately omits --allow-full — enabling the rule alone must never start an unbounded catalog write', () => {
    const job = INGESTION_JOBS.find((j) => j.id === 'SyncTangoSubawards')!;
    expect(job.command).toContain('--commit');
    expect(job.command).not.toContain('--allow-full');
  });

  test('no GSA full-ingest job was added — the existing bounded-manual-entrypoint, no-recurring-schedule posture for sync-gsa-frpp is preserved', () => {
    expect(INGESTION_JOBS.find((j) => j.command[0] === 'sync-gsa-frpp')).toBeUndefined();
  });
});

describe('Funding machine-suggestion producer retirement', () => {
  test('removes obsolete producer jobs while retaining source sync and lifecycle', () => {
    const retired = [
      'GenerateFundingGrantCandidates',
      'GenerateSamOpportunityCandidates',
      'GenerateDibbsOpportunityCandidates',
      'GenerateSbirOpportunityCandidates',
      'GenerateForecastOpportunityCandidates',
    ];
    for (const id of retired) expect(INGESTION_JOBS.some((job) => job.id === id)).toBe(false);
    expect(
      INGESTION_JOBS.find((job) => job.id === 'GenerateGrantOpportunityCandidates')?.command,
    ).toEqual(['generate-grant-opportunity-candidates', '--commit']);
    expect(INGESTION_JOBS.find((job) => job.id === 'SyncTangoForecasts')?.command).toEqual([
      'sync-tango-forecasts',
      '--commit',
      '--limit=5000',
    ]);
    expect(
      INGESTION_JOBS.find((job) => job.id === 'ProcessFundingOpportunityLifecycle')?.command,
    ).toEqual(['process-funding-opportunity-lifecycle', '--commit']);
    const dispatcher = readFileSync(
      resolve(__dirname, '../../../apps/api/scripts/entrypoint-dispatcher.inc'),
      'utf8',
    );
    expect(dispatcher).toContain('generate-grant-opportunity-candidates)');
    expect(dispatcher).toContain('sync-sam-opportunities)');
    expect(dispatcher).toContain('process-funding-opportunity-lifecycle)');
    for (const id of retired) {
      const verb = id.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()).replace(/^-/, '');
      expect(dispatcher).not.toContain(verb + ')');
    }
  });
});
