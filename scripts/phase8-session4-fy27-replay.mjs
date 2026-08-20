#!/usr/bin/env node
/**
 * Dual-path FY27 inspect replay for Phase 8 Session 4.
 *
 * Prefer compiled defense-api dist modules (after `pnpm --filter @capiro/defense-api build`).
 * Resolves monorepo root from cwd so filter-package execution works.
 *
 * No AWS, no DB, no promotion execution, no parser-worker credentials.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

function resolveRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (
      fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')) &&
      fs.existsSync(path.join(dir, 'apps', 'defense-api'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

const root = resolveRepoRoot();
const require = createRequire(path.join(root, 'package.json'));

function loadCompiled(relFromDefenseApiDist) {
  const candidates = [
    path.join(root, 'apps/defense-api/dist', relFromDefenseApiDist),
    path.join(root, 'apps/defense-api/dist/src', relFromDefenseApiDist),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c);
  }
  throw new Error(
    `Missing compiled module ${relFromDefenseApiDist}. Run: pnpm --filter @capiro/defense-api build`,
  );
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '0'.repeat(40);
  }
}

function sha256File(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function stageHashMap(result) {
  const out = {};
  for (const a of result.artifacts) out[a.stage] = a.sha256;
  return out;
}

async function main() {
  const outRel =
    process.argv.includes('--out')
      ? process.argv[process.argv.indexOf('--out') + 1]
      : 'docs/defense-budget/phase8-session4-fy27-replay-evidence.json';
  const outPath = path.join(root, outRel);

  const adaptersMod = loadCompiled('runtime/phase1-7-runtime.adapters.js');
  const contractMod = loadCompiled('runtime/phase1-7-runtime.contract.js');
  const {
    PHASE17_FY27_FIXTURE_SLICES,
    createPhase17RuntimeAdapters,
    defaultFy27InspectInput,
  } = adaptersMod;
  const { Phase17RuntimeCoordinator } = contractMod;

  const sourceDocIds = [];
  let unexplained = 0;
  const notes = [];
  for (const [stage, rel] of Object.entries(PHASE17_FY27_FIXTURE_SLICES)) {
    const retained = path.join(root, 'apps/api/src', rel);
    const moved = path.join(root, 'apps/defense-api/runtime-source', rel);
    if (!fs.existsSync(retained) || !fs.existsSync(moved)) {
      unexplained += 1;
      notes.push(`missing fixture for ${stage}: ${rel}`);
      continue;
    }
    const a = fs.readFileSync(retained);
    const b = fs.readFileSync(moved);
    if (!a.equals(b)) {
      unexplained += 1;
      notes.push(`byte drift for ${stage}: ${rel}`);
    }
    sourceDocIds.push(`${stage}:${rel}`);
  }

  const manifestPath = path.join(
    root,
    'apps/defense-api/runtime-source/defense-budget/contracts/__fixtures__/cycle-manifest-minimal.json',
  );
  const sourceSha = sha256File(manifestPath);
  const input = defaultFy27InspectInput(sourceSha);

  const retainedResult = await new Phase17RuntimeCoordinator(
    createPhase17RuntimeAdapters({ root: 'retained', repoRoot: root }),
  ).inspect(input);
  const movedResult = await new Phase17RuntimeCoordinator(
    createPhase17RuntimeAdapters({ root: 'moved', repoRoot: root }),
  ).inspect(input);

  const rMap = stageHashMap(retainedResult);
  const mMap = stageHashMap(movedResult);
  const compare = (stage) => rMap[stage] === mMap[stage];

  const checks = {
    sameSourceSha:
      compare('source_profile') && retainedResult.sourceDocumentId === movedResult.sourceDocumentId,
    sameParserIdentity:
      input.parserProvider === 'deterministic-fixture' &&
      input.parserVersion === 'pinned-v1' &&
      compare('parser_artifact'),
    sameExtractionHash: compare('semantic_extraction'),
    sameVerificationDecisionHash: compare('phase2_verification'),
    sameProjectionPlanHash: compare('projection_plan'),
    sameCertificationHash: compare('phase6_certification'),
    sameEligibilityHash: compare('phase7_eligibility'),
    samePromotionInspectionHash: compare('promotion_inspection'),
  };

  for (const [k, v] of Object.entries(checks)) {
    if (!v) {
      unexplained += 1;
      notes.push(`hash mismatch: ${k}`);
    }
  }
  if (retainedResult.lineageSha256 !== movedResult.lineageSha256) {
    unexplained += 1;
    notes.push('lineageSha256 mismatch between retained and moved');
  }
  if (
    retainedResult.canonicalMutationAttempted !== false ||
    movedResult.canonicalMutationAttempted !== false
  ) {
    unexplained += 1;
    notes.push('canonicalMutationAttempted was not false');
  }

  const head = gitSha();
  const evidence = {
    schemaVersion: 1,
    fiscalYear: 2027,
    sourceDocumentIds: sourceDocIds,
    sameSourceSha: checks.sameSourceSha === true,
    sameParserIdentity: checks.sameParserIdentity === true,
    sameExtractionHash: checks.sameExtractionHash === true,
    sameVerificationDecisionHash: checks.sameVerificationDecisionHash === true,
    sameProjectionPlanHash: checks.sameProjectionPlanHash === true,
    sameCertificationHash: checks.sameCertificationHash === true,
    sameEligibilityHash: checks.sameEligibilityHash === true,
    samePromotionInspectionHash: checks.samePromotionInspectionHash === true,
    unexplainedDifferences: unexplained,
    canonicalMutationAttempted: false,
    legacyGitSha: head,
    defenseApiGitSha: head,
    recordedAt: new Date().toISOString(),
    notes: [
      'Dual-path inspect-only replay over immutable FY27 fixture slices.',
      'Retained root: apps/api/src/defense-budget',
      'Moved root: apps/defense-api/runtime-source/defense-budget',
      `retainedLineage=${retainedResult.lineageSha256}`,
      `movedLineage=${movedResult.lineageSha256}`,
      'No parser-worker/GPU credentials used. No promotion executed. No DB writes.',
      ...notes,
    ],
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`[phase8-session4-fy27-replay] wrote ${outRel}`);
  console.log(
    JSON.stringify(
      { unexplainedDifferences: unexplained, lineage: retainedResult.lineageSha256 },
      null,
      2,
    ),
  );
  if (unexplained !== 0) {
    console.error('[phase8-session4-fy27-replay] FAILED');
    process.exit(1);
  }
  console.log('[phase8-session4-fy27-replay] PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
