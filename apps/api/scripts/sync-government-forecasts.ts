/** Existing public-data job tooling entry point; no import-time side effects. */
import { readFile, stat } from 'node:fs/promises';
import {
  FORECAST_IMPORT_USAGE,
  parseImportArgs,
  qualifyImport,
} from '../src/government-forecasts/forecast-import-command.js';
import {
  persistForecastSnapshot,
  recordForecastCheckFailure,
} from '../src/government-forecasts/forecast-producer.js';

export async function main(args: string[]) {
  const input = parseImportArgs(args, new Date());
  if (input.help) {
    console.log(FORECAST_IMPORT_USAGE);
    return;
  }
  if (input.apply && !process.env.DATABASE_URL)
    throw new Error('DATABASE_URL is required for apply');
  let snapshot, sourceXml: string | undefined;
  if (!input.failure) {
    if ((await stat(input.input)).size > 40 * 1024 * 1024)
      throw new Error('Source snapshot exceeds 40 MiB');
    const bytes = await readFile(input.input);
    sourceXml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    snapshot = qualifyImport(sourceXml, input);
    if (!input.apply) {
      console.log(
        JSON.stringify({
          mode: 'dry-run',
          candidates: snapshot.candidates.length,
          completedMilestones: snapshot.completedMilestones.length,
          withdrawals: snapshot.withdrawnRins.length,
          rejected: snapshot.rejected.length,
          edition: input.edition,
          sha256: input.sha256,
        }),
      );
      return;
    }
  }
  // Allocate a database client only after all arguments/source/configuration validate.
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    if (input.failure) {
      await recordForecastCheckFailure(prisma, input.observedAt);
      console.log(JSON.stringify({ mode: 'record-failure', recorded: true }));
    } else {
      const result = await persistForecastSnapshot(prisma, snapshot!, {
        sha256: input.sha256,
        edition: input.edition,
        observedAt: input.observedAt,
        sourceXml: sourceXml!,
      });
      console.log(JSON.stringify({ mode: 'apply', ...result }));
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module)
  main(process.argv.slice(2)).catch(() => {
    console.error(
      'Forecast import failed. For a possible database write, reconcile the original snapshot hash and observation time before retrying.',
    );
    process.exitCode = 1;
  });
