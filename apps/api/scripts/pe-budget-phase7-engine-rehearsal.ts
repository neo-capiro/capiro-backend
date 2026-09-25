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
 *   * populated synthetic Program Element reads visibly change to the
 *     candidate's defective value, then exactly return to the prior response
 *     after authorized pointer rollback.
 *
 * Explicitly NOT_RUN: authenticated HTTP, deployed API restart, AWS or
 * production database rollback, real customer/source/notification activity,
 * and commercial activation. This rehearsal uses disposable PostgreSQL only.
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
  projectRdteCandidatesV1,
  type ProjectionCandidateInputV1,
} from '../src/defense-budget/promotion/canonical-projectors-v1.js';
import {
  buildPromotionPlanV1,
  type PromotionProjectionInputV1,
} from '../src/defense-budget/promotion/promotion-planner-v1.js';
import { canonicalMappingRegistryHashV1 } from '../src/defense-budget/promotion/canonical-mapping-registry-v1.js';
import {
  PrismaPromotionAuditSinkV1,
  type PromotionAuditEntryV1,
} from '../src/defense-budget/promotion/promotion-eligibility-service-v1.js';
import { createSnapshotReadPortPrismaV1 } from '../src/defense-budget/promotion/snapshot-read-repository-prisma-v1.js';
import type { SnapshotReadPortV1 } from '../src/defense-budget/promotion/snapshot-read-repository-v1.js';
import { PeSnapshotGateService } from '../src/program-element/snapshot/pe-snapshot-gate.service.js';
import { ProgramElementReadService } from '../src/program-element/program-element-read.service.js';
import { TenantContextStore } from '../src/tenant/tenant-context.store.js';
import type { TenantContext } from '@capiro/shared';

const ADMIN_URL = required('ADMIN_DATABASE_URL');
const PROMOTER_URL = required('PROMOTER_DATABASE_URL');
const APP_URL = required('APP_DATABASE_URL');
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
const F06_PE_CODE = 'P9-F06-SYNTHETIC-PE';
const F06_CANARY_TENANT = 'p9-f06-synthetic-canary-tenant';
const F06_PRIOR_FY2027 = 'P9-F06-SYNTHETIC-PE|pb_fy2027|2027|total';
const F06_CANDIDATE_FY2027 = 'P9-F06-SYNTHETIC-PE|pb_fy2027|2027|total';
const F06_PRIOR_QUANTITY_FY2027 = 'P9-F06-SYNTHETIC-PE|pb_fy2027|2027|quantity';
const F06_CANDIDATE_QUANTITY_FY2027 = 'P9-F06-SYNTHETIC-PE|pb_fy2027|2027|quantity';
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

/** Exercise the shipped ProgramElementReadService and gate with only synthetic legacy data. */
async function readSyntheticPe(
  app: PrismaClient,
  options: { rollbackOn: boolean; tenantId: string },
): Promise<{
  rows: Awaited<ReturnType<ProgramElementReadService['getBudgetPositions']>>;
  snapshotIds: string[];
  legacyReads: number;
}> {
  const source = createSnapshotReadPortPrismaV1(app);
  const snapshotIds: string[] = [];
  let legacyReads = 0;
  const port: SnapshotReadPortV1 = {
    loadActiveSnapshot: (domain, environment) => source.loadActiveSnapshot(domain, environment),
    loadRows: async (query) => {
      snapshotIds.push(query.snapshotId);
      return source.loadRows(query);
    },
    loadManualOverridesForRows: source.loadManualOverridesForRows
      ? (rows) => source.loadManualOverridesForRows!(rows)
      : undefined,
  };
  const tenantStore = new TenantContextStore();
  const configValues: Record<string, string> = {
    PE_SNAPSHOT_READ_MODE: 'snapshot_canary',
    PE_SNAPSHOT_CANARY_TENANTS: F06_CANARY_TENANT,
    PE_SNAPSHOT_CANARY_ROLLBACK: options.rollbackOn ? 'on' : 'off',
    NODE_ENV: 'test',
  };
  const gate = new PeSnapshotGateService(
    port,
    { get: (key: string) => configValues[key] } as never,
    undefined,
    tenantStore,
  );
  const syntheticLegacyPrisma = {
    programElement: { findUnique: async () => ({ peCode: F06_PE_CODE }) },
    programElementBudgetPosition: {
      findMany: async () => {
        legacyReads += 1;
        return [
          {
            positionCycle: 'legacy-only-fy2027',
            assertedFy: 2027,
            amount: { toString: () => '777' },
            quantity: null,
            valueKind: 'total',
            sourceUrl: 'fixture://package9-f06/legacy',
            pageNumber: 1,
          },
        ];
      },
    },
  };
  const reader = new ProgramElementReadService(
    syntheticLegacyPrisma as never,
    {} as never,
    undefined,
    gate,
  );
  const tenantContext = {
    tenantId: options.tenantId,
    tenantSlug: 'package9-f06-synthetic',
    userId: 'p9-f06-synthetic-user',
    clerkUserId: 'p9-f06-synthetic-clerk-user',
    role: 'member',
  } as unknown as TenantContext;
  const rows = await tenantStore.run(tenantContext, () => reader.getBudgetPositions(F06_PE_CODE));
  return { rows, snapshotIds, legacyReads };
}

