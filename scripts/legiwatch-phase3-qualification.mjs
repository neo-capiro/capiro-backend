import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';

// Runs on a disposable migrated PostgreSQL database, locally or in the native
// ARM64 build. Existing suites truncate fixtures: keep database runs sequential.
if (!process.env.DATABASE_URL || !process.env.LEGIWATCH_SAVED_TEST_DATABASE_URL)
  throw new Error('Both disposable database URLs are required');
const root = process.cwd(),
  out = resolve(process.env.LEGIWATCH_QUALIFICATION_OUT ?? 'work/phase3-qualification');
mkdirSync(out, { recursive: true });
const workflow = readFileSync('.github/workflows/legiwatch-ci.yml', 'utf8'),
  results = [];
function run(name, app, paths, floor, web = false, database = process.env.DATABASE_URL) {
  const cwd = join(root, 'apps', app),
    require = createRequire(join(cwd, 'package.json')),
    file = join(out, `${name}.json`);
  const args = web
    ? [
        join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
        'run',
        '--pool=forks',
        '--poolOptions.forks.singleFork',
        '--maxWorkers=1',
        '--minWorkers=1',
        '--testTimeout=20000',
        '--hookTimeout=20000',
        '--reporter=json',
        `--outputFile=${file}`,
        ...paths,
      ]
    : [
        require.resolve('jest/bin/jest'),
        '--ci',
        '--silent',
        '--runInBand',
        '--json',
        `--outputFile=${file}`,
        ...(name === 'api'
          ? ['--testPathIgnorePatterns=legiwatch-saved-sessions-pg.integration.spec.ts']
          : []),
        '--',
        ...paths,
      ];
  const result = spawnSync(process.execPath, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: database, CI: 'true' },
  });
  const assertion = spawnSync(
    process.execPath,
    [join(root, 'scripts/assert-test-summary.mjs'), file, name, ...floor.map(String)],
    { stdio: 'inherit' },
  );
  const summary = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  results.push({
    name,
    exit: result.status ?? 1,
    assertion: assertion.status ?? 1,
    tests: summary.numTotalTests,
    passed: summary.numPassedTests,
    failed: summary.numFailedTests,
    skipped: summary.numPendingTests,
  });
  console.log('PHASE3_CHECK ' + JSON.stringify(results.at(-1)));
}
run(
  'saved-hearings',
  'api',
  ['src/live-hearings/legiwatch-saved-sessions-pg.integration.spec.ts'],
  [1, 17],
  false,
  process.env.LEGIWATCH_SAVED_TEST_DATABASE_URL,
);
run(
  'phase1-folders',
  'intel-api',
  ['test/folder-tracker-postgres.spec.ts', 'test/folder-import-postgres.spec.ts'],
  [2, 17],
);
run('phase1-source', 'api', ['src/ingestion/legiscan-documents-postgres.spec.ts'], [1, 2]);
run(
  'phase2-reports',
  'intel-api',
  ['test/legiwatch-reports-postgres.spec.ts', 'src/tracker/reports/report-domain.spec.ts'],
  [2, 34],
);
run(
  'phase2-source',
  'api',
  [
    'src/ingestion/legiscan-published-records-postgres.spec.ts',
    'src/ingestion/legiscan-published-records.spec.ts',
  ],
  [2, 6],
);
run('phase3-private', 'intel-api', ['test/legiwatch-calendar-postgres.spec.ts'], [1, 7]);
run('phase3-legiscan', 'api', ['src/ingestion/legiscan-calendar.spec.ts'], [1, 3]);
run(
  'workspace-hillday',
  'web',
  ['src/vnext/pages/workspace/hillday/HillDayEditor.test.tsx'],
  [1, 7],
  true,
);
for (const app of ['api', 'intel-api', 'web']) {
  const section = workflow
    .split(`- name: Tests — apps/${app} LegiWatch scope`)[1]
    ?.split('- name: Assert')[0];
  const paths = section
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(src|scripts|test)\//.test(line));
  if (!paths?.length) throw new Error(`Missing ${app} suite enumeration`);
  run(
    app,
    app,
    paths,
    app === 'api' ? [80, 1025] : app === 'web' ? [249, 805] : [71, 763],
    app === 'web',
  );
}
console.log(
  'PHASE3_QUALIFICATION ' +
    JSON.stringify({
      sha: process.env.CAPIRO_SOURCE_SHA ?? 'local',
      architecture: process.arch,
      results,
    }),
);
process.exitCode = results.some((result) => result.exit !== 0 || result.assertion !== 0) ? 1 : 0;
