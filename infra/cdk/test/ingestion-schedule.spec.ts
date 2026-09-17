import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INGESTION_JOBS } from '../lib/ingestion-schedule';

describe('forecast ingestion registration', () => {
  test('source sync remains enabled and registered with the dispatcher', () => {
    const source = INGESTION_JOBS.find((job) => job.id === 'SyncTangoForecasts')!;
    expect(source.command).toEqual(['sync-tango-forecasts', '--commit']);
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
    expect(INGESTION_JOBS.find((job) => job.id === 'GenerateGrantOpportunityCandidates')?.command).toEqual([
      'generate-grant-opportunity-candidates', '--commit',
    ]);
    expect(INGESTION_JOBS.find((job) => job.id === 'SyncTangoForecasts')?.command).toEqual([
      'sync-tango-forecasts', '--commit',
    ]);
    expect(INGESTION_JOBS.find((job) => job.id === 'ProcessFundingOpportunityLifecycle')?.command).toEqual([
      'process-funding-opportunity-lifecycle', '--commit',
    ]);
    const dispatcher = readFileSync(
      resolve(__dirname, '../../../apps/api/scripts/entrypoint-dispatcher.inc'), 'utf8',
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
