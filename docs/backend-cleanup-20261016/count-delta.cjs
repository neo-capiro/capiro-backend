// Exact changed-blob delta against the sealed016e count; no repository-wide scan.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const baseline = '016e79b585c14f20d13669e13c987c01e3dd29dd';
const expectedReceiptSHA256 = 'fad456de08566e2e7857a0b104d18d446362ace22696d06b8219c1620e63fed6';
const receiptBytes = fs.readFileSync(process.argv[2]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (sha256(receiptBytes) !== expectedReceiptSHA256) throw new Error('Baseline receipt mismatch');
const receipt = JSON.parse(receiptBytes);
if (receipt.commit !== baseline) throw new Error('Baseline commit mismatch');
const git = (...args) => execFileSync('git', args, {
  cwd: root, timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
const head = git('rev-parse', 'HEAD').toString().trim();
const before = {
  unique: receipt.authoredSourceWithoutTrustedMirror,
  mirror: receipt.trustedFirstPartyMirror,
  physical: receipt.physicalFirstPartyTotalIncludingTrustedMirror,
};
const after = structuredClone(before);
const original = new Map([
  ...receipt.files.map((entry) => [entry.path, { ...entry, mirror: false }]),
  ...receipt.mirrorFiles.map((entry) => [entry.path, { ...entry, mirror: true }]),
]);
const addedCode = new Map([
  ['scripts/lib/phase17-operator-ownership.mjs', 'infra-scripts-schema-config'],
  ['scripts/lib/phase17-operator-ownership.test.mjs', 'tests-fixtures-evals'],
]);
const changes = [];
for (const row of git('diff', '--no-renames', '--name-status', baseline, head).toString().trim().split('\n')) {
  if (!row) continue;
  const [status, file] = row.split('\t');
  const old = original.get(file);
  // Only the declared new .mjs files count; documentation is excluded exactly
  // as in the baseline. An unexpected new source path refuses this finite delta.
  if (!old && !addedCode.has(file)) {
    if (file.startsWith('docs/') || file.endsWith('.md')) continue;
    throw new Error(`Unclassified changed source: ${file}`);
  }
  const mirror = old?.mirror ?? false;
  const category = old?.category ?? addedCode.get(file);
  const bytes = status === 'D' ? null : git('show', `${head}:${file}`);
  const lines = bytes?.toString('utf8').split(/\r\n|\n|\r/);
  const next = bytes ? {
    files: 1,
    nonblankLines: lines.filter((line) => /\S/u.test(line)).length,
    physicalLines: lines.length - (lines.at(-1) === '' ? 1 : 0),
  } : { files: 0, nonblankLines: 0, physicalLines: 0 };
  const previous = old ? {
    files: 1, nonblankLines: old.nonblankLines, physicalLines: old.totalLines,
  } : { files: 0, nonblankLines: 0, physicalLines: 0 };
  const delta = Object.fromEntries(Object.keys(next).map((key) => [key, next[key] - previous[key]]));
  for (const bucket of [mirror ? 'mirror' : 'unique', 'physical']) {
    for (const key of Object.keys(delta)) after[bucket][key] += delta[key];
  }
  changes.push({ path: file, status, mirror, category, before: previous, after: next, delta,
    beforeBlob: old?.oid ?? null, afterBlob: bytes ? git('rev-parse', `${head}:${file}`).toString().trim() : null,
    afterSHA256: bytes ? sha256(bytes) : null });
}
if (changes.length !== 6) throw new Error(`Expected six changed code paths, received ${changes.length}`);
const report = {
  baseline, sourceHead: head, baselineReceiptSHA256: expectedReceiptSHA256,
  method: 'Sealed baseline plus exact Git-blob line deltas for six classified changed code paths; UTF-8 nonblank including comments, same exclusions/categories; no full rescan.',
  before, after, changes,
  limits: 'Approximate source-size metric, not language-aware SLOC. All frontend/tests/scripts retained. Docs, README, binary/data/lock/config supplements excluded as in baseline. No runtime qualification inferred.',
};
fs.writeFileSync(path.join(__dirname, 'CODE-COUNTS.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ baseline, sourceHead: head, before, after, changedCodeFiles: changes.length }, null, 2));
