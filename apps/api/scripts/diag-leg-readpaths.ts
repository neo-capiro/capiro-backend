/**
 * diag-leg-readpaths (read-only) [refire #224]: dumps the exact data shape behind the two
 * legislative read paths for one PE, so a fix can be verified against prod
 * without guessing. No writes.
 *
 *   diag-leg-readpaths --pe 0603270A [--bill 119-hr-8800]
 *
 * Reports:
 *  - provision_pe_link rows for this PE: DIRECT (pe_code) vs PROGRAM-reachable
 *    (via accepted pe_program_match), by basis + reviewStatus.
 *  - bill_budget_line_link rows for this PE, and — when --bill given — every
 *    link row + the legacy peCodes array + whether cached BillText holds the code.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const pe = (arg('pe') ?? '').toUpperCase();
  const bill = arg('bill');
  if (!pe) {
    console.error('Usage: diag-leg-readpaths --pe <peCode> [--bill <billId>]');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    // ── Provisions ──────────────────────────────────────────────────────────
    const directLinks = await prisma.provisionPeLink.groupBy({
      by: ['matchBasis', 'reviewStatus'],
      where: { peCode: pe },
      _count: { _all: true },
    });
    const matches = await prisma.peProgramMatch.findMany({
      where: { peCode: pe, status: 'accepted' },
      select: { programId: true, program: { select: { canonicalName: true } } },
    });
    const programIds = [...new Set(matches.map((m) => m.programId))];
    const programLinks = programIds.length
      ? await prisma.provisionPeLink.groupBy({
          by: ['matchBasis', 'reviewStatus'],
          where: { programId: { in: programIds } },
          _count: { _all: true },
        })
      : [];

    // ── Bills ───────────────────────────────────────────────────────────────
    const billLinksForPe = await prisma.billBudgetLineLink.findMany({
      where: { peCode: pe },
      select: { billId: true, linkType: true, status: true, confidence: true },
    });
    const billsWithPeInArray = await prisma.congressBill.findMany({
      where: { peCodes: { has: pe } },
      select: { id: true, billType: true, billNumber: true },
    });

    const out: Record<string, unknown> = {
      pe,
      provisions: {
        acceptedPrograms: matches.map((m) => m.program.canonicalName),
        directLinksByBasis: directLinks.map((d) => ({ basis: d.matchBasis, status: d.reviewStatus, n: d._count._all })),
        programLinksByBasis: programLinks.map((d) => ({ basis: d.matchBasis, status: d.reviewStatus, n: d._count._all })),
      },
      bills: {
        billLinkRowsForPe: billLinksForPe.length,
        billLinkSample: billLinksForPe.slice(0, 8),
        billsWithPeInLegacyArray: billsWithPeInArray.map((b) => `${b.id} (${b.billType} ${b.billNumber})`),
      },
    };

    if (bill) {
      const links = await prisma.billBudgetLineLink.findMany({ where: { billId: bill } });
      const billRow = await prisma.congressBill.findUnique({
        where: { id: bill },
        select: { peCodes: true, title: true, latestActionText: true },
      });
      const text = await prisma.billText.findUnique({ where: { billId: bill }, select: { sourceUrl: true, textContent: true } });
      const codeInText = text ? new RegExp(`\\b${pe}\\b`, 'i').test(text.textContent) : null;
      out.billDetail = {
        billId: bill,
        exists: !!billRow,
        legacyPeCodes: billRow?.peCodes ?? null,
        linkRows: links.map((l) => ({ peCode: l.peCode, linkType: l.linkType, status: l.status, derivedBy: l.derivedBy })),
        cachedTextPresent: !!text,
        cachedTextSource: text?.sourceUrl ?? null,
        cachedTextLength: text?.textContent.length ?? 0,
        peCodePresentInCachedText: codeInText,
      };
    }

    console.log(JSON.stringify(out, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
