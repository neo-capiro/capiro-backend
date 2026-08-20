/**
 * Database-backed proof of the governed Program-graph admin boundary.
 *
 * Security model ported from the concurrent Session 3 branch (PR #1044); these
 * tests execute it against a REAL migrated database as the REAL serve login, so
 * the boundary is demonstrated rather than described.
 *
 * What each case proves, and why it is not redundant with the static verifier:
 *  - a standard_user actor CANNOT effect an admin mutation, even though the SQL
 *    is well-formed and the row exists. The verifier can only prove the recheck
 *    is written; only this proves it fires.
 *  - a capiro_admin actor CAN.
 *  - direct DML by the serve role FAILS. If it succeeded, every function above
 *    would be decoration.
 *  - the audit row lands with the real physical timestamp column.
 *
 * Skipped unless REHEARSAL_DATABASE_URL / REHEARSAL_SERVE_URL are set;
 * verify-phase8-session3-db.sh provides both, so `pnpm test` alone stays offline.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.ts';
import { ProgramsService } from './programs.service.ts';

const ADMIN_URL = process.env.REHEARSAL_DATABASE_URL;
const SERVE_URL = process.env.REHEARSAL_SERVE_URL;
const RUN = Boolean(ADMIN_URL && SERVE_URL);

interface Fixture {
  admin: PrismaClient;
  prisma: PrismaService;
  tenantId: string;
  adminUserId: string;
  standardUserId: string;
  keepId: string;
  loserId: string;
  aliasId: string;
  matchId: string;
  suffix: string;
}

async function seed(t: { after: (fn: () => Promise<void> | void) => void }): Promise<Fixture> {
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
  const adminUserId = randomUUID();
  const standardUserId = randomUUID();
  const now = new Date();

  await admin.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $3)`,
    tenantId,
    `p8s3-admin-sec-${suffix}`,
    `P8S3 Admin Security ${suffix}`,
  );
  for (const [id, label] of [
    [adminUserId, 'admin'],
    [standardUserId, 'standard'],
  ] as const) {
    await admin.$executeRawUnsafe(
      `INSERT INTO users (id, clerk_user_id, email) VALUES ($1::uuid, $2, $3)`,
      id,
      `p8s3-admin-sec-${label}-${suffix}`,
      `p8s3-admin-sec-${label}-${suffix}@example.test`,
    );
  }
  // The DB recheck keys off an ACTIVE capiro_admin membership specifically.
  await admin.$executeRawUnsafe(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role, status) VALUES
       ($1::uuid, $2::uuid, 'capiro_admin', 'active'),
       ($1::uuid, $3::uuid, 'standard_user', 'active')`,
    tenantId,
    adminUserId,
    standardUserId,
  );

  const keepId = randomUUID();
  const loserId = randomUUID();
  for (const [id, name] of [
    [keepId, 'Keeper'],
    [loserId, 'Loser'],
  ] as const) {
    await admin.$executeRawUnsafe(
      `INSERT INTO program (id, canonical_name, status, metadata_jsonb, created_at, updated_at)
       VALUES ($1::uuid, $2, 'active', '{}'::jsonb, $3, $3)`,
      id,
      `${name} Program ${suffix}`,
      now,
    );
  }

  const aliasId = randomUUID();
  await admin.$executeRawUnsafe(
    `INSERT INTO program_alias
       (id, program_id, alias, alias_normalized, alias_type, source, confidence, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'former_name', 'manual', 1, $5, $5)`,
    aliasId,
    loserId,
    `SEC ALIAS ${suffix}`,
    `SEC ALIAS ${suffix}`.toUpperCase(),
    now,
  );

  const matchId = randomUUID();
  await admin.$executeRawUnsafe(
    `INSERT INTO pe_program_match
       (id, pe_code, project_code, program_id, score, evidence_tier, status, weak_signal, created_at, updated_at)
     VALUES ($1::uuid, $2, NULL, $3::uuid, 0.75, 'award_match', 'candidate', false, $4, $4)`,
    matchId,
    `SC${suffix.slice(0, 6).toUpperCase()}`,
    keepId,
    now,
  );

  return {
    admin,
    prisma,
    tenantId,
    adminUserId,
    standardUserId,
    keepId,
    loserId,
    aliasId,
    matchId,
    suffix,
  };
}

test(
  'GOVERNED ADMIN: a standard_user actor cannot effect a Program graph mutation',
  { skip: !RUN },
  async (t) => {
    const f = await seed(t);
    const service = new ProgramsService(f.prisma);

    // The SQL is well-formed and the row exists; only the in-database
    // capiro_admin recheck stands between this call and a global mutation.
    await assert.rejects(
      () =>
        service.resolveMatch(
          f.matchId,
          { decision: 'reject' },
          { tenantId: f.tenantId, userId: f.standardUserId, role: 'standard_user' },
        ),
      (error: Error) => {
        // The exact HTTP contract: a 403 ForbiddenException, not a 400 or a 500.
        // The application believed this caller was an admin and the database
        // disagreed, which is an authorization failure and must read as one.
        assert.ok(
          error instanceof ForbiddenException,
          `expected ForbiddenException, got ${error.constructor.name}`,
        );
        assert.match(error.message, /active capiro_admin membership required/i);
        assert.equal((error as { status?: number }).status, 403);
        return true;
      },
      'a standard_user must not be able to resolve a match',
    );

    // ...and nothing changed.
    const after = await f.admin.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT status FROM pe_program_match WHERE id = $1::uuid`,
      f.matchId,
    );
    assert.equal(after[0]?.status, 'candidate', 'the refused call must not have mutated the row');

    await assert.rejects(
      () =>
        service.mergePrograms(
          { keepProgramId: f.keepId, mergeProgramId: f.loserId },
          { tenantId: f.tenantId, userId: f.standardUserId, role: 'standard_user' },
        ),
      /active capiro_admin membership required/i,
      'a standard_user must not be able to merge programs',
    );
    const loser = await f.admin.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT status FROM program WHERE id = $1::uuid`,
      f.loserId,
    );
    assert.equal(loser[0]?.status, 'active', 'the refused merge must not have retired the loser');
  },
);

test(
  'GOVERNED ADMIN: a capiro_admin actor succeeds and the audit row uses occurred_at',
  { skip: !RUN },
  async (t) => {
    const f = await seed(t);
    const service = new ProgramsService(f.prisma);
    const ctx = { tenantId: f.tenantId, userId: f.adminUserId, role: 'capiro_admin' };

    const resolved = await service.resolveMatch(f.matchId, { decision: 'accept', notes: ' ok ' }, ctx);
    assert.deepEqual(resolved, {
      resolved: true,
      id: f.matchId,
      status: 'accepted',
      decision: 'accept',
    });

    const row = await f.admin.$queryRawUnsafe<
      Array<{ status: string; weak_signal: boolean; decision_notes: string | null; resolved_by_user_id: string }>
    >(
      `SELECT status, weak_signal, decision_notes, resolved_by_user_id::text AS resolved_by_user_id
       FROM pe_program_match WHERE id = $1::uuid`,
      f.matchId,
    );
    assert.equal(row[0]?.status, 'accepted');
    assert.equal(row[0]?.weak_signal, false, 'accept clears the weak-signal flag');
    assert.equal(row[0]?.decision_notes, 'ok', 'notes are trimmed by the function');
    assert.equal(row[0]?.resolved_by_user_id, f.adminUserId);

    // audit_logs has occurred_at and NO created_at; a function writing created_at
    // would have failed outright, so this asserts the corrected column is used.
    const audit = await f.admin.$queryRawUnsafe<
      Array<{ action: string; actor_role: string; occurred_at: Date }>
    >(
      `SELECT action, actor_role, occurred_at FROM audit_logs
       WHERE tenant_id = $1::uuid AND action = 'program.match.resolve'`,
      f.tenantId,
    );
    assert.equal(audit.length, 1, 'exactly one audit row for the governed resolve');
    assert.equal(audit[0]?.actor_role, 'capiro_admin');
    assert.ok(audit[0]?.occurred_at instanceof Date, 'occurred_at must be populated');

    const columns = await f.admin.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'audit_logs' AND column_name = 'created_at'`,
    );
    assert.equal(columns.length, 0, 'audit_logs.created_at does not exist — occurred_at is the real column');
  },
);

test(
  'GOVERNED ADMIN: the serve role holds no direct DML on the global Program graph',
  { skip: !RUN },
  async (t) => {
    const f = await seed(t);

    // Raw statements as the REAL serve login. Each must be refused by PostgreSQL
    // itself, not by application code.
    const serve = new PrismaClient({ datasources: { db: { url: SERVE_URL as string } } });
    t.after(async () => {
      await serve.$disconnect();
    });

    const denied: Array<[string, string]> = [
      ['UPDATE program SET status', `UPDATE program SET status = 'merged' WHERE id = '${f.loserId}'::uuid`],
      ['DELETE program_alias', `DELETE FROM program_alias WHERE id = '${f.aliasId}'::uuid`],
      [
        'INSERT program_alias',
        `INSERT INTO program_alias (id, program_id, alias, alias_normalized, alias_type, source, confidence, created_at, updated_at)
         VALUES (gen_random_uuid(), '${f.keepId}'::uuid, 'X', 'X', 'acronym', 'manual', 1, now(), now())`,
      ],
      ['UPDATE pe_program_match', `UPDATE pe_program_match SET status = 'accepted' WHERE id = '${f.matchId}'::uuid`],
      ['UPDATE person_role', `UPDATE person_role SET program_id = '${f.keepId}'::uuid WHERE false`],
      [
        'UPDATE program_office_program_link',
        `UPDATE program_office_program_link SET program_id = '${f.keepId}'::uuid WHERE false`,
      ],
      ['UPDATE provision_pe_link', `UPDATE provision_pe_link SET program_id = '${f.keepId}'::uuid WHERE false`],
    ];

    for (const [label, sql] of denied) {
      await assert.rejects(
        () => serve.$executeRawUnsafe(sql),
        /permission denied/i,
        `the serve role must not be able to: ${label}`,
      );
    }

    // The internal admin gate is not a membership oracle the serve role can probe.
    await assert.rejects(
      () =>
        serve.$queryRawUnsafe(
          `SELECT capiro_defense_require_admin('${f.tenantId}'::uuid, '${f.adminUserId}'::uuid)`,
        ),
      /permission denied/i,
      'capiro_defense_require_admin must not be directly callable by the serve role',
    );

    // SELECT still works — the graph is readable, just not writable.
    const readable = await serve.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM program WHERE id = '${f.keepId}'::uuid`,
    );
    assert.equal(Number(readable[0]?.count), 1, 'the serve role must retain SELECT on the graph');
  },
);

test(
  'GOVERNED ADMIN: alias CRUD and merge run through the functions with validation intact',
  { skip: !RUN },
  async (t) => {
    const f = await seed(t);
    const service = new ProgramsService(f.prisma);
    const ctx = { tenantId: f.tenantId, userId: f.adminUserId, role: 'capiro_admin' };

    // TypeScript validation still owns the HTTP error semantics.
    await assert.rejects(
      () => service.createAlias(f.keepId, { alias: 'Congressional Adds', aliasType: 'acronym' }, ctx),
      /generic accounting category/i,
      'the generic-label stoplist still refuses before any write',
    );
    await assert.rejects(
      () => service.createAlias(f.keepId, { alias: 'Valid Name', aliasType: 'not_a_type' }, ctx),
      /aliasType must be one of/i,
      'the aliasType allowlist still applies',
    );

    const created = await service.createAlias(
      f.keepId,
      { alias: 'Sec-Test Alias', aliasType: 'acronym' },
      ctx,
    );
    assert.equal(created.programId, f.keepId);
    assert.equal(created.aliasNormalized, 'SEC TEST ALIAS', 'the shared normalizer is authoritative');
    assert.equal(created.source, 'analyst_manual');
    assert.equal(created.confidence, 1);

    // Duplicate detection, still in TypeScript, before the governed write.
    await assert.rejects(
      () => service.createAlias(f.keepId, { alias: 'sec test alias', aliasType: 'acronym' }, ctx),
      /already exists on this program/i,
    );

    const updated = await service.updateAlias(created.id, { alias: 'Sec-Test Alias v2' }, ctx);
    assert.equal(updated.aliasNormalized, 'SEC TEST ALIAS V2');

    const deleted = await service.deleteAlias(created.id, ctx);
    assert.deepEqual(deleted, { deleted: true, id: created.id });
    const goneRows = await f.admin.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM program_alias WHERE id = $1::uuid`,
      created.id,
    );
    assert.equal(Number(goneRows[0]?.count), 0);

    // Last-canonical guard, enforced in BOTH layers.
    const canonicalId = randomUUID();
    await f.admin.$executeRawUnsafe(
      `INSERT INTO program_alias
         (id, program_id, alias, alias_normalized, alias_type, source, confidence, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Only Canonical', 'ONLY CANONICAL', 'canonical', 'manual', 1, now(), now())`,
      canonicalId,
      f.keepId,
    );
    await assert.rejects(
      () => service.deleteAlias(canonicalId, ctx),
      /last 'canonical' alias/i,
      'the last canonical alias cannot be deleted',
    );

    // Merge still refuses its invalid inputs before the governed call.
    await assert.rejects(
      () => service.mergePrograms({ keepProgramId: f.keepId, mergeProgramId: f.keepId }, ctx),
      /must differ/i,
    );

    const merged = await service.mergePrograms(
      { keepProgramId: f.keepId, mergeProgramId: f.loserId },
      ctx,
    );
    assert.equal(merged.merged, true);
    assert.equal(merged.keepProgramId, f.keepId);
    assert.equal(merged.mergeProgramId, f.loserId);
    assert.equal(typeof merged.repointed.matches, 'number');
    assert.equal(typeof merged.repointed.roles, 'number');
    assert.equal(typeof merged.repointed.officeLinks, 'number');
    assert.equal(typeof merged.repointed.provisionLinks, 'number');
    assert.equal(merged.aliasesCopied, 1, "the loser's non-colliding alias moved to the keeper");

    // The loser is RETIRED, never deleted.
    const loserAfter = await f.admin.$queryRawUnsafe<
      Array<{ status: string; metadata_jsonb: Record<string, unknown> }>
    >(`SELECT status, metadata_jsonb FROM program WHERE id = $1::uuid`, f.loserId);
    assert.equal(loserAfter.length, 1, 'the loser Program row must survive the merge');
    assert.equal(loserAfter[0]?.status, 'merged');
    assert.equal(loserAfter[0]?.metadata_jsonb?.mergedInto, f.keepId);
    assert.ok(loserAfter[0]?.metadata_jsonb?.mergedAt, 'mergedAt must be recorded');

    // Re-merging an already-merged program is refused.
    await assert.rejects(
      () => service.mergePrograms({ keepProgramId: f.keepId, mergeProgramId: f.loserId }, ctx),
      /already merged/i,
    );

    const mergeAudit = await f.admin.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM audit_logs
       WHERE tenant_id = $1::uuid AND action = 'program.merge' AND occurred_at IS NOT NULL`,
      f.tenantId,
    );
    assert.equal(Number(mergeAudit[0]?.count), 1, 'the merge wrote exactly one audit row');
  },
);
