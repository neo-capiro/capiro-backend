/**
 * plan-defense-budget-parse — deterministic parse plan CLI.
 *
 *   pnpm --filter @capiro/api plan:defense-budget-parse -- \
 *     --manifest <manifest.json> \
 *     --document <document-key> \
 *     --source <local.pdf> \
 *     --profile <profile.json> \
 *     --out <plan.json>
 *
 * Behavior (M2):
 *   - Prints local engine/page plan.
 *   - Pages that may later require OCR.
 *   - paidAuthorizationRequired=false for initial plan.
 *   - Expected parser runtime target.
 *   - No parser execution.
 *
 * Exit codes (M9): 0 success, 2 argument failure, 3 source failure, 9 internal.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { parseBudgetCycleManifestV1 } from '../src/defense-budget/contracts/budget-cycle-manifest-v1.js';
import { buildInitialParsePlan } from '../src/defense-budget/parser-router/route-planner.js';
import type { PageProfileV1 } from '../src/defense-budget/parser-router/page-profiler.js';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function computeFileSha256(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

function main(): void {
  const manifestPath = argValue('manifest');
  const documentKey = argValue('document');
  const sourcePath = argValue('source');
  const profilePath = argValue('profile');
  const outPath = argValue('out');

  if (!manifestPath || !documentKey || !sourcePath || !profilePath || !outPath) {
    console.error(
      'Usage: plan-defense-budget-parse.ts --manifest <manifest.json> --document <key> --source <local.pdf> --profile <profile.json> --out <plan.json>',
    );
    process.exit(2);
  }

  // Validate manifest
  let manifest;
  try {
    manifest = parseBudgetCycleManifestV1(
      JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    );
  } catch (e) {
    console.error(`Manifest validation failed: ${(e as Error).message}`);
    process.exit(2);
    return;
  }

  const docEntry = manifest.documents.find(
    (d: { documentKey: string }) => d.documentKey === documentKey,
  );
  if (!docEntry) {
    console.error(`Document '${documentKey}' not found in manifest.`);
    process.exit(2);
  }

  // Compute source SHA
  if (!fs.existsSync(sourcePath)) {
    console.error(`Source file not found: ${sourcePath}`);
    process.exit(3);
  }
  const actualSha = computeFileSha256(sourcePath);

  // Load profile
  let profileData;
  try {
    profileData = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch (e) {
    console.error(`Cannot read profile: ${(e as Error).message}`);
    process.exit(3);
    return;
  }

  const pageProfiles: PageProfileV1[] = profileData.pages ?? [];
  const requestedPages = pageProfiles.map((p) => p.page);
  const parserPolicy =
    (docEntry as Record<string, unknown>)['parserPolicy'] ?? 'deterministic_table';

  // Build plan
  const plan = buildInitialParsePlan({
    executionId: `plan-${documentKey}-${Date.now()}`,
    cycleId: manifest.cycleId,
    manifestDocumentKey: documentKey,
    sourceSha256: actualSha,
    parserPolicy: parserPolicy as 'deterministic_table' | 'mixed_layout' | 'ocr' | 'complex' | 'native_structured',
    pageProfiles,
  });

  // Write plan
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');

  // Print summary
  console.log(`Plan written: ${outPath}`);
  console.log(`Plan SHA-256: ${plan.planSha256}`);
  console.log(`Steps: ${plan.steps.length}`);
  for (const step of plan.steps) {
    console.log(
      `  ${step.ordinal}: ${step.engine} pages=[${step.pages.join(',')}] paid=${step.paid}`,
    );
  }
  console.log(`Paid authorization required: ${plan.paidAuthorizationRequired}`);
  console.log(`Unresolved pages: [${plan.unresolvedPages.join(',')}]`);

  // Identify pages that may later require OCR
  const ocrPages = pageProfiles
    .filter((p) => p.likelyImageOnly || p.likelyRotated)
    .map((p) => p.page);
  if (ocrPages.length > 0) {
    console.log(`Pages that may later require OCR: [${ocrPages.join(',')}]`);
  }

  // Expected runtime target
  const hasDocling = plan.steps.some((s) => s.engine === 'docling');
  const hasOcr = plan.steps.some((s) => s.engine === 'paddleocr');
  const target = hasOcr ? 'ocr' : hasDocling ? 'layout' : 'table';
  console.log(`Expected parser runtime target: ${target}`);

  process.exit(0);
}

const invokedDirectly =
  process.argv[1] != null &&
  process.argv[1].endsWith('plan-defense-budget-parse.ts');
if (invokedDirectly) {
  main();
}
