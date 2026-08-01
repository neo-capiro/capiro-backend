#!/usr/bin/env tsx
/**
 * GitHub-Actions-independent development-completeness gate for MeriV2.
 *
 * This checks the exact checkout an operator intends to merge. It proves that
 * every Phase 0-22 implementation boundary and the release-critical cross-phase
 * wiring are present. Empirical typecheck/test/database/browser/AWS-diff gates
 * remain owned by scripts/verify-meriv2-release.mjs.
 */
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REQUIRED_MIGRATIONS = [
  '20260729010000_memory_governance_context_v2',
  '20260729011000_memory_governance_lineage',
  '20260811010000_assurance_policy_packs',
  '20260811020000_assurance_eval_runs',
  '20260811030000_assurance_feedback_fixtures',
  '20260811040000_memory_index_outbox_subject',
  '20260812010000_memory_immutable_versions',
  '20260812020000_memory_cleanup_worker_leases',
  '20260812030000_memory_projection_exact_completion',
  '20260813010000_policy_pack_action_authority',
  '20260813020000_policy_pack_lifecycle_concurrency',
  '20260814010000_memory_governance_backfill_jobs',
  '20260814011000_memory_governance_backfill_delete_guards',
  '20260815010000_memory_candidate_withdrawal',
] as const;

interface PhaseResult {
  phase: number;
  title: string;
  status: 'passed' | 'failed';
  checks: number;
  error?: string;
}

const results: PhaseResult[] = [];
let checks = 0;

