/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const usage = 'Usage: tsx scripts/parse-dow-directory.ts --parse [path-to-directory.pdf] (or provide a path explicitly)';
const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage);
  process.exit(0);
}
const inputArgs = args.filter((arg) => arg !== '--parse');
if (
  args.length === 0 ||
  args.filter((arg) => arg === '--parse').length > 1 ||
  inputArgs.length > 1 ||
  inputArgs.some((arg) => arg.startsWith('-')) ||
  (inputArgs.length === 0 && !args.includes('--parse'))
) {
  console.error(usage);
  process.exit(2);
}
const inputPath = inputArgs[0];
dotenvConfig();

async function main() {
  const { PrismaService } = await import('../src/prisma/prisma.service.js');
  const { MatchScorerService } = await import('../src/acquisition-personnel/matching/match-scorer.service.js');
  const { AcquisitionPersonnelWriterService } = await import('../src/acquisition-personnel/acquisition-personnel-writer.service.js');
  const { DowDirectorySectionSplitterService } = await import('../src/acquisition-personnel/parsers/dow-directory-section-splitter.service.js');
  const { DowDirectoryParserService } = await import('../src/acquisition-personnel/parsers/dow-directory-parser.service.js');
  const defaultPath = path.resolve('scripts/__fixtures__/2026_DoW_Directory_Update_4.pdf');
  const cliPath = inputPath ? path.resolve(inputPath) : defaultPath;

  const pdfBuffer = await fs.readFile(cliPath);

  const prisma = new PrismaService();
  await prisma.onModuleInit();

  try {
    const matcher = new MatchScorerService(prisma);
    const writer = new AcquisitionPersonnelWriterService(prisma, matcher);
    const splitter = new DowDirectorySectionSplitterService();
    const parser = new DowDirectoryParserService(prisma, writer, splitter);

    const first = await parser.parseDirectory({
      pdfPath: cliPath,
      pdfBuffer,
    });

    const second = await parser.parseDirectory({
      pdfPath: cliPath,
      pdfBuffer,
    });

    console.log(
      JSON.stringify(
        {
          first_run: first,
          second_run: second,
          rerun_zero_changes_check: {
            persons_inserted: second.persons_inserted === 0,
            persons_addSourceMentioned: second.persons_addSourceMentioned === 0,
          },
          report: {
            total_sections_processed: first.sections_processed,
            persons_inserted: first.persons_inserted,
            persons_addSourceMentioned: first.persons_addSourceMentioned,
            persons_quarantined: first.persons_quarantined,
            vacancies_detected: first.vacancies_detected,
            total_credits_consumed: first.total_firecrawl_credits_consumed,
            runtime_seconds: first.runtime_seconds,
            failed_sections: first.failed_sections,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((e)=>{ console.error('[parse-dow-directory] fatal', e?.stack || e); process.exit(1); });
