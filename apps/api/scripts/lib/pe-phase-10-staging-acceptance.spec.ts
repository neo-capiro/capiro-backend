/**
 * Phase 10 pre-merge acceptance pure unit tests (sole live env=dev / capiro-dev).
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
  isAuthorizedDeployCluster,
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
      'mutation_boundary_observe',
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

  it('targets sole live capiro-dev; forbids staging and prod-os only', () => {
    expect(PE_PHASE_10_STAGING_EXPECTED.ecsClusterName).toBe('capiro-dev');
    expect(PE_PHASE_10_STAGING_EXPECTED.workflowEnv).toBe('dev');
    expect(isAuthorizedDeployCluster('capiro-dev')).toBe(true);
    expect(isForbiddenDeployCluster('capiro-dev')).toBe(false);
    expect(isForbiddenDeployCluster('capiro-staging')).toBe(true);
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
  it('marks missing ECS/api/web/aurora as unhealthy', () => {
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
  });

  it('healthy when ECS services + live aurora even if CF compute rolled back', () => {
    const inv = summarizeStagingInventory({
      accountId: PE_PHASE_10_STAGING_EXPECTED.accountId,
      ecsClusterExists: true,
      ecsClusterStatus: 'ACTIVE',
      computeStackStatus: 'UPDATE_ROLLBACK_COMPLETE',
      dataStackStatus: 'UPDATE_COMPLETE',
      networkStackStatus: 'UPDATE_COMPLETE',
      auroraClusterLive: true,
      auroraClusterId: 'capiro-dev-data-xyz',
      apiServiceExists: true,
      webServiceExists: true,
    });
    expect(inv.healthyCompute).toBe(true);
    expect(inv.blockers).toEqual([]);
    expect(inv.warnings.some((w) => /ROLLBACK|drift/i.test(w))).toBe(true);
  });

  it('healthy only when ECS services + live aurora + non-failed essentials', () => {
    const inv = summarizeStagingInventory({
      accountId: PE_PHASE_10_STAGING_EXPECTED.accountId,
      ecsClusterExists: true,
      ecsClusterStatus: 'ACTIVE',
      computeStackStatus: 'UPDATE_COMPLETE',
      dataStackStatus: 'UPDATE_COMPLETE',
      networkStackStatus: 'UPDATE_COMPLETE',
      auroraClusterLive: true,
      auroraClusterId: 'capiro-dev-data-xyz',
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

  it('unhealthy plane + discover path → BLOCKED complete (honest) with exitGate unsatisfied', () => {
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
    expect(g.marker).not.toBe('PE_PHASE_10_OK');
    // B4: must not green-wash exit gate under blockedComplete
    expect(g.exitGate.every((e) => e.satisfied)).toBe(false);
    expect(g.exitGate.some((e) => !e.satisfied && /UNSATISFIED/i.test(e.reason))).toBe(true);
    const byBullet = new Map(g.exitGate.map((e) => [e.bullet, e]));
    expect(byBullet.get('no_critical_alarm')?.satisfied).toBe(false);
    expect(byBullet.get('no_cross_tenant_disclosure')?.satisfied).toBe(false);
    expect(byBullet.get('no_unexplained_data_mutation')?.satisfied).toBe(false);
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

  it('PE_PHASE_10_OK only when healthy + mutate + images + all required pass + exitGate', () => {
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
      priorTaskDefs: [
        {
          family: 'capiro-dev-api',
          revision: 59,
          arn: 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:59',
          image: 'capiro/dev/api:old',
        },
        {
          family: 'capiro-dev-web',
          revision: 6,
          arn: 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-web:6',
          image: 'capiro/dev/web:old',
        },
      ],
    });
    const outcomes = PE_PHASE_10_ACCEPTANCE_STEPS.filter(
      (s) =>
        s.id !== 'staging_auth_gate' &&
        s.id !== 'email_automation_dark' &&
        s.id !== 'acceptance_record' &&
        s.id !== 'forbidden_production_actions',
    ).map((s) => ({ stepId: s.id, exitCode: 0, detail: 'passed' }));

    outcomes.push({
      stepId: 'mutation_boundary_observe',
      exitCode: 0,
      detail: 'non-pe10 stable',
    });    const g = evaluatePePhase10Gate({
      authOk: true,
      inventory: healthy,
      mutateAllowed: true,
      outcomes,
      integrityOk: true,
      imageRecords: [
        {
          repo: 'capiro/dev/api',
          tag: 'abc',
          digest: 'sha256:deadbeef',
          pushedAt: '2026-07-31T00:00:00Z',
          present: true,
        },
        {
          repo: 'capiro/dev/web',
          tag: 'abc',
          digest: 'sha256:cafebabe',
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
    expect(g.exitGate.every((e) => e.satisfied)).toBe(true);
  });

  it('prose-only rollback does not satisfy rollback_rehearsed exit bullet on healthy mutate plane', () => {
    const healthy = summarizeStagingInventory({
      accountId: PE_PHASE_10_STAGING_EXPECTED.accountId,
      ecsClusterExists: true,
      ecsClusterStatus: 'ACTIVE',
      computeStackStatus: 'UPDATE_COMPLETE',
      auroraClusterLive: true,
      apiServiceExists: true,
      webServiceExists: true,
      priorTaskDefs: [
        {
          family: 'capiro-dev-api',
          revision: 59,
          arn: 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:59',
          image: null,
        },
      ],
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
        { repo: 'capiro/dev/api', tag: 'x', digest: 'sha256:a', pushedAt: null, present: true },
        { repo: 'capiro/dev/web', tag: 'x', digest: 'sha256:b', pushedAt: null, present: true },
      ],
      rollbackDocumented: true,
      acceptanceRecordWritten: true,
      emailAutomationDark: true,
    });
    expect(g.marker).not.toBe('PE_PHASE_10_OK');
    expect(g.exitGate.find((e) => e.bullet === 'rollback_rehearsed')?.satisfied).toBe(false);
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

  it('healthy + mutate off still env_blocks ship steps and fails exitGate full green', () => {
    const healthy = summarizeStagingInventory({
      accountId: PE_PHASE_10_STAGING_EXPECTED.accountId,
      ecsClusterExists: true,
      ecsClusterStatus: 'ACTIVE',
      computeStackStatus: 'UPDATE_ROLLBACK_COMPLETE',
      auroraClusterLive: true,
      apiServiceExists: true,
      webServiceExists: true,
      priorTaskDefs: [
        {
          family: 'capiro-dev-api',
          revision: 59,
          arn: 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:59',
          image: null,
        },
      ],
    });
    const g = evaluatePePhase10Gate({
      authOk: true,
      inventory: healthy,
      mutateAllowed: false,
      outcomes: baseLocalOutcomes(),
      integrityOk: true,
      imageRecords: [{ repo: 'capiro/dev/api', tag: 'x', digest: null, pushedAt: null, present: false }],
      rollbackDocumented: true,
      acceptanceRecordWritten: true,
      emailAutomationDark: true,
    });
    expect(g.ok).toBe(false);
    expect(g.marker).toBe('PE_PHASE_10_BLOCKED');
    expect(g.exitGate.every((e) => e.satisfied)).toBe(false);
  });
});

describe('anti-fake ship evidence (source)', () => {
  const shipSrc = () =>
    require('fs').readFileSync(require('path').join(__dirname, 'pe-phase-10-ship.ts'), 'utf8') as string;

  it('does not export runLocalVerifyEvidenceSteps hard-ok pack', () => {
    const src = shipSrc();
    expect(src).not.toMatch(/export function runLocalVerifyEvidenceSteps/);
    expect(src).toMatch(/export function runLiveProofsTask/);
    expect(src).toMatch(/export function outcomesFromLiveProofReport/);
    expect(src).toMatch(/export function runAlarmTestEvents/);
    expect(src).toMatch(/export function rehearseRollback/);
  });

  it('forbids hardcoded identical_replay ok and source-grep derive greening', () => {
    const src = shipSrc();
    expect(src).not.toMatch(/identical_replay[\s\S]{0,200}exitCode:\s*0,\s*\n\s*classification:\s*'ok'/);
    expect(src).not.toMatch(/src\.includes\(['"]DRY RUN['"]\)/);
    // rls-phase-c-pass.txt may appear only as a purge target, never as a soft-skip evidence reader.
    expect(src).toMatch(/purgeStaleEvidenceArtifacts/);
    expect(src).not.toMatch(/readFileSync\([^)]*rls-phase-c-pass/);
    expect(src).not.toMatch(/existsSync\([^)]*rls-phase-c-pass[^)]*\)[\s\S]{0,80}classification:\s*'ok'/);
  });
});


describe('anti-fake live-proofs source (review FAIL locks)', () => {
  const liveSrc = () =>
    require('fs').readFileSync(
      require('path').join(__dirname, '../pe-phase-10-live-proofs.ts'),
      'utf8',
    ) as string;
  const entrySrc = () =>
    require('fs').readFileSync(
      require('path').join(__dirname, '../entrypoint.sh'),
      'utf8',
    ) as string;
  const composeSrc = () =>
    require('fs').readFileSync(
      require('path').join(__dirname, 'pe-compose-database-url.js'),
      'utf8',
    ) as string;

  it('ensureDatabaseUrl never embeds masked password marker in URL template', () => {
    const src = liveSrc();
    expect(src).toMatch(/export function ensureDatabaseUrl/);
    // Must not contain a postgresql URL template with literal masked password.
    expect(src).not.toMatch(/postgresql:\/\/\$\{[^}]+\}:\*\*\*@/);
    expect(src).not.toMatch(/postgresql:\/\/.*:\*\*\*@/);
    expect(src).toMatch(/encodeURIComponent\(env\.DB_PASSWORD/);
    expect(src).toMatch(/maskedMarker/);
  });

  it('entrypoint compose helper builds real URL (no masked marker in shell export)', () => {
    const src = entrySrc();
    expect(src).toMatch(/pe-compose-database-url\.js/);
    expect(src).not.toMatch(/postgresql:\/\/\$\{DB_USER\}:\*\*\*@/);
    const helper = composeSrc();
    expect(helper).toMatch(/encodeURIComponent/);
    expect(helper).toMatch(/process\.stdout\.write\(url\)/);
  });

  it('registers pe10 source_document and fails closed when missing', () => {
    const src = liveSrc();
    expect(src).toMatch(/pe10_phase10_internal_promotion/);
    expect(src).toMatch(/upsertSourceDocument|registerPromotionSource/);
    expect(src).toMatch(/source_document_register/);
    expect(src).toMatch(/MISSING SOURCE|source_document missing|fail closed/i);
  });

  it('identical_replay requires zero new canonical rows / id-set equality', () => {
    const src = liveSrc();
    expect(src).toMatch(/idSetEqual/);
    expect(src).toMatch(/newCanonicalRows|newRows === 0/);
    expect(src).not.toMatch(/identical_replay[\s\S]{0,120}ok:\s*true,\s*\n\s*exitCode:\s*0/);
  });

  it('mutation_boundary_observe is pre/post non-pe10 drift check (not hard-ok)', () => {
    const src = liveSrc();
    expect(src).toMatch(/mutation_boundary_observe/);
    expect(src).toMatch(/nonPe10Drift|fundingPositionsNonPe10/);
    expect(src).not.toMatch(
      /id:\s*'mutation_boundary_observe',\s*\n\s*ok:\s*true,\s*\n\s*exitCode:\s*0,/,
    );
  });

  it('RLS seeds dual synthetic tenants (not vacuous bare=0 bypass=0 only)', () => {
    const src = liveSrc();
    expect(src).toMatch(/dualTenantSeeded|pe10-rls-a-/);
    expect(src).toMatch(/programElementWatch\.create/);
    expect(src).toMatch(/leakN/);
  });
});

describe('anti-fake ship evidence (review FAIL locks continued)', () => {
  const shipSrc = () =>
    require('fs').readFileSync(require('path').join(__dirname, 'pe-phase-10-ship.ts'), 'utf8') as string;

  it('purges stale rls-phase-c-pass and ship/deploy/migrate artifacts on harness write', () => {
    const src = shipSrc();
    expect(src).toMatch(/purgeStaleEvidenceArtifacts/);
    expect(src).toMatch(/rls-phase-c-pass\.txt/);
    expect(src).toMatch(/writeShipTrace/);
    expect(src).toMatch(/PE10_STALE_EVIDENCE_BASENAMES/);
  });

  it('stores full live-proofs report metrics not SUMMARY-only', () => {
    const src = shipSrc();
    expect(src).toMatch(/fullReport/);
    expect(src).toMatch(/reportHasMetrics/);
    expect(src).toMatch(/metricsIncomplete/);
  });

  it('browser smoke exercises PE read contract beyond health', () => {
    const src = shipSrc();
    expect(src).toMatch(/pe_positions/);
    expect(src).toMatch(/pe_timeline/);
    expect(src).toMatch(/pe_web_route|program-elements\/0603270A/);
    expect(src).toMatch(/pe_read_contract_missing|peAuthWall/);
  });

  it('maps mutation_boundary_observe into outcomes (no hard-ok default)', () => {
    const src = shipSrc();
    expect(src).toMatch(/out\.mutation_boundary_observe/);
    expect(src).toMatch(/mutation_boundary_observe missing from live proofs/);
  });
});

describe('ensureDatabaseUrl unit', () => {
  // Dynamic import of TS via require may not work; test pure logic inline mirror.
  it('compose helper encodes password and rejects masked marker', () => {
    const { spawnSync } = require('child_process');
    const path = require('path');
    const helper = path.join(__dirname, 'pe-compose-database-url.js');
    const ok = spawnSync(
      process.execPath,
      [helper],
      {
        env: {
          ...process.env,
          DB_HOST: 'h',
          DB_PORT: '5432',
          DB_USER: 'u',
          DB_PASSWORD: 'p@ss:x',
          DB_NAME: 'capiro',
        },
        encoding: 'utf8',
      },
    );
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('postgresql://u:p%40ss%3Ax@h:5432/capiro');
    const bad = spawnSync(
      process.execPath,
      [helper],
      {
        env: {
          ...process.env,
          DB_HOST: 'h',
          DB_PORT: '5432',
          DB_USER: 'u',
          DB_PASSWORD: String.fromCharCode(42, 42, 42),
          DB_NAME: 'capiro',
        },
        encoding: 'utf8',
      },
    );
    expect(bad.status).not.toBe(0);
  });
});
