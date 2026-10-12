/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';

const usage = 'Usage: tsx scripts/import-dow-directory-v6.ts --import [path-to-dow_v6_people.json] (or provide a path explicitly)';
const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage);
  process.exit(0);
}
const inputArgs = args.filter((arg) => arg !== '--import');
if (
  args.length === 0 ||
  args.filter((arg) => arg === '--import').length > 1 ||
  inputArgs.length > 1 ||
  inputArgs.some((arg) => arg.startsWith('-')) ||
  (inputArgs.length === 0 && !args.includes('--import'))
) {
  console.error(usage);
  process.exit(2);
}
const inputPath = inputArgs[0];
dotenvConfig();

/**
 * Import the DoW Directory Rev 6 (June 2026) parsed personnel into acquisition_personnel.
 * Reuses the writer's dedup engine; idempotent (re-run => addSourceMention, not insert).
 *
 * Usage: tsx scripts/import-dow-directory-v6.ts --import [path-to-dow_v6_people.json]
 * After import, run: tsx scripts/generate-pe-person-candidates.ts --commit
 * to populate the person->PE review queue using the freshly-imported program signal.
 */
async function main() {
  const { PrismaService } = await import('../src/prisma/prisma.service.js');
  const { AcquisitionPersonnelWriterService } = await import('../src/acquisition-personnel/acquisition-personnel-writer.service.js');
  const { importDowDirectoryV6 } = await import('../src/acquisition-personnel/importers/dow-directory-v6-importer.js');
  const jsonPath = inputPath
    ? path.resolve(inputPath)
    : path.resolve('scripts/__data__/dow_directory_v6/dow_v6_people.json');

  const prisma = new PrismaService();
  await prisma.onModuleInit();

  // Import uses the in-memory dedup map as the sole gate, so a no-op matcher avoids
  // double-deduping (the map already prevents same-name re-inserts).
  const noOpMatcher = { findMatches: async () => [] };
  const writer = new AcquisitionPersonnelWriterService(prisma, noOpMatcher as never);

  try {
    const existingPersonByKey = new Map<string, string>();
    const loadExistingByNameKey = async (): Promise<Array<[string, string]>> => {
      const rows = await prisma.acquisitionPersonnel.findMany({ select: { id: true, nameKey: true } });
      return rows.map((r) => [r.nameKey, r.id] as [string, string]);
    };

    const first = await importDowDirectoryV6(jsonPath, { writer, existingPersonByKey, loadExistingByNameKey });
    const second = await importDowDirectoryV6(jsonPath, { writer, existingPersonByKey, loadExistingByNameKey });

    console.log(
      JSON.stringify(
        {
          source: jsonPath,
          first_run: first,
          second_run: second,
          rerun_zero_new_inserts_check: second.persons_inserted === 0,
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
