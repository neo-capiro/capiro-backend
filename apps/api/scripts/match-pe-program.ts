/**
 * match-pe-program.ts — Step 2.1 — propose NEW candidate PE/project -> Program
 * matches into `pe_program_match` for HUMAN review. NEVER auto-accepts a fuzzy
 * match: the matcher emits only fuzzy evidence tiers, so the derived status can only
 * ever be 'candidate' or 'quarantined' (see program-match-thresholds).
 *
 *   pnpm --filter @capiro/api match:pe-program            # dry run (prints summary)
 *   pnpm --filter @capiro/api match:pe-program --apply    # insert candidates
 *   tsx scripts/match-pe-program.ts --apply --trgm-min 0.5
 *
 * Idempotent: skips (pe, program) pairs that already have a row (curated/accepted or
 * a prior proposal) so it never clobbers a human decision or duplicates. Accuracy
 * logic lives in PeProgramMatcherService (unit-tested); this script is glue.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  PeProgramMatcherService,
  type Component,
  type ProgramAliasRow,
  type OtherFundingLink,
} from '../src/program-element/matching/pe-program-matcher.service.js';

dotenvConfig();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes('--apply');
const TRGM_MIN = Number(arg('trgm-min') ?? 0.45);
const MIN_ALIAS_LEN = Number(arg('min-alias-len') ?? 6);

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/match-pe-program.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }

  const prisma = new PrismaClient({ transactionOptions: { timeout: 120000, maxWait: 20000 } });
  try {
  await prisma.$connect();
  const matcher = new PeProgramMatcherService();
  const source = 'pe_program_matcher';
  const run = await prisma.syncRun.create({ data: { source, startedAt: new Date(), status: 'running' } });

  try {
    await prisma.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', false)");

    // Alias universe (with program component) -> trigram index.
    const aliases = await prisma.programAlias.findMany({
      select: { programId: true, aliasNormalized: true, aliasType: true, program: { select: { component: true } } },
    });
    const aliasIndex = aliases.map((a) => ({
      programId: a.programId,
      aliasNormalized: a.aliasNormalized,
      aliasType: a.aliasType,
      component: (a.program.component as Component | null) ?? null,
      tg: matcher.trigrams(a.aliasNormalized),
    })) satisfies Array<ProgramAliasRow & { tg: Set<string> }>;

    // PE titles + R-2A project titles.
    const pes = await prisma.programElement.findMany({ select: { peCode: true, title: true } });
    const projects = await prisma.programElementProject.findMany({
      select: { peCode: true, projectCode: true, title: true },
    });
    const projByPe = new Map<string, Array<{ peCode: string; projectCode: string; title: string }>>();
    for (const p of projects) {
      const arr = projByPe.get(p.peCode) ?? [];
      arr.push({ peCode: p.peCode, projectCode: p.projectCode, title: p.title });
      projByPe.set(p.peCode, arr);
    }

    // Existing (pe, program) pairs — never duplicate or clobber.
    const existing = await prisma.peProgramMatch.findMany({ select: { peCode: true, programId: true } });
    const existingPairs = new Set(existing.map((e) => `${e.peCode}::${e.programId}`));

    // Other-funding boost (step 1.5) is not yet wired; pass an empty signal map so the
    // matcher runs cleanly. When step 1.5 lands, populate this per (peCode -> program).
    const otherFundingByProgram = new Map<string, OtherFundingLink>();

    const proposals = pes.flatMap((pe) =>
      matcher.matchPe(
        { peCode: pe.peCode, title: pe.title },
        projByPe.get(pe.peCode) ?? [],
        aliasIndex,
        otherFundingByProgram,
        { trgmMin: TRGM_MIN, minAliasLen: MIN_ALIAS_LEN },
      ),
    );

    // Drop proposals against a program the PE is already linked to.
    const fresh = proposals.filter((p) => !existingPairs.has(`${p.peCode}::${p.programId}`));

    const byStatus = fresh.reduce<Record<string, number>>((a, p) => {
      a[p.status] = (a[p.status] ?? 0) + 1;
      return a;
    }, {});
    const byBand = fresh.reduce<Record<string, number>>((a, p) => {
      const b = p.score >= 0.9 ? '>=0.90' : p.score >= 0.7 ? '0.70-0.89' : p.score >= 0.5 ? '0.50-0.69' : '<0.50';
      a[b] = (a[b] ?? 0) + 1;
      return a;
    }, {});
    // Hard invariant proof: a fuzzy proposal must NEVER be 'accepted'.
    const fuzzyAccepted = fresh.filter((p) => p.status === 'accepted').length;

    let inserted = 0;
    if (APPLY) {
      if (fuzzyAccepted > 0) {
        throw new Error(`INVARIANT VIOLATION: ${fuzzyAccepted} fuzzy proposals derived status=accepted; refusing to apply`);
      }
      for (const p of fresh) {
        inserted += await prisma.$executeRawUnsafe(
          `INSERT INTO pe_program_match
             (id, pe_code, project_code, program_id, score, evidence_tier, evidence_jsonb,
              status, weak_signal, match_basis, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3::uuid, $4, $5, $6::jsonb, $7, $8, $9, now(), now())
           ON CONFLICT (pe_code, (COALESCE(project_code, '')), program_id) DO NOTHING`,
          p.peCode,
          p.projectCode,
          p.programId,
          p.score,
          p.evidenceTier,
          JSON.stringify(p.evidence),
          p.status,
          p.weakSignal,
          p.matchBasis,
        );
      }
    }

    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'success', rowsInserted: inserted },
    });
    console.log(
      JSON.stringify(
        {
          source,
          mode: APPLY ? 'APPLIED' : 'DRY_RUN',
          pes: pes.length,
          aliases: aliasIndex.length,
          proposals: proposals.length,
          freshProposals: fresh.length,
          fuzzyAccepted,
          inserted,
          byStatus,
          byBand,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: 'error', errorMessage: String(err) },
    });
    throw err;
  }

  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
}
