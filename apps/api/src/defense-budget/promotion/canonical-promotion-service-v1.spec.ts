/**
 * Phase 7 Workstream E â€” staging is invisible and resumable, activation is one
 * exactly-once transaction, and nothing downstream runs inside it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AmbiguousActivationError,
  DefenseBudgetCanonicalPromotionServiceV1,
  classifyOutboxV1,
  snapshotHashFor,
  type ActivationInputV1,
  type ActivationOutcomeV1,
  type CanonicalRowInputV1,
  type PromotionExecutionRepositoryV1,
  type PromotionExecutionRequestV1,
  type StoredExecutionActivationV1,
  type StoredExecutionAuthorizationV1,
  type StoredExecutionPlanV1,
  type StoredExecutionRunV1,
  type StoredSnapshotV1,
} from './canonical-promotion-service-v1.js';
import {
  buildPromotionPlanV1,
  type CanonicalLineageV1,
  type PromotionModeV1,
  type PromotionPlanItemV1,
  type PromotionProjectionInputV1,
} from './promotion-planner-v1.js';
import { canonicalMappingRegistryHashV1 } from './canonical-mapping-registry-v1.js';
import type {
  PromotionAuditEntryV1,
  PromotionAuditSinkV1,
} from './promotion-eligibility-service-v1.js';
import type { PromotionScopeV1 } from './promotion-eligibility-v1.js';

const SHA = (c: string) => c.repeat(64);
const NOW = new Date('2027-10-01T00:00:00.000Z');
const FUTURE = '2027-10-02T00:00:00.000Z';
const SNAP_NEW = 'snap-next';
const SAG_KEY = 'ARMY|OMA|SAG-111';
const YEAR_KEY = 'ARMY|OMA|SAG-111|2027|request';

const SCOPE: PromotionScopeV1 = {
  cycleId: 'cycle-fy2027',
  fiscalYear: 2027,
  families: ['om'],
  stages: [],
};

const LINEAGE: CanonicalLineageV1 = {
  sourceAssertionId: 'assert-1',
  evidenceIds: ['ev-1'],
  artifactId: 'artifact-1',
  artifactContentSha256: SHA('a'),
  verificationCandidateId: 'cand-1',
  verificationRunId: 'run-1',
  sourceDocumentId: 'doc-1',
  sourcePdfSha256: SHA('b'),
};

function sagIdentity(o: Partial<PromotionProjectionInputV1> = {}): PromotionProjectionInputV1 {
  return {
    projectionId: 'proj-sag',
    projectionHash: SHA('1'),
    projectionKind: 'non_rdte:OmSag',
    naturalKey: SAG_KEY,
    directOrDerived: 'direct',
    values: { textValue: 'Operating Forces' },
    lineage: LINEAGE,
    ...o,
  };
}

function sagYear(o: Partial<PromotionProjectionInputV1> = {}): PromotionProjectionInputV1 {
  return {
    projectionId: 'proj-year',
    projectionHash: SHA('2'),
    projectionKind: 'non_rdte:OmSagYear',
    naturalKey: YEAR_KEY,
    parentNaturalKey: SAG_KEY,
    fiscalYear: 2027,
    fundingField: 'request',
    directOrDerived: 'direct',
    values: { money: { originalValue: '1250', originalUnit: 'thousands', valueMillions: '1.25' } },
    lineage: LINEAGE,
    ...o,
  };
}

function makePlan(
  projections: PromotionProjectionInputV1[],
  mode: PromotionModeV1 = 'baseline_hydration',
): StoredExecutionPlanV1 {
  const plan = buildPromotionPlanV1({
    planId: 'plan-1',
    eligibilityHash: SHA('e'),
    scope: SCOPE,
    mode,
    proposedSnapshotId: SNAP_NEW,
    expectedActiveSnapshotId: null,
    actualActiveSnapshotId: null,
    mappingRegistryHash: canonicalMappingRegistryHashV1(),
    projections,
    priorRows: [],
    overlays: [],
  });
  return {
    planId: plan.planId,
    planHash: plan.planHash,
    eligibilityHash: plan.eligibilityHash,
    mappingRegistryHash: plan.mappingRegistryHash,
    mode: plan.mode,
    proposedSnapshotId: SNAP_NEW,
    expectedActiveSnapshotId: null,
    blockedCount: plan.counts.blocked,
    plan,
  };
}

interface FakeOptions {
  activateThrows?: Error;
  authorizationOverrides?: Partial<StoredExecutionAuthorizationV1>;
  activeSnapshotId?: string | null;
  requiredScopes?: string[];
  rollbackTargetStatus?: { id: string; status: string };
  /** Extra rows already staged, to simulate a corrupted or drifted resume. */
  preStaged?: Map<string, string>;
}

class FakeRepository implements PromotionExecutionRepositoryV1 {
  runs = new Map<string, StoredExecutionRunV1>();
  staged = new Map<string, string>();
  stagedRows: CanonicalRowInputV1[] = [];
  activations = new Map<string, StoredExecutionActivationV1>();
  activationCalls: ActivationInputV1[] = [];
  stageCalls = 0;
  lockDepth = 0;
  maxLockDepth = 0;
  scopesMarked: string[] = [];
  snapshotReadyHash: string | null = null;
  statusLog: { runId: string; status: string }[] = [];
  private nextId = 1;

