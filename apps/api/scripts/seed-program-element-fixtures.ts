/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ProgramElementWriterService } from '../src/program-element/program-element-writer.service.js';
import { type ProgramElementFixture, PROGRAM_ELEMENT_FIXTURES } from '../src/program-element/program-element-fixture-data.js';

export interface ProgramElementWriterLike {
  upsertProgramElement(
    record: ProgramElementFixture['record'],
    source: string,
    sourceConfidence: number,
  ): Promise<{ inserted: boolean; pe_code: string }>;
  upsertProgramElementYear(
    record: ProgramElementFixture['years'][number],
    source: string,
  ): Promise<{ inserted: boolean; changed: boolean; delta?: Array<{ field: string; oldValue: unknown; newValue: unknown }> }>;
  upsertProgramElementMilestone(
    record: ProgramElementFixture['milestones'][number],
    source: string,
  ): Promise<{ inserted: boolean }>;
  refreshProgramElementDetailMaterializedView(source?: string): Promise<void>;
  emitRunSummary(source: string, startedAt: Date, inserted: number, updated: number, quarantined: number): Promise<void>;
  emitRunError(source: string): Promise<void>;
  emitInventoryMetrics(source?: string): Promise<void>;
}

const NOOP_METRICS_WRITER_METHODS = {
  emitRunSummary: async (): Promise<void> => {
    return;
  },
  emitRunError: async (): Promise<void> => {
    return;
  },
  emitInventoryMetrics: async (): Promise<void> => {
    return;
  },
};

export interface SeedSummary {
  peInserted: number;
  yearInserted: number;
  yearChanged: number;
  milestoneInserted: number;
}

export async function seedProgramElementFixtures(writer: ProgramElementWriterLike): Promise<SeedSummary> {
  const startedAt = new Date();
  const summary: SeedSummary = {
    peInserted: 0,
    yearInserted: 0,
    yearChanged: 0,
    milestoneInserted: 0,
  };

  try {
    for (const fixture of PROGRAM_ELEMENT_FIXTURES) {
      const peResult = await writer.upsertProgramElement(fixture.record, 'fixture', 0.99);
      if (peResult.inserted) summary.peInserted += 1;

      for (const yearRecord of fixture.years) {
        const yearResult = await writer.upsertProgramElementYear(yearRecord, 'fixture');
        if (yearResult.inserted) summary.yearInserted += 1;
        if (yearResult.changed) summary.yearChanged += 1;
      }

      for (const milestoneRecord of fixture.milestones) {
        const milestoneResult = await writer.upsertProgramElementMilestone(milestoneRecord, 'fixture');
        if (milestoneResult.inserted) summary.milestoneInserted += 1;
      }
    }

    await writer.refreshProgramElementDetailMaterializedView('fixture');
    await writer.emitRunSummary(
      'fixture',
      startedAt,
      summary.peInserted + summary.yearInserted + summary.milestoneInserted,
      summary.yearChanged,
      0,
    );
    await writer.emitInventoryMetrics('fixture');

    return summary;
  } catch (error: unknown) {
    await writer.emitRunError('fixture');
    throw error;
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.onModuleInit();

  try {
    const writer = Object.assign(
      new ProgramElementWriterService(prisma, undefined),
      NOOP_METRICS_WRITER_METHODS,
    );
    const summary = await seedProgramElementFixtures(writer);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ fixtures: PROGRAM_ELEMENT_FIXTURES.length, ...summary }, null, 2));
  } finally {
    await prisma.onModuleDestroy();
  }
}

if (require.main === module) {
  const usage = 'Usage: tsx scripts/seed-program-element-fixtures.ts --run';
  const argv = process.argv.slice(2);
  if ((argv.length === 1 && argv[0] === '--help') ||
      (argv.length === 2 && argv[0] === '--run' && argv[1] === '--help')) {
    console.log(usage);
    process.exit(0);
  }
  if (argv.length !== 1 || argv[0] !== '--run') {
    console.error(usage);
    process.exit(2);
  }
  dotenvConfig();
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
