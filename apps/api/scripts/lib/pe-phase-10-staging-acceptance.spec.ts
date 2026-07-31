/**
 * Phase 10 staging acceptance pure unit tests.
 */
import {
  PE_PHASE_10_ACCEPTANCE_STEPS,
  PE_PHASE_10_EXIT_GATE_BULLETS,
  PE_PHASE_10_FORBIDDEN_PATH_SUBSTRINGS,
  PE_PHASE_10_STAGING_EXPECTED,
  pePhase10RequiredSteps,
  pePhase10StepIds,
} from './pe-phase-10-staging-acceptance-catalog';
import {
  PE_PHASE_10_BLOCKED_EXIT,
  assertPePhase10CatalogHonest,
  classifyEnvBlockedStep,
  evaluatePePhase10Gate,
  evaluatePePhase10Integrity,
  evaluateStagingAuth,
  evaluateStagingMutateAllowed,
  isForbiddenDeployCluster,
  summarizeStagingInventory,
} from './pe-phase-10-staging-acceptance';

describe('pe-phase-10 catalog', () => {
  it('is honest: unique ids, required kinds, safety rails', () => {
    const r = assertPePhase10CatalogHonest();
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('covers plan staging worklist pillars', () => {
    const ids = new Set(pePhase10StepIds());
    for (const must of [
      'staging_auth_gate',
      'aws_inventory_readonly',
      'image_digest_record',
      'staging_migrate_additive',
      'staging_deploy_images',
      'inspect_only_loaders',
      'exact_sha_internal_promotion',
      'identical_replay',
      'derive_chain_dry_run',
      'browser_smoke',
      'rls_ethical_wall',
      'alarm_test_events',
      'rollback_rehearsal',
      'acceptance_record',
      'email_automation_dark',
    ]) {
      expect(ids.has(must)).toBe(true);
    }
    expect(pePhase10RequiredSteps().every((s) => s.required)).toBe(true);
    expect(PE_PHASE_10_EXIT_GATE_BULLETS.length).toBe(5);
  });

  it('forbids deploying to capiro-dev / prod-os', () => {
    expect(isForbiddenDeployCluster('capiro-dev')).toBe(true);
    expect(isForbiddenDeployCluster('capiro-prod-os-capiro')).toBe(true);
    expect(isForbiddenDeployCluster(PE_PHASE_10_STAGING_EXPECTED.ecsClusterName)).toBe(false);
  });

  it('forbids transport substrings', () => {
    expect(PE_PHASE_10_FORBIDDEN_PATH_SUBSTRINGS).toEqual(
      expect.arrayContaining(['pe-final-v2.part', 'program-elements-final-closeout-source.yml']),
    );
  });
});

describe('evaluateStagingAuth / mutate', () => {
  it('refuses without PE_CLOSEOUT_STAGING_OK', () => {
    expect(evaluateStagingAuth({}).ok).toBe(false);
    expect(evaluateStagingAuth({ PE_CLOSEOUT_STAGING_OK: 'no' }).ok).toBe(false);
  });

  it('accepts yes/true/1', () => {
    expect(evaluateStagingAuth({ PE_CLOSEOUT_STAGING_OK: 'yes' }).ok).toBe(true);
    expect(evaluateStagingAuth({ PE_CLOSEOUT_STAGING_OK: 'TRUE' }).ok).toBe(true);
    expect(evaluateStagingAuth({ PE_CLOSEOUT_STAGING_OK: '1' }).ok).toBe(true);
  });

  it('mutate requires auth + flag + healthy inventory', () => {
    const env = { PE_CLOSEOUT_STAGING_OK: 'yes', PE_CLOSEOUT_STAGING_MUTATE: 'yes' };
    expect(evaluateStagingMutateAllowed(env).ok).toBe(true);
    expect(
      evaluateStagingMutateAllowed(env, {
        healthyCompute: false,
      } as any).ok,
    ).toBe(false);
    expect(
      evaluateStagingMutateAllowed(
        { PE_CLOSEOUT_STAGING_OK: 'yes' },
        { healthyCompute: true } as any,
      ).ok,
    ).toBe(false);
  });
});

describe('summarizeStagingInventory', () => {
  it('marks current broken staging as unhealthy (compute rollback, no ECS, no aurora)', () => {
    const inv = summarizeStagingInventory({
      accountId: PE_PHASE_10_STAGING_EXPECTED.accountId,
      ecsClusterExists: false,
      computeStackStatus: 'UPDATE_ROLLBACK_COMPLETE',
      dataStackStatus: 'UPDATE_COMPLETE',
      networkStackStatus: 'UPDATE_COMPLETE',
      auroraClusterLive: false,
      apiServiceExists: false,
      webServiceExists: false,
      forbiddenClusterPresent: true,
    });
    expect(inv.healthyCompute).toBe(false);
    expect(inv.blockers.length).toBeGreaterThan(0);
    expect(inv.blockers.some((b) => /ECS cluster/.test(b))).toBe(true);
    expect(inv.blockers.some((b) => /Aurora/.test(b))).toBe(true);
    expect(inv.blockers.some((b) => /ROLLBACK/.test(b))).toBe(true);
  });

  it('healthy only when ECS services + live aurora + non-rollback compute', () => {
    const inv = summarizeStagingInventory({
      accountId: PE_PHASE_10_STAGING_EXPECTED.accountId,
      ecsClusterExists: true,
      ecsClusterStatus: 'ACTIVE',
      computeStackStatus: 'UPDATE_COMPLETE',
      dataStackStatus: 'UPDATE_COMPLETE',
      networkStackStatus: 'UPDATE_COMPLETE',
      auroraClusterLive: true,
      auroraClusterId: 'capiro-staging-data-xyz',
      apiServiceExists: true,
      webServiceExists: true,
    });
    expect(inv.healthyCompute).toBe(true);
    expect(inv.blockers).toEqual([]);
  });

  it('rejects wrong account', () => {
    const inv = summarizeStagingInventory({
      accountId: '000000000000',
      ecsClusterExists: true,
      ecsClusterStatus: 'ACTIVE',
      computeStackStatus: 'UPDATE_COMPLETE',
      auroraClusterLive: true,
      apiServiceExists: true,
      webServiceExists: true,
    });
    expect(inv.healthyCompute).toBe(false);
  });

  it('CF UPDATE_COMPLETE alone is not healthy without live aurora/ecs', () => {
    const inv = summarizeStagingInventory({
      accountId: PE_PHASE_10_STAGING_EXPECTED.accountId,
      ecsClusterExists: false,
      computeStackStatus: 'UPDATE_COMPLETE',
      dataStackStatus: 'UPDATE_COMPLETE',
      auroraClusterLive: false,
    });
    expect(inv.healthyCompute).toBe(false);
  });
});

describe('evaluatePePhase10Integrity', () => {
  it('flags transport paths', () => {
    const r = evaluatePePhase10Integrity({
      tipPaths: ['.github/workflows/program-elements-final-closeout-source.yml'],
    });
    expect(r.ok).toBe(false);
    expect(r.forbiddenHits.length).toBeGreaterThan(0);
  });

  it('passes clean tip', () => {
    const r = evaluatePePhase10Integrity({
      tipPaths: ['apps/api/scripts/verify-pe-phase-10.ts'],
    });
    expect(r.ok).toBe(true);
  });
});

describe('evaluatePePhase10Gate', () => {
  const unhealthy = summarizeStagingInventory({
    accountId: PE_PHASE_10_STAGING_EXPECTED.accountId,
    ecsClusterExists: false,
    computeStackStatus: 'UPDATE_ROLLBACK_COMPLETE',
    auroraClusterLive: false,
    apiServiceExists: false,
    webServiceExists: false,
  });

  const baseLocalOutcomes = () =>
    PE_PHASE_10_ACCEPTANCE_STEPS.filter(
      (s) =>
        s.kind === 'git' ||
        s.kind === 'aws_inventory' ||
        s.kind === 'image' ||
        s.kind === 'local_preflight' ||
        s.kind === 'integrity',
    ).map((s) => ({ stepId: s.id, exitCode: 0, detail: 'ok' }));

  it('auth refused → FAIL not OK/BLOCKED complete', () => {
    const g = evaluatePePhase10Gate({
      authOk: false,
      inventory: unhealthy,
      mutateAllowed: false,
      outcomes: baseLocalOutcomes(),
      integrityOk: true,
      rollbackDocumented: true,
      acceptanceRecordWritten: true,
      emailAutomationDark: true,
    });
    expect(g.marker).toBe('PE_PHASE_10_FAIL');
    expect(g.ok).toBe(false);
    expect(g.blockedComplete).toBe(false);
  });

  it('unhealthy staging + discover path → BLOCKED complete (honest)', () => {
    const g = evaluatePePhase10Gate({
      authOk: true,
      inventory: unhealthy,
      mutateAllowed: false,
      outcomes: baseLocalOutcomes(),
      integrityOk: true,
      imageRecords: [
        {
          repo: 'capiro/dev/api',
          tag: '72b299dff',
          digest: null,
          pushedAt: null,
          present: false,
          note: 'branch tip tag absent',
        },
      ],
      rollbackDocumented: true,
      acceptanceRecordWritten: true,
      emailAutomationDark: true,
    });
    expect(g.marker).toBe('PE_PHASE_10_BLOCKED');
    expect(g.ok).toBe(false);
    expect(g.blockedComplete).toBe(true);
    expect(g.classifications.some((c) => c.classification === 'env_blocked')).toBe(true);
    // Must not claim PE_PHASE_10_OK
    expect(g.marker).not.toBe('PE_PHASE_10_OK');
  });

  it('never marks mutate steps ok when inventory unhealthy', () => {
    const step = PE_PHASE_10_ACCEPTANCE_STEPS.find((s) => s.id === 'staging_deploy_images')!;
    const c = classifyEnvBlockedStep(step, unhealthy, false);
    expect(c.classification).toBe('env_blocked');
    expect(c.exitCode).toBe(PE_PHASE_10_BLOCKED_EXIT);
  });

  it('integrity fail prevents blocked-complete and OK', () => {
    const g = evaluatePePhase10Gate({
      authOk: true,
      inventory: unhealthy,
      mutateAllowed: false,
      outcomes: baseLocalOutcomes(),
      integrityOk: false,
      integrityBlockers: ['transport'],
      rollbackDocumented: true,
      acceptanceRecordWritten: true,
      emailAutomationDark: true,
    });
    expect(g.ok).toBe(false);
    expect(g.blockedComplete).toBe(false);
    expect(g.marker).toBe('PE_PHASE_10_FAIL');
  });

  it('PE_PHASE_10_OK only when healthy + mutate + images + all required pass', () => {
    const healthy = summarizeStagingInventory({
      accountId: PE_PHASE_10_STAGING_EXPECTED.accountId,
      ecsClusterExists: true,
      ecsClusterStatus: 'ACTIVE',
      computeStackStatus: 'UPDATE_COMPLETE',
      dataStackStatus: 'UPDATE_COMPLETE',
      networkStackStatus: 'UPDATE_COMPLETE',
      auroraClusterLive: true,
      apiServiceExists: true,
      webServiceExists: true,
    });
    const outcomes = PE_PHASE_10_ACCEPTANCE_STEPS.filter(
      (s) =>
        s.id !== 'staging_auth_gate' &&
        s.id !== 'email_automation_dark' &&
        s.id !== 'rollback_rehearsal' &&
        s.id !== 'acceptance_record' &&
        s.id !== 'forbidden_production_actions',
    ).map((s) => ({ stepId: s.id, exitCode: 0, detail: 'passed' }));
    const g = evaluatePePhase10Gate({
      authOk: true,
      inventory: healthy,
      mutateAllowed: true,
      outcomes,
      integrityOk: true,
      imageRecords: [
        {
          repo: 'capiro/staging/api',
          tag: 'abc',
          digest: 'sha256:deadbeef',
          pushedAt: '2026-07-31T00:00:00Z',
          present: true,
        },
      ],
      rollbackDocumented: true,
      acceptanceRecordWritten: true,
      emailAutomationDark: true,
    });
    expect(g.marker).toBe('PE_PHASE_10_OK');
    expect(g.ok).toBe(true);
    expect(g.blockedComplete).toBe(false);
  });

  it('local preflight failure is hard FAIL even when plane blocked', () => {
    const outcomes = baseLocalOutcomes().map((o) =>
      o.stepId === 'local_pe_preflight_k'
        ? { ...o, exitCode: 1, detail: 'k failed' }
        : o,
    );
    const g = evaluatePePhase10Gate({
      authOk: true,
      inventory: unhealthy,
      mutateAllowed: false,
      outcomes,
      integrityOk: true,
      rollbackDocumented: true,
      acceptanceRecordWritten: true,
      emailAutomationDark: true,
    });
    expect(g.marker).toBe('PE_PHASE_10_FAIL');
    expect(g.blockedComplete).toBe(false);
  });
});
