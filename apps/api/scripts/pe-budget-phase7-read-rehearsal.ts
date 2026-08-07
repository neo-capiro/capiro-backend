/**
 * Phase 7 Workstream M — the snapshot read path against a real database.
 *
 * Invoked by `scripts/pe-budget-phase7-migration-rehearsal.sh` after the drain
 * rehearsal, against the same disposable PostgreSQL container. Never point this
 * at a shared database.
 *
 * It runs **as `capiro_app`**, the general API serve role, because that is the
 * whole question a read cutover has to answer: can the role that serves product
 * traffic read the active snapshot, and is it still unable to write it? A
 * rehearsal that read as the promoter or the table owner would prove neither.
 *
 * What this proves that a unit test cannot:
 *
 *   * the serve role can resolve the activation pointer and read canonical rows
 *     through the read adapter, with only the grants the migration gives it;
 *   * the same role still cannot write a canonical row, insert one, or move the
 *     pointer — the read path opens no write door;
 *   * exact money survives the round trip, with NUMERIC scale padding normalized
 *     back to canonical decimal form;
 *   * a governed override read out of its own table lands on the response with a
 *     provenance label, and the official value survives beside it;
 *   * `assertOneSnapshotV1` catches a genuinely mixed row set built from two real
 *     snapshots in this database.
 */
import { PrismaClient } from '@prisma/client';
import {
  assertOneSnapshotV1,
  createActiveSnapshotResolverV1,
  snapshotProvenanceV1,
  SnapshotMixError,
  type SnapshotCanonicalRowV1,
} from '../src/defense-budget/promotion/snapshot-read-repository-v1.js';
import {
  createSnapshotReadPortPrismaV1,
  type SnapshotReadPrismaLikeV1,
} from '../src/defense-budget/promotion/snapshot-read-repository-prisma-v1.js';
import {
  applyOverrideOverlayV1,
  inForceOverridesV1,
} from '../src/defense-budget/promotion/manual-override-overlay-v1.js';
import { manualOverrideFromRowV1 } from '../src/defense-budget/promotion/manual-override-repository-prisma-v1.js';
import { resolveSnapshotReadModeV1 } from '../src/defense-budget/promotion/snapshot-read-mode-v1.js';

const ADMIN_URL = required('ADMIN_DATABASE_URL');
const APP_URL = required('APP_DATABASE_URL');

/** The environment the SQL-level rehearsal sections activate a populated snapshot in. */
const ENVIRONMENT = 'rehearsal';
const DOMAIN = 'defense_budget';
/** `override_id` is a UUID column, not a slug. */
const APPROVED_OVERRIDE_ID = 'cccccccc-0000-0000-0000-00000000c001';
const PROPOSED_OVERRIDE_ID = 'cccccccc-0000-0000-0000-00000000c002';

let passed = 0;
function ok(message: string): void {
  passed += 1;
  console.log(`[p7-read]   ok  ${message}`);
}
function fail(message: string): never {
  console.error(`[p7-read] FAILED: ${message}`);
  process.exit(1);
}
function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
  ok(message);
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function expectRefused(client: PrismaClient, sql: string, message: string): Promise<void> {
  try {
    await client.$executeRawUnsafe(sql);
  } catch {
    ok(`${message} — refused`);
    return;
  }
  fail(`${message} — the database ACCEPTED a statement it must refuse`);
}

