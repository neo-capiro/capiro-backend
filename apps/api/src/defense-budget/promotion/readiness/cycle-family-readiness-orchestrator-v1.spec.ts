/**
 * Phase 10B-2 - cycle-family-readiness-orchestrator-v1 spec.
 */
import { createHash } from 'node:crypto';
import {
  evaluateAndAdvanceCycleFamilyReadinessV1,
  verifyPersistedPlanHashV1,
  type CycleFamilyReadinessOrchestratorPortsV1,
  type FamilyReconciliationCertificationPortV1,
  type FamilyReconciliationCertificationResultV1,
  type PromotionPlanInputLoaderPortV1,
  type PromotionPlanPersistencePortV1,
  type ReadinessCorpusLoaderPortV1,
} from './cycle-family-readiness-orchestrator-v1.js';
import type {
  CycleFamilyCorpusInputV1,
  CycleFamilyReadinessIdentityV1,
} from './cycle-family-readiness-v1.js';
import type {
  PromotionAuditEntryV1,
  PromotionAuditSinkV1,
  PromotionEligibilityRepositoryV1,
  TrustedActiveSnapshotRecordV1,
  TrustedCandidateRecordV1,
  TrustedCycleCertificationRecordV1,
  TrustedProjectionPlanRecordV1,
} from '../promotion-eligibility-service-v1.js';
import type { DefenseBudgetPromotionPlanV1, PromotionProjectionInputV1 } from '../promotion-planner-v1.js';

const SHA = (c: string) => c.repeat(64);
const NOW = new Date('2027-09-30T00:00:00.000Z');

const IDENTITY: CycleFamilyReadinessIdentityV1 = {
  fiscalYear: 2027,
  authorityTrack: 'authorization',
  familyGroup: 'om',
};

function readyCorpus(): CycleFamilyCorpusInputV1 {
  return {
    identity: IDENTITY,
    cycleId: 'cycle-fy2027-authorization',
    expectedSources: [
      {
        expectedSourceId: 'exp-1',
        sourceFamily: 'pb_o1',
        optional: false,
        expectedState: 'published',
        latestIngestion: 'ingested_pass',
      },
    ],
  };
}

class FakeCorpusLoader implements ReadinessCorpusLoaderPortV1 {
  constructor(public corpus: CycleFamilyCorpusInputV1) {}
  async loadCorpus(): Promise<CycleFamilyCorpusInputV1> {
    return this.corpus;
  }
}

class FakeReconciliationCertification implements FamilyReconciliationCertificationPortV1 {
  public calls = 0;
  constructor(public result: FamilyReconciliationCertificationResultV1) {}
  async reconcileAndCertify(): Promise<FamilyReconciliationCertificationResultV1> {
    this.calls += 1;
    return this.result;
  }
}

function certifiedResult(
  overrides: Partial<FamilyReconciliationCertificationResultV1> = {},
): FamilyReconciliationCertificationResultV1 {
  return {
    certified: true,
    certificationStatus: 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION',
    blockingFindingCount: 0,
    certificationContentSha256: SHA('c'),
    certificationRowId: 'cert-row-1',
    reason: 'all required gates passed',
    ...overrides,
  };
}

interface EligibilityFakeState {
  certifications: TrustedCycleCertificationRecordV1[];
  candidates: TrustedCandidateRecordV1[];
  latestTerminalRunId: Record<string, string | null>;
  projectionPlans: TrustedProjectionPlanRecordV1[];
  openConflicts: number;
  unsupported: number;
  activeSnapshot: TrustedActiveSnapshotRecordV1 | null;
}

function candidate(overrides: Partial<TrustedCandidateRecordV1> = {}): TrustedCandidateRecordV1 {
  return {
    candidateId: 'cand-1',
    status: 'VERIFICATION_PASSED',
    terminalVerificationRunId: 'run-1',
    family: 'om',
    extractionMethod: 'deterministic_pdfplumber',
    extractorActorId: 'actor-extractor',
    acceptedAssertionIds: ['a-1'],
    artifactSha256: SHA('a'),
    sourceSha256: SHA('b'),
    sourceProfileSha256: null,
    verificationPolicySha256: SHA('d'),
    manifestSha256: SHA('e'),
    ...overrides,
  };
}

