/** @cleanup-smoke noArgsExit=0 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

console.error('Usage: node scripts/verify-research-portfolios-phases9-11.mjs (no arguments run the verifier)');
if (process.argv.length > 2) process.exit(2);

const root = process.cwd();
const failures = [];

function read(relativePath) {
  const path = resolve(root, relativePath);
  if (!existsSync(path)) {
    failures.push(`missing file: ${relativePath}`);
    return '';
  }
  return readFileSync(path, 'utf8');
}

function requireText(text, needle, label) {
  if (!text.includes(needle)) failures.push(`${label}: missing ${JSON.stringify(needle)}`);
}

function requireIdsExactlyOnce(text, ids, label) {
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const count = (text.match(new RegExp(`\\|\\s*${escaped}\\s*\\|`, 'g')) ?? []).length;
    if (count !== 1) failures.push(`${label}: ${id} appears in ${count} table rows (expected 1)`);
  }
}

const requirementIds = [
  ...Array.from({ length: 10 }, (_, i) => `RP-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 11 }, (_, i) => `DI-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 3 }, (_, i) => `MX-${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 4 }, (_, i) => `OP-${String(i + 1).padStart(2, '0')}`),
];
const screenIds = Array.from({ length: 18 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
const acceptanceIds = Array.from({ length: 24 }, (_, i) => `AT-${String(i + 1).padStart(2, '0')}`);

const readme = read('docs/research-portfolios/phase11/README.md');
const register = read('docs/research-portfolios/phase11/requirements-and-screens.md');
const acceptance = read('docs/research-portfolios/phase11/acceptance-results.md');
const controls = read('docs/research-portfolios/phase11/release-controls.md');

requireIdsExactlyOnce(register, requirementIds, 'requirement register');
requireIdsExactlyOnce(register, screenIds, 'screen register');
requireIdsExactlyOnce(acceptance, acceptanceIds, 'acceptance register');

for (const [label, text] of [
  ['README', readme],
  ['acceptance results', acceptance],
  ['release controls', controls],
]) {
  requireText(text, 'NO-GO', label);
}
requireText(controls, 'Enabled customer cohort: **NONE**', 'release controls');
requireText(controls, 'No deployment occurred', 'release controls');
requireText(acceptance, 'F01–F42', 'acceptance results');
requireText(acceptance, 'V4-01–V4-15', 'acceptance results');

const acceptanceRows = acceptance
  .split(/\r?\n/)
  .filter((line) => /^\| AT-\d{2} \|/.test(line));
for (const row of acceptanceRows) {
  const status = row.split('|')[2]?.trim();
  if (!['NOT RUN', 'BLOCKED', 'OUT OF COHORT', 'FAILED'].includes(status)) {
    failures.push(`acceptance row has unsupported/unsubstantiated status ${JSON.stringify(status)}: ${row}`);
  }
}

const sourceChecks = [
  ['apps/api/prisma/migrations/20281001010000_research_portfolios_phase9_analytics_outputs/migration.sql', ['research_portfolio_snapshots', 'research_portfolio_output_jobs', 'research_portfolio_subscriptions']],
  ['apps/api/src/research-portfolios/research-portfolio-analytics.service.ts', ['contribution', 'createSnapshot']],
  ['apps/api/src/research-portfolios/research-portfolio-output.service.ts', ['ClientDocumentWriterService', 'outcome_unknown']],
  ['apps/api/src/research-portfolios/research-portfolio-changes.service.ts', ['subscription', 'baselineRevision']],
  ['apps/api/src/research-portfolios/research-portfolios.controller.ts', ["@Get(':id/analytics')", "@Post(':id/outputs')", "@Get(':id/changes')"]],
  ['packages/shared/src/research-portfolios.ts', ['ResearchPortfolioAnalyticsDto', 'ResearchPortfolioSnapshotDto', 'ResearchPortfolioOutputJobDto']],
  ['packages/shared/src/index.ts', ['MERI_CAPABILITY_REGISTRY']],
  ['apps/api/src/meri/meri-tools.service.ts', ['MERI_CAPABILITY_REGISTRY']],
];

for (const [path, markers] of sourceChecks) {
  const source = read(path);
  for (const marker of markers) requireText(source, marker, path);
}

if (failures.length > 0) {
  console.error('LOCAL QUALIFICATION PACKET: FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`LOCAL QUALIFICATION PACKET: PASS (${requirementIds.length} requirements, ${screenIds.length} screens, ${acceptanceIds.length} acceptance scenarios)`);
  console.log('RELEASE VERDICT: NO-GO (deployment, production, real-corpus, independent-label, economics, and rollback gates are not run or blocked)');
}
