/**
 * Step 34 — PE-Person matcher. Populates `program_element_person_candidate` with
 * proposed person -> Program Element links for HUMAN review. NEVER writes
 * acquisition_personnel.pe_primary (a reviewer confirming a candidate does that via
 * resolvePersonCandidate).
 *
 *   pnpm --filter @capiro/api match:pe-person            # dry run (prints summary)
 *   pnpm --filter @capiro/api match:pe-person --apply    # insert candidates
 *   tsx scripts/match-pe-person.ts --apply --s2-min 0.6
 *
 * Idempotent: ON CONFLICT (person_id, pe_code) DO NOTHING. Re-running re-proposes
 * only newly-matchable people. Scope: people with pe_primary IS NULL.
 * Accuracy logic lives in PePersonMatcherService (unit-tested); this script is glue.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PePersonMatcherService, Service } from '../src/acquisition-personnel/matching/pe-person-matcher.service.js';

dotenvConfig();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes('--apply');
const S1_TRGM_MIN = Number(arg('s1-trgm-min') ?? 0.45);
const S2_MIN = Number(arg('s2-min') ?? 0.6);
const S3_MIN = Number(arg('s3-min') ?? 0.6);

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/match-pe-person.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }

  const prisma = new PrismaClient({ transactionOptions: { timeout: 120000, maxWait: 20000 } });
  try {
  await prisma.$connect();
  const matcher = new PePersonMatcherService();
  const source = 'pe_person_matcher';
  const run = await prisma.syncRun.create({ data: { source, startedAt: new Date(), status: 'running' } });

  try {
    await prisma.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', false)");

    const pes = await prisma.programElement.findMany({ select: { peCode: true, title: true } });
    const projects = await prisma.programElementProject.findMany({ select: { peCode: true, title: true } });

    const peIndex = pes.map((p) => ({ peCode: p.peCode, norm: matcher.norm(p.title), tg: matcher.trigrams(p.title), svc: matcher.peService(p.peCode) }));
    const byNormTitle = new Map<string, string[]>();
    for (const p of peIndex) { if (!byNormTitle.has(p.norm)) byNormTitle.set(p.norm, []); byNormTitle.get(p.norm)!.push(p.peCode); }
    const projectIndex = projects
      .filter((p) => (p.title ?? '').trim().length > 0)
      .map((p) => ({ peCode: p.peCode, tg: matcher.trigrams(p.title), svc: matcher.peService(p.peCode) as Service | null }));

    const people = await prisma.acquisitionPersonnel.findMany({
      where: { pePrimary: null },
      select: { id: true, service: true, organization: true, programOfRecord: true, metadata: true },
    });

    const proposals = people.flatMap((pr) => matcher.matchPerson(
      {
        id: pr.id,
        service: pr.service,
        organization: pr.organization,
        peTitle: ((pr.metadata as Record<string, unknown> | null)?.['peTitle'] as string) ?? null,
        programOfRecord: pr.programOfRecord,
      },
      peIndex, byNormTitle, projectIndex,
      { s1TrgmMin: S1_TRGM_MIN, s2Min: S2_MIN, s3Min: S3_MIN },
    ));

    const bySignal = proposals.reduce<Record<string, number>>((a, p) => { const s = String(p.breakdown.signal); a[s] = (a[s] ?? 0) + 1; return a; }, {});
    const byBand = proposals.reduce<Record<string, number>>((a, p) => { const b = p.score >= 0.9 ? '>=0.90' : p.score >= 0.7 ? '0.70-0.89' : p.score >= 0.5 ? '0.50-0.69' : '<0.50'; a[b] = (a[b] ?? 0) + 1; return a; }, {});

    let inserted = 0;
    if (APPLY) {
      for (const p of proposals) {
        inserted += await prisma.$executeRawUnsafe(
          `INSERT INTO program_element_person_candidate (id, person_id, pe_code, score, match_basis, score_breakdown_jsonb, status, created_at)
           VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5::jsonb, 'open', now())
           ON CONFLICT (person_id, pe_code) DO NOTHING`,
          p.personId, p.peCode, p.score, p.matchBasis, JSON.stringify(p.breakdown),
        );
      }
    }

    await prisma.syncRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), status: 'success', rowsInserted: inserted } });
    console.log(JSON.stringify({ source, mode: APPLY ? 'APPLIED' : 'DRY_RUN', people: people.length, proposals: proposals.length, inserted, bySignal, byBand }, null, 2));
  } catch (err) {
    await prisma.syncRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), status: 'error', errorMessage: String(err) } });
    throw err;
  }

  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
void main().catch((err) => { console.error(err); process.exit(1); });
}