  constructor(
    private readonly plan: StoredExecutionPlanV1,
    private readonly projections: PromotionProjectionInputV1[],
    private readonly opts: FakeOptions = {},
  ) {
    if (opts.preStaged) this.staged = new Map(opts.preStaged);
  }

  async loadPlan(planId: string) {
    return planId === this.plan.planId ? this.plan : null;
  }

  async loadAuthorization(authorizationId: string): Promise<StoredExecutionAuthorizationV1 | null> {
    if (authorizationId !== 'auth-1' && authorizationId !== 'auth-rollback') return null;
    return {
      authorizationId,
      planId: this.plan.planId,
      planHash: this.plan.planHash,
      eligibilityHash: this.plan.eligibilityHash,
      expectedActiveSnapshotId: this.opts.activeSnapshotId ?? null,
      expiresAt: FUTURE,
      consumedAt: null,
      consumedByRunId: null,
      ...this.opts.authorizationOverrides,
    };
  }

  async loadProjections() {
    return this.projections;
  }

  async loadActiveSnapshotId() {
    return this.opts.activeSnapshotId ?? null;
  }

  async loadSnapshot(snapshotId: string): Promise<StoredSnapshotV1 | null> {
    return {
      snapshotId,
      // A rollback target is a previously activated snapshot; the proposed
      // snapshot is still staging. The fake distinguishes them so the
      // eligibility check has something real to read.
      status:
        snapshotId === this.opts.rollbackTargetStatus?.id
          ? this.opts.rollbackTargetStatus.status
          : snapshotId === SNAP_NEW
            ? 'STAGING'
            : 'SUPERSEDED',
      requiredScopes: this.opts.requiredScopes ?? ['om'],
      completedScopes: [],
      snapshotHash: null,
    };
  }

  /** Serializes like a real advisory lock: one holder at a time, FIFO. */
  private lockChain: Promise<unknown> = Promise.resolve();
  async withDomainCycleLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
    const run = this.lockChain.then(async () => {
      this.lockDepth += 1;
      this.maxLockDepth = Math.max(this.maxLockDepth, this.lockDepth);
      try {
        return await fn();
      } finally {
        this.lockDepth -= 1;
      }
    });
    this.lockChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run as Promise<T>;
  }

  async findRunByKey(runKey: string) {
    return this.runs.get(runKey) ?? null;
  }

  async createRun(input: { runKey: string; snapshotId: string }) {
    const run: StoredExecutionRunV1 = {
      runId: `run-${this.nextId++}`,
      runKey: input.runKey,
      status: 'STAGING',
      snapshotId: input.snapshotId,
      stagedRowCount: 0,
    };
    this.runs.set(input.runKey, run);
    return run;
  }

  async updateRunStatus(runId: string, status: string) {
    this.statusLog.push({ runId, status });
    for (const run of this.runs.values()) {
      if (run.runId === runId) run.status = status;
    }
  }

  async loadStagedRowHashes() {
    return new Map(this.staged);
  }

  pausedDrains: string[] = [];
  rollbackRecords: { toSnapshotId: string; reason: string }[] = [];

  async pauseSideEffectDrain(domain: string, environment: string) {
    this.pausedDrains.push(`${domain}:${environment}`);
  }

  async resumeSideEffectDrain() {}

  async recordRollback(input: { toSnapshotId: string; reason: string }) {
    this.rollbackRecords.push({ toSnapshotId: input.toSnapshotId, reason: input.reason });
  }

  async stageRows(rows: CanonicalRowInputV1[]) {
    this.stageCalls += 1;
    for (const row of rows) {
      const key = `${row.canonicalEntity} ${row.canonicalNaturalKey}`;
      // Idempotent: a repeat write of the same identity must not duplicate.
      if (!this.staged.has(key)) this.stagedRows.push(row);
      this.staged.set(key, row.canonicalRowHash);
    }
  }

  async recordPlanItemsStaged() {}

  async markScopesComplete(_snapshotId: string, scopes: string[]) {
    this.scopesMarked = scopes;
  }

  async markSnapshotReady(_snapshotId: string, hash: string) {
    this.snapshotReadyHash = hash;
  }

  async activate(input: ActivationInputV1): Promise<ActivationOutcomeV1> {
    this.activationCalls.push(input);
    if (this.opts.activateThrows) throw this.opts.activateThrows;
    if (this.activations.has(input.activationKey)) {
      throw new Error('duplicate activation key');
    }
    const activation: StoredExecutionActivationV1 = {
      activationId: `activation-${this.nextId++}`,
      activationKey: input.activationKey,
      newSnapshotId: input.newSnapshotId,
      previousSnapshotId: input.previousSnapshotId,
    };
    this.activations.set(input.activationKey, activation);
    return {
      activationId: activation.activationId,
      previousSnapshotId: activation.previousSnapshotId,
      newSnapshotId: activation.newSnapshotId,
    };
  }

  async findActivationByKey(activationKey: string) {
    return this.activations.get(activationKey) ?? null;
  }
}

