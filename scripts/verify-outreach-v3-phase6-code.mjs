#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { previewGateProblems } from './outreach-v3-preview-gate-contract.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runApprovedPreviewMaintenance } from './outreach-phase6-approved-preview-maintenance.mjs';

const usage = 'Usage: node scripts/verify-outreach-v3-phase6-code.mjs (--run | --help)';
if (process.argv.length === 3 && process.argv[2] === '--help') {
  console.log(usage);
  process.exit(0);
}
if (process.argv.length !== 3 || process.argv[2] !== '--run') {
  console.error(usage);
  process.exit(2);
}

const root = process.cwd();
const phase5Base = '835cdef35cd8ecb23faf1b100ecfc743bcd31128';
// Retain the original phase-only scope; all source/functional checks use this checkout.
const phase6ScopeEnd =
  process.env.OUTREACH_V3_PHASE6_SCOPE_END ?? 'ab45f984f33f56da7ad2ab9dbbaae6cab831fbda';
// Recovery branches can carry newer mainline commits after the archived Phase
// 5 handoff. Callers may supply a moving-mainline scope for those branches
// (verify-outreach-v3-phase4-6-combined.mjs passes origin/main). It is checked
// in addition to the original phase-only scope and may be empty after merge.
const phase6ScopeBase = process.env.OUTREACH_V3_PHASE6_SCOPE_BASE;

