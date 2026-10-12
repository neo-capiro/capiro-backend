/** @cleanup-smoke noArgsExit=2 */
/**
 * Step 34A — extract DoD officials who testified at defense-committee hearings.
 *
 *   pnpm --filter @capiro/api extract:hearing-witnesses
 *   tsx scripts/extract-hearing-witnesses.ts --months 12
 *
 * Reads committee_hearing rows for defense committees (HASC/SASC/HAC-D/SAC-D) in the
 * last N months (default 12), filters witnesses to DoD-affiliated entries, and upserts
 * each via the personnel writer (source='hearing_witness', confidence=0.9).
 *
 * Deterministic — NO LLM (committee_hearing.witnesses is a plain String[]). Idempotent:
 * the writer dedups source mentions by observedAt (== hearing.date), so re-running adds
 * nothing. Cadence: weekly (EventBridge).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  HearingPersonnelExtractorService,
  HEARING_WITNESS_SOURCE,
  type HearingInput,
} from '../src/acquisition-personnel/extractors/hearing-personnel-extractor.service.js';
import { AcquisitionPersonnelWriterService } from '../src/acquisition-personnel/acquisition-personnel-writer.service.js';
import { MatchScorerService } from '../src/acquisition-personnel/matching/match-scorer.service.js';

dotenvConfig();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const months = Number(arg('months') ?? 12);
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  const source = 'hearing_witness';

  if (!process.env.DATABASE_URL) {
    console.error('Usage: extract-hearing-witnesses [--months <n>] (requires DATABASE_URL)');
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  const writer = new AcquisitionPersonnelWriterService(prisma, new MatchScorerService(prisma));
  const extractor = new HearingPersonnelExtractorService();

  const run = await prisma.syncRun.create({ data: { source, startedAt: new Date(), status: 'running' } });

  let hearings = 0;
  let witnesses = 0;
  let inserted = 0;
  let errors = 0;

  try {
    // Pull recent hearings; defense-committee filter is applied in-process (the predicate
    // spans name + code patterns that don't reduce to a simple SQL WHERE).
    const rows = await prisma.committeeHearing.findMany({
      where: { date: { gte: since } },
      orderBy: { date: 'desc' },
    });
    console.error(`Found ${rows.length} hearings since ${since.toISOString().slice(0, 10)}`);

    for (const r of rows) {
      const hearing: HearingInput = {
        committeeName: r.committeeName,
        committeeCode: r.committeeCode,
        title: r.title,
        date: r.date,
        url: r.url,
        witnesses: r.witnesses ?? [],
      };
      const people = extractor.extractFromHearing(hearing);
      if (people.length === 0) continue;
      hearings += 1;

      for (const p of people) {
        witnesses += 1;
        try {
          const result = await writer.upsertPerson(
            { fullName: p.fullName, title: p.title ?? undefined, organization: p.organization ?? undefined },
            HEARING_WITNESS_SOURCE,
            p.sourceUrl,
            p.snippet,
            p.observedAt,
            p.confidence,
          );
          if (result.inserted) inserted += 1;
        } catch (err) {
          errors += 1;
          console.error(`upsert failed for ${p.fullName}: ${String(err)}`);
        }
      }
    }

    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'success', rowsInserted: inserted, errorCount: errors },
    });
    console.log(
      JSON.stringify({ source, since: since.toISOString().slice(0, 10), hearings, witnesses, inserted, errors }, null, 2),
    );
  } catch (err) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'error', errorCount: errors + 1, errorMessage: String(err) },
    });
    throw err;
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
