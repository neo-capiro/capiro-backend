import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildQualificationScorecard } from '../dist/qualification/scorecard.js';

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
