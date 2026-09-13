import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';

if (
  process.env.LEGIWATCH_RECORDING_TEST_DATABASE !== 'disposable' ||
  !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
)
  throw Error('Explicit local disposable database required');
const root = process.cwd(),
  out = resolve(process.env.LEGIWATCH_PHASE4_QUALIFICATION_OUT ?? 'work/phase4-qualification');
mkdirSync(out, { recursive: true });
const results = [];
function run(app, paths, floor, web = false) {
  const cwd = join(root, 'apps', app),
    require = createRequire(join(cwd, 'package.json')),
    file = join(out, app + '.json');
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
        '--',
        ...paths,
      ];
  const test = spawnSync(process.execPath, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  });
  const assertion = spawnSync(
    process.execPath,
    [join(root, 'scripts/assert-test-summary.mjs'), file, app, ...floor.map(String)],
    { stdio: 'inherit' },
  );
  const summary = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  results.push({
    app,
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
  [
    'src/live-hearings/legiwatch-state-capture-policy.spec.ts',
    'src/live-hearings/live-hearings-phase7.service.spec.ts',
    'src/live-hearings/legiwatch-wave1-attendance.spec.ts',
    'src/live-hearings/hearing-publication-inbox-postgres.spec.ts',
    'src/intelligence/alert-memo/approved-hearing-recap.spec.ts',
    'src/intelligence/alert-memo/hearing-evidence-generation.spec.ts',
  ],
  [6, 53],
);
run(
  'intel-api',
  [
    'test/hearing-recording-postgres.spec.ts',
    'test/hearing-state-audio-postgres.spec.ts',
    'test/hearing-publication-postgres.spec.ts',
    'test/hearing-public-review-postgres.spec.ts',
    'src/hearing/recording/recording-domain.spec.ts',
    'src/hearing/recording/transcription-recovery-domain.spec.ts',
    'src/hearing/hearing-gateway.capture.spec.ts',
    'src/hearing/capture/ffmpeg-deepgram-capture.runtime.spec.ts',
    'src/hearing/capture/public-capture.orchestrator.spec.ts',
    'src/hearing/intelligence/deterministic-public-hearing-extractor.spec.ts',
    'src/hearing/intelligence/tenant-hearing-relevance.processor.spec.ts',
    'src/hearing/intelligence/postgres-public-hearing-insight.store.spec.ts',
    'test/sms-verification.spec.ts',
  ],
  [13, 96],
);
run(
  'web',
  [
    'src/pages/intelligence/LiveHearingRoomPage.capture.test.tsx',
    'src/pages/intelligence/LiveHearingRoomPage.recap.test.tsx',
    'src/pages/intelligence/HearingPublicationsPanel.test.tsx',
    'src/pages/intelligence/HearingRecordingPanel.test.tsx',
    'src/pages/intelligence/PublicHearingAudioPanel.test.tsx',
    'src/vnext/pages/legiwatch/live/HearingRoomVNextView.test.tsx',
    'src/lib/hearing-recording-transport.test.ts',
    'src/lib/hearing-watch-api.test.ts',
  ],
  [8, 65],
  true,
);
console.log(
  'PHASE4_QUALIFICATION ' +
    JSON.stringify({
      sha: process.env.CAPIRO_SOURCE_SHA ?? 'local',
      architecture: process.arch,
      results,
      longMedia:
        'Separate actual elapsed browser and server evidence required; this suite does not simulate four hours',
      delivery: 'Provider and authorized-recipient proof are separate gates',
    }),
);
process.exitCode = results.some((r) => r.exit !== 0 || r.assertion !== 0) ? 1 : 0;
