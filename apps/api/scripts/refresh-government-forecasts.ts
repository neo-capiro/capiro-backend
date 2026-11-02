/** One existing scheduler invocation; no background loop, backfill or retry. */
import { mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { collectOfficialAgenda, SourceCheckFailure } from './lib/government-forecast-source.js';
import { invokeForecastImporter } from './lib/government-forecast-import.js';

export const REFRESH_USAGE = `refresh-government-forecasts --archive-dir <durable absolute path> --run-id <stable scheduler occurrence> [--apply]
Default: bounded official listing/XML check and existing importer dry-run; no database client.
Daily scheduler binding is external. Share one durable archive root across all executions.
An existing .forecast-refresh-active marker refuses execution, including after a crash.
Unknown database outcomes require custodian reconciliation of the retained original identity;
never delete that marker based on age, automatically retry, or invent a new observation.`;

export function parseRefreshArgs(args: string[]) {
  if (args.length === 1 && args[0] === '--help') return { help: true } as const;
  const values = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i],
      value = args[i + 1];
    if (arg === '--apply' && !apply) {
      apply = true;
      continue;
    }
    if (
      arg === undefined ||
      !['--archive-dir', '--run-id'].includes(arg) ||
      values.has(arg) ||
      !value ||
      value.startsWith('--')
    )
      throw new Error('INVALID_REFRESH_ARGUMENTS');
    values.set(arg, value);
    i++;
  }
  const archiveDir = values.get('--archive-dir'),
    runId = values.get('--run-id');
  if (
    !archiveDir ||
    !isAbsolute(archiveDir) ||
    !runId ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId)
  )
    throw new Error('INVALID_REFRESH_ARGUMENTS');
  return { help: false, archiveDir, runId, apply } as const;
}

type RefreshInput = Exclude<ReturnType<typeof parseRefreshArgs>, { help: true }>;
export interface RefreshDependencies {
  fetch: typeof globalThis.fetch;
  now: () => Date;
  importSnapshot: (args: string[]) => Promise<Record<string, unknown>>;
}
const defaults: RefreshDependencies = {
  fetch: (...args) => globalThis.fetch(...args),
  now: () => new Date(),
  importSnapshot: invokeForecastImporter,
};

export async function runRefresh(input: RefreshInput, deps = defaults) {
  // Caller supplies the existing role/pool/TLS envelope, unchanged. Never compose DB_*.
  if (input.apply && !process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
  await mkdir(input.archiveDir, { recursive: true });
  const marker = join(input.archiveDir, '.forecast-refresh-active');
  const lock = await open(marker, 'wx', 0o600); // Exclusive; never reclaim on elapsed time.
  try {
    await lock.writeFile(
      JSON.stringify({ runId: input.runId, createdAt: deps.now().toISOString() }),
    );
    await lock.sync();
  } finally {
    await lock.close();
  }
  let uncertain = false;
  let runCreated = false;
  const runDir = join(input.archiveDir, input.runId);
  const retain = (name: string, bytes: Uint8Array) =>
    writeFile(join(runDir, name), bytes, { flag: 'wx', mode: 0o600, flush: true });
  const record = (name: string, value: unknown) =>
    retain(name, Buffer.from(JSON.stringify(value, null, 2) + '\n'));
  try {
    await mkdir(runDir); // Stable occurrence cannot overwrite or silently replay a prior run.
    runCreated = true;
    const attemptedAt = deps.now().toISOString();
    await record('attempt.json', { runId: input.runId, attemptedAt, apply: input.apply });
    let source;
    try {
      source = await collectOfficialAgenda({ fetch: deps.fetch, now: deps.now, retain });
    } catch (error) {
      if (!(error instanceof SourceCheckFailure)) throw error; // Disk/setup failure is not a source failure.
      await record('source-failure.json', { attemptedAt, reason: error.message });
      if (input.apply) {
        const args = ['--record-failure', '--observed-at', attemptedAt, '--apply'];
        await record('import-intent.json', { kind: 'definite-source-failure', args });
        uncertain = true;
        await record('import-result.json', await deps.importSnapshot(args));
        await record('outcome.json', { status: 'source-failure-recorded', attemptedAt });
        uncertain = false;
      }
      throw error;
    }
    await record('source.json', source);
    const args = [
      '--input',
      join(runDir, 'source.xml'),
      '--edition',
      source.edition,
      '--sha256',
      source.sha256,
      '--observed-at',
      source.observedAt,
      ...(input.apply ? ['--apply'] : []),
    ];
    await record('import-intent.json', { kind: 'snapshot', args });
    uncertain = input.apply;
    await record('import-result.json', await deps.importSnapshot(args));
    await record('outcome.json', {
      status: input.apply ? 'import-returned' : 'dry-run',
      sha256: source.sha256,
      observedAt: source.observedAt,
    });
    uncertain = false;
    return { status: input.apply ? 'import-returned' : 'dry-run', runId: input.runId, ...source };
  } catch (error) {
    if (uncertain) {
      await record('unknown-outcome.json', {
        status: 'unknown',
        action:
          'Reconcile original import-intent.json; retain active marker until custody resolves.',
      }).catch(() => undefined);
      throw new Error('FORECAST_DATABASE_OUTCOME_UNKNOWN');
    }
    if (runCreated)
      await record('failed-run.json', {
        status: 'failed',
        pendingDatabaseOutcome: false,
        kind: error instanceof SourceCheckFailure ? 'source-check' : 'local-or-dry-run',
      }).catch(() => undefined);
    throw error;
  } finally {
    if (!uncertain) await unlink(marker);
  }
}

export async function main(args: string[]) {
  const input = parseRefreshArgs(args);
  if (input.help) {
    console.log(REFRESH_USAGE);
    return;
  }
  console.log(JSON.stringify(await runRefresh(input)));
}

if (require.main === module)
  main(process.argv.slice(2)).catch(() => {
    console.error(
      'Forecast refresh failed. Inspect retained receipts and active marker before another invocation; never infer database rollback or retry with a new observation.',
    );
    process.exitCode = 1;
  });
