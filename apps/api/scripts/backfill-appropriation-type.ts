/**
 * backfill-appropriation-type.ts — repair program_element rows where
 * appropriation_type and/or service are NULL, inferring both DETERMINISTICALLY
 * from the pe_code. The R-1 / committee-mark loaders created RDT&E PEs without
 * stamping type or service; the Finder + Program 360 surface both directly (the
 * Finder even ORDERs and filters by service), so nulls render as unclassified
 * lines that vanish under service filters. (diag-graph-coverage 2026-07-03:
 * 1,139 null appropriation_type; 0601102A also had null service.)
 *
 *   tsx scripts/backfill-appropriation-type.ts            # DRY RUN (breakdown only)
 *   tsx scripts/backfill-appropriation-type.ts --commit   # write
 *
 * Rules (conservative — only unambiguous inferences are written; anything else is
 * reported and LEFT NULL, never guessed):
 *   - appropriation_type: pe_code matches PE_CODE_REGEX (^[0-9]{7}[A-Z]...) -> 'RDT&E'.
 *     A bare <4digit><letter><digits> code can't be told from an O&M account key
 *     without loader context, so non-PE shapes are reported under ambiguousLeftNull.
 *   - service: derived from the PE-code agency designator via serviceFromPeCode
 *     (the same canonical mapping used everywhere else: A=ARMY, N=NAVY, F=AF,
 *     M=USMC, D=DW, E=DARPA, ...). Only written when the designator resolves.
 *   - Never overwrites a non-null value.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { isValidPeCode, serviceFromPeCode } from '../src/program-element/jbook/jbook-extract.js';

dotenvConfig();

const COMMIT = process.argv.includes('--commit');
const RDTE = 'RDT&E';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ pe_code: string; service: string | null; appropriation_type: string | null }>
    >(
      `SELECT pe_code, service, appropriation_type FROM program_element
       WHERE (appropriation_type IS NULL OR service IS NULL) AND retired_at IS NULL
       ORDER BY pe_code`,
    );

    const typeTargets: string[] = [];
    const ambiguousType: string[] = [];
    const serviceTargets = new Map<string, string[]>(); // service -> peCodes
    const unresolvedService: string[] = [];

    for (const r of rows) {
      if (r.appropriation_type === null) {
        if (isValidPeCode(r.pe_code)) typeTargets.push(r.pe_code);
        else ambiguousType.push(r.pe_code);
      }
      if (r.service === null) {
        const svc = isValidPeCode(r.pe_code) ? serviceFromPeCode(r.pe_code).service : null;
        if (svc) {
          const list = serviceTargets.get(svc) ?? [];
          list.push(r.pe_code);
          serviceTargets.set(svc, list);
        } else {
          unresolvedService.push(r.pe_code);
        }
      }
    }

    const CHUNK = 500;
    let typeUpdated = 0;
    let serviceUpdated = 0;
    if (COMMIT) {
      for (let i = 0; i < typeTargets.length; i += CHUNK) {
        const res = await prisma.programElement.updateMany({
          where: { peCode: { in: typeTargets.slice(i, i + CHUNK) }, appropriationType: null },
          data: { appropriationType: RDTE },
        });
        typeUpdated += res.count;
      }
      for (const [svc, codes] of serviceTargets) {
        for (let i = 0; i < codes.length; i += CHUNK) {
          const res = await prisma.programElement.updateMany({
            where: { peCode: { in: codes.slice(i, i + CHUNK) }, service: null },
            data: { service: svc },
          });
          serviceUpdated += res.count;
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          mode: COMMIT ? 'COMMIT' : 'DRY_RUN',
          rowsNeedingRepair: rows.length,
          appropriationType: {
            rdteInferred: typeTargets.length,
            rdteUpdated: typeUpdated,
            ambiguousLeftNull: ambiguousType.length,
            ambiguousSamples: ambiguousType.slice(0, 20),
          },
          service: {
            resolvedByDesignator: [...serviceTargets].map(([s, c]) => `${s}:${c.length}`),
            serviceUpdated,
            unresolvedLeftNull: unresolvedService.length,
            unresolvedSamples: unresolvedService.slice(0, 20),
          },
        },
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
