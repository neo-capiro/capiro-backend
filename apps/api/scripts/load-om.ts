/**
 * O-1 (Operation & Maintenance) loader. Loads the FY2027 O&M "All Accounts" O-1
 * detail lines as program elements of appropriationType 'OM', keyed by a
 * namespaced pe_code = <account><line> (e.g. 2020A010, 0100D010) — the same
 * Treasury/USAspending budget-line convention used for procurement. O-1 amounts
 * are in THOUSANDS, normalized to the canonical MILLIONS unit here.
 *
 *   load-om --artifact scripts/__data__/corrected_json/om_fy2027.json
 *
 * Writes: program_element (title, appropriationType=OM, service, budgetActivity,
 * raw.account/sag/bsa) + program_element_year (request for FY2027, enacted for
 * FY2025 actuals + FY2026). Idempotent; merge-by-source-priority via the writer.
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ProgramElementWriterService } from '../src/program-element/program-element-writer.service.js';
import { thousandsToMillions } from '../src/program-element/jbook/jbook-extract.js';

dotenvConfig();

interface OmYear {
  fy: number;
  request?: number | null;
  enacted?: number | null;
}
interface OmPe {
  peCode: string;
  title: string;
  appropriationType?: string;
  service?: string | null;
  budgetActivity?: string | null;
  raw?: unknown;
  fyData?: OmYear[];
}
interface Artifact {
  source?: string;
  fy?: number;
  pes?: OmPe[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const artifactPath = arg('artifact');
  if (!artifactPath) {
    console.error('Usage: load-om --artifact <om.json>');
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Artifact;
  const source = artifact.source ?? 'o1_fy27';
  const prisma = new PrismaService();
  await prisma.$connect();
  const writer = new ProgramElementWriterService(prisma);
  let pes = 0;
  let yearRows = 0;
  let changed = 0;
  let quarantined = 0;
  try {
    for (const pe of artifact.pes ?? []) {
      await writer.upsertProgramElement(
        {
          peCode: pe.peCode,
          title: pe.title,
          appropriationType: pe.appropriationType ?? 'OM',
          service: pe.service ?? null,
          budgetActivity: pe.budgetActivity ?? null,
          lineNumber: pe.peCode,
          firstSeenFy: artifact.fy ?? 2027,
          raw: pe.raw,
        },
        source,
        0.7,
      );
      pes += 1;
      for (const y of pe.fyData ?? []) {
        const r = await writer.upsertProgramElementYear(
          {
            peCode: pe.peCode,
            fy: y.fy,
            request: thousandsToMillions(y.request ?? null),
            enacted: thousandsToMillions(y.enacted ?? null),
            raw: { source, account: (pe.raw as Record<string, unknown>)?.account },
          },
          source,
        );
        yearRows += 1;
        if (r.changed) changed += 1;
      }
    }
    console.log(
      JSON.stringify(
        { artifact: artifactPath, source, pes, yearRows, changed, quarantined },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
