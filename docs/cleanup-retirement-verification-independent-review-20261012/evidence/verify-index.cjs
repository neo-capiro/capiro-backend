const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const directory = 'docs/cleanup-retirement-verification-independent-review-20261012/';
const index = JSON.parse(fs.readFileSync(directory + 'SHA256-INDEX.json', 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
for (const item of index.packet) {
  assert(item.path.startsWith(directory) && !item.path.includes('/../'));
  const bytes = fs.readFileSync(item.path);
  assert.equal(bytes.length, item.bytes, item.path);
  assert.equal(hash(bytes), item.sha256, item.path);
}
for (const item of index.source) {
  const bytes = cp.execFileSync('git', ['show', index.sourceHead + ':' + item.path], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(bytes.length, item.bytes, item.path);
  assert.equal(hash(bytes), item.sha256, item.path);
  assert.deepEqual(bytes, fs.readFileSync(item.path), `local source ${item.path}`);
}
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const target = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(target) : [target];
});
assert.deepEqual(walk(directory).filter(file => !file.endsWith('/SHA256-INDEX.json')).sort(), index.packet.map(item => item.path).sort());
console.log(JSON.stringify({ source: index.sourceHead, sourceTree: index.sourceTree, packetHashes: index.packet.length, sourceHashes: index.source.length, failures: 0 }));