class RecordingAudit implements PromotionAuditSinkV1 {
  entries: PromotionAuditEntryV1[] = [];
  async record(entry: PromotionAuditEntryV1) {
    this.entries.push(entry);
  }
}

const REQUEST = (o: Partial<PromotionExecutionRequestV1> = {}): PromotionExecutionRequestV1 => ({
  planId: 'plan-1',
  authorizationId: 'auth-1',
  expectedPlanHash: '',
  expectedActiveSnapshotId: null,
  executorIdentity: 'fargate:promoter',
  executionMode: 'execute',
  environment: 'rehearsal',
  ...o,
});

function build(
  projections: PromotionProjectionInputV1[] = [sagIdentity(), sagYear()],
  opts: FakeOptions = {},
  mode: PromotionModeV1 = 'baseline_hydration',
) {
  const plan = makePlan(projections, mode);
  const repository = new FakeRepository(plan, projections, opts);
  const audit = new RecordingAudit();
  const service = new DefenseBudgetCanonicalPromotionServiceV1(repository, audit, {
    now: () => NOW,
    chunkSize: 1,
  });
  return {
    plan,
    repository,
    audit,
    service,
    request: REQUEST({ expectedPlanHash: plan.planHash }),
  };
}

describe('Phase 7 WS E â€” complete staging and activation', () => {
  it('stages every authorized row and activates once', async () => {
    const { service, repository, request } = build();
    const result = await service.execute(request);

    expect(result.committed).toBe(true);
    expect(result.stagedRowCount).toBe(2);
    expect(repository.staged.size).toBe(2);
    expect(repository.activationCalls).toHaveLength(1);
    expect(result.recoveredExistingActivation).toBe(false);
  });

  it('holds the domain/cycle advisory lock for the whole run', async () => {
    const { service, repository, request } = build();
    await service.execute(request);
    expect(repository.maxLockDepth).toBe(1);
  });

  it('stages in bounded chunks', async () => {
    const { service, repository, request } = build();
    await service.execute(request);
    // chunkSize is 1 and there are two rows.
    expect(repository.stageCalls).toBe(2);
  });

  it('marks the snapshot READY with a deterministic content hash before activating', async () => {
    const { service, repository, request, plan } = build();
    await service.execute(request);
    expect(repository.snapshotReadyHash).toBe(snapshotHashFor(plan, repository.stagedRows));
  });

  it('carries full lineage onto every staged row', async () => {
    const { service, repository, request } = build();
    await service.execute(request);
    for (const row of repository.stagedRows) {
      expect(row.sourceAssertionId).toBe('assert-1');
      expect(row.artifactContentSha256).toBe(SHA('a'));
      expect(row.verificationRunId).toBe('run-1');
      expect(row.mappingRegistryHash).toBe(canonicalMappingRegistryHashV1());
      expect(row.directOrDerived).toBe('direct');
    }
  });

  it('stores money as its exact three parts and never as a number', async () => {
    const { service, repository, request } = build();
    await service.execute(request);
    const yearRow = repository.stagedRows.find(
      (row) => row.canonicalEntity === 'canonical_om_sag_year',
    );
    expect(yearRow?.moneyOriginalValue).toBe('1250');
    expect(yearRow?.moneyOriginalUnit).toBe('thousands');
    expect(yearRow?.moneyValueMillions).toBe('1.25');
    expect(typeof yearRow?.moneyValueMillions).toBe('string');
  });
});

describe('Phase 7 WS E â€” resume and idempotency', () => {
  it('resumes a partially staged run without restaging what is already there', async () => {
    const { service, repository, request, plan } = build();
    // Stage the identity row up front, as an interrupted run would have.
    const first = buildPromotionPlanV1({
      planId: 'plan-1',
      eligibilityHash: SHA('e'),
      scope: SCOPE,
      mode: 'baseline_hydration',
      proposedSnapshotId: SNAP_NEW,
      expectedActiveSnapshotId: null,
      actualActiveSnapshotId: null,
      mappingRegistryHash: canonicalMappingRegistryHashV1(),
      projections: [sagIdentity(), sagYear()],
    });
    const identityItem = first.items.find((i) => i.canonicalEntity === 'canonical_om_sag');
    repository.staged.set(`canonical_om_sag ${SAG_KEY}`, identityItem?.proposedRowHash ?? '');

    const result = await service.execute(request);
    expect(result.committed).toBe(true);
    // Only the year row needed staging.
    expect(repository.stageCalls).toBe(1);
    expect(repository.staged.size).toBe(2);
    expect(plan.blockedCount).toBe(0);
  });

  it('refuses a resume whose already-staged row hashes to something else', async () => {
    const preStaged = new Map([[`canonical_om_sag ${SAG_KEY}`, SHA('f')]]);
    const { service, request, repository } = build([sagIdentity(), sagYear()], { preStaged });
    const result = await service.execute(request);

    expect(result.committed).toBe(false);
    expect(result.refusals.map((r) => r.reason)).toContain('staged_row_hash_mismatch');
    expect(repository.activationCalls).toHaveLength(0);
  });

  it('produces the same run key for the same plan and authorization', () => {
    const a = DefenseBudgetCanonicalPromotionServiceV1.runKeyFor('p', 'a', 's');
    const b = DefenseBudgetCanonicalPromotionServiceV1.runKeyFor('p', 'a', 's');
    expect(a).toBe(b);
    expect(DefenseBudgetCanonicalPromotionServiceV1.runKeyFor('p', 'a', 't')).not.toBe(a);
  });
});

