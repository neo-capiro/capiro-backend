#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const phase5Base = '835cdef35cd8ecb23faf1b100ecfc743bcd31128';

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

const required = [
  'docs/plans/outreach-v3/revised-phase-6-design-to-state-manifest.md',
  'apps/web/src/pages/engagement/outreach/v3/OutreachWizardRouter.tsx',
  'apps/web/src/pages/engagement/outreach/v3/OutreachV3Route.tsx',
  'apps/web/src/pages/engagement/outreach/v3/OutreachConversation.tsx',
  'apps/web/src/pages/engagement/outreach/v3/CampaignBrief.tsx',
  'apps/web/src/pages/engagement/outreach/v3/DecisionSurfaces.tsx',
  'apps/web/src/pages/engagement/outreach/v3/useOutreachV3Session.ts',
  'apps/web/src/pages/engagement/outreach/v3/outreach-v3-api.ts',
  'apps/web/src/pages/engagement/outreach/v3/outreach-v3-preview.ts',
  'apps/web/src/pages/engagement/outreach/v3/outreach-v3.css',
];
for (const file of required) assert(existsSync(resolve(root, file)), `missing:${file}`);

const changed = output('git', ['diff', '--name-only', `${phase5Base}...HEAD`])
  .split(/\r?\n/)
  .filter(Boolean);
assert(changed.length > 0, 'empty-phase6-diff');
for (const file of changed) {
  assert(!file.startsWith('apps/api/src/'), `phase6-api-change:${file}`);
  assert(!file.startsWith('packages/'), `phase6-package-change:${file}`);
  assert(!file.startsWith('infra/'), `phase6-infrastructure-change:${file}`);
  assert(!file.includes('/prisma/migrations/'), `phase6-migration:${file}`);
  assert(!file.startsWith('apps/outreach-api/'), `new-outreach-service:${file}`);
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
assert(
  router.includes("previewMode === 'v3' && isEngagementPreviewActive() && !hasClassicDraft"),
  'missing-dual-preview-gate',
);
assert(router.includes('<ClassicOutreachWizard {...props} />'), 'classic-fallback-missing');
assert(router.includes('initialRecord || props.initialDraftId'), 'classic-draft-routing-missing');

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
  'src/pages/engagement/outreach/v3/commands.spec.ts',
  'src/pages/engagement/outreach/v3/outreach-v3-api.spec.ts',
  'src/pages/engagement/outreach/v3/useOutreachV3Session.spec.ts',
  'src/pages/engagement/outreach/v3/phase6-ui-contract.spec.ts',
  'src/lib/engagement-api-preview.spec.ts',
]);
run('Web production build', 'pnpm', ['--filter', '@capiro/web', 'build']);
run('Diff whitespace', 'git', ['diff', '--check', `${phase5Base}...HEAD`]);

process.stdout.write('\nOUTREACH_V3_PHASE6_COMPLETE\n');
