import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INGESTION_JOBS } from '../lib/ingestion-schedule';

describe('forecast ingestion registration', () => {
  test('source and candidate jobs have separate commands, ordered schedules, and gated activation', () => {
    const source = INGESTION_JOBS.find((job) => job.id === 'SyncTangoForecasts')!;
    const candidates = INGESTION_JOBS.find(
      (job) => job.id === 'GenerateForecastOpportunityCandidates',
    )!;
    expect(source.command).toEqual(['sync-tango-forecasts', '--commit']);
    expect(candidates.command).toEqual(['generate-forecast-opportunity-candidates', '--commit']);
    expect(Number(candidates.cron.hour) * 60 + Number(candidates.cron.minute)).toBeGreaterThan(
      Number(source.cron.hour) * 60 + Number(source.cron.minute),
    );
    expect(source.enabled).toBe(true);
    expect(candidates.enabled).toBe(true);
    const dispatcher = readFileSync(
      resolve(__dirname, '../../../apps/api/scripts/entrypoint-dispatcher.inc'),
      'utf8',
    );
    for (const job of [source, candidates])
      expect(dispatcher).toContain(
        `${job.command[0]}) shift; exec ./node_modules/.bin/tsx scripts/${job.command[0]}.ts`,
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