describe('Phase 7 WS E â€” pre-activation proof', () => {
  it('refuses when a plan item has no reloaded projection', async () => {
    // The plan authorizes two rows; only one projection comes back.
    const plan = makePlan([sagIdentity(), sagYear()]);
    const repository = new FakeRepository(plan, [sagIdentity()]);
    const service = new DefenseBudgetCanonicalPromotionServiceV1(repository, new RecordingAudit(), {
      now: () => NOW,
    });
    const result = await service.execute(REQUEST({ expectedPlanHash: plan.planHash }));

    expect(result.committed).toBe(false);
    expect(result.refusals.map((r) => r.reason)).toContain('projection_missing');
    expect(repository.activationCalls).toHaveLength(0);
  });

  it('refuses when a reloaded projection no longer hashes to the authorized value', async () => {
    const plan = makePlan([sagIdentity(), sagYear()]);
    // The projection changed value after the plan was authorized.
    const drifted = [
      sagIdentity(),
      sagYear({
        values: {
          money: { originalValue: '9990', originalUnit: 'thousands', valueMillions: '9.99' },
        },
      }),
    ];
    const repository = new FakeRepository(plan, drifted);
    const service = new DefenseBudgetCanonicalPromotionServiceV1(repository, new RecordingAudit(), {
      now: () => NOW,
    });
    const result = await service.execute(REQUEST({ expectedPlanHash: plan.planHash }));

    expect(result.committed).toBe(false);
    expect(result.refusals.map((r) => r.reason)).toContain('projection_hash_mismatch');
    expect(repository.activationCalls).toHaveLength(0);
  });

  it('refuses when an extra row is staged that the plan does not authorize', async () => {
    const preStaged = new Map([['canonical_om_sag ARMY|OMA|SAG-999', SHA('c')]]);
    const { service, request, repository } = build([sagIdentity(), sagYear()], { preStaged });
    const result = await service.execute(request);

    expect(result.committed).toBe(false);
    expect(result.refusals.map((r) => r.reason)).toContain('extra_staged_row');
    expect(repository.activationCalls).toHaveLength(0);
  });

  it('refuses when the snapshot requires a scope the plan does not cover', async () => {
    const { service, request, repository } = build([sagIdentity(), sagYear()], {
      requiredScopes: ['om', 'procurement'],
    });
    const result = await service.execute(request);

    expect(result.committed).toBe(false);
    expect(result.refusals.map((r) => r.reason)).toContain('required_scope_incomplete');
    expect(repository.activationCalls).toHaveLength(0);
  });

  it('leaves the run FAILED_PRECOMMIT and nothing active when a pre-activation check fires', async () => {
    const { service, request, repository } = build([sagIdentity(), sagYear()], {
      requiredScopes: ['om', 'milcon'],
    });
    await service.execute(request);
    expect(repository.statusLog.map((s) => s.status)).toContain('FAILED_PRECOMMIT');
    expect(repository.activations.size).toBe(0);
  });

  it('does not activate in dry_run mode', async () => {
    const { service, request, repository } = build();
    const result = await service.execute({ ...request, executionMode: 'dry_run' });

    expect(result.committed).toBe(false);
    expect(result.stagedRowCount).toBe(2);
    expect(repository.activationCalls).toHaveLength(0);
    expect(repository.statusLog.map((s) => s.status)).toContain('READY');
  });
});

describe('Phase 7 WS E â€” bindings are reloaded and compared', () => {
  it('refuses a plan hash the caller got wrong', async () => {
    const { service, request } = build();
    const result = await service.execute({ ...request, expectedPlanHash: SHA('0') });
    expect(result.refusals.map((r) => r.reason)).toContain('plan_hash_mismatch');
  });

  it('refuses a missing plan', async () => {
    const { service, request } = build();
    const result = await service.execute({ ...request, planId: 'nope' });
    expect(result.refusals.map((r) => r.reason)).toContain('plan_not_found');
  });

  it('refuses a missing authorization', async () => {
    const { service, request } = build();
    const result = await service.execute({ ...request, authorizationId: 'nope' });
    expect(result.refusals.map((r) => r.reason)).toContain('authorization_not_found');
  });

  it('refuses an expired authorization', async () => {
    const { service, request } = build([sagIdentity(), sagYear()], {
      authorizationOverrides: { expiresAt: '2027-09-01T00:00:00.000Z' },
    });
    const result = await service.execute(request);
    expect(result.refusals.map((r) => r.reason)).toContain('authorization_expired');
  });

  it('refuses an authorization already consumed by another run', async () => {
    const { service, request, repository } = build([sagIdentity(), sagYear()], {
      authorizationOverrides: {
        consumedAt: '2027-09-30T00:00:00.000Z',
        consumedByRunId: 'some-other-run',
      },
    });
    const result = await service.execute(request);
    expect(result.refusals.map((r) => r.reason)).toContain('authorization_already_used');
    expect(repository.activationCalls).toHaveLength(0);
  });

  it('refuses active-snapshot drift', async () => {
    const { service, request, repository } = build([sagIdentity(), sagYear()], {
      activeSnapshotId: 'someone-elses-snapshot',
    });
    const result = await service.execute(request);
    expect(result.refusals.map((r) => r.reason)).toContain('active_snapshot_drift');
    expect(repository.activationCalls).toHaveLength(0);
  });

  it('refuses a plan that still has blocked items', async () => {
    // A candidate binding blocks the year row.
    const { service, request, repository } = build([
      sagIdentity(),
      sagYear({ bindingStatus: 'candidate' }),
    ]);
    const result = await service.execute(request);
    expect(result.refusals.map((r) => r.reason)).toContain('plan_has_blocked_items');
    expect(repository.activationCalls).toHaveLength(0);
  });
});

