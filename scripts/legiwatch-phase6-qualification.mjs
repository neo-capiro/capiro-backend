import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';

if (
  process.env.LEGIWATCH_PHASE6_TEST_DATABASE !== 'disposable' ||
  !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
)
  throw Error('Explicit local disposable PostgreSQL required');
const root = process.cwd(),
  out = resolve(process.env.LEGIWATCH_PHASE6_QUALIFICATION_OUT ?? 'work/phase6-qualification'),
  results = [];
mkdirSync(out, { recursive: true });
function run(name, workspace, paths, floor, web = false) {
  if (
    process.env.LEGIWATCH_PHASE6_TEST_GROUPS &&
    !process.env.LEGIWATCH_PHASE6_TEST_GROUPS.split(',').includes(name)
  )
    return;
  const cwd = join(root, workspace),
    require = createRequire(join(cwd, 'package.json')),
    file = join(out, name + '.json');
  for (const path of paths)
    if (!existsSync(join(cwd, path))) throw Error('Missing qualification suite: ' + path);
  const args = web
    ? [
        join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
        'run',
        '--pool=forks',
        '--poolOptions.forks.singleFork',
        '--maxWorkers=1',
        '--minWorkers=1',
        '--reporter=json',
        '--outputFile=' + file,
        ...paths,
      ]
    : [
        require.resolve('jest/bin/jest'),
        '--ci',
        '--runInBand',
        '--forceExit',
        '--json',
        '--outputFile=' + file,
        '--runTestsByPath',
        ...paths,
      ];
  const test = spawnSync(process.execPath, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  });
  const assertion = spawnSync(
    process.execPath,
    [join(root, 'scripts/assert-test-summary.mjs'), file, name, ...floor.map(String)],
    { stdio: 'inherit' },
  );
  const summary = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  results.push({
    name,
    exit: test.status ?? 1,
    assertion: assertion.status ?? 1,
    tests: summary.numTotalTests,
    passed: summary.numPassedTests,
    failed: summary.numFailedTests,
    skipped: summary.numPendingTests,
  });
}
run(
  'api',
  'apps/api',
  [
    'src/external/govinfo/govinfo.service.spec.ts',
    'src/ingestion/legiscan-published-records.spec.ts',
    'src/ingestion/legiscan-published-records-postgres.spec.ts',
    'src/ingestion/legiscan-vote-revisions.spec.ts',
    'src/ingestion/legiscan-vote-revisions-postgres.spec.ts',
    'src/ingestion/legiscan-document-evidence-postgres.spec.ts',
    'src/ingestion/govinfo-hearing-records-postgres.spec.ts',
    'src/intelligence/alert-memo/approved-record-brief.spec.ts',
    'src/engagement/hearing-record-document-access.spec.ts',
    'src/engagement/outreach-send-attachment-integrity.spec.ts',
    'src/engagement/generation/evidence-source.service.spec.ts',
    'src/engagement/engagement.attachment-content-type.spec.ts',
    'src/meri/meri-tools.firmdata.spec.ts',
    'src/meri/meri-tools.registration.spec.ts',
    'src/live-hearings/internal-legiwatch.controller.spec.ts',
    'src/live-hearings/hearing-publication-inbox-postgres.spec.ts',
    'src/meri/meri-action-proposal.service.spec.ts',
  ],
  [15, 130],
);
run(
  'intel',
  'apps/intel-api',
  [
    'test/hearing-records-postgres.spec.ts',
    'src/hearing/published-record-domain.spec.ts',
    'src/hearing/hearing-record-retrieval.controller.spec.ts',
    'src/tracker/reports/record-report-composition.spec.ts',
    'test/keyword-query.spec.ts',
    'test/keyword-discovery-postgres.spec.ts',
    'test/keyword-workflows-postgres.spec.ts',
    'test/keyword-delivery-postgres.spec.ts',
    'test/folder-tracker.spec.ts',
    'test/folder-tracker-postgres.spec.ts',
    'test/folder-import-postgres.spec.ts',
    'test/legiwatch-reports-postgres.spec.ts',
    'test/legiwatch-calendar-postgres.spec.ts',
    'src/tracker/reports/report-domain.spec.ts',
  ],
  [14, 120],
);
run(
  'core',
  'packages/meriv2-core',
  [
    'src/tools/hearing/published-record-brief.spec.ts',
    'src/llm/llm-client.spec.ts',
    'src/tools/hearing/hearing-tools.spec.ts',
  ],
  [3, 40],
);
run(
  'orchestrator',
  'apps/meriv2-orchestrator',
  [
    'src/meri/request-scoped-llm.client.spec.ts',
    'src/meri/delegated-tools.catalog.spec.ts',
    'src/meri/meri-registry.service.spec.ts',
    'src/meri/meri-capability-contract.spec.ts',
    'src/meri/full-chat-read-tools.catalog.spec.ts',
    'src/meri/write-tools.catalog.spec.ts',
  ],
  [3, 64],
);
run(
  'web',
  'apps/web',
  [
    'src/vnext/pages/legiwatch/reports/ReportWorkspace.test.tsx',
    'src/vnext/pages/legiwatch/bills/FolderBillsTab.test.tsx',
    'src/vnext/pages/legiwatch/hearings/phase3-preparation.integration.test.tsx',
    'src/vnext/pages/legiwatch/hearings/committee-member-navigation.integration.test.tsx',
    'src/vnext/pages/legiwatch/hearings/hearing-detail-navigation.integration.test.tsx',
  ],
  [4, 10],
  true,
);
const summary = {
  sha: process.env.CAPIRO_SOURCE_SHA ?? 'local',
  architecture: process.arch,
  results,
  providerScope:
    'Provider qualification, rendered browser/Figma/DOCX evidence and recipient activation are separate gates. Tests send no external messages.',
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('PHASE6_QUALIFICATION ' + JSON.stringify(summary));
process.exitCode = results.some((r) => r.exit !== 0 || r.assertion !== 0) ? 1 : 0;