function run(label, command, args, options = {}) {
  process.stdout.write(`\n== ${label} ==\n${[command, ...args].join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    process.stderr.write(`\nOUTREACH_V3_PHASE6_FAILED:${label}\n`);
    process.exit(result.status ?? 1);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `${command} failed\n`);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) {
    process.stderr.write(`OUTREACH_V3_PHASE6_CONTRACT_FAILED:${message}\n`);
    process.exit(1);
  }
}

if (runApprovedPreviewMaintenance(root, run)) process.exit(0);

const required = [
  'docs/plans/outreach-v3/revised-phase-6-design-to-state-manifest.md',
  'apps/web/src/pages/engagement/outreach/v3/OutreachWizardRouter.tsx',
  'apps/web/src/pages/engagement/outreach/v3/OutreachV3Route.tsx',
  'apps/web/src/pages/engagement/outreach/v3/OutreachConversation.tsx',
  'apps/web/src/pages/engagement/outreach/v3/CampaignBrief.tsx',
  'apps/web/src/pages/engagement/outreach/v3/CurrentDecisionSurface.tsx',
  'apps/web/src/pages/engagement/outreach/v3/TargetWorkspace.tsx',
  'apps/web/src/pages/engagement/outreach/v3/TargetWorkspaceEntry.tsx',
  'apps/web/src/pages/engagement/outreach/v3/ContextReviewSurface.tsx',
  'apps/web/src/pages/engagement/outreach/v3/DecisionSurfaces.tsx',
  'apps/web/src/pages/engagement/outreach/v3/useOutreachV3Session.ts',
  'apps/web/src/pages/engagement/outreach/v3/outreach-v3-api.ts',
  'apps/web/src/pages/engagement/outreach/v3/outreach-v3-preview.ts',
  'apps/web/src/pages/engagement/outreach/v3/target-intelligence-contracts.ts',
  'apps/web/src/pages/engagement/outreach/v3/outreach-v3.css',
  'apps/web/src/pages/engagement/outreach/v3/target-workspace.css',
  'apps/web/src/pages/engagement/outreach/v3/context-review-surface.css',
];
for (const file of required) assert(existsSync(resolve(root, file)), `missing:${file}`);

const changedIn = (range) =>
  output('git', ['diff', '--name-only', range]).split(/\r?\n/).filter(Boolean);
const changed = changedIn(`${phase5Base}...${phase6ScopeEnd}`);
assert(changed.length > 0, 'empty-phase6-diff');
// Phase 4/5 closeout fixes (scope-aware tests, type fixes, Windows compat)
// are legitimately in the post-Phase-5 range but are not Phase 6 API features.
// Exclude test/spec files and the four Phase 4/5 closeout source fixes from
// the Phase 6 API-change contract, mirroring the scope-aware pattern used by
// the Phase 4/5 architecture tests and the whitespace gates.
const phase45CloseoutApiFiles = new Set([
  'apps/api/src/capabilities/capability-authorization.service.ts',
  'apps/api/src/capabilities/capability-result.ts',
  'apps/api/src/capabilities/targets/outreach-target-reference.service.ts',
  'apps/api/src/capabilities/targets/outreach-target.contract.ts',
]);
const recoveryCloseoutFiles = new Set([
  // Recovery closeout repairs carried on this branch; checked by their own gates.
  'apps/api/prisma/migrations/20281002010000_research_portfolios_phase10_watch_delivery/migration.sql',
  'apps/api/prisma/migrations/20281003010000_dedup_client_intel_mapping/migration.sql',
  'apps/api/src/embeddings/embedder.ts',
  'apps/api/src/intelligence/news/news-catcher-dashboard.service.ts',
  'apps/api/src/meeting-capture/meeting-capture-persistence.service.ts',
  'apps/api/src/memory/memory-ingest.helpers.ts',
  'apps/api/src/memory/memory-ingest.service.ts',
  'apps/api/src/memory/memory-store.service.ts',
  'apps/api/src/memory/memory-wall.helpers.ts',
  // Value import of PrismaService so Nest can inject it; the type-only import
  // left the service unresolvable and the API unable to boot.
  'apps/api/src/meri/meri-chat-attachment-read.service.ts',
  'packages/defense-domain/src/budget-lifecycle/discovery/listing-extract.ts',
  'packages/shared/src/index.ts',
]);
// The recovery closeout allowance applies only to the moving-mainline scope; the
// original Phase 6 scope keeps the strict boundary.
function assertPhase6Scope(files, { allowRecoveryCloseout }) {
  for (const file of files) {
    const isTestOrFixture =
      file.includes('.spec.') || file.includes('.test.') || file.includes('__fixtures__/');
    const isPhase45Closeout = phase45CloseoutApiFiles.has(file);
    const isRecoveryCloseout = allowRecoveryCloseout && recoveryCloseoutFiles.has(file);
    assert(
      !file.startsWith('apps/api/src/') ||
        isTestOrFixture ||
        isPhase45Closeout ||
        isRecoveryCloseout,
      `phase6-api-change:${file}`,
    );
    assert(!file.startsWith('packages/') || isRecoveryCloseout, `phase6-package-change:${file}`);
    assert(!file.startsWith('infra/'), `phase6-infrastructure-change:${file}`);
    assert(!file.includes('/prisma/migrations/') || isRecoveryCloseout, `phase6-migration:${file}`);
    assert(!file.startsWith('apps/outreach-api/'), `new-outreach-service:${file}`);
  }
}
assertPhase6Scope(changed, { allowRecoveryCloseout: false });
if (phase6ScopeBase) {
  assertPhase6Scope(changedIn(`${phase6ScopeBase}...HEAD`), { allowRecoveryCloseout: true });
}

const v3Dir = resolve(root, 'apps/web/src/pages/engagement/outreach/v3');
const productionFiles = readdirSync(v3Dir)
  .filter((name) => /\.(ts|tsx)$/.test(name))
  .filter((name) => !/\.(spec|test)\./.test(name));
const productionCombined = productionFiles
  .map((name) => readFileSync(resolve(v3Dir, name), 'utf8'))
  .join('\n');
const apiClient = readFileSync(resolve(v3Dir, 'outreach-v3-api.ts'), 'utf8');
const router = readFileSync(resolve(v3Dir, 'OutreachWizardRouter.tsx'), 'utf8');
const proposalReview = readFileSync(resolve(v3Dir, 'CurrentDecisionSurface.tsx'), 'utf8');
const targets = readFileSync(resolve(v3Dir, 'TargetWorkspace.tsx'), 'utf8');
const context = readFileSync(resolve(v3Dir, 'ContextReviewSurface.tsx'), 'utf8');
const contextSelection = readFileSync(resolve(v3Dir, 'context-selection.ts'), 'utf8');
const manifest = readFileSync(
  resolve(root, 'docs/plans/outreach-v3/revised-phase-6-design-to-state-manifest.md'),
  'utf8',
);

assert(!apiClient.includes('send-intents'), 'send-intent-client');
assert(!apiClient.includes('send-test'), 'test-send-client');
assert(!apiClient.includes('draft-artifacts'), 'draft-authority-client');
assert(!/\/generate(?:-|\/|')/.test(apiClient), 'generation-client');
assert(!/\/send(?:-|\/|')/.test(apiClient), 'send-client');
assert(!productionCombined.includes('X-Capiro-Engagement-Preview'), 'preview-header-leak');
assert(!/localStorage\.setItem\([^)]*campaign/i.test(productionCombined), 'browser-campaign-store');
assert(!/useState<OutreachV3CampaignSpec/.test(productionCombined), 'duplicate-campaign-spec');
assert(previewGateProblems(router).length === 0, 'missing-dual-preview-gate');
assert(
  /!hasClassicDraft\s*&&\s*previewMode === 'v3'\s*&&\s*isEngagementPreviewActive\(\)/.test(router),
  'missing-dual-preview-gate',
);
assert(router.includes('<ClassicOutreachWizard {...props} />'), 'classic-fallback-missing');
assert(router.includes('initialRecord || props.initialDraftId'), 'classic-draft-routing-missing');
assert(proposalReview.includes('Why this proposal?'), 'proposal-rationale-control-missing');
assert(proposalReview.includes('Edit manually'), 'proposal-edit-control-missing');
assert(proposalReview.includes('will not auto-rebase'), 'stale-proposal-no-rebase-copy-missing');
assert(
  proposalReview.includes('disabled={proposalBusy || stale}'),
  'stale-proposal-apply-guard-missing',
);
// These contracts are behavioral: comments and explanatory copy can change
// while the no-write and scope boundaries stay intact. Exercise actual loading,
// explicit acceptance and the unavailable group-safe selection here.
run('Build shared web contracts', 'pnpm', ['--filter', '@capiro/shared', 'build']);
run('Read-only target loading and governed context selection', 'pnpm', [
  '--filter',
  '@capiro/web',
  'exec',
  'vitest',
  'run',
  '--poolOptions.threads.singleThread',
  '--testTimeout=20000',
  '--hookTimeout=20000',
  'src/pages/engagement/outreach/v3/TargetWorkspace.spec.tsx',
  'src/pages/engagement/outreach/v3/ContextReviewSurface.spec.tsx',
  'src/pages/engagement/outreach/v3/context-selection.spec.ts',
]);
assert(
  targets.includes('Read-only: this never calls applyCommands'),
  'target-read-only-load-contract-missing',
);
assert(
  targets.includes('Saving to the shared Directory remains'),
  'manual-directory-default-off-copy-missing',
);
assert(targets.includes('getOutreachV3TargetRelationships'), 'relationship-inspection-missing');
assert(!targets.includes('void runSearch();'), 'target-stage-auto-commit');
assert(context.includes('Style is not evidence'), 'writing-guidance-separation-missing');
assert(context.includes('Applies to ${scopeTarget} only'), 'target-scope-copy-missing');
assert(
  context.includes("entry.contextClass === 'required_policy'"),
  'required-policy-lock-missing',
);
assert(
  context.includes('Group-safe') &&
    contextSelection.includes('group_safe') &&
    contextSelection.includes('no representation here'),
  'group-safe-fail-closed-missing',
);

for (const node of [
  '634:2703',
  '638:2906',
  '640:3097',
  '643:3350',
  '645:3555',
  '646:3746',
  '648:3987',
  '649:4168',
  '650:4380',
  '651:4576',
  '652:4774',
  '654:4967',
  '655:5028',
  '656:5099',
  '661:5304',
]) {
  assert(manifest.includes(node), `missing-figma-node:${node}`);
}

run('Preview route manifest drift', 'node', [
  'scripts/engagement-phase3-preview-route-patterns.mjs',
  '--check',
]);
run('vNext outreach-decision css generator controls', 'node', [
  '--test',
  'scripts/port-outreach-decision-vnext-css.spec.mjs',
]);
run('vNext outreach-decision css drift', 'node', [
  'scripts/port-outreach-decision-vnext-css.mjs',
  '--check',
]);
run('Preview gate negative controls', 'node', [
  '--test',
  'scripts/outreach-v3-preview-gate-contract.spec.mjs',
]);
run('Web typecheck', 'pnpm', ['--filter', '@capiro/web', 'typecheck']);
run('Outreach V3 focused tests', 'pnpm', [
  '--filter',
  '@capiro/web',
  'exec',
  'vitest',
  'run',
  '--poolOptions.threads.singleThread',
  '--testTimeout=20000',
  '--hookTimeout=20000',
  'src/pages/engagement/outreach/v3/outreach-v3-preview.spec.ts',
  'src/pages/engagement/outreach/v3/OutreachWizardRouter.spec.tsx',
  'src/pages/engagement/outreach/v3/CurrentDecisionSurface.spec.tsx',
  'src/pages/engagement/outreach/v3/commands.spec.ts',
  'src/pages/engagement/outreach/v3/outreach-v3-api.spec.ts',
  'src/pages/engagement/outreach/v3/useOutreachV3Session.spec.ts',
  'src/pages/engagement/outreach/v3/phase6-ui-contract.spec.ts',
  'src/lib/engagement-api-preview.spec.ts',
]);
run('Web production build', 'pnpm', ['--filter', '@capiro/web', 'build']);
const whitespaceExclusions = [
  ':(exclude)docs/plans/**/*.md',
  ':(exclude).github/**/*.yml',
  ':(exclude).github/**/*.yaml',
];
run('Diff whitespace', 'git', [
  'diff',
  '--check',
  `${phase5Base}...${phase6ScopeEnd}`,
  '--',
  '.',
  ...whitespaceExclusions,
]);
if (phase6ScopeBase) {
  run('Moving-mainline diff whitespace', 'git', [
    'diff',
    '--check',
    `${phase6ScopeBase}...HEAD`,
    '--',
    '.',
    ...whitespaceExclusions,
  ]);
}

run('Current PR whitespace', 'git', ['diff', '--check', 'origin/main...HEAD']);

process.stdout.write('\nOUTREACH_V3_PHASE6_COMPLETE\n');