describe('Phase 7 WS E â€” exactly-once activation', () => {
  it('uses a deterministic activation key', () => {
    const key = DefenseBudgetCanonicalPromotionServiceV1.activationKeyFor('run:abc', 'PROMOTION');
    expect(key).toBe(
      DefenseBudgetCanonicalPromotionServiceV1.activationKeyFor('run:abc', 'PROMOTION'),
    );
    expect(key).not.toBe(
      DefenseBudgetCanonicalPromotionServiceV1.activationKeyFor('run:abc', 'ROLLBACK'),
    );
  });

  it('recovers an existing activation instead of activating twice', async () => {
    const { service, repository, request } = build();
    const first = await service.execute(request);
    expect(first.committed).toBe(true);

    const second = await service.execute(request);
    expect(second.committed).toBe(true);
    expect(second.recoveredExistingActivation).toBe(true);
    expect(second.activationId).toBe(first.activationId);
    // Crucially: the repository was asked to activate exactly once.
    expect(repository.activationCalls).toHaveLength(1);
  });

  it('resolves an ambiguous commit by reading the ledger, never by retrying', async () => {
    const plan = makePlan([sagIdentity(), sagYear()]);
    const repository = new FakeRepository(plan, [sagIdentity(), sagYear()]);
    // The transaction actually committed, but the caller never learned so.
    const ambiguous = new AmbiguousActivationError(
      DefenseBudgetCanonicalPromotionServiceV1.activationKeyFor(
        DefenseBudgetCanonicalPromotionServiceV1.runKeyFor('plan-1', 'auth-1', SNAP_NEW),
        'PROMOTION',
      ),
    );
    const service = new DefenseBudgetCanonicalPromotionServiceV1(repository, new RecordingAudit(), {
      now: () => NOW,
    });

    // Seed the ledger as the committed-but-unacknowledged transaction would have.
    repository.activations.set(ambiguous.activationKey, {
      activationId: 'activation-committed',
      activationKey: ambiguous.activationKey,
      newSnapshotId: SNAP_NEW,
      previousSnapshotId: null,
    });
    const result = await service.execute(REQUEST({ expectedPlanHash: plan.planHash }));

    expect(result.committed).toBe(true);
    expect(result.recoveredExistingActivation).toBe(true);
    expect(result.activationId).toBe('activation-committed');
    expect(repository.activationCalls).toHaveLength(0);
  });

  it('rethrows an ambiguous activation when the ledger shows nothing committed', async () => {
    const plan = makePlan([sagIdentity(), sagYear()]);
    const key = DefenseBudgetCanonicalPromotionServiceV1.activationKeyFor(
      DefenseBudgetCanonicalPromotionServiceV1.runKeyFor('plan-1', 'auth-1', SNAP_NEW),
      'PROMOTION',
    );
    const repository = new FakeRepository(plan, [sagIdentity(), sagYear()], {
      activateThrows: new AmbiguousActivationError(key),
    });
    const service = new DefenseBudgetCanonicalPromotionServiceV1(repository, new RecordingAudit(), {
      now: () => NOW,
    });

    await expect(service.execute(REQUEST({ expectedPlanHash: plan.planHash }))).rejects.toThrow(
      AmbiguousActivationError,
    );
    // It did not retry.
    expect(repository.activationCalls).toHaveLength(1);
  });

  it('serializes concurrent promotions of the same cycle to a single activation', async () => {
    const { service, repository, request } = build();
    const [a, b] = await Promise.all([service.execute(request), service.execute(request)]);

    expect(repository.activationCalls).toHaveLength(1);
    const committed = [a, b].filter((r) => r.committed);
    expect(committed).toHaveLength(2);
    // Exactly one performed the activation; the other recovered it.
    expect(
      [a.recoveredExistingActivation, b.recoveredExistingActivation].filter(Boolean),
    ).toHaveLength(1);
  });
});

