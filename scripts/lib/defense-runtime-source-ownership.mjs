import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CANONICAL_RUNTIME_SOURCE_PATHS = Object.freeze([
  'apps/api/src/defense-budget',
  'apps/api/src/program-element/snapshot',
  'apps/api/src/program-element/source-document',
  'apps/api/src/program-element/deltas',
  'apps/api/src/program-element/program-element-change-outbox.service.ts',
  'apps/api/src/program-element/program-element-change-outbox.service.spec.ts',
]);
export const REPLAY_FIXTURE_PATHS = Object.freeze([
  'defense-budget/contracts/__fixtures__/cycle-manifest-minimal.json',
  'defense-budget/parser-router/__fixtures__/cross-lang-job.json',
  'defense-budget/contracts/__fixtures__/extraction-result-minimal.json',
  'defense-budget/contracts/__fixtures__/r2-minimal.json',
  'defense-budget/contracts/__fixtures__/r1-minimal.json',
  'defense-budget/phase6/__fixtures__/golden-phase6-cycle.json',
  'defense-budget/contracts/__fixtures__/pdoc-minimal.json',
  'defense-budget/contracts/__fixtures__/committee-minimal.json',
  'defense-budget/contracts/__fixtures__/r3-performer-minimal.json',
]);
const CANONICAL_ROOT = 'apps/api/src';
const RETIRED_ROOT = 'apps/defense-api/runtime-source';
const MANIFEST_PATH = 'scripts/lib/defense-runtime-source-retirement.json';
const CODE_PATH = /\.(?:[cm]?[jt]sx?|py|sh|ps1|c|cc|cpp|h|hpp|rs|go|java|rb)$/i;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Check one canonical implementation owner and the retained fixture bytes.
 * Baseline Git entries are independently derived from the six fixed paths
 * above: the retirement manifest is not its own completeness proof. The
 * historical blobs prove the removed twins; current canonical code may evolve.
 */
