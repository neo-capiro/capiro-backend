/**
 * Phase 10B-31 -- automated RED/GREEN mutation check for the lifecycle-bridge
 * SourceDocument metadata-agreement fix.
 *
 * `verify:pe-budget-phase-10b31`'s jest half already proves the fix is GREEN
 * on today's source. That alone cannot prove the test is actually SENSITIVE
 * to the fix -- a suite that would pass identically against the old, buggy
 * code is not a regression, it is a tautology. This script proves sensitivity
 * for real: it reverts the exact 9 Stage 2 source files to their content at
 * the pre-fix baseline commit (read via `git show`, never hand-retyped), runs
 * `lifecycle-bridge-source-metadata-agreement.integration.spec.ts` UNMODIFIED
 * against that reverted source and requires the SPECIFIC tests that exercise
 * the fix to FAIL, restores the exact current bytes, and requires the whole
 * file GREEN again. Two tests are asserted to remain green in BOTH states
 * (the null-component guard and pure candidate-identity idempotency were
 * already correct pre-fix, per the Stage 2 field-mapping investigation, so a
 * revert must not touch them) -- if either of those instead turned red, or if
 * any of the 7 fix-sensitive tests stayed green under the revert, that is
 * itself reported as a finding: either this script's file list has drifted
 * from the real fix, or the fix is not doing what it claims.
 *
 * Uses the SAME crash-safe `SourceMutationJournal` the Phase 6/7 negative-
 * control runners use, so a killed run (external timeout, Ctrl-C) leaves a
 * journal that the next invocation restores from and reports loudly, never a
 * silently-reverted file sitting in the tracked tree. See
 * `scripts/lib/source-mutation-journal.ts` for why that matters.
 *
 * Requires DATABASE_URL to name a LOCAL disposable Postgres (see docs:
 * pgvector/pgvector:pg16, database `capiro`, `prisma migrate deploy` against
 * BOTH prisma/schema.prisma and prisma/phase6-projection/schema.prisma) --
 * refuses to run against anything else. Also requires the
 * apps/defense-budget-parser Python runtime pre-synced (`uv sync --locked`
 * there). The spec file manages its own scratch
 * BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT and DEFENSE_BUDGET_PARSER_PROJECT_DIR
 * per run (see its own `beforeAll`); this script does not need to set either.
 *
 * This script makes ZERO AWS calls (every SourceDocument row the spec it
 * drives creates carries no archive fields, so `ArchiveProofResolver` never
 * reaches an S3 client -- see that spec's own file header) and ZERO
 * production-database calls (DATABASE_URL is required to be local). The only
 * side effects are: writing/restoring 9 tracked files in THIS worktree
 * (verified byte-for-byte restored before exit), and rows in the local
 * disposable Postgres the jest spec itself creates.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SourceMutationJournal } from './lib/source-mutation-journal.js';

const API_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');
const BASELINE_REV = '8c4735e6b'; // origin/main immediately before Phase 10B-31 Stage 2's fix.
const SPEC_RELATIVE_TO_API = 'src/defense-budget/verification/persistence/lifecycle-bridge-source-metadata-agreement.integration.spec.ts';
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** The exact 9 source files (never test files) Stage 2's fix touched, repo-root-relative. */
const FIX_FILES = [
  'apps/api/src/defense-budget/contracts/budget-cycle-manifest-v1.ts',
  'apps/api/src/defense-budget/default-parser-handoff.adapter.ts',
  'apps/api/src/defense-budget/observation-ingestion-bridge.ports.ts',
  'apps/api/src/defense-budget/observation-ingestion-bridge.service.ts',
  'apps/api/src/defense-budget/parser-router/source-document-parser-handoff.ts',
  'apps/api/src/defense-budget/prisma-observation-bridge.store.ts',
  'apps/api/src/defense-budget/verification/services/budget-verification-v1.service.ts',
  'apps/api/src/defense-budget/verification/persistence/prisma-budget-verification.repository.ts',
  'apps/api/src/defense-budget/verification/trusted-proof/composite-proof-resolver.ts',
];

