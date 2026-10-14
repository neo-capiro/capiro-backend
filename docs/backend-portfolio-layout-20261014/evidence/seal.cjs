const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const packet = path.resolve(__dirname, '..'), root = path.resolve(packet, '../..');
const indexFile = path.join(packet, 'SHA256-INDEX.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (absolute === indexFile) return [];
    if (entry.isSymbolicLink()) throw new Error('packet symlink refused');
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}
function git(...args) { return cp.execFileSync('git', args, { cwd: root, maxBuffer: 2 * 1024 * 1024 }); }
if (process.argv[2] === '--write') {
  const files = walk(packet).sort().map(file => { const bytes = fs.readFileSync(file); return { path: path.relative(packet, file), bytes: bytes.length, sha256: hash(bytes) }; });
  fs.writeFileSync(indexFile, JSON.stringify({ algorithm: 'SHA-256', note: 'Derived index excludes itself; original preparation index remains in received4c211c9/source history.', files }, null, 2) + '\n');
}
const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
const actual = walk(packet).map(file => path.relative(packet, file)).sort();
if (JSON.stringify(actual) !== JSON.stringify(index.files.map(file => file.path).sort())) throw new Error('packet inventory mismatch');
let raw = 0;
for (const item of index.files) {
  const bytes = fs.readFileSync(path.join(packet, item.path));
  if (bytes.length !== item.bytes || hash(bytes) !== item.sha256) throw new Error(`payload changed: ${item.path}`);
  if (item.path.endsWith('.lossless.json')) {
    const value = JSON.parse(bytes.toString()), original = Buffer.from(value.data, 'base64');
    if (value.encoding !== 'base64' || original.length !== value.bytes || hash(original) !== value.sha256) throw new Error(`lossless mismatch: ${item.path}`);
    raw += 1;
  }
}
const receipt = JSON.parse(fs.readFileSync(path.join(packet, 'SOURCE-RECEIPT.json')));
git('merge-base', '--is-ancestor', receipt.source.head, 'HEAD');
if (git('rev-parse', `${receipt.source.head}^{tree}`).toString().trim() !== receipt.source.tree) throw new Error('source tree mismatch');
for (const item of receipt.source.paths) {
  const bytes = git('show', `${receipt.source.head}:${item.path}`);
  if (bytes.length !== item.bytes || hash(bytes) !== item.sha256 || git('rev-parse', `${receipt.source.head}:${item.path}`).toString().trim() !== item.blob) throw new Error(`source mismatch: ${item.path}`);
  if (git('diff', receipt.source.head, 'HEAD', '--', item.path).length) throw new Error(`product changed after checks: ${item.path}`);
}
for (const immutable of receipt.preservation) {
  if (!immutable.exact || immutable.baseBlob !== immutable.sourceBlob) throw new Error(`owner not preserved: ${immutable.path}`);
}
for (const attempt of ['18-jest', '19-types']) {
  const check = JSON.parse(fs.readFileSync(path.join(__dirname, `${attempt}-receipt.json`)));
  if (check.source.head !== receipt.source.head || check.exitCode !== 0 || !check.sourceDeltaUnchanged || !check.boundSourcesUnchanged) throw new Error(`check not qualified: ${attempt}`);
  for (const item of check.source.bindings) if (hash(git('show', `${receipt.source.head}:${item.path}`)) !== item.sha256) throw new Error(`uncommitted source in check: ${item.path}`);
}
const cases = JSON.parse(fs.readFileSync(path.join(packet, 'CASE-COMPARISON.json')));
if (cases.originalCount !== 75 || cases.preserved.length !== 75 || cases.missing.length || cases.finalCount !== 110 || cases.added.length !== 35) throw new Error('case custody mismatch');
const combined = JSON.parse(fs.readFileSync(path.join(packet, 'COMBINED-RECEIPT.json')));
git('merge-base', '--is-ancestor', combined.combined.head, 'HEAD');
if (git('rev-parse', `${combined.combined.head}^{tree}`).toString().trim() !== combined.combined.tree) throw new Error('combined tree mismatch');
if (git('show', '-s', '--format=%P', combined.combined.head).toString().trim() !== combined.combined.parents.join(' ')) throw new Error('combined parents mismatch');
if (combined.sourceUnion.overlap.length || combined.sourceUnion.outsideUnion.length || combined.sourceUnion.missing.length || !combined.sourceUnion.allBlobsAndModesExact) throw new Error('source union rejected');
for (const item of combined.sourceUnion.paths) {
  const expected = `${item.mode} ${item.type} ${item.blob}`;
  for (const head of [item.acceptedHead, combined.combined.head, 'HEAD']) {
    const tuple = git('ls-tree', head, '--', item.path).toString().split('\t')[0];
    if (tuple !== expected) throw new Error(`union mode/blob mismatch: ${item.path}`);
  }
  if (hash(git('show', `${combined.combined.head}:${item.path}`)) !== item.sha256) throw new Error(`union source hash mismatch: ${item.path}`);
}
const changedSources = git('diff', '--name-only', combined.base.head, 'HEAD').toString().trim().split('\n').filter(file => file && !file.startsWith('docs/')).sort();
if (JSON.stringify(changedSources) !== JSON.stringify(combined.sourceUnion.paths.map(item => item.path).sort())) throw new Error('outside union source changes');
for (const attempt of ['20-jest', '21-types']) {
  const check = JSON.parse(fs.readFileSync(path.join(__dirname, `${attempt}-receipt.json`)));
  if (check.source.head !== combined.combined.head || check.exitCode !== 0 || !check.sourceDeltaUnchanged || !check.boundSourcesUnchanged) throw new Error(`combined check not qualified: ${attempt}`);
  for (const item of check.source.bindings) if (hash(git('show', `${combined.combined.head}:${item.path}`)) !== item.sha256) throw new Error(`combined uncommitted binding: ${item.path}`);
}
const identities = file => JSON.parse(fs.readFileSync(path.join(__dirname, file))).testResults.flatMap(suite => suite.assertionResults.map(row => [row.fullName, row.status])).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
if (JSON.stringify(identities('18-jest-result.json')) !== JSON.stringify(identities('20-jest-result.json'))) throw new Error('combined case identity/multiplicity mismatch');
const unionReview = JSON.parse(fs.readFileSync(path.join(packet, 'COMBINED-UNION-REVIEW.json')));
if (unionReview.result !== 'exact_source_union_pass' || unionReview.mergedHead !== combined.combined.head || unionReview.mergedTree !== combined.combined.tree || !unionReview.allMergedModesTypesObjectsEqualOrdinaryUnion) throw new Error('independent union review rejected');
// Only re-parse preserved observations; no Core fixture/runtime/test is invoked.
require('./derive-core-admission.cjs');
console.log(JSON.stringify({ passed: true, payloads: index.files.length, lossless: raw, sourcePaths: receipt.source.paths.length, combinedSourcePaths: combined.sourceUnion.pathCount, cases: 110, preserved: 75 }));
