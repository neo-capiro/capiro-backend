/**
 * repair-person-pe-links.ts
 *
 *   tsx scripts/repair-person-pe-links.ts            # DRY RUN (counts + samples)
 *   tsx scripts/repair-person-pe-links.ts --commit   # clear stale links
 *   flags: --limit=N (cap changed people this run; 0 = all)
 *
 * Re-validates person->PE links against the authoritative PE set after the PE
 * retire pass. For each NON-superseded person:
 *   - pePrimary pointing at a non-authoritative PE (missing or retired) is CLEARED,
 *     UNLESS it was human-confirmed (a pe_match_confirmed source mention) — those
 *     are never auto-cleared.
 *   - peSecondary codes that aren't authoritative are stripped (secondary links are
 *     never human-confirmed; the candidate flow only ever sets pePrimary).
 * Authoritative = the PE still exists and retired_at IS NULL (a kept real-but-
 * uncovered stanford PE still counts — we only decided it's real).
 *
 * Cleared pePrimary becomes NULL, so a follow-up `generate-pe-person-candidates`
 * re-proposes the J-book-correct PE for human review (the matcher only scans
 * pe_primary IS NULL). Run AFTER reconcile-stale-pes. Idempotent.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { decideLinkRepair } from '../src/program-element/pe-staleness.js';

dotenvConfig();

const COMMIT = process.argv.includes('--commit');

function numArg(name: string, def: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return def;
  const v = Number(hit.split('=')[1]);
  return Number.isFinite(v) ? v : def;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/repair-person-pe-links.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const limit = numArg('limit', 0);
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    // Authoritative PE set: exists AND not retired.
    const authRows = await prisma.programElement.findMany({
      where: { retiredAt: null },
      select: { peCode: true },
    });
    const authoritative = new Set(authRows.map((r) => r.peCode));
    const isAuthoritativePe = (code: string) => authoritative.has(code);

    // Human-trusted links: a person with a pe_match_confirmed source mention (the
    // confirm flow writes one). Never auto-clear that person's pePrimary.
    const trustedRows = await prisma.acquisitionPersonnelSource.findMany({
      where: { source: 'pe_match_confirmed' },
      select: { personId: true },
    });
    const trusted = new Set(trustedRows.map((r) => r.personId));

    const people = await prisma.acquisitionPersonnel.findMany({
      where: {
        supersededAt: null,
        OR: [{ pePrimary: { not: null } }, { peSecondary: { isEmpty: false } }],
      },
      select: { id: true, fullName: true, pePrimary: true, peSecondary: true },
    });

    const changes: Array<{
      id: string;
      fullName: string;
      clearPrimary: boolean;
      newPeSecondary: string[];
    }> = [];
    let primaryCleared = 0;
    let secondaryStripped = 0;
    let trustedPrimaryKept = 0;

    for (const p of people) {
      const decision = decideLinkRepair({
        pePrimary: p.pePrimary,
        peSecondary: p.peSecondary,
        isAuthoritativePe,
        pePrimaryTrusted: trusted.has(p.id),
      });
      if (decision.reason === 'kept_trusted_primary_despite_unauthoritative_target') {
        trustedPrimaryKept += 1;
      }
      if (!decision.changed) continue;
      if (decision.clearPrimary) primaryCleared += 1;
      if (decision.newPeSecondary.length !== p.peSecondary.length) secondaryStripped += 1;
      changes.push({
        id: p.id,
        fullName: p.fullName,
        clearPrimary: decision.clearPrimary,
        newPeSecondary: decision.newPeSecondary,
      });
    }

    const capped = limit > 0 ? changes.slice(0, limit) : changes;

    let updated = 0;
    if (COMMIT && capped.length > 0) {
      const CHUNK = 50;
      for (let i = 0; i < capped.length; i += CHUNK) {
        const slice = capped.slice(i, i + CHUNK);
        await Promise.all(
          slice.map((c) =>
            prisma.acquisitionPersonnel.update({
              where: { id: c.id },
              data: {
                ...(c.clearPrimary ? { pePrimary: null } : {}),
                peSecondary: c.newPeSecondary,
              },
            }),
          ),
        );
        updated += slice.length;
      }
    }

    console.log(
      JSON.stringify(
        {
          mode: COMMIT ? 'COMMIT' : 'DRY_RUN',
          authoritativePeCount: authoritative.size,
          peopleWithLinks: people.length,
          wouldChange: changes.length,
          primaryCleared,
          secondaryStripped,
          trustedPrimaryKept,
          capApplied: limit > 0 ? limit : null,
          updated: COMMIT ? updated : 0,
          note: 'After commit, run generate-pe-person-candidates --commit to re-propose links for cleared people.',
          sample: capped
            .slice(0, 15)
            .map((c) => ({ name: c.fullName, clearedPrimary: c.clearPrimary })),
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
void main().catch((err) => {
  console.error(
    '[repair-person-pe-links] FAILED',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
}