describe('Phase 7 WS E â€” no side effects inside activation', () => {
  const source = readFileSync(join(__dirname, 'canonical-promotion-service-v1.ts'), 'utf8');

  it('leaves the run in SIDE_EFFECTS_PENDING rather than COMPLETED', async () => {
    const { service, repository, request } = build();
    await service.execute(request);
    const last = repository.statusLog[repository.statusLog.length - 1];
    expect(last?.status).toBe('SIDE_EFFECTS_PENDING');
    expect(repository.statusLog.map((s) => s.status)).not.toContain('COMPLETED');
  });

  it('writes outbox rows inside the activation call, not separately', async () => {
    const { service, repository, request } = build();
    const result = await service.execute(request);
    expect(repository.activationCalls[0]?.outbox).toHaveLength(result.outboxRowCount);
    expect(result.outboxRowCount).toBe(2);
  });

  it('emits no alert, delta, cache, or email call', () => {
    expect(source).not.toMatch(/sendAlert|emitAlert|fanOut|sendEmail|nodemailer/i);
    expect(source).not.toMatch(/DeltaEngine|computeDeltas|refreshCache|invalidateCache/);
    expect(source).not.toMatch(/intelligence_change|IntelligenceService/);
  });

  it('imports no Prisma client, Nest decorator, or legacy writer', () => {
    expect(source).not.toMatch(/from\s+['"]@prisma\/client['"]/);
    expect(source).not.toMatch(/from\s+['"]@nestjs\//);
    expect(source).not.toMatch(/ProgramElementWriterService|ReconciliationService/);
  });

  it('reads no clock of its own', () => {
    expect(source).not.toMatch(/Date\s*\.\s*now\s*\(/);
    expect(source).not.toMatch(/new\s+Date\s*\(\s*\)/);
  });
});

describe('Phase 7 WS E â€” outbox classification', () => {
  const item = (o: Partial<PromotionPlanItemV1> = {}): PromotionPlanItemV1 => ({
    sourceProjectionId: 'p',
    sourceProjectionHash: SHA('1'),
    projectionKind: 'non_rdte:OmSagYear',
    canonicalEntity: 'canonical_om_sag_year',
    canonicalNaturalKey: YEAR_KEY,
    family: 'om',
    fiscalYear: 2027,
    fundingField: 'request',
    operation: 'INSERT',
    priorRowHash: null,
    proposedRowHash: SHA('2'),
    reason: '',
    blockReason: null,
    alertDisposition: 'eligible',
    compatibilityEffect: 'project_to_budget_lines',
    ...o,
  });

  it('classifies by run mode before anything else', () => {
    expect(classifyOutboxV1('baseline_hydration', item())).toBe('initial_hydration');
    expect(classifyOutboxV1('rollback', item())).toBe('rollback');
    expect(classifyOutboxV1('new_cycle', item())).toBe('material_change');
  });

  it('classifies a correction and an unchanged row', () => {
    expect(classifyOutboxV1('new_cycle', item({ operation: 'CORRECTION' }))).toBe('correction');
    expect(classifyOutboxV1('new_cycle', item({ operation: 'UNCHANGED' }))).toBe('unchanged');
  });

  it('classifies a non-alertable entity as an identity change', () => {
    expect(
      classifyOutboxV1('new_cycle', item({ alertDisposition: 'suppressed_not_alertable' })),
    ).toBe('identity_change');
  });

  it('suppresses every outbox row of a baseline hydration', async () => {
    const { service, repository, request } = build();
    await service.execute(request);
    const outbox = repository.activationCalls[0]?.outbox ?? [];
    expect(outbox).not.toHaveLength(0);
    for (const row of outbox) {
      expect(row.changeClassification).toBe('initial_hydration');
      expect(row.suppressAlert).toBe(true);
    }
  });

  it('gives every outbox row a distinct deterministic dedupe key', async () => {
    const { service, repository, request } = build();
    await service.execute(request);
    const outbox = repository.activationCalls[0]?.outbox ?? [];
    const keys = outbox.map((row) => row.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries UNCHANGED rows into the new snapshot but emits no outbox row for them', async () => {
    // Second run against the same active data: everything is UNCHANGED.
    const projections = [sagIdentity(), sagYear()];
    const first = makePlan(projections);
    const priorRows = first.plan.items
      .filter((i) => i.canonicalEntity != null && i.proposedRowHash != null)
      .map((i) => ({
        canonicalEntity: i.canonicalEntity!,
        naturalKey: i.canonicalNaturalKey,
        rowHash: i.proposedRowHash!,
        snapshotId: 'snap-live',
      }));
    const unchangedPlan = buildPromotionPlanV1({
      planId: 'plan-1',
      eligibilityHash: SHA('e'),
      scope: SCOPE,
      mode: 'new_cycle',
      proposedSnapshotId: SNAP_NEW,
      expectedActiveSnapshotId: 'snap-live',
      actualActiveSnapshotId: 'snap-live',
      mappingRegistryHash: canonicalMappingRegistryHashV1(),
      projections,
      priorRows,
    });
    expect(unchangedPlan.counts.unchanged).toBe(2);

    const stored: StoredExecutionPlanV1 = {
      planId: 'plan-1',
      planHash: unchangedPlan.planHash,
      eligibilityHash: unchangedPlan.eligibilityHash,
      mappingRegistryHash: unchangedPlan.mappingRegistryHash,
      mode: 'new_cycle',
      proposedSnapshotId: SNAP_NEW,
      expectedActiveSnapshotId: 'snap-live',
      blockedCount: 0,
      plan: unchangedPlan,
    };
    const repository = new FakeRepository(stored, projections, {
      activeSnapshotId: 'snap-live',
    });
    const service = new DefenseBudgetCanonicalPromotionServiceV1(repository, new RecordingAudit(), {
      now: () => NOW,
    });
    const result = await service.execute(
      REQUEST({ expectedPlanHash: unchangedPlan.planHash, expectedActiveSnapshotId: 'snap-live' }),
    );

    expect(result.committed).toBe(true);
    // No notifications: carrying a row forward is not a change.
    expect(result.outboxRowCount).toBe(0);
    // But the rows ARE staged. A snapshot is a complete annual picture, not a
    // changeset: staging only the deltas would make every unchanged row vanish
    // from the active snapshot, because canonical rows are snapshot-scoped and
    // a read never falls back to a prior snapshot to find them.
    expect(result.stagedRowCount).toBe(2);
  });
});

describe('Phase 7 WS E â€” rollback', () => {
  it('reactivates a prior snapshot as a forward pointer transition', async () => {
    const { service, repository } = build([sagIdentity(), sagYear()], {
      activeSnapshotId: 'snap-live',
    });
    const result = await service.rollback({
      toSnapshotId: 'snap-prior',
      authorizationId: 'auth-rollback',
      executorIdentity: 'fargate:promoter',
      environment: 'rehearsal',
      reason: 'bad cycle',
    });

    expect(result.committed).toBe(true);
    expect(repository.activationCalls[0]?.activationKind).toBe('ROLLBACK');
    expect(repository.activationCalls[0]?.newSnapshotId).toBe('snap-prior');
    expect(repository.activationCalls[0]?.previousSnapshotId).toBe('snap-live');
  });

  it('suppresses alerts on every rollback outbox row', async () => {
    const { service, repository } = build([sagIdentity(), sagYear()], {
      activeSnapshotId: 'snap-live',
    });
    await service.rollback({
      toSnapshotId: 'snap-prior',
      authorizationId: 'auth-rollback',
      executorIdentity: 'fargate:promoter',
      environment: 'rehearsal',
      reason: 'bad cycle',
    });
    for (const row of repository.activationCalls[0]?.outbox ?? []) {
      expect(row.suppressAlert).toBe(true);
      expect(row.changeClassification).toBe('rollback');
      expect(row.isRollback).toBe(true);
    }
  });

  it('refuses a rollback whose authorization expects a different active snapshot', async () => {
    const { service, repository } = build([sagIdentity(), sagYear()], {
      activeSnapshotId: 'snap-live',
      authorizationOverrides: { expectedActiveSnapshotId: 'snap-something-else' },
    });
    const result = await service.rollback({
      toSnapshotId: 'snap-prior',
      authorizationId: 'auth-rollback',
      executorIdentity: 'fargate:promoter',
      environment: 'rehearsal',
      reason: 'bad cycle',
    });

    expect(result.committed).toBe(false);
    expect(result.refusals.map((r) => r.reason)).toContain('active_snapshot_drift');
    expect(repository.activationCalls).toHaveLength(0);
  });

  it('refuses a rollback with an expired authorization', async () => {
    const { service } = build([sagIdentity(), sagYear()], {
      activeSnapshotId: 'snap-live',
      authorizationOverrides: {
        expectedActiveSnapshotId: 'snap-live',
        expiresAt: '2027-09-01T00:00:00.000Z',
      },
    });
    const result = await service.rollback({
      toSnapshotId: 'snap-prior',
      authorizationId: 'auth-rollback',
      executorIdentity: 'fargate:promoter',
      environment: 'rehearsal',
      reason: 'bad cycle',
    });
    expect(result.refusals.map((r) => r.reason)).toContain('authorization_expired');
  });

  it('refuses a rollback to a snapshot that was never activated', async () => {
    // A STAGING snapshot never became truth. The activation trigger admits only
    // READY or ACTIVE, so without this check the rollback would abort with
    // 0A000 deep inside the transaction instead of refusing cleanly.
    const { service, repository } = build([sagIdentity(), sagYear()], {
      activeSnapshotId: 'snap-live',
      rollbackTargetStatus: { id: 'snap-never-live', status: 'STAGING' },
    });
    const result = await service.rollback({
      toSnapshotId: 'snap-never-live',
      authorizationId: 'auth-rollback',
      executorIdentity: 'fargate:promoter',
      environment: 'rehearsal',
      reason: 'should refuse',
    });

    expect(result.committed).toBe(false);
    expect(result.refusals.map((r) => r.reason)).toContain('rollback_target_not_eligible');
    expect(repository.activationCalls).toHaveLength(0);
  });

  it('refuses a rollback whose authorization was already consumed', async () => {
    const { service, repository } = build([sagIdentity(), sagYear()], {
      activeSnapshotId: 'snap-live',
      authorizationOverrides: {
        expectedActiveSnapshotId: 'snap-live',
        consumedAt: '2027-09-30T00:00:00.000Z',
        consumedByRunId: 'some-run',
      },
    });
    const result = await service.rollback({
      toSnapshotId: 'snap-prior',
      authorizationId: 'auth-rollback',
      executorIdentity: 'fargate:promoter',
      environment: 'rehearsal',
      reason: 'reused',
    });

    expect(result.committed).toBe(false);
    expect(result.refusals.map((r) => r.reason)).toContain('authorization_already_used');
    expect(repository.activationCalls).toHaveLength(0);
  });

  it('pauses the side-effect drain before moving the pointer', async () => {
    const { service, repository } = build([sagIdentity(), sagYear()], {
      activeSnapshotId: 'snap-live',
    });
    await service.rollback({
      toSnapshotId: 'snap-prior',
      authorizationId: 'auth-rollback',
      executorIdentity: 'fargate:promoter',
      environment: 'rehearsal',
      reason: 'bad cycle',
    });
    expect(repository.pausedDrains).toContain('defense_budget:rehearsal');
  });

  it('writes an append-only rollback record', async () => {
    const { service, repository } = build([sagIdentity(), sagYear()], {
      activeSnapshotId: 'snap-live',
    });
    await service.rollback({
      toSnapshotId: 'snap-prior',
      authorizationId: 'auth-rollback',
      executorIdentity: 'fargate:promoter',
      environment: 'rehearsal',
      reason: 'bad cycle',
    });
    expect(repository.rollbackRecords).toEqual([
      { toSnapshotId: 'snap-prior', reason: 'bad cycle' },
    ]);
  });

  it('audits a successful rollback', async () => {
    const { service, audit } = build([sagIdentity(), sagYear()], {
      activeSnapshotId: 'snap-live',
    });
    await service.rollback({
      toSnapshotId: 'snap-prior',
      authorizationId: 'auth-rollback',
      executorIdentity: 'fargate:promoter',
      environment: 'rehearsal',
      reason: 'bad cycle',
    });
    const entry = audit.entries[audit.entries.length - 1];
    expect(entry?.outcome).toBe('ALLOWED');
    expect((entry?.scope as Record<string, unknown>)?.kind).toBe('ROLLBACK');
  });

  it('recovers an existing rollback activation instead of activating twice', async () => {
    const { service, repository } = build([sagIdentity(), sagYear()], {
      activeSnapshotId: 'snap-live',
    });
    const first = await service.rollback({
      toSnapshotId: 'snap-prior',
      authorizationId: 'auth-rollback',
      executorIdentity: 'fargate:promoter',
      environment: 'rehearsal',
      reason: 'bad cycle',
    });
    const second = await service.rollback({
      toSnapshotId: 'snap-prior',
      authorizationId: 'auth-rollback',
      executorIdentity: 'fargate:promoter',
      environment: 'rehearsal',
      reason: 'bad cycle',
    });
    expect(second.recoveredExistingActivation).toBe(true);
    expect(second.activationId).toBe(first.activationId);
    expect(repository.activationCalls).toHaveLength(1);
  });
  it('never deletes anything â€” rollback only ever calls activate', () => {
    const source = readFileSync(join(__dirname, 'canonical-promotion-service-v1.ts'), 'utf8');
    const rollbackBody = source.slice(
      source.indexOf('  async rollback('),
      source.indexOf(
        '  /* ---------------------------------------------------------------- */\n  /* E8.',
      ),
    );
    expect(rollbackBody).not.toMatch(/delete|drop|truncate/i);
  });
});

describe('Phase 7 WS E â€” cancellation', () => {
  it('cancels a run that has not activated', async () => {
    const { service, repository, request } = build();
    await service.execute({ ...request, executionMode: 'dry_run' });
    const runKey = DefenseBudgetCanonicalPromotionServiceV1.runKeyFor('plan-1', 'auth-1', SNAP_NEW);

    const result = await service.cancel(runKey, 'operator stopped it');
    expect(result.cancelled).toBe(true);
    expect(repository.runs.get(runKey)?.status).toBe('CANCELLED');
  });

  it('refuses to cancel a run that already activated', async () => {
    const { service, request } = build();
    await service.execute(request);
    const runKey = DefenseBudgetCanonicalPromotionServiceV1.runKeyFor('plan-1', 'auth-1', SNAP_NEW);

    const result = await service.cancel(runKey, 'too late');
    expect(result.cancelled).toBe(false);
    expect(result.detail).toContain('SIDE_EFFECTS_PENDING');
  });

  it('refuses to execute a cancelled run', async () => {
    const { service, request } = build();
    await service.execute({ ...request, executionMode: 'dry_run' });
    const runKey = DefenseBudgetCanonicalPromotionServiceV1.runKeyFor('plan-1', 'auth-1', SNAP_NEW);
    await service.cancel(runKey, 'stopped');

    const result = await service.execute(request);
    expect(result.committed).toBe(false);
    expect(result.refusals.map((r) => r.reason)).toContain('run_cancelled');
  });
});

describe('Phase 7 WS E â€” audit', () => {
  it('audits a committed redemption', async () => {
    const { service, audit, request } = build();
    await service.execute(request);
    const entry = audit.entries[audit.entries.length - 1];
    expect(entry?.attemptKind).toBe('REDEMPTION');
    expect(entry?.outcome).toBe('ALLOWED');
  });

  it('audits a refusal with its reasons', async () => {
    const { service, audit, request } = build();
    await service.execute({ ...request, expectedPlanHash: SHA('0') });
    const entry = audit.entries[0];
    expect(entry?.outcome).toBe('REFUSED');
    expect(entry?.reasons).toContain('plan_hash_mismatch');
  });
});
