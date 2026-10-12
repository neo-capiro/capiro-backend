const fs = require('node:fs'), cp = require('node:child_process'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const pin = '13c316d6765dcc22765dcadf8c10be33c1bb9aa4';
const path = 'docs/cleanup-newsletter-two-contract-source-preservation-20261012/evidence/ORIGINAL-SOURCE-MANIFEST.json';
const blob = cp.execFileSync('git', ['show', `${pin}:${path}`]);
const manifest = JSON.parse(blob);
const git = (...args) => cp.execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const checked = [];
for (const entry of manifest.entries) {
  const c = cp.execFileSync('git', ['show', `${manifest.C}:${entry.path}`]);
  const w = cp.execFileSync('git', ['show', `${manifest.W}:${entry.path}`]);
  assert(c.equals(w)); assert.equal(c.length, entry.bytes); assert.equal(sha(c), entry.sha256);
  assert.equal(git('rev-parse', `${manifest.C}:${entry.path}`).trim(), entry.Cblob);
  assert.equal(git('rev-parse', `${manifest.W}:${entry.path}`).trim(), entry.Wblob);
  assert.equal(git('ls-tree', manifest.base, '--', entry.path).trim(), '');
  checked.push({ path: entry.path, kind: entry.kind, Cblob: entry.Cblob, Wblob: entry.Wblob, bytes: c.length, sha256: sha(c), absentFromFourSourceBase: true });
}
assert.equal(checked.length, 58);
for (const support of manifest.supports) assert.equal(git('rev-parse', `${manifest.base}:${support.path}`).trim(), support.baseBlob);
const result = { planPin: '6d89253b4db7c2a1d792a9ff5605c61a84c6300a', prefrozenPin: pin, manifestSha256: sha(blob),
  C: manifest.C, Ctree: manifest.Ctree, W: manifest.W, Wtree: manifest.Wtree,
  fourSourceBase: manifest.base, fourSourceTree: manifest.baseTree, counts: manifest.counts,
  verifiedEntries: checked, supportInputsVerified: manifest.supports.length,
  sourceGraphExecuted: false, sqlExecuted: false, applicationAcceptance: false, awaitingFrozenSource: true };
const out = 'docs/cleanup-newsletter-two-contract-independent-review-20261012/evidence/prefrozen-rebound.json';
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ counts: manifest.counts, verifiedEntries: checked.length, supportInputsVerified: manifest.supports.length, applicationAcceptance: false, awaitingFrozenSource: true }));
