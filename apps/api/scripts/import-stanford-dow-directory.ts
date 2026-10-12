/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';

const usage = 'Usage: tsx scripts/import-stanford-dow-directory.ts --import';
const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage);
  process.exit(0);
}
if (args.length !== 1 || args[0] !== '--import') {
  console.error(usage);
  process.exit(2);
}
dotenvConfig();

async function main() {
  const { PrismaService } = await import('../src/prisma/prisma.service.js');
  const { AcquisitionPersonnelWriterService } = await import('../src/acquisition-personnel/acquisition-personnel-writer.service.js');
  const { ProgramElementWriterService } = await import('../src/program-element/program-element-writer.service.js');
  const { importStanfordDowDirectory } = await import('../src/acquisition-personnel/importers/stanford-dow-importer.js');
  const workbookPath = path.resolve('scripts/__fixtures__/dow_directory_full.xlsx');

  const prisma = new PrismaService();
  await prisma.onModuleInit();

  const noOpMatcher = {
    findMatches: async () => [],
  };
  const writer = new AcquisitionPersonnelWriterService(prisma, noOpMatcher as never);
  const noOpPeMetrics = {
    emitCount: async () => undefined,
    emitSeconds: async () => undefined,
    emitGauge: async () => undefined,
  };
  const programElementWriter = new ProgramElementWriterService(prisma, noOpPeMetrics as never);

  try {
    const existingPersonByKey = new Map<string, string>();

    // Idempotency: pre-seed the dedup map from existing people (keyed by nameKey,
    // matching DB uniqueness) so re-runs add source mentions instead of creating
    // duplicate person rows.
    const loadExistingByNameKey = async (): Promise<Array<[string, string]>> => {
      const rows = await prisma.acquisitionPersonnel.findMany({ select: { id: true, nameKey: true } });
      return rows.map((r) => [r.nameKey, r.id] as [string, string]);
    };

    const first = await importStanfordDowDirectory(workbookPath, {
      writer,
      programElementWriter,
      existingPersonByKey,
      loadExistingByNameKey,
    });

    const second = await importStanfordDowDirectory(workbookPath, {
      writer,
      programElementWriter,
      existingPersonByKey,
      loadExistingByNameKey,
    });

    console.log(
      JSON.stringify(
        {
          first_run: first,
          second_run: second,
          rerun_zero_changes_check: {
            persons_inserted: second.persons_inserted === 0,
            persons_addSourceMentioned: second.persons_addSourceMentioned === 0,
            pes_inserted: second.pes_inserted === 0,
            pe_years_inserted: second.pe_years_inserted === 0,
          },
          spot_check_sample: first.spot_check_sample,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main();
