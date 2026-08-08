/**
 * Phase 7 Workstream E — end-to-end engine rehearsal against a real database.
 *
 * Invoked by `scripts/pe-budget-phase7-migration-rehearsal.sh` against a
 * disposable PostgreSQL container. Never point this at a shared database.
 *
 * What it proves that the unit tests cannot:
 *
 *   * the Prisma adapter's SQL actually satisfies the ports the engine expects;
 *   * the engine can write canonical rows **while connected as
 *     `capiro_pe_promoter`**, which is the role the canonical-row trigger
 *     demands — the unit tests use in-memory fakes and prove nothing about
 *     grants;
 *   * the seven-step activation transaction commits atomically and moves the
 *     pointer;
 *   * a repeated execution recovers the existing activation rather than
 *     activating twice, verified by counting ledger rows;
 *   * rollback is a forward pointer transition that deletes nothing.
 *
 * Seeding runs as the database owner. The promotion itself runs as the
 * promoter, so a missing grant fails the rehearsal rather than hiding.
 */
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';
import {
  DefenseBudgetCanonicalPromotionServiceV1,
  type PromotionExecutionRequestV1,
} from '../src/defense-budget/promotion/canonical-promotion-service-v1.js';
import {
  PrismaPromotionExecutionRepositoryV1,
  advisoryLockKeyV1,
  isAmbiguousActivationFailureV1,
  type PromotionPrismaLikeV1,
  type PromotionProjectionSourceV1,
} from '../src/defense-budget/promotion/canonical-promotion-repository-prisma-v1.js';
import {
  projectOmCandidatesV1,
  type ProjectionCandidateInputV1,
} from '../src/defense-budget/promotion/canonical-projectors-v1.js';
import {
  buildPromotionPlanV1,
  type PromotionProjectionInputV1,
} from '../src/defense-budget/promotion/promotion-planner-v1.js';
import { canonicalMappingRegistryHashV1 } from '../src/defense-budget/promotion/canonical-mapping-registry-v1.js';
import type { PromotionAuditEntryV1 } from '../src/defense-budget/promotion/promotion-eligibility-service-v1.js';

const ADMIN_URL = required('ADMIN_DATABASE_URL');
const PROMOTER_URL = required('PROMOTER_DATABASE_URL');
// A distinct environment from the SQL-level sections above, so this runs as a
// genuine baseline hydration against an empty pointer. The active pointer is
// unique per (domain, environment), so the two cannot interfere. Sharing the
// environment made the engine refuse with active_snapshot_drift — correct
// behaviour, and a useful accident: it proved the drift check fires before
// anything else was verified.
const ENVIRONMENT = 'engine';
const DOMAIN = 'defense_budget';
const SNAPSHOT_ID = '99999999-9999-9999-9999-999999999999';
const PRIOR_SNAPSHOT_ID = '99999999-9999-9999-9999-999999999998';
const SHA = (c: string) => c.repeat(64);