type SyntheticPeRows = Awaited<ReturnType<ProgramElementReadService['getBudgetPositions']>>;
function canonicalizePeResponse(rows: SyntheticPeRows): SyntheticPeRows {
  return [...rows].sort(
    (a, b) =>
      a.assertedFy - b.assertedFy ||
      a.positionCycle.localeCompare(b.positionCycle) ||
      a.valueKind.localeCompare(b.valueKind),
  );
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
  const app = new PrismaClient({ datasources: { db: { url: APP_URL } } });

  const auditEntries: PromotionAuditEntryV1[] = [];
  const persistedAudit = new PrismaPromotionAuditSinkV1(promoter.defenseBudgetPromotionAudit);
  const audit = {
    async record(entry: PromotionAuditEntryV1) {
      auditEntries.push(entry);
      await persistedAudit.record(entry);
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
    check(projections.length === 2, `projector produced ${projections.length} O&M projections`);

    // The rollback rehearsal exercises the real PE read service against both
    // snapshots. Seed two deterministic synthetic budget positions per
    // snapshot; the candidate deliberately carries a conspicuous bad FY2027
    // amount so pointer rollback has a visible response-level effect.
    const peCandidates: ProjectionCandidateInputV1[] = [
      { key: 'total', valueKind: 'total', valueMillions: '999', originalValue: '999' },
      { key: 'quantity', valueKind: 'quantity', valueMillions: '12', originalValue: '12' },
    ].map((row) => ({
      candidateId: `p9-f06:${row.key}`,
      target: 'ProgramElementBudgetPosition',
      naturalKey: row.key === 'total' ? F06_CANDIDATE_FY2027 : F06_CANDIDATE_QUANTITY_FY2027,
      operation: 'insert',
      reason: 'synthetic populated rollback rehearsal',
      artifactId: `artifact-p9-f06-${row.key}`,
      artifactContentSha256: SHA('f'),
      verificationCandidateId: `candidate-p9-f06-${row.key}`,
      verificationRunId: `run-p9-f06-${row.key}`,
      verificationDecisionId: `decision-p9-f06-${row.key}`,
      sourceDocumentKey: '00000000-0000-0000-0000-000000000001',
      sourcePdfSha256: SHA('d'),
      assertionIds: [`assert-p9-f06-${row.key}`],
      evidenceIds: [`evidence-p9-f06-${row.key}`],
      values: {
        peCode: F06_PE_CODE,
        fiscalYear: 2027,
        positionCycle: 'pb_fy2027',
        valueKind: row.valueKind,
        amount: row.valueMillions,
        originalValue: row.originalValue,
        originalUnit: 'millions',
      },
    }));
    const peProjectionResult = projectRdteCandidatesV1(peCandidates);
    if (peProjectionResult.refusals.length > 0) {
      fail(
        `RDT&E projector refused synthetic PE rows: ${peProjectionResult.refusals.map((r) => r.detail).join('; ')}`,
      );
    }
    const peIdentityResult = projectRdteCandidatesV1([
      {
        candidateId: 'p9-f06:identity',
        target: 'ProgramElement',
        naturalKey: F06_PE_CODE,
        operation: 'insert',
        reason: 'synthetic populated rollback rehearsal',
        artifactId: 'artifact-p9-f06-identity',
        artifactContentSha256: SHA('f'),
        verificationCandidateId: 'candidate-p9-f06-identity',
        verificationRunId: 'run-p9-f06-identity',
        verificationDecisionId: 'decision-p9-f06-identity',
        sourceDocumentKey: '00000000-0000-0000-0000-000000000001',
        sourcePdfSha256: SHA('d'),
        assertionIds: ['assert-p9-f06-identity'],
        evidenceIds: ['evidence-p9-f06-identity'],
        values: { peCode: F06_PE_CODE, title: 'Synthetic rollback rehearsal PE' },
      },
    ]);
    if (peIdentityResult.refusals.length > 0) {
      fail(
        `RDT&E projector refused synthetic PE identity: ${peIdentityResult.refusals.map((r) => r.detail).join('; ')}`,
      );
    }
    projections.push(...peProjectionResult.projections, ...peIdentityResult.projections);
    check(
      peProjectionResult.projections.length === 2 && peIdentityResult.projections.length === 1,
      'RDT&E projector produced one Program Element identity and two populated budget positions',
    );

    const yearProjection = projections.find((p) => p.projectionKind === 'non_rdte:OmSagYear');
    check(
      yearProjection?.values.money?.valueMillions === '12.345678',
      'exact six-decimal money survived the read-project round trip',
    );

    const plan = buildPromotionPlanV1({
      planId: 'plan-engine-1',
      eligibilityHash: SHA('e'),
      scope: { cycleId: 'cycle-fy2027', fiscalYear: 2027, families: ['om', 'rdte'], stages: [] },
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
              '["om","rdte"]'::jsonb, '[]'::jsonb, '${SHA('a')}');`);

    // Gap 3 closeout: eligibility_hash is now a foreign key into
    // defense_budget_promotion_eligibility. Both the plan and both
    // authorizations below reuse SHA('e'), so one row covers all of them.
    //
    // ON CONFLICT DO NOTHING: SHA('e') ('e'.repeat(64)) collides with
    // pe-budget-phase7-plan-rehearsal.ts's ELIGIBILITY_HASH — the same 64-'e'
    // string — and both scripts run against the one shared disposable database
    // within a single rehearsal invocation, order notwithstanding.
    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_promotion_eligibility
        (eligibility_id, eligibility_hash, cycle_id, mapping_registry_version,
         mapping_registry_hash, scope, scope_hash, open_conflict_count,
         unsupported_item_count, document, generated_at)
      VALUES ('elig-engine-1', '${SHA('e')}', 'cycle-fy2027', '1.0.0', '${SHA('a')}',
              '{"cycleId":"cycle-fy2027","fiscalYear":2027,"families":["om","rdte"],"stages":[]}'::jsonb,
              '${SHA('a')}', 0, 0, '{}'::jsonb, now())
      ON CONFLICT ("eligibility_hash") DO NOTHING;`);

    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_promotion_plan
        (plan_id, plan_hash, eligibility_hash, mapping_registry_version, mapping_registry_hash,
         cycle_id, fiscal_year, scope, scope_hash, mode, proposed_snapshot_id,
         item_count, blocked_count, plan_document)
      VALUES ('plan-engine-1', '${plan.planHash}', '${SHA('e')}', '1.0.0', '${SHA('a')}',
              'cycle-fy2027', 2027, '{"families":["om","rdte"]}'::jsonb, '${SHA('a')}',
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
    check(result.stagedRowCount === 5, `staged ${result.stagedRowCount} canonical rows`);
    check(result.outboxRowCount === 5, `wrote ${result.outboxRowCount} outbox rows`);

    /* ---- Verify the committed state ---- */
    const [{ count: rowCount }] = await admin.$queryRawUnsafe<[{ count: bigint }]>(
      `SELECT count(*) FROM defense_budget_canonical_row WHERE snapshot_id = '${SNAPSHOT_ID}'`,
    );
    check(Number(rowCount) === 5, `canonical rows persisted (${rowCount})`);

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

    // Compose the shipped tenant-scoped read gate with the real active pointer
    // while every database and legacy fixture remains synthetic/disposable.
    const priorPeEnvironment = process.env.PE_SNAPSHOT_ENVIRONMENT;
    process.env.PE_SNAPSHOT_ENVIRONMENT = ENVIRONMENT;
    try {
      const canaryRead = await readSyntheticPe(app, {
        rollbackOn: false,
        tenantId: F06_CANARY_TENANT,
      });
      const candidateResponse = canonicalizePeResponse(canaryRead.rows);
      check(
        candidateResponse.length === 2,
        'canary foreground response came from populated canonical rows, not the legacy sentinel',
      );
      check(
        candidateResponse.find((row) => row.assertedFy === 2027)?.amount === '999',
        'candidate snapshot exposes the deliberately defective FY2027 value through ProgramElementReadService',
      );
      check(
        canaryRead.snapshotIds.includes(SNAPSHOT_ID),
        'tenant-scoped canary routed through the active snapshot pointer',
      );

      const emergencyRead = await readSyntheticPe(app, {
        rollbackOn: true,
        tenantId: F06_CANARY_TENANT,
      });
      check(
        emergencyRead.rows[0]?.positionCycle === 'legacy-only-fy2027',
        'emergency process switch restored legacy response',
      );
      check(emergencyRead.snapshotIds.length === 0, 'emergency switch bypassed snapshot row reads');
    } finally {
      if (priorPeEnvironment === undefined) delete process.env.PE_SNAPSHOT_ENVIRONMENT;
      else process.env.PE_SNAPSHOT_ENVIRONMENT = priorPeEnvironment;
    }

    /* ---- Rollback to a prior snapshot ---- */
    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_canonical_snapshot
        (id, snapshot_key, environment, cycle_id, fiscal_year, status,
         required_scopes, completed_scopes, mapping_registry_hash, snapshot_hash)
      VALUES ('${PRIOR_SNAPSHOT_ID}', 'snap-prior-engine', '${ENVIRONMENT}', 'cycle-fy2026', 2026,
              'STAGING', '[]'::jsonb, '[]'::jsonb, '${SHA('a')}', NULL);`);
    const [{ promotion_run_id: syntheticRunId }] = await admin.$queryRawUnsafe<
      [{ promotion_run_id: string }]
    >(
      `SELECT promotion_run_id FROM defense_budget_canonical_row WHERE snapshot_id = '${SNAPSHOT_ID}' AND canonical_entity = 'canonical_rdte_budget_position' LIMIT 1`,
    );
    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_canonical_row
        (snapshot_id, promotion_run_id, canonical_entity, canonical_natural_key, parent_natural_key,
         family, fiscal_year, funding_field, canonical_row_hash, money_original_value,
         money_original_unit, money_value_millions, attributes, direct_or_derived, binding_status,
         source_projection_id, source_assertion_id, evidence_ids, artifact_id, artifact_content_sha256,
         verification_candidate_id, verification_run_id, source_document_id, source_pdf_sha256, mapping_registry_hash)
      VALUES
        ('${PRIOR_SNAPSHOT_ID}', '${syntheticRunId}', 'canonical_rdte_program_element', '${F06_PE_CODE}', NULL,
         'rdte', NULL, NULL, '${SHA('4')}', NULL, NULL, NULL,
         '{"peCode":"${F06_PE_CODE}"}'::jsonb, 'direct', 'accepted',
         'p9-f06-prior-identity', 'assert-p9-f06-prior-identity', '["evidence-p9-f06-prior-identity"]'::jsonb,
         'artifact-p9-f06-prior-identity', '${SHA('f')}', 'candidate-p9-f06-prior-identity', 'run-p9-f06-prior-identity',
         '00000000-0000-0000-0000-000000000001', '${SHA('d')}', '${SHA('a')}'),
        ('${PRIOR_SNAPSHOT_ID}', '${syntheticRunId}', 'canonical_rdte_budget_position', '${F06_PRIOR_FY2027}', '${F06_PE_CODE}',
         'rdte', 2027, 'request', '${SHA('2')}', '250', 'millions', 250,
         '{"peCode":"${F06_PE_CODE}","positionCycle":"pb_fy2027","valueKind":"total"}'::jsonb,
         'direct', 'accepted', 'p9-f06-prior-2027', 'assert-p9-f06-prior-2027', '["evidence-p9-f06-prior-2027"]'::jsonb,
         'artifact-p9-f06-prior-2027', '${SHA('f')}', 'candidate-p9-f06-prior-2027', 'run-p9-f06-prior-2027',
         '00000000-0000-0000-0000-000000000001', '${SHA('d')}', '${SHA('a')}'),
        ('${PRIOR_SNAPSHOT_ID}', '${syntheticRunId}', 'canonical_rdte_budget_position', '${F06_PRIOR_QUANTITY_FY2027}', '${F06_PE_CODE}',
         'rdte', 2027, 'request', '${SHA('3')}', '12', 'millions', 12,
         '{"peCode":"${F06_PE_CODE}","positionCycle":"pb_fy2027","valueKind":"quantity"}'::jsonb,
         'direct', 'accepted', 'p9-f06-prior-quantity-2027', 'assert-p9-f06-prior-quantity-2027', '["evidence-p9-f06-prior-quantity-2027"]'::jsonb,
         'artifact-p9-f06-prior-quantity-2027', '${SHA('f')}', 'candidate-p9-f06-prior-quantity-2027', 'run-p9-f06-prior-quantity-2027',
         '00000000-0000-0000-0000-000000000001', '${SHA('d')}', '${SHA('a')}');
      UPDATE defense_budget_canonical_snapshot SET status = 'SUPERSEDED', snapshot_hash = '${SHA('b')}' WHERE id = '${PRIOR_SNAPSHOT_ID}';`);
    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_promotion_authorization
        (authorization_id, plan_id, plan_hash, eligibility_hash, scope_hash,
         expected_active_snapshot_id, authorizer_actor_id, authorizer_role, reason,
         issued_at, expires_at, segregation, authorization_hash)
      VALUES ('auth-rollback-1', 'plan-engine-1', '${plan.planHash}', '${SHA('e')}', '${SHA('a')}',
              '${SNAPSHOT_ID}', 'actor-admin', 'capiro_admin', 'rollback rehearsal',
              now(), now() + interval '1 hour', '{}'::jsonb, '${SHA('a')}');`);

    const candidateRowsBeforeRollback = await admin.$queryRawUnsafe<
      { canonical_entity: string; canonical_natural_key: string; canonical_row_hash: string }[]
    >(
      `SELECT canonical_entity, canonical_natural_key, canonical_row_hash
         FROM defense_budget_canonical_row WHERE snapshot_id = '${SNAPSHOT_ID}'
        ORDER BY canonical_entity, canonical_natural_key`,
    );

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
    check(Number(survivingRows) === 5, 'rolled-back snapshot kept all of its rows');
    const candidateRowsAfterRollback = await admin.$queryRawUnsafe<
      { canonical_entity: string; canonical_natural_key: string; canonical_row_hash: string }[]
    >(
      `SELECT canonical_entity, canonical_natural_key, canonical_row_hash
         FROM defense_budget_canonical_row WHERE snapshot_id = '${SNAPSHOT_ID}'
        ORDER BY canonical_entity, canonical_natural_key`,
    );
    check(
      JSON.stringify(candidateRowsAfterRollback) === JSON.stringify(candidateRowsBeforeRollback),
      'rollback left every immutable candidate row hash unchanged',
    );
    const [{ count: restoredRows }] = await admin.$queryRawUnsafe<[{ count: bigint }]>(
      `SELECT count(*) FROM defense_budget_canonical_row WHERE snapshot_id = '${PRIOR_SNAPSHOT_ID}'`,
    );
    check(
      Number(restoredRows) === 3,
      'prior snapshot retained its Program Element identity and both populated budget positions',
    );

    const [{ count: snapshots }] = await admin.$queryRawUnsafe<[{ count: bigint }]>(
      `SELECT count(*) FROM defense_budget_canonical_snapshot WHERE environment = '${ENVIRONMENT}'`,
    );
    check(Number(snapshots) === 2, 'no snapshot was deleted by the rollback');

    const rollbackRows = await admin.$queryRawUnsafe<
      [{ count: bigint; from_snapshot_id: string; to_snapshot_id: string }]
    >(
      `SELECT count(*) OVER() AS count, from_snapshot_id, to_snapshot_id
         FROM defense_budget_rollback_record WHERE authorization_id = 'auth-rollback-1'`,
    );
    check(rollbackRows.length === 1, 'durable rollback record was retained');
    check(
      rollbackRows[0].from_snapshot_id === SNAPSHOT_ID &&
        rollbackRows[0].to_snapshot_id === PRIOR_SNAPSHOT_ID,
      'rollback record preserves the exact pointer transition',
    );
    const [{ paused }] = await admin.$queryRawUnsafe<[{ paused: boolean }]>(
      `SELECT paused FROM defense_budget_side_effect_drain_pause
        WHERE domain = '${DOMAIN}' AND environment = '${ENVIRONMENT}'`,
    );
    check(paused, 'rollback left side-effect drain paused');
    const [{ count: rollbackOutbox }] = await admin.$queryRawUnsafe<[{ count: bigint }]>(
      `SELECT count(*) FROM defense_budget_promotion_outbox o
         JOIN defense_budget_promotion_activation a ON a.id = o.activation_id
        WHERE a.environment = '${ENVIRONMENT}' AND o.is_rollback = true AND o.suppress_alert = false`,
    );
    check(Number(rollbackOutbox) === 0, 'rollback emitted no unsuppressed notification');
    const [{ count: rollbackAudit }] = await admin.$queryRawUnsafe<[{ count: bigint }]>(
      `SELECT count(*) FROM defense_budget_promotion_audit
        WHERE authorization_id = 'auth-rollback-1' AND attempt_kind = 'REDEMPTION' AND outcome = 'ALLOWED'`,
    );
    check(Number(rollbackAudit) === 1, 'accepted rollback authorization has one durable audit row');

    const rollbackReadEnvironment = process.env.PE_SNAPSHOT_ENVIRONMENT;
    process.env.PE_SNAPSHOT_ENVIRONMENT = ENVIRONMENT;
    try {
      const afterRollbackRead = await readSyntheticPe(app, {
        rollbackOn: false,
        tenantId: F06_CANARY_TENANT,
      });
      const restoredResponse = canonicalizePeResponse(afterRollbackRead.rows);
      check(
        restoredResponse.length === 2,
        'post-rollback canary foreground response came from populated restored canonical rows',
      );
      check(
        JSON.stringify(restoredResponse) ===
          JSON.stringify([
            {
              positionCycle: 'pb_fy2027',
              assertedFy: 2027,
              amount: null,
              quantity: '12',
              valueKind: 'quantity',
              sourceUrl: null,
              pageNumber: null,
            },
            {
              positionCycle: 'pb_fy2027',
              assertedFy: 2027,
              amount: '250',
              quantity: null,
              valueKind: 'total',
              sourceUrl: null,
              pageNumber: null,
            },
          ]),
        'authorized pointer rollback restored the exact prior populated ProgramElementReadService response',
      );
      check(
        afterRollbackRead.snapshotIds.includes(PRIOR_SNAPSHOT_ID),
        'post-rollback tenant-scoped canary followed the restored pointer',
      );
    } finally {
      if (rollbackReadEnvironment === undefined) delete process.env.PE_SNAPSHOT_ENVIRONMENT;
      else process.env.PE_SNAPSHOT_ENVIRONMENT = rollbackReadEnvironment;
    }

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

    console.log(
      '[p7-engine] NOT_RUN: authenticated HTTP, deployed API restart, AWS/production DB rollback, real customer/source/notification activity, commercial activation',
    );
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