async function main(): Promise<void> {
  await phase(0, 'Containment and server-owned control boundaries', async () => {
    await files([
      'apps/api/src/meri/governed-meri-tools.proxy.ts',
      'apps/api/src/meri/governed-meri-research.factory.ts',
      'apps/api/src/memory/memory-embed-isolation.spec.ts',
      'apps/api/src/memory/memory-private-fail-closed.spec.ts',
      'apps/meriv2-orchestrator/src/meri/api-action-proposal.repo.ts',
    ]);
    await contains('apps/api/src/meri/governed-meri-tools.proxy.ts', 'service secret');
    await contains('apps/api/src/memory/memory-private-fail-closed.spec.ts', 'private');
    await contains('apps/meriv2-orchestrator/src/meri/api-action-proposal.repo.ts', 'bearerToken');
  });

  await phase(1, 'Atomic candidate activation', async () => {
    await files([
      'apps/api/src/memory/memory-candidate.service.ts',
      'apps/api/src/memory/memory-candidate.atomicity.spec.ts',
      'apps/api/src/memory/memory-candidate.approval.spec.ts',
    ]);
    await contains('apps/api/src/memory/memory-candidate.service.ts', 'FOR UPDATE');
    await contains('apps/api/src/memory/memory-candidate.service.ts', 'commitToClioMemoryInTx');
    await contains('apps/api/src/memory/memory-candidate.service.ts', 'markDecidedInTx');
    await contains('apps/api/src/memory/memory-candidate.service.ts', 'cleanupOutbox.enqueue');
  });

  await phase(2, 'Canonical governed metadata and lineage', async () => {
    await migration('20260729010000_memory_governance_context_v2');
    await migration('20260729011000_memory_governance_lineage');
    await files([
      'apps/api/src/memory/memory-canonical-activation.helpers.ts',
      'apps/api/src/memory/governed-memory-candidate.service.ts',
      'apps/api/src/memory/governed-memory-store.service.ts',
    ]);
    await contains('apps/api/prisma/schema.prisma', 'governedStatus');
    await contains('apps/api/prisma/schema.prisma', 'memoryAuthority');
    await contains('apps/api/src/memory/memory-canonical-activation.helpers.ts', 'committedMemoryItemId');
  });

  await phase(3, 'Settings shared-memory review lifecycle', async () => {
    await files([
      'apps/api/src/memory/settings-memory-version-candidate.service.ts',
      'apps/api/src/memory/settings-aware-memory-candidate.service.ts',
      'apps/api/src/memory/settings-aware-memory-candidate.service.spec.ts',
      'apps/web/src/components/MemoryFileEditor.tsx',
      'apps/web/src/components/MemoryProposalQueue.tsx',
      'apps/web/src/components/MemoryReviewQueue.tsx',
      'apps/api/src/memory/memory.controller.settings-review.spec.ts',
      'apps/web/src/components/MemoryFileEditor.phase3.test.ts',
    ]);
    await contains('apps/web/src/components/MemoryFileEditor.tsx', 'Submitted for independent review');
    await contains('apps/api/src/memory/settings-aware-memory-candidate.service.ts', 'proposeExistingCorrection');
    await contains('apps/api/src/memory/settings-memory-version-candidate.service.ts', "'memory_correction'");
    await contains('apps/api/src/memory/settings-memory-version-candidate.service.ts', 'settingsStableSlug');
  });

  await phase(4, 'Immutable corrections, conflicts, restore, and stable catalog identity', async () => {
    await migration('20260812010000_memory_immutable_versions');
    await files([
      'apps/api/src/memory/immutable-memory-version.service.ts',
      'apps/api/src/memory/memory-conflict.service.ts',
      'apps/api/src/memory/memory-version.controller.ts',
      'apps/api/src/memory/lineage-aware-memory-store.service.ts',
      'apps/api/src/memory/lineage-aware-memory-store.service.spec.ts',
      'docs/qa/meriv2-phase-4-immutable-memory-versions.md',
    ]);
    await contains('apps/api/src/memory/immutable-memory-version.service.ts', 'proposeRestore');
    await contains('apps/api/src/memory/immutable-memory-version.service.ts', 'supersedeOne');
    await contains('apps/api/src/memory/lineage-aware-memory-store.service.ts', 'WITH RECURSIVE lineage');
    await contains('apps/api/src/memory/lineage-aware-memory-store.service.ts', 'MEMORY_GOVERNANCE_TENANTS');
    await contains('apps/api/src/memory/memory-authorization.helpers.ts', 'legal_hold');
  });

  await phase(5, 'Durable scheduled projection worker', async () => {
    await files([
      'apps/api/src/memory/exact-memory-projection-worker.service.ts',
      'apps/api/scripts/drain-memory-cleanup-outbox.ts',
      'infra/cdk/lib/constructs/scheduled-memory-projection-worker.ts',
      'infra/cdk/lib/memory-projection-worker-stack.ts',
    ]);
    await contains(
      'infra/cdk/lib/constructs/scheduled-memory-projection-worker.ts',
      'enabled: props.scheduleEnabled',
    );
    await excludes('infra/cdk/lib/constructs/scheduled-memory-projection-worker.ts', 'enabled: true');
    await contains(
      'infra/cdk/lib/constructs/scheduled-memory-projection-worker.ts',
      'alarm.addAlarmAction(action)',
    );
    await contains('infra/cdk/lib/constructs/scheduled-memory-projection-worker.ts', 'apiImageTag');
  });

  await phase(6, 'Exact projection completion and recovery', async () => {
    await migration('20260812020000_memory_cleanup_worker_leases');
    await migration('20260812030000_memory_projection_exact_completion');
    await files([
      'apps/api/src/memory/exact-memory-cleanup-outbox.service.ts',
      'apps/api/src/memory/exact-memory-projection-worker.service.spec.ts',
      'apps/api/src/memory/exact-memory-cleanup-outbox.service.spec.ts',
    ]);
    await contains('apps/api/src/memory/exact-memory-projection-worker.service.ts', 'dead_letter');
    await contains('apps/api/src/memory/exact-memory-projection-worker.service.ts', 'lease');
    await contains('apps/api/src/memory/exact-memory-projection-worker.service.ts', 'sourceContentHash');
  });

  await phase(7, 'Truthful Context Packet persistence', async () => {
    await files([
      'apps/api/src/context/context-persistence-boundary.service.ts',
      'apps/api/src/context/context-persistence-boundary.interceptor.ts',
      'apps/api/src/context/context-required-persistence.ts',
      'apps/workspace/src/generation/context-persistence-hold.ts',
    ]);
    await contains('apps/api/src/context/context-compiler.service.ts', 'context_packet_read_after_write_missing');
    await contains('apps/workspace/src/generation/context-compiler.service.ts', 'context_packet_read_after_write_missing');
  });

  await phase(8, 'Context Packet v2 rollout and surface policy', async () => {
    await files([
      'packages/meriv2-core/src/context/context-rollout.ts',
      'packages/meriv2-core/src/context/context-release-switch.ts',
      'packages/meriv2-core/src/context/surface-policy.ts',
      'packages/meriv2-core/src/context/compiler-v2.spec.ts',
      'apps/api/src/context/context-compiler-v2.service.spec.ts',
    ]);
    await contains('packages/meriv2-core/src/context/context-rollout.ts', "mode === 'shadow'");
    await contains('packages/meriv2-core/src/context/context-release-switch.ts', 'tenantContextPacketCanaryEnabled');
    await contains('packages/meriv2-core/src/context/surface-policy.ts', "'district-brief'");
  });

  await phase(9, 'Governed lifecycle convergence and recall suppression', async () => {
    await files([
      'apps/api/src/memory/memory-governance-lifecycle.helpers.ts',
      'apps/api/src/memory/memory-recall-suppression.helpers.ts',
      'packages/meriv2-core/src/memory/governance.ts',
    ]);
    await contains('apps/api/src/memory/memory-governance-lifecycle.helpers.ts', 'MEMORY_GOVERNANCE_LIFECYCLE');
    await contains('apps/api/src/memory/memory-recall-suppression.helpers.ts', 'governed_status');
    await contains('packages/meriv2-core/src/memory/governance.ts', "'superseded'");
  });

  await phase(10, 'Persisted policy authority and tenant canary', async () => {
    await migration('20260811010000_assurance_policy_packs');
    await migration('20260813010000_policy_pack_action_authority');
    await migration('20260813020000_policy_pack_lifecycle_concurrency');
    await files([
      'apps/api/src/meri/meri-policy-pack.service.ts',
      'apps/api/src/meri/meri-policy-pack.controller.ts',
      'apps/api/src/meri/meri-policy-pack-rollout.service.ts',
      'apps/web/src/pages/settings/PolicyPacksPage.tsx',
      'apps/api/scripts/test-policy-pack-lifecycle-concurrency.sh',
    ]);
    await contains('apps/api/src/meri/meri-policy-pack.service.ts', 'recordDecisionInTx');
    await contains('apps/api/src/meri/meri-policy-pack-rollout.service.ts', 'MERI_POLICY_PACK_TENANTS');
    await contains('apps/api/src/meri/meri-policy-pack-rollout.service.ts', "source === 'enforce'");
  });

  await phase(11, 'Reversible drift-safe governance backfill', async () => {
    await migration('20260814010000_memory_governance_backfill_jobs');
    await migration('20260814011000_memory_governance_backfill_delete_guards');
    await files([
      'apps/api/scripts/backfill-memory-governance-v2.ts',
      'apps/api/scripts/lib/memory-governance-backfill-store.ts',
      'apps/api/scripts/test-memory-governance-backfill-rollback.sh',
      'docs/runbooks/meriv2-memory-backfill.md',
    ]);
    await contains('apps/api/scripts/backfill-memory-governance-v2.ts', '--rollback');
    await contains('apps/api/scripts/backfill-memory-governance-v2.ts', '--confirm-job');
    await contains('apps/api/scripts/lib/memory-governance-backfill-store.ts', 'blocked_drift');
  });

  await phase(12, 'Least-privilege client review grants', async () => {
    await files([
      'apps/api/src/memory/memory-access-grant.service.ts',
      'apps/api/src/memory/memory-access-grant.service.spec.ts',
      'apps/api/src/memory/memory-authorization.phase12.spec.ts',
      'docs/qa/meriv2-phase-12-client-review-grants.md',
    ]);
    await contains('apps/api/src/memory/memory-access-grant.service.ts', 'expiresAt');
    await contains('apps/api/src/memory/memory-access-grant.service.ts', 'clientMemoryAllowed');
    await contains('apps/api/src/memory/memory-authorization.helpers.ts', 'explicit_grant');
  });

  await phase(13, 'Proposer withdrawal versus reviewer rejection', async () => {
    await migration('20260815010000_memory_candidate_withdrawal');
    await files([
      'apps/api/src/memory/governed-memory-candidate.service.ts',
      'apps/api/src/memory/memory-candidate-withdrawal.helpers.spec.ts',
      'apps/web/src/components/MemoryProposalQueue.tsx',
      'apps/web/src/components/MemoryReviewQueue.tsx',
      'docs/qa/meriv2-phase-13-withdrawal-vs-rejection.md',
    ]);
    await contains('apps/api/src/memory/governed-memory-candidate.service.ts', 'withdrawn_by_proposer');
    await contains('apps/api/src/memory/governed-memory-candidate.service.ts', 'rejected_by_reviewer');
  });

  await phase(14, 'Accessible Context Inspector', async () => {
    await files([
      'apps/web/src/components/trust/ContextInspector.tsx',
      'apps/web/src/components/trust/ContextInspector.css',
      'apps/web/src/components/trust/ContextInspector.test.tsx',
      'apps/web/src/components/trust/ContextInspector.a11y-fixture.tsx',
      'docs/qa/meriv2-phase-14-context-inspector-accessibility.md',
    ]);
    await contains('apps/web/src/components/trust/ContextInspector.tsx', 'useId');
    await contains('apps/web/src/components/trust/ContextInspector.tsx', 'unauthorizedCount');
  });

  await phase(15, 'Memory Governance Center and canonical action paths', async () => {
    await files([
      'apps/api/src/memory/memory-governance.controller.ts',
      'apps/api/src/memory/memory-governance-read.service.ts',
      'apps/api/src/memory/memory-governance-action.service.ts',
      'apps/api/src/memory/memory-governance-tenant.interceptor.ts',
      'apps/web/src/components/MemoryGovernanceCenter.tsx',
      'apps/web/src/components/MemoryGovernanceCenter.test.ts',
      'docs/qa/meriv2-phase-15-memory-governance-center.md',
    ]);
    await contains('apps/api/src/memory/memory-governance-center.switch.ts', 'MEMORY_GOVERNANCE_CENTER');
    await contains('apps/api/src/memory/memory-governance-tenant.interceptor.ts', 'runWithMemoryGovernanceTenant');
  });

  await phase(16, 'Cross-surface government-affairs assurance envelope', async () => {
    await files([
      'packages/meriv2-core/src/assurance/envelope.ts',
      'packages/meriv2-core/src/assurance/risk-gate.ts',
      'packages/meriv2-core/src/assurance/rollout.ts',
      'packages/meriv2-core/src/assurance/request-scope.ts',
      'apps/meriv2-orchestrator/src/meri/chat/chat-assistant.service.ts',
      'apps/meriv2-orchestrator/src/meri/in-editor/in-editor-assistant.service.ts',
      'apps/workspace/src/generation/generation-assurance.ts',
      'apps/workspace/src/generation/single-section-assurance.ts',
      'apps/workspace/src/generation/single-section-assurance.spec.ts',
      'apps/meriv2-orchestrator/src/meri/strategy/strategy-assurance.ts',
      'apps/meriv2-orchestrator/src/meri/steward/steward-assurance.ts',
      'apps/api-strategy/src/agents/execution-assurance.ts',
    ]);
    await contains('apps/workspace/src/generation/generation.controller.ts', 'assertSingleGeneratedSectionRelease');
    await contains('apps/workspace/src/generation/generation.controller.ts', 'runWithGenerationAssuranceTenant');
    await contains('apps/api-strategy/src/agents/agents.module.ts', 'ExecutionAssuranceTenantInterceptor');
    await contains('apps/meriv2-orchestrator/src/meri/strategy/strategy.controller.ts', 'runWithAssuranceRequestScope');
  });

  await phase(17, 'One exact local release matrix', async () => {
    await files([
      'scripts/verify-meriv2-release.mjs',
      'apps/api/scripts/verify-meriv2-development-completeness.ts',
      'docs/qa/meriv2-phase-17-final-ci.md',
    ]);
    await contains('scripts/verify-meriv2-release.mjs', 'pnpm install');
    await contains('scripts/verify-meriv2-release.mjs', 'eval:meriv2');
    await contains('scripts/verify-meriv2-release.mjs', 'assertCurrentWithMain');
    await contains('scripts/verify-meriv2-release.mjs', 'MERIV2_LOCAL_RELEASE_PREFLIGHT_OK');
  });

  await phase(18, 'Clean and upgrade database release rehearsal', async () => {
    await files([
      'apps/api/scripts/meriv2-phase18-database-rehearsal.sh',
      'apps/api/scripts/meriv2-phase18-schema-assertions.sql',
      'apps/api/scripts/meriv2-phase18-rls-rehearsal.sh',
      'apps/api/scripts/meriv2-phase18-application-rehearsal.ts',
      'apps/api/scripts/meriv2-phase18-backfill-rehearsal.ts',
      'docs/qa/meriv2-database-release-rehearsal.md',
    ]);
    await contains('apps/api/scripts/meriv2-phase18-database-rehearsal.sh', 'prisma migrate diff');
    await contains('apps/api/scripts/meriv2-phase18-database-rehearsal.sh', 'MEMORY_GOVERNANCE_TENANTS=all');
    await contains('apps/api/scripts/meriv2-phase18-database-rehearsal.sh', 'MERI_POLICY_PACK_TENANTS=all');
  });

  await phase(19, 'Authenticated browser and accessibility acceptance', async () => {
    await files([
      'scripts/run-meriv2-phase19-local.mjs',
      'apps/api/scripts/seed-meriv2-phase19-browser-fixtures.ts',
      'apps/web/scripts/meriv2-phase19-browser-acceptance.mjs',
      'apps/web/scripts/phase19-cdp.mjs',
      'apps/web/src/phase19/AssuranceAcceptanceFixture.tsx',
      'docs/qa/meriv2-closeout-browser-acceptance.md',
    ]);
    await contains('scripts/run-meriv2-phase19-local.mjs', "MEMORY_GOVERNANCE_TENANTS: 'all'");
    await contains('apps/web/scripts/meriv2-phase19-browser-acceptance.mjs', 'ethical-wall-denied-user');
  });

  await phase(20, 'SOC 2 control system, alarms, and operations isolation', async () => {
    await files([
      'packages/meriv2-core/src/assurance/control-metrics.ts',
      'apps/api/scripts/emit-meriv2-control-metrics.ts',
      'apps/api/scripts/demo-meriv2-control-alarms.ts',
      'infra/cdk/lib/meriv2-control-stack.ts',
      'infra/cdk/bin/meriv2-operations.ts',
      'scripts/deploy-meriv2-operations-dark.mjs',
      'docs/security/meriv2-memory-assurance-control-mapping.md',
      'docs/runbooks/meriv2-memory-context-assurance-rollout.md',
      'docs/runbooks/meriv2-memory-context-assurance-rollback.md',
      'docs/runbooks/meriv2-memory-backfill.md',
      'docs/runbooks/meriv2-policy-pack-operations.md',
    ]);
    await contains('infra/cdk/lib/meriv2-control-stack.ts', 'enabled: props.monitorEnabled');
    await contains('infra/cdk/bin/meriv2-operations.ts', 'protectFromDestroy: true');
    await excludes('infra/cdk/bin/meriv2-operations.ts', 'new ComputeStack');
    await contains('scripts/deploy-meriv2-operations-dark.mjs', "worker.State !== 'DISABLED'");
  });

  await phase(21, 'Trusted PR and release authorization package', async () => {
    await files([
      'docs/qa/meriv2-phase-21-release-authorization.md',
      'docs/qa/meriv2-development-completeness-review.md',
      'docs/runbooks/meriv2-merge-and-aws-ship.md',
    ]);
    await contains('docs/runbooks/meriv2-merge-and-aws-ship.md', 'MERIV2_LOCAL_RELEASE_PREFLIGHT_OK');
    await contains('docs/runbooks/meriv2-merge-and-aws-ship.md', 'No implementer may be the sole');
  });

  await phase(22, 'Migration, dark deployment, canary, backfill, and rollback execution', async () => {
    await files([
      'scripts/collect-meriv2-aws-context.mjs',
      'scripts/prepare-meriv2-ecs-release.mjs',
      'scripts/execute-meriv2-ecs-release.mjs',
      'scripts/deploy-meriv2-operations-dark.mjs',
      'docs/runbooks/meriv2-merge-and-aws-ship.md',
      'docs/runbooks/meriv2-memory-context-assurance-rollout.md',
      'docs/runbooks/meriv2-memory-context-assurance-rollback.md',
    ]);
    await contains('scripts/prepare-meriv2-ecs-release.mjs', "MEMORY_GOVERNANCE_TENANTS: ''");
    await contains('scripts/prepare-meriv2-ecs-release.mjs', "MERI_POLICY_PACK_TENANTS: ''");
    await contains('scripts/execute-meriv2-ecs-release.mjs', 'imageDigest');
    await contains('scripts/execute-meriv2-ecs-release.mjs', 'rollbackServices');
    await contains('scripts/execute-meriv2-ecs-release.mjs', 'DEPLOY_CAPIRO_');
    await contains('scripts/deploy-meriv2-operations-dark.mjs', 'OPERATIONS_DARK');
    await contains('docs/runbooks/meriv2-merge-and-aws-ship.md', 'serves production traffic');
    await contains('docs/runbooks/meriv2-merge-and-aws-ship.md', 'MEMORY_GOVERNANCE_TENANTS=<internal-tenant-uuid>');
  });

  await globalChecks();
  await writeEvidence();

  const failed = results.filter((result) => result.status === 'failed');
  console.log(
    JSON.stringify({
      marker: failed.length
        ? 'MERIV2_DEVELOPMENT_COMPLETENESS_FAILED'
        : 'MERIV2_DEVELOPMENT_COMPLETENESS_OK',
      phaseCount: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      checks,
      requiredMigrationCount: REQUIRED_MIGRATIONS.length,
      productionAction: false,
      results,
    }),
  );
  if (failed.length) process.exitCode = 1;
}

