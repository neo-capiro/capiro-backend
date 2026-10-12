/** @cleanup-smoke noArgsExit=2 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { topPeCandidates, PeText } from '../src/program-element/matching/pe-person-matcher.js';

/**
 * generate-pe-person-candidates.ts
 *
 * Phase 1b: propose person -> Program Element links for HUMAN REVIEW. This NEVER
 * sets acquisition_personnel.pe_primary directly — it only fills the
 * program_element_person_candidate review queue. A reviewer confirms a candidate,
 * which is what then applies the link.
 *
 * Signal (deterministic, no LLM, auditable):
 *   - For each unmapped person (pe_primary IS NULL), overlap their org/title text
 *     against each PE's title + its project titles.
 *   - Distinctive program acronyms (AMPV, THAAD, ...) and distinctive words drive
 *     the score; generic acquisition words are stopworded out (see matcher).
 *   - Only candidates >= threshold (default 0.5) are queued, top N per person.
 *
 * Usage:
 *   tsx scripts/generate-pe-person-candidates.ts            # DRY RUN (prints stats + samples)
 *   tsx scripts/generate-pe-person-candidates.ts --commit   # upsert into review queue
 *   flags: --threshold=0.5  --limit=3  --max-people=0(all)
 */

function arg(name: string, def: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1]! : def;
}

async function main(): Promise<void> {
  dotenvConfig();
  if (!process.env.DATABASE_URL) {
    console.error('Usage: generate-pe-person-candidates [--threshold=<n>] [--limit=<n>] [--max-people=<n>] [--commit] (requires DATABASE_URL)');
    process.exitCode = 2;
    return;
  }
  const commit = process.argv.includes('--commit');
  const threshold = Number(arg('threshold', '0.7'));
  const limit = Number(arg('limit', '3'));
  const maxPeople = Number(arg('max-people', '0')); // 0 = all

  const prisma = new PrismaService();
  await prisma.onModuleInit();

  try {
    // Build PE text corpus: title + all project titles, grouped by pe_code.
    const pes = await prisma.programElement.findMany({ select: { peCode: true, title: true } });
    const projects = await prisma.programElementProject.findMany({ select: { peCode: true, title: true } });
    const projByPe = new Map<string, string[]>();
    for (const p of projects) {
      const arr = projByPe.get(p.peCode) ?? [];
      arr.push(p.title);
      projByPe.set(p.peCode, arr);
    }
    const peTexts: PeText[] = pes.map((pe) => ({
      peCode: pe.peCode,
      text: [pe.title ?? '', ...(projByPe.get(pe.peCode) ?? [])].join(' '),
    }));

    // Unmapped people with some org/title signal.
    const people = await prisma.acquisitionPersonnel.findMany({
      where: {
        pePrimary: null,
        OR: [{ organization: { not: null } }, { title: { not: null } }],
      },
      select: { id: true, fullName: true, organization: true, title: true, programOfRecord: true },
      ...(maxPeople > 0 ? { take: maxPeople } : {}),
    });

    let peopleWithCandidates = 0;
    let totalCandidates = 0;
    let written = 0;
    const samples: Array<{ person: string; org: string | null; peCode: string; score: number; basis: string }> = [];

    for (const person of people) {
      const cands = topPeCandidates(
        { organization: person.organization, title: person.title, programOfRecord: person.programOfRecord },
        peTexts,
        threshold,
        limit,
      );
      if (cands.length === 0) continue;
      peopleWithCandidates += 1;
      totalCandidates += cands.length;

      for (const c of cands) {
        if (samples.length < 30) {
          samples.push({ person: person.fullName, org: person.organization, peCode: c.peCode, score: c.score, basis: c.matchBasis });
        }
        if (commit) {
          await prisma.programElementPersonCandidate.upsert({
            where: { personId_peCode: { personId: person.id, peCode: c.peCode } },
            create: {
              personId: person.id,
              peCode: c.peCode,
              score: c.score,
              matchBasis: c.matchBasis,
              scoreBreakdown: c.breakdown as unknown as object,
              status: 'open',
            },
            update: {
              // Refresh score/basis on re-run, but never clobber a human decision.
              score: c.score,
              matchBasis: c.matchBasis,
              scoreBreakdown: c.breakdown as unknown as object,
            },
          });
          written += 1;
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          mode: commit ? 'COMMIT' : 'DRY_RUN',
          threshold,
          limit_per_person: limit,
          unmapped_people_scanned: people.length,
          pe_corpus_size: peTexts.length,
          people_with_candidates: peopleWithCandidates,
          total_candidates: totalCandidates,
          candidates_written: written,
        },
        null,
        2,
      ),
    );
    console.log('\nSAMPLE CANDIDATES (for quality review):');
    for (const s of samples) {
      console.log(`  [${s.score}] ${s.person}  (${s.org ?? '—'})  ->  ${s.peCode}   ::  ${s.basis}`);
    }
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main();
