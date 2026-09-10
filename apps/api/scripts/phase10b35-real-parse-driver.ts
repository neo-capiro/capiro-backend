/**
 * Phase 10B-35 -- real-document parse driver (evidence tooling, no DB, no AWS).
 *
 * Runs the REAL production parser handoff (`runParserHandoffForSourceDocument`:
 * real page profiler -> real route planner -> real Python engines via `uv run`
 * -> real R-2/R-2A segmenter + extractors -> real verifier) against a PDF and
 * writes:
 *   <out-dir>/<label>.extraction-v1.json   the full extraction artifact
 *   <out-dir>/<label>.summary.json         compact substantive summary
 *
 * Used to demonstrate, on the exact FY2024 Army R-2 Vol 1 BA1 source, that the
 * pre-fix R-2A path leaks the previous PE's project identity onto the next
 * PE's first R-2 page (physical pages 126/132/161/164) and that the repaired
 * path does not. Pair with `phase10b35-artifact-delta.ts` to diff two runs.
 *
 * Usage:
 *   tsx scripts/phase10b35-real-parse-driver.ts --pdf <path> --out-dir <dir> --label <name>
 *        [--sha256 <expected>] [--work-dir <dir>] [--component ARMY] [--fiscal-year 2024]
 *
 * Refuses to run if the parser runtime cannot construct the engines it needs
 * (`ENGINE_UNAVAILABLE` sentinel surfaces from the real router) -- a missing
 * OCR engine is reported as a driver failure, never silently degraded.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runParserHandoffForSourceDocument } from '../src/defense-budget/parser-router/source-document-parser-handoff.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../src/defense-budget/contracts/extraction-artifact-v1.js';
import { summarizeExtractionArtifactForPhase10b35 } from './lib/phase10b35-artifact-summary.js';

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const pdf = arg('pdf');
  const outDir = arg('out-dir');
  const label = arg('label');
  if (!pdf || !outDir || !label) {
    console.error('usage: --pdf <path> --out-dir <dir> --label <name> [--sha256 <expected>] [--work-dir <dir>]');
    process.exit(2);
  }
  if (!existsSync(pdf)) {
    console.error(`pdf not found: ${pdf}`);
    process.exit(2);
  }
  const bytes = readFileSync(pdf);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const expected = arg('sha256');
  if (expected && expected !== sha) {
    console.error(`source sha mismatch: expected ${expected}, got ${sha}`);
    process.exit(3);
  }
  const component = arg('component', 'ARMY') as 'ARMY';
  const fiscalYear = Number(arg('fiscal-year', '2024'));
  const workDir = arg('work-dir') ?? mkdtempSync(join(tmpdir(), `p10b35-${label}-`));
  mkdirSync(workDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const sourcePath = join(workDir, 'source.pdf');
  writeFileSync(sourcePath, bytes);
  const parserProjectDir = resolve(__dirname, '../..', 'defense-budget-parser');

  const startedAt = new Date().toISOString();
  const result = await runParserHandoffForSourceDocument({
    executionId: `phase10b35-${label}`,
    cycleId: `phase10b35-${label}`,
    sourceDocumentId: '1d20fc43-b6c0-4212-b6fd-aa95cbc3c342',
    sourcePath,
    sourceSha256: sha,
    sourceLocator:
      'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf',
    sourceUrl:
      'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf',
    sourceKey: '1d20fc43-b6c0-4212-b6fd-aa95cbc3c342',
    parserPolicy: 'deterministic_table',
    exhibitType: 'R-2',
    budgetFamily: 'rdte',
    fiscalYear,
    authority: 'dod-comptroller',
    component,
    budgetCycle: 'pb',
    documentType: 'r2',
    title: 'r2',
    workDir,
    persistVerificationAudit: false,
    allowPaidParse: false,
    maxPaidPages: 0,
    parserProjectDir,
  });
  const finishedAt = new Date().toISOString();

  const artifact = JSON.parse(readFileSync(result.outputPath, 'utf8')) as DefenseBudgetExtractionArtifactV1;
  const artifactOut = join(outDir, `${label}.extraction-v1.json`);
  writeFileSync(artifactOut, JSON.stringify(artifact, null, 2));
  const summary = {
    label,
    startedAt,
    finishedAt,
    decision: result.decision,
    finalState: result.finalState,
    sourceSha256: sha,
    artifactId: artifact.artifactId,
    contentSha256: artifact.contentSha256,
    parserRuns: artifact.parserRuns.map((r) => ({ method: r.method, pageRanges: r.pageRanges, succeeded: r.succeededPages?.length, failed: r.failedPages?.length })),
    ...summarizeExtractionArtifactForPhase10b35(artifact),
  };
  writeFileSync(join(outDir, `${label}.summary.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ artifactOut, decision: result.decision, finalState: result.finalState, totals: summary.totals }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