async function globalChecks(): Promise<void> {
  const migrations = await readdir(path.join(ROOT, 'apps/api/prisma/migrations'));
  for (const name of REQUIRED_MIGRATIONS) {
    ok(migrations.includes(name), `Required migration missing: ${name}`);
  }

  const relevantFiles = await walk([
    'apps/api/src/memory',
    'apps/api/src/context',
    'apps/meriv2-orchestrator/src/meri',
    'apps/workspace/src/generation',
    'apps/api-strategy/src/agents',
    'packages/meriv2-core/src',
  ]);
  for (const relative of relevantFiles.filter(isLiveTypeScript)) {
    const value = await text(relative);
    ok(
      !/ethicalWallAllowed\s*:\s*true/.test(value),
      `Live ethical-wall bypass found: ${relative}`,
    );
    if (/admin_auto_commit/.test(value)) {
      ok(
        relative === 'apps/api/src/memory/memory-candidate-rules.ts',
        `Unexpected live admin auto-commit reference: ${relative}`,
      );
    }
  }

  const module = await text('apps/api/src/memory/memory.module.ts');
  ok(
    module.includes('useExisting: LineageAwareMemoryStoreService'),
    'MemoryStoreService is not bound to the lineage-aware implementation.',
  );
  ok(
    module.includes('useExisting: SettingsAwareMemoryCandidateService'),
    'MemoryCandidateService is not bound to the Settings-aware implementation.',
  );

  const ops = await text('infra/cdk/bin/meriv2-operations.ts');
  for (const forbidden of ['ComputeStack', 'DataStack', 'NetworkStack', 'AlarmsStack']) {
    ok(!ops.includes(`new ${forbidden}`), `Operations app must not instantiate ${forbidden}.`);
  }

  const packageJson = JSON.parse(await text('package.json')) as {
    scripts?: Record<string, string>;
  };
  for (const script of [
    'verify:meriv2-development',
    'verify:meriv2-release',
    'verify:meriv2-browser',
    'collect:meriv2-aws-context',
    'prepare:meriv2-ecs-release',
    'ship:meriv2-ecs-release',
    'deploy:meriv2-operations-dark',
  ]) {
    ok(Boolean(packageJson.scripts?.[script]), `Root package script is missing: ${script}`);
  }
}