export function validateDefenseRuntimeSourceOwnership(manifest, ports) {
  const errors = [];
  if (manifest.schemaVersion !== 1 || manifest.model !== 'single-canonical-code-owner-with-retained-fixtures') {
    return ['Unsupported Defense runtime source ownership manifest'];
  }
  if (manifest.canonicalRoot !== CANONICAL_ROOT || manifest.retiredRoot !== RETIRED_ROOT) {
    return ['Defense runtime source ownership roots differ from their canonical owners'];
  }
  const baseline = new Map(ports.baselineEntries.map((entry) => [entry.path, entry]));
  const baselineCode = ports.baselineEntries.filter((entry) => entry.path.endsWith('.ts'));
  const baselineData = ports.baselineEntries.filter((entry) => !entry.path.endsWith('.ts') && !entry.path.endsWith('.md'));
  const baselineDocs = ports.baselineEntries.filter((entry) => entry.path.endsWith('.md'));
  const retired = manifest.retiredCodeFiles;
  const keptData = manifest.retainedDataFiles;
  const keptDocs = manifest.retainedDocumentationFiles;
  const retiredPaths = new Set();
  const canonicalCodePaths = new Set();
  let testCount = 0;
  for (const entry of retired) {
    const relative = entry.retiredPath.slice(RETIRED_ROOT.length + 1);
    const canonicalPath = `${CANONICAL_ROOT}/${relative}`;
    if (!entry.retiredPath.startsWith(`${RETIRED_ROOT}/`) || relative.split('/').includes('..') ||
        !entry.retiredPath.endsWith('.ts') || entry.canonicalPath !== canonicalPath) {
      errors.push(`Invalid canonical code mapping: ${entry.retiredPath}`);
      continue;
    }
    if (retiredPaths.has(entry.retiredPath) || canonicalCodePaths.has(entry.canonicalPath)) {
      errors.push(`Duplicate retired code mapping: ${entry.retiredPath}`);
    }
    retiredPaths.add(entry.retiredPath);
    canonicalCodePaths.add(entry.canonicalPath);
    const original = baseline.get(entry.canonicalPath);
    if (!original || original.mode !== entry.mode || original.blob !== entry.blob) {
      errors.push(`Retired twin differs from immutable canonical baseline: ${entry.retiredPath}`);
    }
    if (entry.test !== entry.canonicalPath.endsWith('.spec.ts')) errors.push(`Invalid test twin classification: ${entry.retiredPath}`);
    if (entry.test) testCount += 1;
    if (!ports.sourceExists(entry.canonicalPath)) errors.push(`Missing canonical runtime source: ${entry.canonicalPath}`);
  }
  if (baselineCode.length !== retired.length || baselineCode.some((entry) => !canonicalCodePaths.has(entry.path)) ||
      manifest.counts.retiredCodeFiles !== retired.length || manifest.counts.retainedCanonicalTests !== testCount) {
    errors.push('Retired code/test inventory does not cover the immutable canonical baseline');
  }
  for (const canonicalPath of CANONICAL_RUNTIME_SOURCE_PATHS.slice(0, 4)) {
    const recorded = manifest.baseline.sourceTrees.find((entry) => entry.canonicalPath === canonicalPath);
    if (!recorded || recorded.baselineTree !== ports.baselineTrees.get(canonicalPath)) {
      errors.push(`Canonical runtime baseline tree mismatch: ${canonicalPath}`);
    }
  }

  const mirrored = new Set(ports.mirroredPaths);
  for (const mirrorPath of mirrored) {
    if (CODE_PATH.test(mirrorPath)) errors.push(`Duplicate executable runtime source: ${mirrorPath}; use ${CANONICAL_ROOT}`);
  }
  if (!mirrored.has(`${RETIRED_ROOT}/README.md`)) errors.push('Missing runtime source ownership README');
  const retainedOwners = new Set();
  for (const entry of [...keptData, ...keptDocs]) {
    const relative = entry.mirrorPath.slice(RETIRED_ROOT.length + 1);
    const original = baseline.get(entry.canonicalPath);
    if (!entry.mirrorPath.startsWith(`${RETIRED_ROOT}/`) || relative.split('/').includes('..') ||
        CODE_PATH.test(entry.mirrorPath) || entry.canonicalPath !== `${CANONICAL_ROOT}/${relative}` ||
        !original || original.mode !== entry.mode || original.blob !== entry.blob || retainedOwners.has(entry.canonicalPath)) {
      errors.push(`Invalid retained runtime data mapping: ${entry.mirrorPath}`);
      continue;
    }
    retainedOwners.add(entry.canonicalPath);
    if (!mirrored.has(entry.mirrorPath)) errors.push(`Missing retained runtime data: ${entry.mirrorPath}`);
    try {
      const mirrorHash = sha256(ports.readBytes(entry.mirrorPath));
      const canonicalHash = sha256(ports.readBytes(entry.canonicalPath));
      if (mirrorHash !== entry.sha256) errors.push(`Retained runtime data changed: ${entry.mirrorPath}`);
      if (canonicalHash !== mirrorHash) errors.push(`Canonical/retained runtime data drift: ${entry.canonicalPath}`);
    } catch (error) {
      errors.push(`Unable to read retained runtime data ${entry.mirrorPath}: ${error.message}`);
    }
  }
  if (manifest.counts.retainedDataFiles !== keptData.length || manifest.counts.retainedDocumentationFiles !== keptDocs.length ||
      baselineData.length !== keptData.length || baselineDocs.length !== keptDocs.length ||
      [...baselineData, ...baselineDocs].some((entry) => !retainedOwners.has(entry.path))) {
    errors.push('Retained data/documentation inventory does not cover the immutable canonical baseline');
  }
  const replayPaths = keptData.filter((entry) => entry.replayFixture).map((entry) => entry.mirrorPath.slice(RETIRED_ROOT.length + 1));
  if (manifest.counts.replayFixtures !== REPLAY_FIXTURE_PATHS.length || replayPaths.length !== REPLAY_FIXTURE_PATHS.length ||
      REPLAY_FIXTURE_PATHS.some((relative) => !replayPaths.includes(relative))) {
    errors.push('All nine original FY27 replay fixture paths must remain retained');
  }
  return errors;
}

function parseGitEntries(output) {
  return output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [metadata, filePath] = line.split('\t');
    const [mode, type, blob] = metadata.split(' ');
    return { path: filePath, mode, type, blob };
  });
}

function listFiles(root, relative, result = []) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return result;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) listFiles(root, child, result);
    else result.push(child);
  }
  return result;
}

export function inspectDefenseRuntimeSourceOwnership(root) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_PATH), 'utf8'));
    if (!/^[a-f0-9]{40}$/.test(manifest.baseline?.commit ?? '')) throw new Error('Invalid immutable baseline commit');
    const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
    const baselineEntries = parseGitEntries(git(['ls-tree', '-r', manifest.baseline.commit, '--', ...CANONICAL_RUNTIME_SOURCE_PATHS]));
    const treeHashes = git(['rev-parse', ...CANONICAL_RUNTIME_SOURCE_PATHS.slice(0, 4).map((relative) => `${manifest.baseline.commit}:${relative}`)]).trim().split(/\r?\n/);
    const baselineTrees = new Map(CANONICAL_RUNTIME_SOURCE_PATHS.slice(0, 4).map((relative, index) => [relative, treeHashes[index]]));
    const errors = validateDefenseRuntimeSourceOwnership(manifest, {
      baselineEntries, baselineTrees,
      sourceExists: (relative) => {
        try { return fs.statSync(path.join(root, relative)).isFile(); } catch { return false; }
      },
      mirroredPaths: listFiles(root, RETIRED_ROOT),
      readBytes: (relative) => fs.readFileSync(path.join(root, relative)),
    });
    return { errors, counts: manifest.counts, baseline: manifest.baseline.commit };
  } catch (error) {
    return { errors: [`Unable to verify Defense runtime source ownership: ${error.message}`] };
  }
}
