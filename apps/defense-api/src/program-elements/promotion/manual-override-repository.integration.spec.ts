/**
 * Database-backed regression tests for two Session 3 bug fixes in
 * ManualOverrideRepositoryPrisma, found during old-vs-new parity review
 * against apps/api's Phase 7 promotion module:
 *
 *  1. findLatestForTarget only filtered on (canonicalEntity,
 *     canonicalNaturalKey), dropping fundingField from the WHERE clause. A
 *     PE/FY with an open proposal on one field (e.g. 'request') wrongly
 *     refused a legitimate, independent proposal on another field (e.g.
 *     'hascMark') for the same PE/FY with target_has_open_proposal.
 *  2. findById returned money_value_millions verbatim from the NUMERIC(24,9)
 *     column, which Postgres pads to its declared scale ("1.25" stored as
 *     "1.250000000"), instead of renormalizing it back to the canonical
 *     decimal string the proposer supplied.
 *
 * Skipped unless REHEARSAL_DATABASE_URL/REHEARSAL_SERVE_URL are set, same
 * convention as health.service.integration.spec.ts: verify-phase8-session3-db.sh
 * sets both up before running `pnpm --filter @capiro/defense-api test`, so
 * `pnpm test` alone still runs with no database and no regression.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.ts';
import { ManualOverrideRepositoryPrisma } from './manual-override-repository.prisma.ts';
import { canonicalTargetForLegacyPeYearV1, proposeManualOverrideV1 } from './manual-override-service-v1.ts';

const SERVE_URL = process.env.REHEARSAL_SERVE_URL;
const RUN = Boolean(SERVE_URL);

test('findLatestForTarget scopes by fundingField, not just PE/FY (regression)', { skip: !RUN }, async (t) => {
  const priorDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = SERVE_URL;
  const prisma = new PrismaService();
  t.after(async () => {
    await prisma.$disconnect();
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  });

  const repo = new ManualOverrideRepositoryPrisma(prisma);
  const peCode = `RG${randomUUID().slice(0, 6).toUpperCase()}`;
  const fy = 2027;
  const now = new Date().toISOString();

  // First proposal on 'request' — left open (never approved).
  await proposeManualOverrideV1(
    {
      overrideId: randomUUID(),
      target: canonicalTargetForLegacyPeYearV1({ peCode, fy, fieldName: 'request' }),
      value: { originalValue: '5', originalUnit: 'millions', valueMillions: '5' },
      authorActorId: randomUUID(),
      reason: 'regression fixture — request field',
      evidenceIds: [randomUUID()],
      effectiveFrom: now,
      proposedAt: now,
    },
    repo,
  );

  // A proposal on a DIFFERENT field for the SAME (peCode, fy) must succeed —
  // the two funding fields are independent targets. Before the fix this threw
  // ManualOverrideRefusalError('target_has_open_proposal') because
  // findLatestForTarget ignored fundingField and matched the 'request' row.
  const second = await proposeManualOverrideV1(
    {
      overrideId: randomUUID(),
      target: canonicalTargetForLegacyPeYearV1({ peCode, fy, fieldName: 'hascMark' }),
      value: { originalValue: '6', originalUnit: 'millions', valueMillions: '6' },
      authorActorId: randomUUID(),
      reason: 'regression fixture — hascMark field',
      evidenceIds: [randomUUID()],
      effectiveFrom: now,
      proposedAt: now,
    },
    repo,
  );
  assert.equal(second.status, 'proposed');
  assert.equal(second.version, 1, 'independent field must start its own version chain, not continue request\'s');
});

test('findById renormalizes a NUMERIC(24,9)-padded valueMillions back to canonical form (regression)', { skip: !RUN }, async (t) => {
  const priorDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = SERVE_URL;
  const prisma = new PrismaService();
  t.after(async () => {
    await prisma.$disconnect();
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
  });

  const repo = new ManualOverrideRepositoryPrisma(prisma);
  const peCode = `RG${randomUUID().slice(0, 6).toUpperCase()}`;
  const now = new Date().toISOString();
  const overrideId = randomUUID();

  const proposed = await proposeManualOverrideV1(
    {
      overrideId,
      target: canonicalTargetForLegacyPeYearV1({ peCode, fy: 2027, fieldName: 'enacted' }),
      // A value whose canonical string has fewer fractional digits than the
      // column's declared scale (9) — Postgres will zero-pad it on write.
      value: { originalValue: '1.25', originalUnit: 'millions', valueMillions: '1.25' },
      authorActorId: randomUUID(),
      reason: 'regression fixture — NUMERIC renormalization',
      evidenceIds: [randomUUID()],
      effectiveFrom: now,
      proposedAt: now,
    },
    repo,
  );
  assert.equal(proposed.value.valueMillions, '1.25');

  const reread = await repo.findById(overrideId);
  assert.ok(reread, 'inserted override must be findable by id');
  assert.equal(
    reread?.value.valueMillions,
    '1.25',
    'value read back from NUMERIC(24,9) must be renormalized to canonical form, not left zero-padded',
  );
});
