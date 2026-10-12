// Pure Git/blob/hash verification. No database, migration, provider or engine.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const docs = 'docs/rebuild-integrated-rc-20261012';
const git = (...args) => execFileSync('git', args, { cwd: root });
const read = file => JSON.parse(fs.readFileSync(path.join(root, docs, file), 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = read('SOURCE-MANIFEST.json');
const changed = git('diff', '--name-only', source.acceptedImplementationSource, 'HEAD').toString().trim().split('\n').filter(Boolean);
if (changed.some(file => !file.startsWith(`${docs}/`))) throw Error('Post-review runtime/source changed');
for (const file of source.files) {
  const bytes = git('show', `HEAD:${file.path}`);
  if (hash(bytes) !== file.sha256 || git('rev-parse', `HEAD:${file.path}`).toString().trim() !== file.gitBlob)
    throw Error(`Source mismatch: ${file.path}`);
}
const release = read('RELEASE-MANIFEST.json');
let included = 0;
for (const ref of release.candidateRefs) {
  if (ref.pr === 2392) continue;
  git('merge-base', '--is-ancestor', ref.head, 'HEAD');
  included++;
}
git('merge-base', '--is-ancestor', release.base, 'HEAD');
if (included !== 19) throw Error(`Expected 19 candidate ancestors; got ${included}`);
for (const migration of release.migrationSources) {
  if (hash(git('show', `HEAD:${migration.path}`)) !== migration.sha256) throw Error(`Migration mismatch: ${migration.path}`);
}
const sums = read('SHA256SUMS.json');
for (const file of sums.files) {
  if (hash(git('show', `HEAD:${file.path}`)) !== file.sha256) throw Error(`Evidence mismatch: ${file.path}`);
}
process.stdout.write(JSON.stringify({
  status: 'PASS', verifiedHead: git('rev-parse', 'HEAD').toString().trim(),
  verifiedTree: git('rev-parse', 'HEAD^{tree}').toString().trim(),
  implementationSource: source.acceptedImplementationSource,
  implementationTree: source.acceptedImplementationTree,
  sourceBlobs: source.files.length, candidateAncestors: included,
  migrationSources: release.migrationSources.length, evidenceBlobs: sums.files.length,
  postReviewSourceUnchanged: true, nativeAcceptance: false,
}, null, 2) + '\n');
