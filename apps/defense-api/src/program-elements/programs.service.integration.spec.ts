/**
 * Database-backed regression test for a Session 3 bug found during old-vs-new
 * parity review against apps/api's programs.service.mergePrograms:
 *
 *  - mergePrograms hard-deleted the loser Program row and bulk-updateMany'd
 *    its aliases/matches onto the keeper with no collision handling. Any real
 *    merge where the keeper already had an alias with the same
 *    (aliasNormalized, aliasType) hit the DB's own unique constraint
 *    (program_alias_program_norm_type_key) and aborted the whole transaction;
 *    even when it didn't collide, the loser's row (and its history) was
 *    permanently gone.
 *  - Fixed to dedupe per-row against the keeper and retire the loser (status
 *    'merged') instead of deleting it, matching apps/api's safety net.
 *
 * Skipped unless REHEARSAL_DATABASE_URL/REHEARSAL_ADMIN_URL/REHEARSAL_SERVE_URL
 * are set — verify-phase8-session3-db.sh sets these up before running
 * `pnpm --filter @capiro/defense-api test`, so `pnpm test` alone still runs
 * with no database and no regression.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.ts';
import { ProgramsService } from './programs.service.ts';

const ADMIN_URL = process.env.REHEARSAL_DATABASE_URL;
const SERVE_URL = process.env.REHEARSAL_SERVE_URL;
const RUN = Boolean(ADMIN_URL && SERVE_URL);

test('mergePrograms dedupes colliding rows and retires (not deletes) the loser (regression)', { skip: !RUN }, async (t) => {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL as string } } });
  const priorDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = SERVE_URL;
  const prisma = new PrismaService();

  t.after(async () => {
    await prisma.$disconnect();
    await admin.$disconnect();
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  });

  const suffix = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const userId = randomUUID();
  await admin.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $3)`,
    tenantId,
    `p8s3-merge-rehearsal-${suffix}`,
    `P8S3 Merge Rehearsal ${suffix}`,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO users (id, clerk_user_id, email) VALUES ($1::uuid, $2, $3)`,
    userId,
    `p8s3-merge-rehearsal-${suffix}`,
    `p8s3-merge-rehearsal-${suffix}@example.test`,
  );

  const keepId = randomUUID();
  const mergeId = randomUUID();
  const now = new Date();
  for (const [id, name] of [[keepId, 'Keeper Program'], [mergeId, 'Loser Program']] as const) {
    await admin.program.create({
      data: { id, canonicalName: `${name} ${suffix}`, status: 'active', metadata: {}, createdAt: now, updatedAt: now },
    });
  }

  // A colliding alias: same (aliasNormalized, aliasType) on both keeper and
  // loser — real DB unique constraint program_alias_program_norm_type_key.
  // Before the fix, the bulk updateMany hit this constraint and aborted the
  // entire merge.
  const keeperAliasId = randomUUID();
  const collidingAliasId = randomUUID();
  const uniqueAliasId = randomUUID();
  await admin.programAlias.create({
    data: { id: keeperAliasId, programId: keepId, alias: 'SHARED NAME', aliasNormalized: 'SHARED NAME', aliasType: 'former_name', source: 'manual', confidence: 1, createdAt: now, updatedAt: now },
  });
  await admin.programAlias.create({
    data: { id: collidingAliasId, programId: mergeId, alias: 'SHARED NAME', aliasNormalized: 'SHARED NAME', aliasType: 'former_name', source: 'manual', confidence: 1, createdAt: now, updatedAt: now },
  });
  await admin.programAlias.create({
    data: { id: uniqueAliasId, programId: mergeId, alias: 'ONLY ON LOSER', aliasNormalized: 'ONLY ON LOSER', aliasType: 'former_name', source: 'manual', confidence: 1, createdAt: now, updatedAt: now },
  });

  // A colliding match: same (peCode, projectCode) on both keeper and loser.
  // Seeded via raw SQL: pe_program_match.evidence_tier and .updated_at are
  // NOT NULL on the shared physical table but aren't in defense-api's own
  // (intentionally reduced) PeProgramMatch Prisma model, so its generated
  // client can't set them.
  const peCode = `MG${suffix.slice(0, 6).toUpperCase()}`;
  const keeperMatchId = randomUUID();
  const collidingMatchId = randomUUID();
  const uniqueMatchId = randomUUID();
  const insertMatch = (id: string, code: string, programId: string, status: string, score: number) =>
    admin.$executeRawUnsafe(
      `INSERT INTO pe_program_match
         (id, pe_code, project_code, program_id, score, evidence_tier, status, weak_signal, created_at, updated_at)
       VALUES ($1::uuid, $2, NULL, $3::uuid, $4, 'manual_seed', $5, false, $6, $6)`,
      id,
      code,
      programId,
      score,
      status,
      now,
    );
  await insertMatch(keeperMatchId, peCode, keepId, 'accepted', 0.9);
  await insertMatch(collidingMatchId, peCode, mergeId, 'candidate', 0.5);
  await insertMatch(uniqueMatchId, `${peCode}X`, mergeId, 'candidate', 0.6);

  const service = new ProgramsService(prisma);
  const result = await service.mergePrograms({ keepProgramId: keepId, mergeProgramId: mergeId }, { tenantId, userId, role: 'capiro_admin' });

  assert.equal(result.keepProgramId, keepId);
  assert.equal(result.mergedProgramId, mergeId);
  assert.equal(result.repointed.aliasesDropped, 1, 'the colliding alias must be dropped, not thrown on');
  assert.equal(result.repointed.aliasesCopied, 1, 'the non-colliding alias must be repointed to the keeper');
  assert.equal(result.repointed.matchesDropped, 1, 'the colliding match must be dropped, not thrown on');
  assert.equal(result.repointed.matchesRepointed, 1, 'the non-colliding match must be repointed to the keeper');

  // The loser must still exist (retired), never hard-deleted.
  const loser = await admin.program.findUnique({ where: { id: mergeId } });
  assert.ok(loser, 'the loser Program row must survive the merge, not be deleted');
  assert.equal(loser?.status, 'merged');
  assert.equal((loser?.metadata as Record<string, unknown>)?.mergedInto, keepId);

  // The keeper must end up with exactly one alias per distinct normalized key
  // (no duplicate), and both the originally-owned and newly-repointed alias.
  const keeperAliases = await admin.programAlias.findMany({ where: { programId: keepId } });
  assert.equal(keeperAliases.length, 2);
  assert.deepEqual(keeperAliases.map((a) => a.aliasNormalized).sort(), ['ONLY ON LOSER', 'SHARED NAME']);

  const keeperMatches = await admin.peProgramMatch.findMany({ where: { programId: keepId } });
  assert.equal(keeperMatches.length, 2);
  assert.deepEqual(keeperMatches.map((m) => m.peCode).sort(), [peCode, `${peCode}X`].sort());
});
