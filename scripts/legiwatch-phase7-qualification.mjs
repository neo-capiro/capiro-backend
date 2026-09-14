import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
if (
  process.env.LEGIWATCH_PHASE7_TEST_DATABASE !== 'disposable' ||
  !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
)
  throw Error('EXPLICIT_LOCAL_DISPOSABLE_DATABASE_REQUIRED');
const root = process.cwd(),
  out = resolve(process.env.LEGIWATCH_PHASE7_QUALIFICATION_OUT ?? 'work/phase7-qualification'),
  results = [];
mkdirSync(out, { recursive: true });
const env = {
  ...process.env,
  CI: 'true',
  LEGIWATCH_PHASE6_TEST_DATABASE: 'disposable',
  LEGIWATCH_PHASE5_TEST_DATABASE: 'disposable',
  LEGIWATCH_PHASE6_QUALIFICATION_OUT: join(out, 'phase6-regressions'),
};
if (process.env.LEGIWATCH_PHASE7_SKIP_BASELINE !== 'true') {
  const baseline = spawnSync(process.execPath, ['scripts/legiwatch-phase6-qualification.mjs'], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  const path = join(out, 'phase6-regressions', 'summary.json'),
    summary = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  results.push({
    name: 'phase6-regressions',
    exit: baseline.status ?? 1,
    groups: summary.results ?? [],
  });
}
for (const [app, files, web] of [
  [
    'api',
    [
      'src/ingestion/legislative-corpus.spec.ts',
      'src/ingestion/research-document-inventory-postgres.spec.ts',
      'src/ingestion/legiscan-historical-research-postgres.spec.ts',
      'src/external/state-register/fl-research.spec.ts',
      'src/external/state-register/fl-far.client.spec.ts',
      'src/external/legiscan/legiscan-dataset.util.spec.ts',
      'src/meri/meri-attachment-extract.spec.ts',
    ],
    false,
  ],
  [
    'intel-api',
    [
      'test/research-postgres.spec.ts',
      'src/tracker/research/research-domain.spec.ts',
      'test/historical-recommendation-postgres.spec.ts',
      'test/research-feature-flag.spec.ts',
    ],
    false,
  ],
  ['workspace', ['src/drafts/drafts.list-projection.spec.ts'], false],
  ['web', ['src/vnext/pages/legiwatch/research/ResearchTab.test.tsx'], true],
]) {
  const cwd = join(root, 'apps', app),
    require = createRequire(join(cwd, 'package.json')),
    file = join(out, app + '.json');
  const args = web
    ? [
        join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
        'run',
        '--pool=forks',
        '--poolOptions.forks.singleFork',
        '--reporter=json',
        '--outputFile=' + file,
        ...files,
      ]
    : [
        require.resolve('jest/bin/jest'),
        '--ci',
        '--runInBand',
        '--forceExit',
        '--json',
        '--outputFile=' + file,
        '--runTestsByPath',
        ...files,
      ];
  const test = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit' }),
    summary = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  results.push({
    name: app,
    exit: test.status ?? 1,
    tests: summary.numTotalTests,
    passed: summary.numPassedTests,
    failed: summary.numFailedTests,
    skipped: summary.numPendingTests,
  });
}
const passed = results.every(
  (r) =>
    r.exit === 0 &&
    (r.groups
      ? r.groups.every((g) => g.exit === 0 && g.assertion === 0)
      : r.tests > 0 && r.failed === 0 && r.skipped === 0),
);
const summary = {
  sha: process.env.CAPIRO_SOURCE_SHA ?? 'local',
  architecture: process.arch,
  passed,
  results,
  scope:
    'Isolated database and synthetic transport. Human source classification, live rollout and client acceptance are separate evidence.',
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('PHASE7_QUALIFICATION ' + JSON.stringify(summary));
process.exitCode = passed ? 0 : 1;