function defaultEligibilityState(): EligibilityFakeState {
  return {
    certifications: [{ certificationId: 'cert-1', contentSha256: SHA('1'), status: 'CERTIFIED_READY' }],
    candidates: [candidate()],
    latestTerminalRunId: { 'cand-1': 'run-1' },
    projectionPlans: [{ projectionPlanId: 'pp-1', contentSha256: SHA('2') }],
    openConflicts: 0,
    unsupported: 0,
    activeSnapshot: null,
  };
}

class FakeEligibilityRepository implements PromotionEligibilityRepositoryV1 {
  constructor(public state: EligibilityFakeState) {}
  async loadCycleCertifications() {
    return this.state.certifications;
  }
  async loadCandidates() {
    return this.state.candidates;
  }
  async loadLatestTerminalRunId(candidateId: string) {
    return this.state.latestTerminalRunId[candidateId] ?? null;
  }
  async loadProjectionPlans() {
    return this.state.projectionPlans;
  }
  async countOpenBlockingConflicts() {
    return this.state.openConflicts;
  }
  async countUnsupportedProjections() {
    return this.state.unsupported;
  }
  async loadActiveSnapshot() {
    return this.state.activeSnapshot;
  }
}

class RecordingAudit implements PromotionAuditSinkV1 {
  entries: PromotionAuditEntryV1[] = [];
  async record(entry: PromotionAuditEntryV1) {
    this.entries.push(entry);
  }
}

class FakePlanInputs implements PromotionPlanInputLoaderPortV1 {
  constructor(
    public projections: PromotionProjectionInputV1[] = [],
    public activeSnapshot: { snapshotId: string; snapshotHash: string } | null = null,
  ) {}
  async loadProjections() {
    return this.projections;
  }
  async loadPriorRows() {
    return [];
  }
  async loadOverlays() {
    return [];
  }
  async loadExpectedActiveSnapshot() {
    return this.activeSnapshot;
  }
}

class FakePlanPersistence implements PromotionPlanPersistencePortV1 {
  public stored = new Map<string, DefenseBudgetPromotionPlanV1>();
  public persistCallCount = 0;
  async persistPlan(plan: DefenseBudgetPromotionPlanV1) {
    this.persistCallCount += 1;
    const existing = this.stored.get(plan.planId);
    if (existing != null && existing.planHash !== plan.planHash) {
      throw new Error(
        `plan_id_conflict: plan ${plan.planId} already filed with a different hash`,
      );
    }
    const replay = existing != null;
    this.stored.set(plan.planId, plan);
    return { filed: true, replay };
  }
}

function buildPorts(overrides: {
  corpus?: CycleFamilyCorpusInputV1;
  reconciliation?: FamilyReconciliationCertificationResultV1;
  eligibilityState?: EligibilityFakeState;
  projections?: PromotionProjectionInputV1[];
} = {}) {
  const corpusLoader = new FakeCorpusLoader(overrides.corpus ?? readyCorpus());
  const reconciliationCertification = new FakeReconciliationCertification(
    overrides.reconciliation ?? certifiedResult(),
  );
  const eligibilityRepository = new FakeEligibilityRepository(
    overrides.eligibilityState ?? defaultEligibilityState(),
  );
  const eligibilityAudit = new RecordingAudit();
  const planInputs = new FakePlanInputs(overrides.projections ?? []);
  const planPersistence = new FakePlanPersistence();

  const ports: CycleFamilyReadinessOrchestratorPortsV1 = {
    corpusLoader,
    reconciliationCertification,
    eligibilityRepository,
    eligibilityAudit,
    planInputs,
    planPersistence,
    now: () => NOW,
  };
  return {
    ports,
    corpusLoader,
    reconciliationCertification,
    eligibilityRepository,
    eligibilityAudit,
    planInputs,
    planPersistence,
  };
}

const RUN_OPTIONS = { mode: 'new_cycle' as const, environment: 'dev' };

