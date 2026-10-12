/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'Usage: node scripts/package9-scorecard.mjs --write [--evidence <path>] [--output <path>]';
const cliArgs = process.argv.slice(2);
if (cliArgs.length === 1 && (cliArgs[0] === '--help' || cliArgs[0] === '-h')) {
  console.log(USAGE);
  process.exit(0);
}
let writeRequested = false;
let invalid = false;
for (let index = 0; index < cliArgs.length; index++) {
  const arg = cliArgs[index];
  if (arg === '--write') {
    writeRequested = true;
  } else if (arg === '--evidence' || arg === '--output') {
    if (!cliArgs[index + 1] || cliArgs[index + 1].startsWith('--')) invalid = true;
    else index++;
  } else {
    invalid = true;
  }
}
if (!writeRequested || invalid) {
  console.error(USAGE);
  process.exit(2);
}
const { buildQualificationScorecard } = await import('../dist/qualification/scorecard.js');

const here = path.dirname(fileURLToPath(import.meta.url));

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const evidencePath = path.resolve(
  argument(
    '--evidence',
    path.join(here, '../src/qualification/__fixtures__/package9-current-evidence-v1.json'),
  ),
);
const outputPath = path.resolve(
  argument('--output', path.join(here, '../tmp/package9-scorecard/report.json')),
);
const evidenceBytes = readFileSync(evidencePath, 'utf8');
const evidence = JSON.parse(evidenceBytes);
const scorecard = buildQualificationScorecard(evidence);
const report = {
  ...scorecard,
  evaluatedReleaseRevision: evidence.qualificationManifest?.releaseRevision ?? null,
  evidenceHash: createHash('sha256').update(evidenceBytes).digest('hex'),
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `${report.status}/${report.activation}: ${report.reasons.join(', ') || 'all gates met'}`,
);
