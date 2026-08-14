#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHASE5_HEAD = '835cdef35cd8ecb23faf1b100ecfc743bcd31128';

function fail(message, status = 1) {
  console.error(`OUTREACH_V3_PHASE6_FINAL_FAILED:${message}`);
  process.exit(status);
}

function run(label, command, args) {
  console.log(`\n== ${label} ==\n${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env },
  });
  if (result.status !== 0) fail(label, result.status ?? 1);
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) fail(`${command}:${args.join(' ')}`);
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const exactHead = output('git', ['rev-parse', 'HEAD']);
const shaIndex = process.argv.indexOf('--sha');
if (shaIndex !== -1) {
  const requested = process.argv[shaIndex + 1];
  assert(Boolean(requested), 'MISSING_SHA_ARGUMENT');
  assert(requested === exactHead, `HEAD_MISMATCH:${requested}:${exactHead}`);
}
run('Phase 5 ancestry', 'git', ['merge-base', '--is-ancestor', PHASE5_HEAD, exactHead]);

const required = [
  'docs/plans/outreach-v3/revised-phase-6-design-to-state-manifest.md',
  'apps/web/src/pages/engagement/outreach/v3/OutreachWizardRouter.tsx',
  'apps/web/src/pages/engagement/outreach/v3/OutreachV3Route.tsx',
  'apps/web/src/pages/engagement/outreach/v3/OutreachConversation.tsx',
  'apps/web/src/pages/engagement/outreach/v3/CampaignBrief.tsx',
  'apps/web/src/pages/engagement/outreach/v3/CurrentDecisionSurface.tsx',
  'apps/web/src/pages/engagement/outreach/v3/GoalDecisionSurface.tsx',
  'apps/web/src/pages/engagement/outreach/v3/SponsorDecisionSurface.tsx',
  'apps/web/src/pages/engagement/outreach/v3/TargetWorkspace.tsx',
  'apps/web/src/pages/engagement/outreach/v3/DeliveryDecisionSurface.tsx',
  'apps/web/src/pages/engagement/outreach/v3/ContextReviewSurface.tsx',
  'apps/web/src/pages/engagement/outreach/v3/StrategyDecisionSurface.tsx',
  'apps/web/src/pages/engagement/outreach/v3/ReadyForGenerationSurface.tsx',
  'apps/web/src/pages/engagement/outreach/v3/decision-surface-contract.ts',
  'apps/web/src/pages/engagement/outreach/v3/target-intelligence-contracts.ts',
  'apps/web/src/pages/engagement/outreach/v3/useOutreachV3Session.ts',
  'apps/web/src/pages/engagement/outreach/v3/outreach-v3-api.ts',
  'apps/web/src/pages/engagement/outreach/v3/outreach-v3-preview.ts',
  'apps/web/src/pages/engagement/outreach/v3/outreach-v3.css',
  'apps/web/src/pages/engagement/outreach/v3/target-workspace.css',
  'apps/web/src/pages/engagement/outreach/v3/context-review-surface.css',
  'apps/web/src/pages/engagement/outreach/v3/planning-surfaces.css',
];
for (const relative of required) assert(existsSync(path.join(ROOT, relative)), `MISSING:${relative}`);

const changed = output('git', ['diff', '--name-only', `${PHASE5_HEAD}...${exactHead}`])
  .split(/\r?\n/)
  .filter(Boolean);
assert(changed.length > 0, 'EMPTY_DIFF');
// Mirror verify-outreach-v3-phase6-code.mjs: Phase 4/5 closeout fixes and
// test/spec/fixture-only paths may sit in the post-Phase-5 range without
// being Phase 6 API features. Production API expansion is still forbidden.
const phase45CloseoutApiFiles = new Set([
  'apps/api/src/capabilities/capability-authorization.service.ts',
  'apps/api/src/capabilities/capability-result.ts',
  'apps/api/src/capabilities/targets/outreach-target-reference.service.ts',
  'apps/api/src/capabilities/targets/outreach-target.contract.ts',
]);
for (const relative of changed) {
  const isTestOrFixture =
    relative.includes('.spec.') ||
    relative.includes('.test.') ||
    relative.includes('__fixtures__/');
  const isPhase45Closeout = phase45CloseoutApiFiles.has(relative);
  assert(
    !relative.startsWith('apps/api/src/') || isTestOrFixture || isPhase45Closeout,
    `API_SCOPE_EXPANSION:${relative}`,
  );
  assert(!relative.startsWith('packages/'), `PACKAGE_SCOPE_EXPANSION:${relative}`);
  assert(!relative.startsWith('infra/'), `INFRA_SCOPE_EXPANSION:${relative}`);
  assert(!relative.includes('/prisma/migrations/'), `MIGRATION_SCOPE_EXPANSION:${relative}`);
  assert(!relative.startsWith('apps/outreach-api/'), `NEW_SERVICE:${relative}`);
}

const dir = path.join(ROOT, 'apps/web/src/pages/engagement/outreach/v3');
const production = readdirSync(dir)
  .filter((name) => /\.(ts|tsx)$/.test(name))
  .filter((name) => !/\.(spec|test)\./.test(name))
  .map((name) => readFileSync(path.join(dir, name), 'utf8'))
  .join('\n');
const read = (name) => readFileSync(path.join(dir, name), 'utf8');
const api = read('outreach-v3-api.ts');
const router = read('OutreachWizardRouter.tsx');
const route = read('OutreachV3Route.tsx');
const hook = read('useOutreachV3Session.ts');
const proposal = read('CurrentDecisionSurface.tsx');
const goal = read('GoalDecisionSurface.tsx');
const sponsor = read('SponsorDecisionSurface.tsx');
const targets = read('TargetWorkspace.tsx');
const delivery = read('DeliveryDecisionSurface.tsx');
const context = read('ContextReviewSurface.tsx');
const strategy = read('StrategyDecisionSurface.tsx');
const ready = read('ReadyForGenerationSurface.tsx');

for (const forbidden of [
  'send-intents',
  'send-test',
  'draft-artifacts',
  'REQUEST_SAMPLE_GENERATION',
  'REQUEST_FULL_GENERATION',
  'REQUEST_SEND_REVIEW',
]) {
  assert(!api.includes(forbidden), `LATER_PHASE_API_AUTHORITY:${forbidden}`);
}
assert(!/\/generate(?:-|\/|')/.test(api), 'GENERATION_ENDPOINT');
assert(!/\/send(?:-|\/|')/.test(api), 'SEND_ENDPOINT');
assert(!production.includes('X-Capiro-Engagement-Preview'), 'PREVIEW_HEADER_LEAK');
assert(!/localStorage\.setItem\([^)]*campaign/i.test(production), 'BROWSER_CAMPAIGN_STORE');
assert(!/useState<OutreachV3CampaignSpec/.test(production), 'DUPLICATE_CAMPAIGN_SPEC');

assert(router.includes("previewMode === 'v3' && isEngagementPreviewActive() && !hasClassicDraft"), 'DUAL_PREVIEW_GATE');
assert(router.includes('<ClassicOutreachWizard {...props} />'), 'CLASSIC_FALLBACK');
assert(router.includes('initialRecord || props.initialDraftId'), 'CLASSIC_DRAFT_ROUTE');
assert(route.includes('session={session}'), 'CANONICAL_SESSION_PROJECTION');
assert(!route.includes('decisionSession'), 'RECOMMENDATION_PROJECTED_AS_STATE');
assert(!route.includes('recommendedPattern'), 'ROUTE_DELIVERY_INFERENCE');

assert(goal.includes('objective.trim()'), 'GOAL_OBJECTIVE_REQUIRED');
assert(goal.includes('Client or sponsor scope is optional'), 'GOAL_FIRST_COPY');
assert(!goal.includes('Search clients'), 'CLIENT_FORCED_IN_GOAL');
assert(sponsor.includes('Sponsor and target audience are separate'), 'SPONSOR_AUDIENCE_SEPARATION');
assert(!sponsor.includes('ADD_TARGET_REFS'), 'SPONSOR_ADDS_TARGET');
assert(!sponsor.includes("selectedClientId ? 'client' : 'firm'"), 'SPONSOR_INFERENCE');

assert(targets.includes('Read-only recommendations are allowed to load automatically'), 'READ_ONLY_RECOMMENDATIONS');
assert(!targets.includes('void runSearch();'), 'TARGET_STAGE_AUTO_COMMIT');
assert(targets.includes('Saving to the shared Directory remains'), 'MANUAL_DIRECTORY_DEFAULT');
assert(targets.includes('getOutreachV3TargetRelationships'), 'RELATIONSHIP_READ');
assert(targets.includes('Add target'), 'EXPLICIT_TARGET_ADD');
assert(targets.includes('Not relevant'), 'TARGET_REJECTION');

assert(delivery.includes('Cards select. Continue commits'), 'DELIVERY_EXPLICIT_COMMIT');
assert(delivery.includes("pattern === 'shared_thread' && !sharedVisibilityAccepted"), 'SHARED_VISIBILITY_ACK');
assert(delivery.includes("disabled={pattern === 'shared_thread' && value === 'high'}"), 'SHARED_HIGH_PERSONALIZATION_BLOCK');
assert(!delivery.includes('applyCommands(deliveryCommands(recommended'), 'DELIVERY_RECOMMENDATION_AUTO_APPLY');

assert(context.includes('Style is not evidence'), 'GUIDANCE_EVIDENCE_SEPARATION');
assert(context.includes('Applies to ${scopeTarget} only'), 'TARGET_CONTEXT_SCOPE');
assert(context.includes("entry.contextClass === 'required_policy'"), 'REQUIRED_POLICY_LOCK');
assert(context.includes('Group-safe context requires a named audience group'), 'GROUP_SAFE_FAIL_CLOSED');
assert(context.includes('never commits'), 'MEMORY_AUTO_COMMIT_COPY');

assert(strategy.includes('Recommendations remain editable'), 'STRATEGY_EDITABLE');
assert(strategy.includes('strategyCommands'), 'STRATEGY_COMMANDS');
assert(!strategy.match(/REQUEST_(?:SAMPLE|FULL)_GENERATION/), 'STRATEGY_GENERATION');
assert(ready.includes('The product stops safely here'), 'PLANNING_BOUNDARY');
assert(ready.includes('No sender, test send, final send, provider call, or delivery retry'), 'LATER_AUTHORITY_COPY');
assert(!ready.match(/onGenerate|createSendIntent|sendCampaign/), 'READY_BOUNDARY_ACTION_LEAK');

assert(proposal.includes('Why this proposal?'), 'PROPOSAL_RATIONALE');
assert(proposal.includes('Edit manually'), 'PROPOSAL_EDIT');
assert(proposal.includes('will not auto-rebase'), 'NO_AUTO_REBASE');
assert(proposal.includes('disabled={proposalBusy || stale}'), 'STALE_APPLY_DISABLED');
assert(hook.includes('await archiveOutreachV3Session(api, priorId);'), 'ARCHIVE_NOT_AWAITED');
assert(!hook.includes('archiveOutreachV3Session(api, priorId).catch'), 'ARCHIVE_FAILURE_SWALLOWED');

run('Preview route manifest drift', 'node', [
  'scripts/engagement-phase3-preview-route-patterns.mjs',
  '--check',
]);
run('Web typecheck', 'pnpm', ['--filter', '@capiro/web', 'typecheck']);
run('Outreach V3 final focused tests', 'pnpm', [
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
  'src/pages/engagement/outreach/v3/GoalDecisionSurface.spec.tsx',
  'src/pages/engagement/outreach/v3/SponsorDecisionSurface.spec.tsx',
  'src/pages/engagement/outreach/v3/TargetWorkspace.spec.tsx',
  'src/pages/engagement/outreach/v3/DeliveryDecisionSurface.spec.tsx',
  'src/pages/engagement/outreach/v3/ContextReviewSurface.spec.tsx',
  'src/pages/engagement/outreach/v3/StrategyDecisionSurface.spec.tsx',
  'src/pages/engagement/outreach/v3/ReadyForGenerationSurface.spec.tsx',
  'src/pages/engagement/outreach/v3/commands.spec.ts',
  'src/pages/engagement/outreach/v3/outreach-v3-api.spec.ts',
  'src/pages/engagement/outreach/v3/useOutreachV3Session.spec.ts',
  'src/pages/engagement/outreach/v3/phase6-ui-contract.spec.ts',
  'src/pages/engagement/outreach/v3/phase6-planning-surfaces.spec.ts',
  'src/lib/engagement-api-preview.spec.ts',
]);
run('Web production build', 'pnpm', ['--filter', '@capiro/web', 'build']);
run('Diff whitespace', 'git', ['diff', '--check', `${PHASE5_HEAD}...${exactHead}`]);

console.log(`\nOUTREACH_V3_PHASE6_CODE_COMPLETE:${exactHead}`);
