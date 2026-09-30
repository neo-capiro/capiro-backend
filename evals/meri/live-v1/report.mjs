import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyCaptureBundle } from './verify-capture.mjs';

export function buildMarkdownReport(report, bundle = {}) {
  const score = report.score === null ? 'UNSET — no executed PASS/FAIL cases' : `${(report.score * 100).toFixed(2)}%`;
  const verification = Array.isArray(bundle.localVerification) ? bundle.localVerification : [];
  const lines = [
    '# 26 offline / 75 live baseline',
    '',
    '## Live-v1 contract result',
    '',
    `- Contract validity: ${report.valid ? 'VALID' : 'INVALID'}`,
    `- Live score: ${score}`,
    `- PASS: ${report.counts.PASS}`,
    `- FAIL: ${report.counts.FAIL}`,
    `- BLOCKED: ${report.counts.BLOCKED}`,
    `- NOT_RUN: ${report.counts.NOT_RUN}`,
    `- Frozen fixture: ${report.contract.fixtureVersion}`,
    `- Fixture SHA-256: \`${report.contract.fixtureSha256}\``,
    `- Appendix F source SHA-256: \`${report.contract.contractSourceSha256}\``,
    '',
    'No live API, cloud, provider, browser, database, or write execution was performed for this foundation report. The 75 live cases are NOT_RUN, not inferred PASS. The existing 26-case offline suite remains separate and was not rerun by this narrow contract change.',
    '',
    '## Classification',
    '',
    'Missing captures are NOT_RUN. Missing prerequisites or stale deployment/fixture identity are BLOCKED. Only a captured run with complete run, auth, source, effect, status, UI, deterministic assertion, and human-rubric evidence can become PASS or FAIL.',
    '',
    '## Narrow local verification',
    '',
  ];
  if (verification.length === 0) lines.push('- Not recorded.');
  else for (const item of verification) lines.push(`- \`${item.command}\` — exit ${item.exitCode}${item.summary ? `; ${item.summary}` : ''}`);
  lines.push(
    '',
    '## Remaining implementation gaps',
    '',
    '- Authenticated Clerk identity/session acquisition and dedicated eval-tenant readiness checks.',
    '- Case-specific fixture seeding/reset against an isolated database; no destructive Phase 19 seed is included.',
    '- Real governed API/SSE capture and actual `/meri` Playwright controls.',
    '- Adapter/provider/JEV/worker fault injection for cases 19, 51, 54, 56–58, and 71–75.',
    '- Disposable sink execution, authoritative effect reconciliation, and persisted approval/readback evidence.',
    '- Browser download byte capture, screenshots/traces, and approval/reload UI evidence.',
    '- Human adjudication and optional recorded-output Promptfoo wiring; the included provider is read-only only.',
    '- CD-01–CD-07 and CW-01–CW-08 extraction namespaces are not included in this first canonical 75-case foundation.',
    '',
    '## Safety disposition',
    '',
    '- No production/shared AWS faults or deployments.',
    '- No real sends, cloud/provider calls, or browser actions.',
    '- No global budget/bill writes and no destructive Phase 19 fixture seed.',
    '- Offline grading must consume recorded outputs and cannot invoke writes.',
  );
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length < 5) throw new Error('Usage: node report.mjs <bundle.json> <report.json> <report.md>');
  const [, , bundlePath, jsonPath, markdownPath] = process.argv;
  const bundle = JSON.parse(await readFile(resolve(bundlePath), 'utf8'));
  const report = verifyCaptureBundle(bundle);
  const markdown = buildMarkdownReport(report, bundle);
  await Promise.all([
    mkdir(dirname(resolve(jsonPath)), { recursive: true }),
    mkdir(dirname(resolve(markdownPath)), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(jsonPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(resolve(markdownPath), `${markdown}\n`, 'utf8'),
  ]);
  console.log(JSON.stringify({ valid: report.valid, counts: report.counts, score: report.score, jsonPath, markdownPath }));
  if (!report.valid || report.counts.FAIL > 0) process.exitCode = 1;
}