/**
 * Every test title in the spec, and whether it is expected to turn RED when
 * the 9 files above are reverted. The 2 expected to stay green exercise
 * invariants the Stage 2 field-mapping investigation traced as ALREADY
 * correct pre-fix (the null-component guard; pure candidateIdentity-hash
 * idempotency) -- a revert must not disturb either.
 */
const EXPECTED_RED_WHEN_REVERTED: Record<string, boolean> = {
  'a SourceDocument whose sourceKey/component/fiscalYear/sha256 all genuinely match the manifest shows NO metadata-agreement finding, and persists under the raw lifecycle cycle UUID': true,
  'a different, genuinely-registered component (NAVY, not ARMY) and a different fiscal year (2026, not 2024) exercise the same generic repair path successfully': true,
  'a null component (legitimate all-component/committee document) is never coerced into a false mismatch': false,
  'component mismatch: the persisted row disagrees with what the handoff declares': true,
  'identity/locator (sourceKey) mismatch: the persisted row disagrees with what the handoff declares': true,
  'fiscal year mismatch: the persisted row disagrees with what the handoff declares': true,
  'hash mismatch: the persisted SourceDocument.sha256 disagrees with the real, resolved artifactPath bytes': true,
  'an identical repeat of the same scenario is a true idempotent replay: same candidate, same run, no duplicate rows': false,
  'reprocessing the same observation with corrected metadata does not overwrite the prior (historically rejected-for-mismatch) evidence, and creates no invalid duplicate association': true,
};

interface JestAssertion {
  title: string;
  status: 'passed' | 'failed' | 'pending' | 'todo' | 'disabled';
  fullName: string;
}
interface JestJsonResult {
  success: boolean;
  numTotalTests: number;
  testResults: Array<{ assertionResults: JestAssertion[]; message?: string }>;
}

function requireLocalDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. This script requires a LOCAL disposable Postgres ' +
        '(pgvector/pgvector:pg16, database `capiro`, both prisma schemas migrated).',
    );
  }
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`DATABASE_URL "${url}" is not a valid URL.`);
  }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
    throw new Error(
      `DATABASE_URL host "${hostname}" is not local. Refusing to run this mutation check ` +
        'against anything but a local disposable database.',
    );
  }
  return url;
}

