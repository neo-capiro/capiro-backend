/**
 * report-rdte-cycle — print machine-readable JSON + a concise human summary
 * of a built RDT&E cycle output directory (WS N).
 *
 * Usage:
 *   pnpm --filter @capiro/api report:rdte-cycle -- --cycle-dir <out>
 *
 * Read-only: reads cycle-bundle.json, build-summary.json, and artifacts from
 * the cycle output directory produced by build-rdte-cycle. Exit 0 when the
 * report is printed, 5 on operational failure.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rdteCycleBundleV1Schema } from '../src/defense-budget/rdte/rdte-cycle-bundle-v1.js';

const EXIT_OK = 0;
const EXIT_ERROR = 5;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const cycleDir = argValue('cycle-dir');
  if (!cycleDir) {
    console.error('Usage: report-rdte-cycle.ts --cycle-dir <cycle-output-directory>');
    process.exit(EXIT_ERROR);
  }

  const bundlePath = path.join(cycleDir, 'cycle-bundle.json');
  const summaryPath = path.join(cycleDir, 'build-summary.json');
  if (!fs.existsSync(bundlePath)) {
    console.error(`cycle bundle not found: ${bundlePath}`);
    process.exit(EXIT_ERROR);
  }

  const bundle = rdteCycleBundleV1Schema.parse(JSON.parse(fs.readFileSync(bundlePath, 'utf8')));
  const buildSummary = fs.existsSync(summaryPath)
    ? (JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as Record<string, unknown>)
    : null;

  const decisionCounts = new Map<string, number>();
  for (const verification of bundle.verifications) {
    decisionCounts.set(
      verification.decision,
      (decisionCounts.get(verification.decision) ?? 0) + 1,
    );
  }

  const report = {
    cycleId: bundle.cycleId,
    fiscalYear: bundle.fiscalYear,
    certification: bundle.certification,
    documents: {
      expected: bundle.sourceDocuments.length,
      supplied: bundle.artifacts.length,
      required: bundle.sourceDocuments.filter((d) => d.required).length,
    },
    artifactsBuilt: bundle.artifacts.length,
    verificationDecisions: Object.fromEntries(decisionCounts),
    coverage: bundle.coverage.map((entry) => ({
      category: entry.category,
      status: entry.status,
      numerator: entry.numerator,
      denominator: entry.denominator,
      missingKeys: entry.missingKeys,
    })),
    reconciliation: {
      comparisons: bundle.comparisons.length,
      comparisonResults: Object.fromEntries(
        bundle.comparisons.reduce((acc, comparison) => {
          acc.set(comparison.result, (acc.get(comparison.result) ?? 0) + 1);
          return acc;
        }, new Map<string, number>()),
      ),
    },
    findings: {
      blocking: bundle.blockingFindings.length,
      nonBlocking: bundle.nonBlockingFindings.length,
    },
    counts: buildSummary?.counts ?? null,
    projectionPlanContentSha256: bundle.projectionPlanContentSha256 ?? null,
    bundleContentSha256: bundle.contentSha256,
  };

  console.log(JSON.stringify(report, null, 2));

  /* Human summary on stderr (stdout stays machine-readable). */
  const lines = [
    `RDT&E cycle ${bundle.cycleId} (FY${bundle.fiscalYear})`,
    `  certification: ${bundle.certification}`,
    `  documents: ${report.documents.supplied}/${report.documents.expected} supplied (${report.documents.required} required)`,
    `  verification: ${[...decisionCounts.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    `  coverage: ${bundle.coverage.map((c) => `${c.category}:${c.status}`).join(', ') || 'n/a'}`,
    `  findings: ${bundle.blockingFindings.length} blocking / ${bundle.nonBlockingFindings.length} review`,
    `  bundle sha256: ${bundle.contentSha256}`,
  ];
  console.error(lines.join('\n'));
  process.exit(EXIT_OK);
}

main();
