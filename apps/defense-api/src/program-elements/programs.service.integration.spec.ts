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
  // A REAL active capiro_admin membership is now required, not just a ctx object
  // claiming `role: 'capiro_admin'`. The merge runs inside
  // capiro_defense_merge_programs, which rechecks membership in the database — so a
  // caller the application believes is an admin but the database does not is
  // refused. That is the whole point of the governed boundary, and it is why this
  // seed grew a membership row: without it the test 403s, correctly.
  await admin.$executeRawUnsafe(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role, status)
     VALUES ($1::uuid, $2::uuid, 'capiro_admin', 'active')`,
    tenantId,
    userId,
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

  // A person_role and a provision_pe_link on the loser. apps/api repoints BOTH
  // (person_role has no unique on program_id -> straight UPDATE; provision_pe_link
  // is keyed on (provisionId, peCode ?? '') -> dedupe). The prior defense-api
  // implementation touched neither, so a merge silently orphaned the loser's
  // people and its committee report language.
  const personId = randomUUID();
  const roleId = randomUUID();
  await admin.$executeRawUnsafe(
    `INSERT INTO acquisition_personnel (id, full_name, name_key, updated_at)
     VALUES ($1::uuid, $2, $3, $4)`,
    personId,
    `P8S3 Rehearsal Person ${suffix}`,
    `p8s3-rehearsal-person-${suffix}`,
    now,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO person_role
       (id, person_id, program_id, role_title, role_type, source, observed_at, contact_use, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'PM', 'pm', 'p8s3-rehearsal', $4, 'program_ownership_context', $4, $4)`,
    roleId,
    personId,
    mergeId,
    now,
  );

  const sourceDocId = randomUUID();
  const provisionId = randomUUID();
  const provLinkId = randomUUID();
  await admin.$executeRawUnsafe(
    `INSERT INTO source_document
       (id, source_key, budget_cycle, document_type, title, source_url, extraction_method)
     VALUES ($1::uuid, $2, 'hasc', 'committee_report', $3, $4, 'manual')`,
    sourceDocId,
    `p8s3-merge-${suffix}`,
    `P8S3 Merge Rehearsal Report ${suffix}`,
    `https://example.test/p8s3-merge-${suffix}`,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO committee_report_provision
       (id, source_document_id, committee, fy, heading, text, updated_at)
     VALUES ($1::uuid, $2::uuid, 'HASC', 2027, 'Rehearsal heading', 'Rehearsal provision text', $3)`,
    provisionId,
    sourceDocId,
    now,
  );
  await admin.$executeRawUnsafe(
    `INSERT INTO provision_pe_link
       (id, provision_id, program_id, match_basis, review_status, confidence, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'program_alias', 'accepted', 0.8, $4)`,
    provLinkId,
    provisionId,
    mergeId,
    now,
  );

  const service = new ProgramsService(prisma);
  const result = await service.mergePrograms({ keepProgramId: keepId, mergeProgramId: mergeId }, { tenantId, userId, role: 'capiro_admin' });

  // Envelope is apps/api's, field-for-field: { merged, keepProgramId,
  // mergeProgramId, repointed: { matches, roles, officeLinks, provisionLinks },
  // aliasesCopied }. The per-table DELETE counts stay in the audit log, not the
  // response, so collision-dedup is asserted below against real DB state -- a
  // stronger check than trusting a counter the implementation reports about itself.
  assert.equal(result.merged, true);
  assert.equal(result.keepProgramId, keepId);
  assert.equal(result.mergeProgramId, mergeId);
  assert.equal(result.aliasesCopied, 1, 'the non-colliding alias must be repointed to the keeper');
  assert.equal(result.repointed.matches, 1, 'the non-colliding match must be repointed to the keeper');
  assert.equal(result.repointed.roles, 1, 'a person_role on the loser must be repointed, not orphaned');
  assert.equal(
    result.repointed.provisionLinks,
    1,
    'a non-colliding provision_pe_link on the loser must be repointed, not orphaned',
  );

  // The loser must be left holding NOTHING: every colliding row deleted, every
  // non-colliding row repointed. A row still pointing at a retired program is
  // exactly the silent data-loss this merge exists to avoid.
  // ALIASES ARE THE ONE EXCEPTION, and it is apps/api's behaviour, not an
  // oversight: a loser alias whose (aliasNormalized, aliasType) the keeper ALREADY
  // has is left where it is (`continue`), not deleted -- the keeper already carries
  // an equivalent alias, and the loser row is retired, so nothing is lost and no
  // history is destroyed. Only the non-colliding alias moves. defense-api matches
  // that exactly; the PRIOR implementation deleted the colliding row, which was a
  // silent divergence from apps/api in the destructive direction.
  const loserAliasesAfter = await admin.programAlias.findMany({ where: { programId: mergeId } });
  assert.deepEqual(
    loserAliasesAfter.map((a) => a.aliasNormalized),
    ['SHARED NAME'],
    'exactly the colliding alias stays with the retired loser, matching apps/api',
  );
  assert.equal(
    await admin.peProgramMatch.count({ where: { programId: mergeId } }),
    0,
    'no pe_program_match may still point at the retired loser',
  );
  assert.equal(
    await admin.personRole.count({ where: { programId: mergeId } }),
    0,
    'no person_role may still point at the retired loser',
  );
  assert.equal(
    await admin.provisionPeLink.count({ where: { programId: mergeId } }),
    0,
    'no provision_pe_link may still point at the retired loser',
  );

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