async function phase(number: number, title: string, work: () => Promise<void>): Promise<void> {
  const before = checks;
  try {
    await work();
    results.push({ phase: number, title, status: 'passed', checks: checks - before });
  } catch (error) {
    results.push({
      phase: number,
      title,
      status: 'failed',
      checks: checks - before,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function files(paths: readonly string[]): Promise<void> {
  for (const relative of paths) await file(relative);
}

async function file(relative: string): Promise<void> {
  const info = await stat(path.join(ROOT, relative)).catch(() => null);
  ok(Boolean(info?.isFile()), `Required file missing: ${relative}`);
}

async function migration(name: (typeof REQUIRED_MIGRATIONS)[number]): Promise<void> {
  await file(`apps/api/prisma/migrations/${name}/migration.sql`);
}

async function contains(relative: string, fragment: string): Promise<void> {
  const value = await text(relative);
  ok(value.includes(fragment), `${relative} is missing required contract: ${fragment}`);
}

async function excludes(relative: string, fragment: string): Promise<void> {
  const value = await text(relative);
  ok(!value.includes(fragment), `${relative} contains forbidden contract: ${fragment}`);
}

function ok(condition: unknown, message: string): asserts condition {
  checks += 1;
  assert.ok(condition, message);
}

async function text(relative: string): Promise<string> {
  return readFile(path.join(ROOT, relative), 'utf8');
}

async function walk(roots: readonly string[]): Promise<string[]> {
  const output: string[] = [];
  for (const root of roots) await visit(root, output);
  return output;
}

async function visit(relative: string, output: string[]): Promise<void> {
  const absolute = path.join(ROOT, relative);
  const info = await stat(absolute);
  if (info.isFile()) {
    output.push(relative.split(path.sep).join('/'));
    return;
  }
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    await visit(path.join(relative, entry.name), output);
  }
}

function isLiveTypeScript(relative: string): boolean {
  return (
    relative.endsWith('.ts') &&
    !relative.endsWith('.spec.ts') &&
    !relative.endsWith('.test.ts') &&
    !relative.includes('/__fixtures__/') &&
    !relative.includes('/fixtures/')
  );
}

async function writeEvidence(): Promise<void> {
  const destination = process.env.MERIV2_COMPLETENESS_EVIDENCE?.trim();
  if (!destination) return;
  const absolute = path.resolve(ROOT, destination);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(
    absolute,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), checks, results }, null, 2)}\n`,
    'utf8',
  );
}

void main();
