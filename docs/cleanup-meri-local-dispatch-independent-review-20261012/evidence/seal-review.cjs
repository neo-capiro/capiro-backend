const fs = require('node:fs'), assert = require('node:assert/strict'), cp = require('node:child_process'), crypto = require('node:crypto');
const dir = 'docs/cleanup-meri-local-dispatch-independent-review-20261012';
const source = '7ea444c74a5637577aa0eb3cb99cb420b5f8223e';
const receipt = JSON.parse(fs.readFileSync(dir + '/ACCEPTANCE.json', 'utf8'));
assert.equal(cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), source);
for (const path of [...receipt.reviewedApplicationPaths, ...receipt.reviewedAdoptionPaths]) assert(fs.readFileSync(path).equals(cp.execFileSync('git', ['show', `${source}:${path}`])));
assert.equal(cp.execFileSync('git', ['diff', '--name-only', '--', '.', `:!${dir}`], { encoding: 'utf8' }).trim(), '');
assert.equal(fs.readFileSync(dir + '/evidence/staged-full-diff-check.log').length, 0);
assert.equal(fs.readFileSync(dir + '/evidence/staged-nonlog-diff-check.log').length, 0);
const entries = [];
function walk(path) {
  for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
    const file = path + '/' + entry.name;
    if (entry.isDirectory()) walk(file);
    else if (file !== dir + '/SHA256.json') {
      const bytes = fs.readFileSync(file);
      entries.push({ path: file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
walk(dir); entries.sort((a, b) => a.path.localeCompare(b.path));
fs.writeFileSync(dir + '/SHA256.json', JSON.stringify({ acceptedSource: source, acceptedTree: receipt.tree, excludesItselfOnly: true, entries }, null, 2) + '\n');
for (const entry of entries) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(entry.path)).digest('hex'), entry.sha256);
console.log(JSON.stringify({ source, tree: receipt.tree, evidenceFilesHashed: entries.length, sourceBlobsExact: 7, allEvidenceHashesReadbackPass: true, fullStagedDiffCheck: 'PASS', nonLogStagedDiffCheck: 'PASS' }));