let passed = 0;
function ok(message: string): void {
  passed += 1;
  console.log(`[p7-engine]   ok  ${message}`);
}
function fail(message: string): never {
  console.error(`[p7-engine] FAILED: ${message}`);
  process.exit(1);
}
function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
  ok(message);
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env var ${name}`);
  return value;
}

/** Reads the verified O&M projection tables and runs the Workstream H projector. */
class OmProjectionSource implements PromotionProjectionSourceV1 {
  constructor(private readonly prisma: PrismaClient) {}

  async loadForPlan(): Promise<PromotionProjectionInputV1[]> {
    const sags = await this.prisma.$queryRawUnsafe<
      {
        natural_key: string;
        component: string;
        account: string;
        sag_code: string;
        title: string | null;
      }[]
    >('SELECT natural_key, component, account, sag_code, title FROM om_sag ORDER BY natural_key');

    const years = await this.prisma.$queryRawUnsafe<
      {
        natural_key: string;
        fiscal_year: number;
        funding_field: string;
        amount_millions: string;
        original_value: string;
        original_unit: string;
        assertion_id: string;
        verification_candidate_id: string;
        verification_run_id: string;
        extraction_artifact_id: string;
        extraction_artifact_content_sha256: string;
        source_pdf_sha256: string;
      }[]
    >(
      `SELECT s.natural_key, y.fiscal_year, y.funding_field, y.amount_millions::text AS amount_millions,
              y.original_value, y.original_unit, y.assertion_id, y.verification_candidate_id,
              y.verification_run_id, y.extraction_artifact_id,
              y.extraction_artifact_content_sha256, y.source_pdf_sha256
         FROM om_sag_year y JOIN om_sag s ON s.id = y.om_sag_id
        ORDER BY s.natural_key, y.fiscal_year`,
    );

    const candidates: ProjectionCandidateInputV1[] = [];

    for (const sag of sags) {
      candidates.push({
        candidateId: `sag:${sag.natural_key}`,
        target: 'OmSag',
        naturalKey: sag.natural_key,
        operation: 'insert',
        reason: 'rehearsal',
        artifactId: 'artifact-1',
        artifactContentSha256: SHA('a'),
        verificationCandidateId: 'vc-1',
        verificationRunId: 'vr-1',
        verificationDecisionId: 'vd-1',
        sourceDocumentKey: 'doc-1',
        sourcePdfSha256: SHA('b'),
        assertionIds: ['assert-sag'],
        evidenceIds: ['ev-1'],
        values: {
          naturalKey: sag.natural_key,
          component: sag.component,
          account: sag.account,
          sagCode: sag.sag_code,
          title: sag.title,
        },
      });
    }

    for (const year of years) {
      candidates.push({
        candidateId: `year:${year.natural_key}:${year.fiscal_year}`,
        target: 'OmSagYear',
        naturalKey: `${year.natural_key}|${year.fiscal_year}|${year.funding_field}`,
        operation: 'insert',
        reason: 'rehearsal',
        artifactId: year.extraction_artifact_id,
        artifactContentSha256: year.extraction_artifact_content_sha256,
        verificationCandidateId: year.verification_candidate_id,
        verificationRunId: year.verification_run_id,
        verificationDecisionId: year.verification_run_id,
        sourceDocumentKey: 'doc-1',
        sourcePdfSha256: year.source_pdf_sha256,
        assertionIds: [year.assertion_id],
        evidenceIds: ['ev-1'],
        values: {
          identityNaturalKey: year.natural_key,
          fiscalYear: year.fiscal_year,
          fundingField: year.funding_field,
          // Exact decimal strings straight from NUMERIC — never parsed to float.
          valueMillions: normalizeDecimal(year.amount_millions),
          originalValue: year.original_value,
          originalUnit: year.original_unit,
        },
      });
    }

    const { projections, refusals } = projectOmCandidatesV1(candidates);
    if (refusals.length > 0) {
      fail(
        `projector refused ${refusals.length} candidate(s): ${refusals.map((r) => r.detail).join('; ')}`,
      );
    }
    return projections;
  }
}

/** NUMERIC(20,6) renders as "1.250000"; canonical form drops trailing zeros. */
function normalizeDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

async function main(): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  const promoter = new PrismaClient({ datasources: { db: { url: PROMOTER_URL } } });

  const auditEntries: PromotionAuditEntryV1[] = [];
  const audit = {
    async record(entry: PromotionAuditEntryV1) {
      auditEntries.push(entry);
    },
  };

  try {
    /* ---- Seed verified O&M projections and the promotion ledger ---- */
    // om_sag_year carries a foreign key to source_document; the projection is
    // proof-bound, so there is no way to seed a funding row without its source.
    await admin.$executeRawUnsafe(`
      INSERT INTO source_document
        (id, source_key, fiscal_year, budget_cycle, component, document_type,
         title, source_url, sha256, extraction_method)
      VALUES ('00000000-0000-0000-0000-000000000001', 'p7-engine-rehearsal', 2027,
              'pb_fy2027', 'ARMY', 'o1', 'Phase 7 engine rehearsal', 'file:///o1.pdf',
              '${SHA('d')}', 'structured_import')
      ON CONFLICT DO NOTHING;`);

    await admin.$executeRawUnsafe(`
      INSERT INTO om_sag (natural_key, component, account, sag_code, printed_sag_code, title)
      VALUES ('OM_SAG:ARMY:OMA:121', 'ARMY', 'OMA', '121', '121', 'Rehearsal SAG')
      ON CONFLICT DO NOTHING;`);
    await admin.$executeRawUnsafe(`
      INSERT INTO om_sag_year
        (om_sag_id, fiscal_year, funding_field, amount_millions, original_value, original_unit,
         source_document_id, extraction_artifact_id, extraction_artifact_content_sha256,
         assertion_id, verification_candidate_id, verification_run_id, verification_decision_id,
         source_pdf_sha256, evidence_ids_jsonb)
      SELECT id, 2027, 'request', 12.345678, '12345.678', 'thousands',
             '00000000-0000-0000-0000-000000000001', 'artifact-om',
             '${SHA('c')}', 'assert-om', 'cand-om', 'run-om', 'decision-om',
             '${SHA('d')}', '["ev-om"]'::jsonb
        FROM om_sag WHERE natural_key = 'OM_SAG:ARMY:OMA:121'
      ON CONFLICT DO NOTHING;`);
    ok('seeded verified O&M projections');

    const source = new OmProjectionSource(admin);
    const projections = await source.loadForPlan();
    check(projections.length === 2, `projector produced ${projections.length} projections`);

    const yearProjection = projections.find((p) => p.projectionKind === 'non_rdte:OmSagYear');
    check(
      yearProjection?.values.money?.valueMillions === '12.345678',
      'exact six-decimal money survived the read-project round trip',
    );

    const plan = buildPromotionPlanV1({
      planId: 'plan-engine-1',
      eligibilityHash: SHA('e'),
      scope: { cycleId: 'cycle-fy2027', fiscalYear: 2027, families: ['om'], stages: [] },
      mode: 'baseline_hydration',
      proposedSnapshotId: SNAPSHOT_ID,
      expectedActiveSnapshotId: null,
      actualActiveSnapshotId: null,
      mappingRegistryHash: canonicalMappingRegistryHashV1(),
      projections,
      priorRows: [],
    });
    check(!plan.blocked, 'plan has no blocked items');

    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_canonical_snapshot
        (id, snapshot_key, environment, cycle_id, fiscal_year, status,
         required_scopes, completed_scopes, mapping_registry_hash)
      VALUES ('${SNAPSHOT_ID}', 'snap-engine', '${ENVIRONMENT}', 'cycle-fy2027', 2027, 'STAGING',
              '["om"]'::jsonb, '[]'::jsonb, '${SHA('a')}');`);

    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_promotion_plan
        (plan_id, plan_hash, eligibility_hash, mapping_registry_version, mapping_registry_hash,
         cycle_id, fiscal_year, scope, scope_hash, mode, proposed_snapshot_id,
         item_count, blocked_count, plan_document)
      VALUES ('plan-engine-1', '${plan.planHash}', '${SHA('e')}', '1.0.0', '${SHA('a')}',
              'cycle-fy2027', 2027, '{"families":["om"]}'::jsonb, '${SHA('a')}',
              'baseline_hydration', '${SNAPSHOT_ID}', ${plan.counts.total}, 0,
              $$${JSON.stringify(plan)}$$::jsonb);`);

    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_promotion_authorization
        (authorization_id, plan_id, plan_hash, eligibility_hash, scope_hash,
         authorizer_actor_id, authorizer_role, reason, issued_at, expires_at,
         segregation, authorization_hash)
      VALUES ('auth-engine-1', 'plan-engine-1', '${plan.planHash}', '${SHA('e')}', '${SHA('a')}',
              'actor-admin', 'capiro_admin', 'engine rehearsal', now(), now() + interval '1 hour',
              '{}'::jsonb, '${SHA('a')}');`);

    ok('seeded plan, authorization, and snapshot');

    /* ---- Run the engine as capiro_pe_promoter ---- */
    const repository = new PrismaPromotionExecutionRepositoryV1(
      promoter as unknown as PromotionPrismaLikeV1,
      source,
      async () => {
        const client = new PgClient({ connectionString: PROMOTER_URL });
        await client.connect();
        return client;
      },
    );
    const service = new DefenseBudgetCanonicalPromotionServiceV1(repository, audit, {
      now: () => new Date(),
    });

    const request: PromotionExecutionRequestV1 = {
      planId: 'plan-engine-1',
      authorizationId: 'auth-engine-1',
      expectedPlanHash: plan.planHash,
      expectedActiveSnapshotId: null,
      executorIdentity: 'rehearsal:promoter',
      executionMode: 'execute',
      environment: ENVIRONMENT,
    };

    const result = await service.execute(request);
    if (!result.committed) {
      fail(`engine refused: ${result.refusals.map((r) => `${r.reason}: ${r.detail}`).join('; ')}`);
    }
    ok('engine staged and activated as capiro_pe_promoter');
    check(result.stagedRowCount === 2, `staged ${result.stagedRowCount} canonical rows`);
    check(result.outboxRowCount === 2, `wrote ${result.outboxRowCount} outbox rows`);

    /* ---- Verify the committed state ---- */
    const [{ count: rowCount }] = await admin.$queryRawUnsafe<[{ count: bigint }]>(
      `SELECT count(*) FROM defense_budget_canonical_row WHERE snapshot_id = '${SNAPSHOT_ID}'`,
    );
    check(Number(rowCount) === 2, `canonical rows persisted (${rowCount})`);

    const [{ snapshot_id: activeId }] = await admin.$queryRawUnsafe<[{ snapshot_id: string }]>(
      `SELECT snapshot_id FROM defense_budget_active_snapshot WHERE environment = '${ENVIRONMENT}'`,
    );
    check(activeId === SNAPSHOT_ID, 'activation pointer moved to the new snapshot');

    const [{ status }] = await admin.$queryRawUnsafe<[{ status: string }]>(
      `SELECT status FROM defense_budget_canonical_snapshot WHERE id = '${SNAPSHOT_ID}'`,
    );
    check(status === 'ACTIVE', `snapshot is ${status}`);

    const [{ consumed_at: consumedAt }] = await admin.$queryRawUnsafe<
      [{ consumed_at: Date | null }]
    >(
      `SELECT consumed_at FROM defense_budget_promotion_authorization WHERE authorization_id = 'auth-engine-1'`,
    );
    check(consumedAt != null, 'authorization was consumed inside the activation transaction');

    // Scoped to THIS activation. Earlier SQL-level sections of the rehearsal
    // deliberately insert a material_change row with suppress_alert = false, so
    // an unscoped count would fail for the wrong reason.
    const [{ count: suppressed }] = await admin.$queryRawUnsafe<[{ count: bigint }]>(
      `SELECT count(*) FROM defense_budget_promotion_outbox o
         JOIN defense_budget_promotion_activation a ON a.id = o.activation_id
        WHERE a.environment = '${ENVIRONMENT}' AND o.suppress_alert = false`,
    );
    check(Number(suppressed) === 0, 'baseline hydration produced no un-suppressed alert');

    const [{ money }] = await admin.$queryRawUnsafe<[{ money: string | null }]>(
      `SELECT money_value_millions::text AS money FROM defense_budget_canonical_row
        WHERE canonical_entity = 'canonical_om_sag_year' AND snapshot_id = '${SNAPSHOT_ID}'`,
    );
    check(money === '12.345678000', `exact money round-tripped through the engine (${money})`);

    /* ---- Re-execute: must recover, not activate twice ---- */
    const second = await service.execute(request);
    check(second.committed, 're-execution reports committed');
    check(second.recoveredExistingActivation, 're-execution recovered the existing activation');

    // Scoped to this environment: the SQL-level sections above create their own
    // activations, and an unscoped count would fail for the wrong reason.
    const [{ count: activations }] = await admin.$queryRawUnsafe<[{ count: bigint }]>(
      `SELECT count(*) FROM defense_budget_promotion_activation
        WHERE activation_kind = 'PROMOTION' AND environment = '${ENVIRONMENT}'`,
    );
    check(Number(activations) === 1, `exactly one activation exists (${activations})`);

    /* ---- Rollback to a prior snapshot ---- */
    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_canonical_snapshot
        (id, snapshot_key, environment, cycle_id, fiscal_year, status,
         required_scopes, completed_scopes, mapping_registry_hash, snapshot_hash)
      VALUES ('${PRIOR_SNAPSHOT_ID}', 'snap-prior-engine', '${ENVIRONMENT}', 'cycle-fy2026', 2026,
              'SUPERSEDED', '[]'::jsonb, '[]'::jsonb, '${SHA('a')}', '${SHA('b')}');`);
    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_promotion_authorization
        (authorization_id, plan_id, plan_hash, eligibility_hash, scope_hash,
         expected_active_snapshot_id, authorizer_actor_id, authorizer_role, reason,
         issued_at, expires_at, segregation, authorization_hash)
      VALUES ('auth-rollback-1', 'plan-engine-1', '${plan.planHash}', '${SHA('e')}', '${SHA('a')}',
              '${SNAPSHOT_ID}', 'actor-admin', 'capiro_admin', 'rollback rehearsal',
              now(), now() + interval '1 hour', '{}'::jsonb, '${SHA('a')}');`);

    // No manual status fix-up here. The service and adapter must handle the
    // SUPERSEDED -> READY transition inside the activation transaction; if they
    // do not, this call fails with 0A000 and the rehearsal catches it.
    const rollback = await service.rollback({
      toSnapshotId: PRIOR_SNAPSHOT_ID,
      authorizationId: 'auth-rollback-1',
      executorIdentity: 'rehearsal:promoter',
      environment: ENVIRONMENT,
      reason: 'engine rehearsal rollback',
    });
    if (!rollback.committed) {
      fail(
        `rollback refused: ${rollback.refusals.map((r) => `${r.reason}: ${r.detail}`).join('; ')}`,
      );
    }
    ok('rollback reactivated the prior snapshot');

    const [{ snapshot_id: afterRollback }] = await admin.$queryRawUnsafe<[{ snapshot_id: string }]>(
      `SELECT snapshot_id FROM defense_budget_active_snapshot WHERE environment = '${ENVIRONMENT}'`,
    );
    check(afterRollback === PRIOR_SNAPSHOT_ID, 'pointer now names the prior snapshot');

    const [{ count: survivingRows }] = await admin.$queryRawUnsafe<[{ count: bigint }]>(
      `SELECT count(*) FROM defense_budget_canonical_row WHERE snapshot_id = '${SNAPSHOT_ID}'`,
    );
    check(Number(survivingRows) === 2, 'rolled-back snapshot kept all of its rows');

    const [{ count: snapshots }] = await admin.$queryRawUnsafe<[{ count: bigint }]>(
      `SELECT count(*) FROM defense_budget_canonical_snapshot WHERE environment = '${ENVIRONMENT}'`,
    );
    check(Number(snapshots) === 2, 'no snapshot was deleted by the rollback');

    /* ---- Pure helpers ---- */
    check(
      advisoryLockKeyV1('a') === advisoryLockKeyV1('a') &&
        advisoryLockKeyV1('a') !== advisoryLockKeyV1('b'),
      'advisory lock keys are deterministic and distinct',
    );
    check(
      isAmbiguousActivationFailureV1({ code: '08006' }) &&
        !isAmbiguousActivationFailureV1({ code: '23505' }),
      'connection failures classify as ambiguous, integrity violations do not',
    );

    check(auditEntries.length >= 2, `engine audited ${auditEntries.length} attempts`);

    console.log(`[p7-engine] ENGINE REHEARSAL PASSED — ${passed} checks`);
  } finally {
    await admin.$disconnect().catch(() => undefined);
    await promoter.$disconnect().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('[p7-engine] FAILED:', error);
  process.exit(1);
});