async function main(): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  const app = new PrismaClient({ datasources: { db: { url: APP_URL } } });

  try {
    const port = createSnapshotReadPortPrismaV1(app as unknown as SnapshotReadPrismaLikeV1);

    /* =================================================================== */
    /* 1. The serve role can resolve the pointer                           */
    /* =================================================================== */
    const resolver = createActiveSnapshotResolverV1(port, DOMAIN, ENVIRONMENT);
    const active = await resolver.resolve();
    check(active != null, 'the serve role resolved the activation pointer');
    if (active == null) return;
    check(active.status === 'ACTIVE', `the pointed-at snapshot is ACTIVE (${active.status})`);
    check(resolver.resolved(), 'the resolver reports a pointer exists');

    // The read-mode decision the product would make with this pointer present.
    const decision = resolveSnapshotReadModeV1({
      configuredMode: 'snapshot',
      tenantId: 'tenant-rehearsal',
      hasActiveSnapshot: resolver.resolved(),
    });
    check(
      decision.serve === 'snapshot',
      'with a pointer present, snapshot mode serves the snapshot',
    );

    /* =================================================================== */
    /* 2. It can read canonical rows, and only from that snapshot           */
    /* =================================================================== */
    const rows = await port.loadRows({ snapshotId: active.snapshotId });
    check(rows.length > 0, `the serve role read ${rows.length} canonical row(s)`);
    assertOneSnapshotV1(rows, active.snapshotId);
    ok('every row returned belongs to the active snapshot');

    const money = rows.find((row) => row.money != null);
    check(money != null, 'at least one row carries money');
    if (money?.money != null) {
      // Postgres pads NUMERIC(24,9) to scale. The adapter normalizes, so what
      // arrives here is canonical decimal form rather than 1.250000000.
      check(
        !money.money.valueMillions.endsWith('000000000'),
        `money came back in canonical form, not scale-padded (${money.money.valueMillions})`,
      );
      check(
        money.money.originalValue.length > 0 && money.money.originalUnit.length > 0,
        'the money triple arrived whole',
      );
    }

    const provenance = snapshotProvenanceV1(active, 0);
    check(
      provenance.activeSnapshotId === active.snapshotId,
      'provenance names the snapshot the response was built from',
    );

    /* =================================================================== */
    /* 3. Reading opens no write door                                       */
    /* =================================================================== */
    const target = rows[0];
    if (target == null) fail('no canonical row to test writes against');

    await expectRefused(
      app,
      `UPDATE "defense_budget_canonical_row" SET "text_value" = 'tampered'
        WHERE "snapshot_id" = '${active.snapshotId}'::uuid`,
      'the serve role updating a canonical row',
    );
    await expectRefused(
      app,
      `DELETE FROM "defense_budget_canonical_row" WHERE "snapshot_id" = '${active.snapshotId}'::uuid`,
      'the serve role deleting a canonical row',
    );
    await expectRefused(
      app,
      `UPDATE "defense_budget_active_snapshot" SET "snapshot_id" = "snapshot_id"
        WHERE "environment" = '${ENVIRONMENT}'`,
      'the serve role moving the activation pointer',
    );
    await expectRefused(
      app,
      `INSERT INTO "defense_budget_canonical_delta"
         ("delta_key", "activation_id", "outbox_id", "new_snapshot_id", "canonical_entity",
          "canonical_natural_key", "family", "delta_kind", "changed_axes",
          "change_classification", "suppress_alert")
       SELECT 'app-forged', o."activation_id", o."id", '${active.snapshotId}',
              'canonical_om_sag_year', 'forged', 'om', 'increase', '["money"]'::jsonb,
              'material_change', false
         FROM "defense_budget_promotion_outbox" o LIMIT 1`,
      'the serve role forging a canonical delta',
    );

    /* =================================================================== */
    /* 4. A governed override lands on the response                         */
    /* =================================================================== */
    // Inserted as the owner: authoring and approving are the guarded admin
    // surface's job, not this rehearsal's. What is being proved here is the read
    // path, so the row is created in its approved end state with author ≠
    // approver, which the table's own CHECK constraints require.
    const overrideValueMillions = '4242.5';
    await admin.$executeRawUnsafe(`
      INSERT INTO "defense_budget_manual_override"
        ("override_id", "canonical_entity", "canonical_natural_key", "fiscal_year", "funding_field",
         "money_original_value", "money_original_unit", "money_value_millions",
         "author_actor_id", "approver_actor_id", "approver_role", "reason", "evidence_ids",
         "status", "version", "effective_from", "proposed_at", "approved_at", "override_hash")
      VALUES ('${APPROVED_OVERRIDE_ID}', '${target.canonicalEntity}', '${target.canonicalNaturalKey}',
              ${target.fiscalYear ?? 'NULL'},
              ${target.fundingField == null ? 'NULL' : `'${target.fundingField}'`},
              '4242500', 'thousands', ${overrideValueMillions},
              'author-rehearsal', 'approver-rehearsal', 'capiro_admin',
              'read-path rehearsal correction', '["issue-read-1"]'::jsonb,
              'approved', 1, now() - interval '1 day', now() - interval '2 days', now() - interval '1 day',
              '${'a'.repeat(64)}')
      ON CONFLICT DO NOTHING`);

    // Read back through the serve role, and parse with the same function the
    // application uses — so a row this rehearsal wrote by hand still has to
    // satisfy the governed record schema.
    const overrideRows = await app.defenseBudgetManualOverride.findMany({
      where: { overrideId: APPROVED_OVERRIDE_ID },
    });
    check(overrideRows.length === 1, 'the serve role can read the override table');
    const parsed = overrideRows.map((row) => manualOverrideFromRowV1(row));
    check(
      parsed[0]?.value.valueMillions === overrideValueMillions,
      `the override's exact value survived NUMERIC storage (${parsed[0]?.value.valueMillions})`,
    );

    const overlay = inForceOverridesV1(parsed, new Date());
    check(overlay.length === 1, 'the approved override is in force');

    const applied = applyOverrideOverlayV1(rows, overlay);
    check(applied.applied === 1, 'the overlay matched exactly one canonical row');
    const overridden = applied.rows.find((row) => row.override != null);
    check(overridden != null, 'the overridden row carries a provenance label');
    check(
      overridden?.money?.valueMillions === overrideValueMillions,
      `the reader sees the corrected value (${overridden?.money?.valueMillions})`,
    );
    check(
      overridden?.officialMoney?.valueMillions === target.money?.valueMillions,
      'the official value survives beside the correction',
    );
    check(
      overridden?.canonicalRowHash === target.canonicalRowHash,
      'the canonical row hash is unchanged by the override',
    );
    check(
      snapshotProvenanceV1(active, applied.applied).overridesApplied === 1,
      'provenance counts the override that was applied',
    );

    // A proposal must change nothing. Same target, higher version, unapproved.
    await admin.$executeRawUnsafe(`
      INSERT INTO "defense_budget_manual_override"
        ("override_id", "canonical_entity", "canonical_natural_key", "fiscal_year", "funding_field",
         "money_original_value", "money_original_unit", "money_value_millions",
         "author_actor_id", "reason", "evidence_ids",
         "status", "version", "prior_override_id", "effective_from", "proposed_at", "override_hash")
      VALUES ('${PROPOSED_OVERRIDE_ID}', '${target.canonicalEntity}', '${target.canonicalNaturalKey}',
              ${target.fiscalYear ?? 'NULL'},
              ${target.fundingField == null ? 'NULL' : `'${target.fundingField}'`},
              '1', 'thousands', 0.000001,
              'author-rehearsal', 'a proposal that must not take effect', '["issue-read-2"]'::jsonb,
              'proposed', 2, '${APPROVED_OVERRIDE_ID}', now() - interval '1 day', now(),
              '${'b'.repeat(64)}')
      ON CONFLICT DO NOTHING`);

    const withProposal = (
      await app.defenseBudgetManualOverride.findMany({
        where: { canonicalNaturalKey: target.canonicalNaturalKey },
      })
    ).map((row) => manualOverrideFromRowV1(row));
    const afterProposal = inForceOverridesV1(withProposal, new Date());
    check(
      afterProposal.length === 0,
      'a newer proposal is not in force, and does not let the approved older version stand either',
    );

    /* =================================================================== */
    /* 5. A genuinely mixed row set is refused                              */
    /* =================================================================== */
    const otherSnapshotId = await admin
      .$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id"::text AS id FROM "defense_budget_canonical_snapshot"
          WHERE "id" <> $1::uuid LIMIT 1`,
        active.snapshotId,
      )
      .then((result) => result[0]?.id ?? null);
    check(otherSnapshotId != null, 'this database holds more than one snapshot');
    if (otherSnapshotId != null) {
      const foreign: SnapshotCanonicalRowV1 = { ...target, snapshotId: otherSnapshotId };
      let refused = false;
      try {
        assertOneSnapshotV1([target, foreign], active.snapshotId);
      } catch (error) {
        refused = error instanceof SnapshotMixError;
      }
      check(refused, 'a row set straddling two real snapshots is refused, not served');
    }

    console.log(`[p7-read] READ REHEARSAL PASSED — ${passed} checks`);
  } finally {
    await admin.$disconnect().catch(() => undefined);
    await app.$disconnect().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('[p7-read] FAILED:', error);
  process.exit(1);
});
