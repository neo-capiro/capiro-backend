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
