// Read-only source/evidence verification. No leaf test, database or provider run.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const packet = 'docs/cleanup-source-gates-20261012';
const target = process.argv[2] || 'HEAD';
const git = (...args) => execFileSync('git', args, { cwd: root });
const text = (...args) => git(...args).toString().trim();
const bytes = (file) => git('show', `${target}:${file}`);
const json = (file) => JSON.parse(bytes(file).toString());
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const overlay = json(`${packet}/SOURCE-OVERLAY.json`);
const manifest = json('docs/rebuild-integrated-rc-20261012/SOURCE-MANIFEST.json');
const checksumManifest = json(`${packet}/SHA256SUMS.json`);
assert.equal(text('merge-base', '--is-ancestor', overlay.parentPublishedSource, target), '');
const changed = text('diff', '--name-only', overlay.parentPublishedSource, target)
  .split('\n').filter(Boolean);
const sourceChanged = changed.filter((file) => !file.startsWith('docs/'));
assert.deepEqual(sourceChanged.sort(), overlay.sourceDelta.map((row) => row.path).sort());
let preserved = 0;
for (const row of manifest.files) {
  const replacement = overlay.sourceDelta.find((item) => item.path === row.path);
  const expectedHash = replacement ? replacement.afterSha256 : row.sha256;
  const expectedBlob = replacement ? replacement.afterGitBlob : row.gitBlob;
  assert.equal(sha256(bytes(row.path)), expectedHash, row.path);
  assert.equal(text('rev-parse', `${target}:${row.path}`), expectedBlob, row.path);
  if (!replacement) preserved++;
}
assert.equal(preserved, overlay.parentManifestPreservedEntries);
// Parent evidence stays historical: no manifest, guard or acceptance rewrite.
for (const file of text('ls-tree', '-r', '--name-only', overlay.parentPublishedSource,
  'docs/rebuild-integrated-rc-20261012').split('\n').filter(Boolean)) {
  assert.equal(text('rev-parse', `${target}:${file}`),
    text('rev-parse', `${overlay.parentPublishedSource}:${file}`), file);
}
for (const [file, expectedHash] of Object.entries(checksumManifest.files)) {
  assert.equal(sha256(bytes(file)), expectedHash, file);
}
assert.equal(json(`${packet}/GATE-MATRIX.json`).fullReleaseAcceptance, false);
assert.equal(json(`${packet}/BLOCKERS.json`).releaseAccepted, false);
console.log(JSON.stringify({ target: text('rev-parse', target),
  tree: text('rev-parse', `${target}^{tree}`), sourceChanges: sourceChanged,
  preservedParentSourceEntries: preserved,
  verifiedQualificationFiles: Object.keys(checksumManifest.files).length,
  historicalParentPacketUnchanged: true, nativeOrFullCleanupAcceptance: false }, null, 2));
