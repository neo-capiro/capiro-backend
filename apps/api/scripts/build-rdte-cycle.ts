/**
 * build-rdte-cycle — manifest-driven Phase 4 RDT&E cycle build (WS N).
 *
 * Usage:
 *   pnpm --filter @capiro/api build:rdte-cycle -- \
 *     --manifest <fy-manifest.json> \
 *     --out <cycle-output-directory> \
 *     [--source-root <path>] \
 *     [--pages-dir <phase3-page-results-dir>] \
 *     [--allow-paid-parse --max-paid-pages N --paid-mode pdf_premium]
 *
 * Behavior:
 *   - validates the manifest;
 *   - computes source SHAs for real files;
 *   - consumes Phase 3 normalized page results (never re-parses; content-
 *     addressed replay) from --pages-dir (`<documentKey>.pages-v1.json`);
 *     fixture:// documents resolve through the built-in golden fixtures;
 *   - builds defense_budget_extraction_v1 artifacts per document;
 *   - runs cross-exhibit reconciliation + cycle certification;
 *   - produces the read-only projection plan when certified;
 *   - writes content-addressed artifacts/reports under --out;
 *   - performs NO canonical write and NO paid call by default.
 *
 * Paid escalation flags are forwarded ONLY when supplied and never weaken
 * the Phase 3 authorization contract; the default run is local/no-paid.
 *
 * Exit codes (plan §19):
 *   0 certified / successful inspect
 *   2 needs review
 *   3 incomplete
 *   4 rejected
 *   5 operational/configuration failure
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseBudgetCycleManifestV1,
  validateBudgetCycleManifestV1,
} from '../src/defense-budget/contracts/budget-cycle-manifest-v1.js';
import { defenseBudgetExtractionArtifactV1Schema } from '../src/defense-budget/contracts/extraction-artifact-v1.js';
import type { ParserPageResultV1 } from '../src/defense-budget/parser-router/parser-runtime-contract-v1.js';
import { runRdteCyclePipeline } from '../src/defense-budget/rdte/cycle/rdte-cycle-pipeline-v1.js';
import {
  goldenPagesByKey,
  goldenSource,
} from '../src/defense-budget/rdte/cycle/rdte-golden-cycle-v1.js';
import { planRdteCanonicalProjection } from '../src/defense-budget/rdte/projection/rdte-projection-planner-v1.js';
import type { RdteCycleVerificationRefV1 } from '../src/defense-budget/rdte/rdte-cycle-bundle-v1.js';

const EXIT_OK = 0;
const EXIT_NEEDS_REVIEW = 2;
const EXIT_INCOMPLETE = 3;
const EXIT_REJECTED = 4;
const EXIT_ERROR = 5;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function computeFileSha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function main(): void {
  const manifestPath = argValue('manifest');
  const outDir = argValue('out');
  const sourceRoot = argValue('source-root');
  const pagesDir = argValue('pages-dir');
  const allowPaidParse = hasFlag('allow-paid-parse');
  const maxPaidPages = argValue('max-paid-pages');
  const paidMode = argValue('paid-mode');
  const verificationsPath = argValue('verifications');

  if (!manifestPath || !outDir) {
    console.error(
      'Usage: build-rdte-cycle.ts --manifest <manifest.json> --out <dir> ' +
        '[--source-root <dir>] [--pages-dir <dir>] [--verifications <refs.json>] ' +
        '[--allow-paid-parse --max-paid-pages N --paid-mode pdf_premium]',
    );
    process.exit(EXIT_ERROR);
  }
  if (allowPaidParse && (!maxPaidPages || Number(maxPaidPages) <= 0)) {
    console.error('--allow-paid-parse requires --max-paid-pages <positive integer>');
    process.exit(EXIT_ERROR);
  }
  if (!fs.existsSync(manifestPath)) {
    console.error(`manifest not found: ${manifestPath}`);
    process.exit(EXIT_ERROR);
  }

  /* 1. Validate manifest. */
  let manifest;
  try {
    manifest = parseBudgetCycleManifestV1(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  } catch (err) {
    console.error(`manifest validation failed: ${(err as Error).message}`);
    process.exit(EXIT_ERROR);
    return;
  }
  const findings = validateBudgetCycleManifestV1(manifest);
  const errors = findings.filter((f) => f.severity === 'error');
  if (errors.length > 0) {
    for (const f of errors) console.error(`manifest error ${f.path}: ${f.message}`);
    process.exit(EXIT_ERROR);
  }
  const manifestContentSha256 = createHash('sha256')
    .update(fs.readFileSync(manifestPath))
    .digest('hex');

  /* 2. Resolve per-document page results + sources. */
  const goldenPages = goldenPagesByKey();
  const documents = [];
  const verifications: RdteCycleVerificationRefV1[] = [];
  const suppliedVerifications = new Map<string, RdteCycleVerificationRefV1>();
  if (verificationsPath != null) {
    if (!fs.existsSync(verificationsPath)) {
      console.error(`verifications file not found: ${verificationsPath}`);
      process.exit(EXIT_ERROR);
    }
    const parsed = JSON.parse(fs.readFileSync(verificationsPath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) {
      console.error('--verifications must be a JSON array of verification references');
      process.exit(EXIT_ERROR);
    }
    for (const entry of parsed as RdteCycleVerificationRefV1[]) {
      suppliedVerifications.set(entry.manifestDocumentKey, entry);
    }
  }
  for (const doc of manifest.documents) {
    let pages: readonly ParserPageResultV1[];
    let sourceSha256: string;

    if (doc.sourceLocator.startsWith('fixture://')) {
      const fixturePages = goldenPages[doc.documentKey];
      if (fixturePages == null) {
        console.error(`no golden fixture for fixture document ${doc.documentKey}`);
        process.exit(EXIT_ERROR);
      }
      pages = fixturePages;
      sourceSha256 = goldenSource(doc.documentKey).sourcePdfSha256;
    } else if (pagesDir != null) {
      const pagesPath = path.join(pagesDir, `${doc.documentKey}.pages-v1.json`);
      if (!fs.existsSync(pagesPath)) {
        console.error(
          `missing Phase 3 page results for ${doc.documentKey}: ${pagesPath}\n` +
            '  run Phase 3 first: pnpm --filter @capiro/api extract:defense-budget-cycle ' +
            '(local/no-paid by default)',
        );
        process.exit(EXIT_ERROR);
      }
      pages = JSON.parse(fs.readFileSync(pagesPath, 'utf8')) as ParserPageResultV1[];
      const realSourcePath =
        sourceRoot != null
          ? path.join(sourceRoot, path.basename(doc.sourceLocator))
          : doc.sourceLocator;
      if (!fs.existsSync(realSourcePath)) {
        console.error(`missing source PDF for ${doc.documentKey}: ${realSourcePath}`);
        process.exit(EXIT_ERROR);
      }
      sourceSha256 = computeFileSha256(realSourcePath);
      if (doc.expectedSourceSha256 != null && doc.expectedSourceSha256 !== sourceSha256) {
        console.error(
          `source SHA mismatch for ${doc.documentKey}: expected ${doc.expectedSourceSha256}, got ${sourceSha256}`,
        );
        process.exit(EXIT_ERROR);
      }
    } else {
      console.error(
        `document ${doc.documentKey} requires Phase 3 page results: pass --pages-dir <dir> ` +
          `or use a fixture:// source locator for rehearsals`,
      );
      process.exit(EXIT_ERROR);
      return;
    }

    const source = {
      manifestDocumentKey: doc.documentKey,
      sourcePdfSha256: sourceSha256,
      sourceLocator: doc.sourceLocator,
      ...(doc.sourceUrl != null ? { sourceUrl: doc.sourceUrl } : {}),
      fiscalYear: manifest.fiscalYear,
      family: doc.family,
      exhibit: doc.exhibit,
      authority: doc.authority,
      component: doc.component,
      budgetCycle: doc.budgetCycle,
      documentType: doc.documentType,
    };
    documents.push({ document: doc, source, pages });

    /* Phase 2 verification reference. fixture:// documents carry a
     * deterministic fixture reference (documented rehearsal mode). Real
     * documents must be verified with the inspect-mode Phase 2 command
     * (verify-defense-budget-extraction-v1.ts) and their references passed
     * via --verifications <refs.json>; without one they are marked
     * NEEDS_REVIEW so certification fails closed. */
    const supplied = suppliedVerifications.get(doc.documentKey);
    if (supplied != null) {
      verifications.push(supplied);
    } else if (doc.sourceLocator.startsWith('fixture://')) {
      verifications.push({
        manifestDocumentKey: doc.documentKey,
        artifactId: `fixture_artifact_${doc.documentKey}`,
        verificationCandidateId: `fixture_candidate_${doc.documentKey}`,
        verificationRunId: `fixture_run_${doc.documentKey}`,
        decision: 'VERIFICATION_PASSED',
        decisionId: `fixture_decision_${doc.documentKey}`,
      });
    } else {
      verifications.push({
        manifestDocumentKey: doc.documentKey,
        artifactId: `pending_${doc.documentKey}`,
        verificationCandidateId: `pending_candidate_${doc.documentKey}`,
        verificationRunId: `pending_run_${doc.documentKey}`,
        decision: 'NEEDS_REVIEW',
        decisionId: `pending_decision_${doc.documentKey}`,
      });
    }
  }

  /* 3. Run the pure pipeline. */
  const result = runRdteCyclePipeline({
    cycleIdIdentity: { cycleId: manifest.cycleId, fiscalYear: manifest.fiscalYear },
    fiscalYear: manifest.fiscalYear,
    manifestContentSha256,
    documents,
    verifications,
  });

  /* 4. Projection plan when certified. */
  let projectionPlan = null;
  if (result.certification === 'CERTIFIED_RDTE_READY_FOR_PROJECTION') {
    const planned = planRdteCanonicalProjection({
      bundle: result.bundle,
      artifacts: result.artifacts.map((a) => a.artifact),
    });
    projectionPlan = planned.plan;
  }

  /* 5. Write content-addressed outputs. */
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, 'artifacts'), { recursive: true });
  for (const { documentKey, artifact } of result.artifacts) {
    const parsed = defenseBudgetExtractionArtifactV1Schema.parse(artifact);
    fs.writeFileSync(
      path.join(outDir, 'artifacts', `${documentKey}.extraction-v1.json`),
      JSON.stringify(parsed, null, 2),
    );
  }
  fs.writeFileSync(path.join(outDir, 'cycle-bundle.json'), JSON.stringify(result.bundle, null, 2));
  if (projectionPlan != null) {
    fs.writeFileSync(
      path.join(outDir, 'projection-plan.json'),
      JSON.stringify(projectionPlan, null, 2),
    );
  }
  fs.writeFileSync(
    path.join(outDir, 'build-summary.json'),
    JSON.stringify(
      {
        cycleId: result.bundle.cycleId,
        fiscalYear: result.bundle.fiscalYear,
        certification: result.certification,
        reason: result.reason,
        counts: result.counts,
        artifacts: result.artifacts.map((a) => ({
          documentKey: a.documentKey,
          artifactId: a.artifact.artifactId,
          contentSha256: a.artifact.contentSha256,
        })),
        bundleContentSha256: result.bundle.contentSha256,
        projectionPlanContentSha256: projectionPlan?.contentSha256 ?? null,
        allowPaidParse,
        paidMode: paidMode ?? null,
        maxPaidPages: maxPaidPages != null ? Number(maxPaidPages) : null,
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ certification: result.certification, reason: result.reason }));

  switch (result.certification) {
    case 'CERTIFIED_RDTE_READY_FOR_PROJECTION':
      process.exit(EXIT_OK);
      break;
    case 'NEEDS_REVIEW':
      process.exit(EXIT_NEEDS_REVIEW);
      break;
    case 'INCOMPLETE':
      process.exit(EXIT_INCOMPLETE);
      break;
    case 'REJECTED':
      process.exit(EXIT_REJECTED);
      break;
  }
}

main();
