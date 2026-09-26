/**
 * Promptfoo custom provider for Meri offline runtime.
 *
 * Exported as a class with id() and async callApi(prompt, context) per
 * Promptfoo provider contract. Promptfoo passes context.vars including caseId.
 *
 * Spawns `node --import tsx runner.mjs` from packages/meriv2-core cwd.
 * Sends vars as JSON via stdin. Returns:
 *   { output: JSON.stringify(record), metadata: { measurement: record.measurement } }
 *
 * Rejects unknown caseIds and child failures; never fabricates output.
 */

'use strict';

const { spawnSync } = require('child_process');
const { createHash } = require('node:crypto');
const { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } = require('fs');
const { join, resolve } = require('path');

// Resolve workspace from this file's location: evals/meri/runtime/provider.cjs
// -> workspace root is 3 levels up
const WORKSPACE = resolve(__dirname, '..', '..', '..');
const RUNNER_PATH = join(WORKSPACE, 'evals', 'meri', 'runtime', 'runner.mjs');
const CORE_CWD = join(WORKSPACE, 'packages', 'meriv2-core');
const SCRATCH_DIR = join(WORKSPACE, '.artifacts', 'meri-promptfoo', 'tmp');
const INPUT_FILES = {
  config: join(WORKSPACE, 'evals', 'meri', 'promptfooconfig.yaml'),
  scorer: join(WORKSPACE, 'evals', 'meri', 'scorer.py'),
  provider: join(__dirname, 'provider.cjs'),
  runner: RUNNER_PATH,
  ga_fixture: join(WORKSPACE, 'apps', 'api', 'src', 'meri', 'evals', 'government-affairs-fixtures.ts'),
};

function fingerprintInputs() {
  return Object.fromEntries(Object.entries(INPUT_FILES).map(([name, file]) => [
    name, createHash('sha256').update(readFileSync(file)).digest('hex'),
  ]));
}

// Known case IDs - must match suite-contract.json exactly
const KNOWN_CASES = new Set([
  'core/leakage.cross-tenant.matrix',
  'core/grounding.claim-evidence',
  'core/compliance.gate.enforcement',
  'core/entity.grounding.canonical-ids',
  'core/legislation.bill-status.hr8800-rule-failed',
  'core/legislation.state-bill-status.crossover-dead',
  'core/legislation.state-rule-status.no-fabrication',
  'core/legislation.committee-roster.never-guess',
  'core/legislation.multi-state-comparison.order-independent',
  'core/legislation.federal-state-mixed.no-cross-contamination',
  'core/government-affairs-assurance-ga-goldens-v1.0.0',
  'ga/ga-budget-stage-and-units',
  'ga/ga-funding-eligibility-and-forecast',
  'ga/ga-meeting-history-and-role',
  'ga/ga-hearing-statement-versus-decision',
  'ga/ga-legislation-current-version',
  'ga/ga-executive-consistent-deliverable',
  'plan/portfolio-changes',
  'plan/overland-ai-profile',
  'plan/c2-strategies-mail-history',
  'plan/kindetic-industries-research',
  'plan/selected-client-priorities',
  'sequence/portfolio-overlap-with-target',
  'sequence/cleared-prior-target',
  'calibration/bad-citation',
  'calibration/tenant-leak',
]);

// Fail closed: a denylist cannot anticipate every provider/DB credential or
// NODE_OPTIONS preload that could make an otherwise pure fixture call unsafe.
const CHILD_ENV_ALLOWLIST = [
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'LANG',
];

function cleanEnv(parentEnv) {
  const env = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (typeof parentEnv[key] === 'string') env[key] = parentEnv[key];
  }
  env.TEMP = SCRATCH_DIR;
  env.TMP = SCRATCH_DIR;
  env.TMPDIR = SCRATCH_DIR;
  env.PROMPTFOO_DISABLE_TELEMETRY = '1';
  env.PROMPTFOO_DISABLE_REMOTE_GENERATION = '1';
  return env;
}

class MeriOfflineProvider {
  id() {
    return 'meri-offline-runner';
  }

  async callApi(prompt, context) {
    // Promptfoo passes vars in context.vars; prompt is set to caseId via prompts config
    const vars = (context && context.vars) ? context.vars : {};
    const caseId = vars.caseId || prompt;

    if (!caseId) {
      return { error: 'Missing caseId in vars' };
    }

    if (!KNOWN_CASES.has(caseId)) {
      return { error: 'Unknown caseId: ' + caseId };
    }

    // Keep result files and child-process temporary data in ignored artifacts.
    mkdirSync(SCRATCH_DIR, { recursive: true });
    const tempDir = mkdtempSync(join(SCRATCH_DIR, 'meri-runner-'));
    const resultPath = join(tempDir, 'result.json');

    let child;
    try {
      // Build the input JSON with all vars plus resultPath
      const runnerInput = JSON.stringify(Object.assign({}, vars, { caseId, resultPath }));

      // Spawn: node --import tsx runner.mjs from packages/meriv2-core cwd
      child = spawnSync(process.execPath, ['--import', 'tsx', RUNNER_PATH], {
        cwd: CORE_CWD,
        env: cleanEnv(process.env),
        input: runnerInput,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
        shell: false,
        windowsHide: true,
      });
    } catch (spawnErr) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      return { error: 'Spawn exception: ' + spawnErr.message };
    }

    if (child.error) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      return { error: 'Runner spawn failed: ' + child.error.message };
    }

    if (child.status !== 0) {
      const stderr = (child.stderr || child.stdout || '').slice(0, 2000);
      try { rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      return { error: 'Runner exited ' + child.status + ': ' + stderr };
    }

    // Read result file BEFORE cleanup
    let record;
    try {
      if (!existsSync(resultPath)) {
        try { rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        return { error: 'Result file not written by runner' };
      }
      const raw = readFileSync(resultPath, 'utf8');
      record = JSON.parse(raw);
    } catch (readErr) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      return { error: 'Failed to read/parse result: ' + readErr.message };
    }

    // Cleanup temp dir after reading
    try { rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}

    // Validate basic record structure
    if (!record || record.schemaVersion !== 1) {
      return { error: 'Invalid record schemaVersion' };
    }
    if (record.datasetVersion !== 'meri-offline-v1') {
      return { error: 'Invalid record datasetVersion' };
    }
    if (!record.provenance || typeof record.provenance !== 'object' || record.provenance.model !== 'none') {
      return { error: 'Record provenance.model must be "none"' };
    }

    try {
      // Bind the result to the actual uncommitted harness bytes, not just Git HEAD.
      record.provenance.inputSha256 = fingerprintInputs();
    } catch (error) {
      return { error: 'Could not fingerprint offline evaluation inputs: ' + error.message };
    }

    return {
      output: JSON.stringify(record),
      metadata: {
        measurement: record.measurement || null,
      },
    };
  }
}

module.exports = MeriOfflineProvider;
