import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const packet = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(packet, '../..');
const prefix = path.relative(root, packet).split(path.sep).join('/');
const write = process.argv.includes('--write');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const git = (args) => cp.execFileSync('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
const read = (name) => write ? fs.readFileSync(path.join(packet, name)) : git(['show', `HEAD:${prefix}/${name}`]);
function paths(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = base + entry.name;
    return entry.isDirectory() ? paths(path.join(dir, entry.name), name + '/') : [name];
  });
}
const names = (write ? paths(packet) : git(['ls-tree', '-r', '--name-only', 'HEAD', '--', prefix]).toString().trim().split('\n').map((name) => name.slice(prefix.length + 1)))
  .filter((name) => name !== 'SHA256-INDEX.json').sort();
const rows = names.map((name) => { const content = read(name); return { path: name, bytes: content.length, sha256: hash(content) }; });
const value = { contractVersion: 1, sourceOnly: true, payloads: rows };
if (write) fs.writeFileSync(path.join(packet, 'SHA256-INDEX.json'), JSON.stringify(value, null, 2) + '\n');
else assert.deepEqual(JSON.parse(read('SHA256-INDEX.json').toString()), value);
const rawOutputs = new Map();
for (const name of names.filter((name) => name.endsWith('-output.raw.json'))) {
  const raw = JSON.parse(read(name).toString());
  assert.equal(raw.encoding, 'base64');
  const bytes = Buffer.from(raw.data, 'base64');
  assert.equal(bytes.length, raw.bytes); assert.equal(hash(bytes), raw.sha256);
  rawOutputs.set(name, bytes);
}
for (const name of names.filter((name) => name.endsWith('-receipt.json') && name.startsWith('evidence/'))) {
  const receipt = JSON.parse(read(name).toString());
  assert.equal(hash(rawOutputs.get(`evidence/${receipt.label}-output.raw.json`)), receipt.outputSha256);
  assert.equal(receipt.sourceStatusBefore, receipt.sourceStatusAfter);
  assert.equal(receipt.exactCommittedSource, receipt.sourceStatusBefore === '');
  assert.equal(git(['rev-parse', `${receipt.head}^{tree}`]).toString().trim(), receipt.tree);
}
const source = JSON.parse(read('SOURCE-RECEIPT.json').toString());
assert.equal(git(['rev-parse', `${source.sourceHead}^{tree}`]).toString().trim(), source.sourceTree);
assert.equal(git(['rev-parse', `${source.baseHead}^{tree}`]).toString().trim(), source.baseTree);
for (const row of source.sourceDelta) {
  assert(!row.path.includes('engagement.service.'));
  const content = git(['show', `${source.sourceHead}:${row.path}`]);
  assert.equal(content.length, row.bytes); assert.equal(hash(content), row.sha256);
  assert.equal(git(['rev-parse', `${source.sourceHead}:${row.path}`]).toString().trim(), row.blob);
  if (!write) assert.equal(git(['rev-parse', `HEAD:${row.path}`]).toString().trim(), row.blob);
}
const comparison = JSON.parse(read('CASE-COMPARISON.json').toString());
assert.equal(comparison.originalCount, 146); assert.equal(comparison.afterCount, 150);
assert.equal(comparison.originalCaseIdentitiesAndMultiplicityRetained, true);
const results = JSON.parse(read('evidence/prospect-final-source-results.json').toString());
assert.equal(results.numPassedTests, 150); assert.equal(results.numFailedTests, 0);
assert.equal(results.numPendingTests, 0); assert.equal(results.numPassedTestSuites, 7);
const emit = JSON.parse(rawOutputs.get('evidence/prospect-final-narrow-emit-output.raw.json').toString());
assert.equal(emit.result, 'pass'); assert.equal(emit.sourceRows.length, 34);
assert.equal(emit.artifacts.length, 136); assert.equal(emit.artifacts.filter((row) => row.path.endsWith('.js')).length, 34);
const archive = read('narrow-emitted-source.tar.gz');
const inspectArchive = `import hashlib,io,json,sys,tarfile\nwith tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode='r:gz') as t:\n print(json.dumps([{'path':m.name,'bytes':m.size,'sha256':hashlib.sha256(t.extractfile(m).read()).hexdigest()} for m in t.getmembers()]))\n`;
const archived = JSON.parse(cp.execFileSync('python3', ['-c', inspectArchive], { input: archive }).toString());
assert.deepEqual(archived.sort((a,b)=>a.path.localeCompare(b.path)), [...emit.artifacts].sort((a,b)=>a.path.localeCompare(b.path)));
console.log(JSON.stringify({ result: 'pass', mode: write ? 'write-index' : 'verify-committed-Git', payloads: rows.length,
  rawOutputs: rawOutputs.size, sourceHead: source.sourceHead, cases: 150, emittedArtifacts: 136,
  scope: 'finite hash/source/result verification, not independent/native/live acceptance' }));