function gitShow(rev: string, relPath: string): Buffer {
  const result = spawnSync('git', ['show', `${rev}:${relPath}`], {
    cwd: REPO_ROOT,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.status !== 0) {
    throw new Error(
      `git show ${rev}:${relPath} failed: ${(result.stderr ?? Buffer.from('')).toString('utf8')}`,
    );
  }
  return result.stdout;
}

function runSpec(): JestJsonResult {
  const outputFile = path.join(API_ROOT, `.phase10b31-mutation-jest-output-${Date.now()}.json`);
  try {
    spawnSync(
      process.execPath,
      [
        path.join(API_ROOT, 'node_modules', 'jest', 'bin', 'jest.js'),
        '--runInBand',
        '--forceExit',
        '--silent',
        `--json`,
        `--outputFile=${outputFile}`,
        SPEC_RELATIVE_TO_API,
      ],
      { cwd: API_ROOT, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES },
    );
    if (!fs.existsSync(outputFile)) {
      throw new Error('jest did not produce a --json output file (did the spec file fail to load at all?)');
    }
    return JSON.parse(fs.readFileSync(outputFile, 'utf8')) as JestJsonResult;
  } finally {
    fs.rmSync(outputFile, { force: true });
  }
}

function assertionsByTitle(result: JestJsonResult): Map<string, JestAssertion> {
  const map = new Map<string, JestAssertion>();
  for (const file of result.testResults) {
    for (const assertion of file.assertionResults) {
      map.set(assertion.title, assertion);
    }
  }
  return map;
}

function main(): void {
  requireLocalDatabaseUrl();

  // Matches the repo's existing `.p*-nc-restore/` gitignore pattern (see
  // root .gitignore) shared with the Phase 6/7 negative-control runners.
  const journal = new SourceMutationJournal({ root: REPO_ROOT, directoryName: '.p10b31-nc-restore' });
  const recovered = journal.recoverAbandoned();
  if (recovered.length > 0) {
    console.error(
      `Recovered ${recovered.length} file(s) abandoned by a previous killed run before continuing.`,
    );
  }

  const currentBytes = new Map<string, Buffer>();
  for (const relPath of FIX_FILES) {
    const absolute = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(absolute)) throw new Error(`fix file missing: ${relPath}`);
    currentBytes.set(relPath, fs.readFileSync(absolute));
  }

  console.error('Phase 10B-31 metadata-regression mutation check: reverting 9 files to pre-fix baseline...');
  let redResult: JestJsonResult | null = null;
  let restoredCleanly = false;
  try {
    for (const relPath of FIX_FILES) {
      journal.record('phase10b31-metadata-fix', relPath, currentBytes.get(relPath)!);
      const baseline = gitShow(BASELINE_REV, relPath);
      fs.writeFileSync(path.join(REPO_ROOT, relPath), baseline);
    }

    console.error('Running the metadata-agreement spec against the REVERTED (pre-fix) source (expect RED)...');
    redResult = runSpec();
  } finally {
    for (const relPath of FIX_FILES) {
      fs.writeFileSync(path.join(REPO_ROOT, relPath), currentBytes.get(relPath)!);
    }
    restoredCleanly = FIX_FILES.every((relPath) =>
      fs.readFileSync(path.join(REPO_ROOT, relPath)).equals(currentBytes.get(relPath)!),
    );
    if (!restoredCleanly) {
      // Deliberately do NOT clear the journal: a failed byte-for-byte
      // restore is exactly the case the journal exists to survive, and the
      // NEXT run (of this script, or any negative-control runner sharing
      // this pattern) must still be able to recover from it.
      console.error('FATAL: byte-for-byte restore of one or more fix files failed. Journal left in place for recovery.');
    } else {
      journal.clear();
    }
  }

  if (!restoredCleanly) {
    process.exit(1);
  }

  console.error('Running the metadata-agreement spec against the RESTORED (fixed) source (expect GREEN)...');
  const greenResult = runSpec();

  const redByTitle = assertionsByTitle(redResult);
  const greenByTitle = assertionsByTitle(greenResult);
  const findings: string[] = [];

  if (greenResult.numTotalTests !== Object.keys(EXPECTED_RED_WHEN_REVERTED).length) {
    findings.push(
      `expected ${Object.keys(EXPECTED_RED_WHEN_REVERTED).length} tests in the GREEN run, found ${greenResult.numTotalTests} -- ` +
        'this script\'s EXPECTED_RED_WHEN_REVERTED table has drifted from the spec file; update both together.',
    );
  }
  if (!greenResult.success) {
    findings.push('the RESTORED (fixed) source did not fully pass -- the fix itself is broken, or the restore did not actually happen.');
  }

  for (const [title, expectRed] of Object.entries(EXPECTED_RED_WHEN_REVERTED)) {
    const red = redByTitle.get(title);
    const green = greenByTitle.get(title);
    if (!green) {
      findings.push(`"${title}": not found in the GREEN run's results at all.`);
      continue;
    }
    if (green.status !== 'passed') {
      findings.push(`"${title}": expected to PASS on restored (fixed) source, but was "${green.status}".`);
    }
    if (!red) {
      findings.push(`"${title}": not found in the REVERTED run's results at all (did the file fail to load under the revert?).`);
      continue;
    }
    if (expectRed && red.status !== 'failed') {
      findings.push(
        `"${title}": expected to FAIL under the Stage-2 revert (this is a fix-sensitive test) but was "${red.status}" -- ` +
          'either this test is not actually exercising the fix, or the fix-file list above is incomplete.',
      );
    }
    if (!expectRed && red.status !== 'passed') {
      findings.push(
        `"${title}": expected to remain PASSING even under the Stage-2 revert (an invariant that was already correct pre-fix) but was "${red.status}".`,
      );
    }
  }

  const summary = {
    ok: findings.length === 0,
    baselineRev: BASELINE_REV,
    filesReverted: FIX_FILES.length,
    redRun: { success: redResult.success, numTotalTests: redResult.numTotalTests },
    greenRun: { success: greenResult.success, numTotalTests: greenResult.numTotalTests },
    findings,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (findings.length > 0) process.exit(1);
}

main();
