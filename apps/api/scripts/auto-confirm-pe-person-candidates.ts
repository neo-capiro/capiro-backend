import { config as dotenvConfig } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { inferRoleType } from '../src/acquisition-personnel/acquisition-personnel-read.service.js';
import { classifyContactUse } from '../src/acquisition-personnel/contact-use.policy.js';

/**
 * auto-confirm-pe-person-candidates.ts
 *
 * Bulk-approve high-confidence person -> Program Element candidates WITHOUT manual
 * review. Mirrors the per-candidate confirm path (resolvePersonCandidate): for each
 * OPEN candidate with score >= --min-score it, in one transaction,
 *   - sets acquisition_personnel.pe_primary (only if NULL — never clobbers a link),
 *   - records a citable acquisition_personnel_source, and
 *   - materializes an accepted PersonRole (person -> office; programId null),
 * then marks the candidate 'confirmed'. Idempotent (skips non-open) and
 * non-clobbering.
 *
 * REVERSIBLE: every write this batch makes carries source='pe_match_auto_confirmed'
 * (distinct from the manual 'pe_match_confirmed'), so an auto-approval sweep can find
 * and undo exactly these links. decisionNotes records the threshold + batch date.
 *
 * Usage:
 *   tsx scripts/auto-confirm-pe-person-candidates.ts                       # DRY RUN (counts + sample)
 *   tsx scripts/auto-confirm-pe-person-candidates.ts --min-score=0.8 --commit
 *   flags: --min-score=0.8 (default)  --limit=0 (0 = all)  --note="..."
 */
const AUTO_SOURCE = 'pe_match_auto_confirmed';

function arg(name: string, def: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1]! : def;
}

async function resolveOfficeId(
  prisma: PrismaService,
  organization: string | null,
): Promise<string | null> {
  const org = (organization ?? '').trim();
  if (!org) return null;
  const office = await prisma.programOffice.findFirst({
    where: { name: { equals: org, mode: 'insensitive' } },
    select: { id: true },
  });
  return office?.id ?? null;
}

async function main(): Promise<void> {
  dotenvConfig();
  const commit = process.argv.includes('--commit');
  const minScore = Number(arg('min-score', '0.8'));
  const limit = Number(arg('limit', '0')); // 0 = all
  const note = arg('note', `auto-confirmed: score>=${minScore} (batch)`);

  const prisma = new PrismaService();
  await prisma.onModuleInit();

  let scanned = 0;
  let linked = 0; // pe_primary newly set
  let confirmedOnly = 0; // person already had a pe_primary; candidate still confirmed
  let rolesCreated = 0;
  let errors = 0;

  try {
    const candidates = await prisma.programElementPersonCandidate.findMany({
      where: { status: 'open', score: { gte: minScore } },
      orderBy: [{ score: 'desc' }, { createdAt: 'asc' }],
      ...(limit > 0 ? { take: limit } : {}),
    });
    console.log(
      `[auto-confirm] ${candidates.length} OPEN candidates with score>=${minScore} (${commit ? 'COMMIT' : 'DRY-RUN'})`,
    );

    for (const c of candidates) {
      scanned += 1;
      if (!commit) {
        if (scanned <= 15) {
          console.log(
            `  would confirm: person=${c.personId} pe=${c.peCode} score=${c.score.toFixed(3)}`,
          );
        }
        continue;
      }
      try {
        await prisma.$transaction(async (tx) => {
          const before = await tx.acquisitionPersonnel.findUnique({
            where: { id: c.personId },
            select: { pePrimary: true, organization: true, title: true, role: true },
          });
          const applied = await tx.acquisitionPersonnel.updateMany({
            where: { id: c.personId, pePrimary: null },
            data: { pePrimary: c.peCode },
          });
          if (applied.count > 0) linked += 1;
          else confirmedOnly += 1;

          await tx.acquisitionPersonnelSource.create({
            data: {
              personId: c.personId,
              source: AUTO_SOURCE,
              sourceUrl: null,
              snippet: `Auto-linked to PE ${c.peCode} (score ${c.score.toFixed(3)} >= ${minScore}). Match basis: ${c.matchBasis ?? 'n/a'}.`,
              observedAt: new Date(),
              confidence: c.score,
              metadata: {
                candidateId: c.id,
                peCode: c.peCode,
                score: c.score,
                autoConfirmed: true,
                minScore,
              },
            },
          });

          const roleTitle = (before?.title || before?.role || 'Program team member').trim();
          const existingRole = await tx.personRole.findFirst({
            where: { personId: c.personId, roleTitle, source: AUTO_SOURCE },
            select: { id: true },
          });
          if (!existingRole) {
            const officeId = await resolveOfficeId(prisma, before?.organization ?? null);
            const roleType = inferRoleType(before?.role, before?.title);
            await tx.personRole.create({
              data: {
                personId: c.personId,
                officeId,
                programId: null,
                roleTitle,
                roleType,
                source: AUTO_SOURCE,
                sourceUrl: null,
                observedAt: new Date(),
                confidence: c.score,
                reviewStatus: 'accepted',
                contactUse: classifyContactUse({
                  roleType,
                  source: AUTO_SOURCE,
                  reviewStatus: 'accepted',
                }),
              },
            });
            rolesCreated += 1;
          }

          await tx.programElementPersonCandidate.update({
            where: { id: c.id },
            data: { status: 'confirmed', resolvedAt: new Date(), decisionNotes: note },
          });
        });
      } catch (err) {
        errors += 1;
        console.error(`  confirm failed for person=${c.personId} pe=${c.peCode}: ${String(err)}`);
      }
    }

    console.log(
      JSON.stringify(
        { minScore, commit, scanned, linked, confirmedOnly, rolesCreated, errors },
        null,
        2,
      ),
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

const isDirectRun = /auto-confirm-pe-person-candidates(\.[cm]?[tj]s)?$/.test(
  (process.argv[1] ?? '').replace(/\\/g, '/'),
);
if (isDirectRun) {
  void main().catch((err) => {
    console.error('[auto-confirm] FAILED', err);
    process.exit(1);
  });
}

export { main };