describe('evaluateAndAdvanceCycleFamilyReadinessV1', () => {
  it('[waiting] an incomplete corpus never invokes reconciliation/certification', async () => {
    const notReadyCorpus: CycleFamilyCorpusInputV1 = {
      identity: IDENTITY,
      cycleId: 'cycle-fy2027-authorization',
      expectedSources: [
        {
          expectedSourceId: 'exp-1',
          sourceFamily: 'pb_o1',
          optional: false,
          expectedState: 'expected',
          latestIngestion: null,
        },
      ],
    };
    const { ports, reconciliationCertification, planPersistence } = buildPorts({
      corpus: notReadyCorpus,
    });
    const result = await evaluateAndAdvanceCycleFamilyReadinessV1(IDENTITY, ports, RUN_OPTIONS);
    expect(result.outcome).toBe('waiting_for_sources');
    expect(reconciliationCertification.calls).toBe(0);
    expect(planPersistence.persistCallCount).toBe(0);
    expect(result.planId).toBeNull();
  });

  it('[reconciliation_failed] a corpus that certifies INCOMPLETE creates no promotion plan', async () => {
    const { ports, planPersistence } = buildPorts({
      reconciliation: certifiedResult({
        certified: false,
        certificationStatus: 'INCOMPLETE',
        certificationContentSha256: null,
        certificationRowId: null,
        blockingFindingCount: 2,
        reason: 'required document missing',
      }),
    });
    const result = await evaluateAndAdvanceCycleFamilyReadinessV1(IDENTITY, ports, RUN_OPTIONS);
    expect(result.outcome).toBe('reconciliation_failed');
    expect(result.planId).toBeNull();
    expect(planPersistence.persistCallCount).toBe(0);
  });

  it('[certification_failed] a corpus that certifies REJECTED creates no promotion plan', async () => {
    const { ports, planPersistence } = buildPorts({
      reconciliation: certifiedResult({
        certified: false,
        certificationStatus: 'REJECTED',
        certificationContentSha256: null,
        certificationRowId: null,
        blockingFindingCount: 1,
        reason: 'rejected artifact present',
      }),
    });
    const result = await evaluateAndAdvanceCycleFamilyReadinessV1(IDENTITY, ports, RUN_OPTIONS);
    expect(result.outcome).toBe('certification_failed');
    expect(result.planId).toBeNull();
    expect(planPersistence.persistCallCount).toBe(0);
  });

  it('[certification_failed] a certified-clean corpus that fails the EXISTING eligibility gate creates no promotion plan', async () => {
    const { ports, planPersistence } = buildPorts({
      eligibilityState: { ...defaultEligibilityState(), openConflicts: 3 },
    });
    const result = await evaluateAndAdvanceCycleFamilyReadinessV1(IDENTITY, ports, RUN_OPTIONS);
    expect(result.outcome).toBe('certification_failed');
    expect(result.planId).toBeNull();
    expect(planPersistence.persistCallCount).toBe(0);
  });

  it('[ready_for_plan -> awaiting_authorization] a successful certified corpus creates exactly one deterministic plan/hash and stops at awaiting_authorization', async () => {
    const { ports, planPersistence } = buildPorts();
    const result = await evaluateAndAdvanceCycleFamilyReadinessV1(IDENTITY, ports, RUN_OPTIONS);

    expect(result.outcome).toBe('awaiting_authorization');
    expect(result.planId).not.toBeNull();
    expect(result.planHash).not.toBeNull();
    expect(result.planReplay).toBe(false);
    expect(planPersistence.persistCallCount).toBe(1);

    const storedPlan = planPersistence.stored.get(result.planId as string);
    expect(storedPlan).toBeDefined();
    expect(verifyPersistedPlanHashV1(storedPlan as DefenseBudgetPromotionPlanV1)).toBe(true);

    // Determinism: recompute the same run and confirm the plan hash is
    // reproducible from the same certified inputs (not merely non-null).
    const secondPorts = buildPorts();
    const secondResult = await evaluateAndAdvanceCycleFamilyReadinessV1(
      IDENTITY,
      secondPorts.ports,
      RUN_OPTIONS,
    );
    expect(secondResult.planId).toBe(result.planId);
    expect(secondResult.planHash).toBe(result.planHash);
  });

  it('[idempotent replay] re-running with identical certified inputs converges to the same plan/hash and creates no duplicate pending promotion', async () => {
    const { ports, planPersistence } = buildPorts();

    const first = await evaluateAndAdvanceCycleFamilyReadinessV1(IDENTITY, ports, RUN_OPTIONS);
    expect(first.planReplay).toBe(false);
    expect(planPersistence.stored.size).toBe(1);

    const second = await evaluateAndAdvanceCycleFamilyReadinessV1(IDENTITY, ports, RUN_OPTIONS);
    expect(second.outcome).toBe('awaiting_authorization');
    expect(second.planId).toBe(first.planId);
    expect(second.planHash).toBe(first.planHash);
    expect(second.planReplay).toBe(true);
    // Still exactly one row for this plan id — no duplicate pending promotion.
    expect(planPersistence.stored.size).toBe(1);
    expect(planPersistence.persistCallCount).toBe(2);
  });

  it('[new identity on change] changed source/certification input produces a new plan identity/hash rather than mutating an authorized historical plan', async () => {
    const { ports: firstPorts } = buildPorts({
      reconciliation: certifiedResult({ certificationContentSha256: SHA('c') }),
    });
    const first = await evaluateAndAdvanceCycleFamilyReadinessV1(IDENTITY, firstPorts, RUN_OPTIONS);

    // A DIFFERENT certified certification content hash simulates changed
    // source/certification input (e.g. a corrected re-extraction).
    const { ports: secondPorts, planPersistence: secondPersistence } = buildPorts({
      reconciliation: certifiedResult({ certificationContentSha256: SHA('f') }),
    });
    const second = await evaluateAndAdvanceCycleFamilyReadinessV1(
      IDENTITY,
      secondPorts,
      RUN_OPTIONS,
    );

    expect(second.outcome).toBe('awaiting_authorization');
    expect(second.planId).not.toBe(first.planId);
    expect(second.planHash).not.toBe(first.planHash);
    // The new plan is filed as a FIRST file (not a replay) under its own new
    // identity — it never mutates the first plan's row.
    expect(second.planReplay).toBe(false);
    expect(secondPersistence.stored.has(first.planId as string)).toBe(false);
  });

  it('[authorization boundary] the persisted plan conflict guard refuses to silently overwrite an existing plan id with different content (never mutates an authorized historical plan)', async () => {
    const { planPersistence } = buildPorts();
    const planA: DefenseBudgetPromotionPlanV1 = {
      schemaVersion: 'defense_budget_promotion_plan_v1',
      planId: 'plan-fixed-id',
      mappingRegistryVersion: 'v1',
      mappingRegistryHash: SHA('1'),
      eligibilityHash: SHA('2'),
      scope: { cycleId: 'c', fiscalYear: 2027, families: ['om'], stages: [] },
      mode: 'new_cycle',
      expectedActiveSnapshotId: null,
      proposedSnapshotId: SHA('3').slice(0, 36),
      items: [],
      counts: { total: 0, insert: 0, supersede: 0, unchanged: 0, correction: 0, blocked: 0, alertEligible: 0 },
      diffsByFamily: [],
      diffsByEntity: [],
      diffsByFiscalYear: [],
      diffsByFundingField: [],
      blockReasonCounts: [],
      blocked: false,
      planHash: SHA('4'),
    };
    const planB: DefenseBudgetPromotionPlanV1 = { ...planA, planHash: SHA('5') };

    await planPersistence.persistPlan(planA);
    await expect(planPersistence.persistPlan(planB)).rejects.toThrow(/plan_id_conflict/);
  });

  it('[authorization boundary — absolute invariant] no code path (outside doc comments) in the orchestrator references PROMOTER_DATABASE_URL, DefenseBudgetCanonicalPromotionServiceV1, or DefenseBudgetPromotionAuthorizationServiceV1', () => {
    const orchestratorPath = require('node:path').join(__dirname, 'cycle-family-readiness-orchestrator-v1.ts');
    const rawSource = require('node:fs').readFileSync(orchestratorPath, 'utf8') as string;
    // Strip comments first — the file's OWN header/inline docs deliberately
    // NAME every forbidden identifier to explain why they are absent from
    // real code. Scanning the doc prose itself would produce a false
    // positive on the exact sentence that documents the invariant. This
    // mirrors `phase7-closeout-gates-v1.ts`'s own `stripComments` approach.
    const codeOnly = rawSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      'PROMOTER_DATABASE_URL',
      'DefenseBudgetCanonicalPromotionServiceV1',
      'DefenseBudgetPromotionAuthorizationServiceV1',
      '.execute(',
      'process.env.DATABASE_URL',
    ]) {
      expect(codeOnly.includes(forbidden)).toBe(false);
    }
  });

  it('[authorization boundary] the result contract has no "authorized" or "executed" member; the highest reachable outcome is awaiting_authorization', async () => {
    const { ports } = buildPorts();
    const result = await evaluateAndAdvanceCycleFamilyReadinessV1(IDENTITY, ports, RUN_OPTIONS);
    expect(Object.keys(result)).not.toContain('authorized');
    expect(Object.keys(result)).not.toContain('executed');
    expect(result.outcome).toBe('awaiting_authorization');
  });
});
