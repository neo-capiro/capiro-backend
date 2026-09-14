import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
if (
  process.env.LEGIWATCH_PHASE8_TEST_DATABASE !== 'disposable' ||
  !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
)
  throw Error('EXPLICIT_LOCAL_DISPOSABLE_DATABASE_REQUIRED');
const root = process.cwd(),
  out = resolve(process.env.LEGIWATCH_PHASE8_QUALIFICATION_OUT ?? 'work/phase8-qualification'),
  results = [];
mkdirSync(out, { recursive: true });
if (process.env.LEGIWATCH_PHASE8_SKIP_BASELINE !== 'true') {
  const run = spawnSync(process.execPath, ['scripts/legiwatch-phase7-qualification.mjs'], {
    cwd: root,
    env: { ...process.env, LEGIWATCH_PHASE7_TEST_DATABASE: 'disposable' },
    stdio: 'inherit',
  });
  results.push({ name: 'phase6-and-phase7-regressions', exit: run.status ?? 1 });
}
for (const [app, files, web] of [
  [
    'api',
    [
      'src/intelligence/news/news-catcher-dashboard.access.spec.ts',
      'src/intelligence/news/news-catcher-dashboard.service.spec.ts',
      'src/intelligence/news/news-catcher-dashboard.media.spec.ts',
      'src/intelligence/news/news-dashboard.controller.filters.spec.ts',
    ],
    false,
  ],
  ['intel-api', ['test/phase8-domain.spec.ts', 'test/phase8-postgres.spec.ts'], false],
  ['web', ['src/vnext/pages/legiwatch/editorial/EvidenceTab.test.tsx'], true],
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
  const run = spawnSync(process.execPath, args, { cwd, env: process.env, stdio: 'inherit' }),
    summary = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  results.push({
    name: app,
    exit: run.status ?? 1,
    tests: summary.numTotalTests,
    passed: summary.numPassedTests,
    failed: summary.numFailedTests,
    skipped: summary.numPendingTests,
  });
}
const passed = results.every(
  (r) =>
    r.exit === 0 && (r.tests === undefined || (r.tests > 0 && r.failed === 0 && r.skipped === 0)),
);
const summary = {
  sha: process.env.CAPIRO_SOURCE_SHA ?? 'local',
  architecture: process.arch,
  passed,
  results,
  scope:
    'Automated technical evidence. Provider transport in tests is synthetic; human relevance, client acceptance and live delivery are separate.',
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('PHASE8_QUALIFICATION ' + JSON.stringify(summary));
process.exitCode = passed ? 0 : 1;
