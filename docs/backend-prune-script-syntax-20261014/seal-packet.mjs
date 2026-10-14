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
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? paths(path.join(dir, entry.name), base + entry.name + '/') : [base + entry.name]);
}
const names = (write ? paths(packet) : git(['ls-tree', '-r', '--name-only', 'HEAD', '--', prefix]).toString().trim().split('\n').map((name) => name.slice(prefix.length + 1)))
  .filter((name) => name !== 'SHA256-INDEX.json').sort();
const value = { contractVersion: 1, sourceOnly: true, payloads: names.map((name) => {
  const bytes = read(name); return { path: name, bytes: bytes.length, sha256: hash(bytes) };
}) };
if (write) fs.writeFileSync(path.join(packet, 'SHA256-INDEX.json'), JSON.stringify(value, null, 2) + '\n');
else assert.deepEqual(JSON.parse(read('SHA256-INDEX.json').toString()), value);
const rawOutputs = new Map();
for (const name of names.filter((name) => name.endsWith('-output.raw.json'))) {
  const raw = JSON.parse(read(name).toString()); assert.equal(raw.encoding, 'base64');
  const bytes = Buffer.from(raw.data, 'base64'); assert.equal(bytes.length, raw.bytes); assert.equal(hash(bytes), raw.sha256);
  rawOutputs.set(name, bytes);
}
for (const name of names.filter((name) => name.startsWith('evidence/') && name.endsWith('-receipt.json'))) {
  const receipt = JSON.parse(read(name).toString());
  assert.equal(hash(rawOutputs.get(`evidence/${receipt.label}-output.raw.json`)), receipt.outputSha256);
  assert.equal(receipt.sourceStatusBefore, receipt.sourceStatusAfter);
  assert.equal(receipt.exactCommittedSource, receipt.sourceStatusBefore === '');
  assert.equal(git(['rev-parse', `${receipt.head}^{tree}`]).toString().trim(), receipt.tree);
}
const source = JSON.parse(read('SOURCE-RECEIPT.json').toString());
assert.equal(git(['rev-parse', `${source.sourceHead}^{tree}`]).toString().trim(), source.sourceTree);
assert.equal(source.sourceDelta.length, 2);
for (const row of source.sourceDelta) {
  const bytes = git(['show', `${source.sourceHead}:${row.path}`]);
  assert.equal(hash(bytes), row.sha256); assert.equal(bytes.length, row.bytes);
  assert.equal(git(['rev-parse', `${source.sourceHead}:${row.path}`]).toString().trim(), row.blob);
  if (!write) assert.equal(git(['rev-parse', `HEAD:${row.path}`]).toString().trim(), row.blob);
}
const donor = JSON.parse(read('DONOR-SOURCE.lossless.json').toString());
for (const row of donor.files) {
  const bytes = Buffer.from(row.data, 'base64'); assert.equal(bytes.length, row.bytes); assert.equal(hash(bytes), row.sha256);
  const blob = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
  assert.equal(blob, row.blob);
}
const proof = JSON.parse(read('SQL-BYTE-PROOF.json').toString());
const before = git(['show', `${proof.base}:${proof.operatorPath}`]);
const after = git(['show', `${source.sourceHead}:${proof.operatorPath}`]);
const needle = "-- found no `existing`, its reviewStatus='rejected'";
assert.equal(before.toString().split(needle).length - 1, 2);
assert.equal(before.toString().replaceAll(needle, needle.replaceAll('`', '')), after.toString());
const strip = (text) => text.split(/(?<=\n)/).filter((line) => !line.trimStart().startsWith('--')).join('');
assert.equal(strip(before.toString()), strip(after.toString()));
assert.equal(hash(strip(before.toString())), proof.sourceWithoutFullSqlCommentLinesSha256);
const queryBlocks = (text) => [...text.matchAll(/\$queryRaw<CandidateRow>`([\s\S]*?)\n        `/g)].map((m) => strip(m[1]));
const oldQueries = queryBlocks(before.toString()); const currentQueries = queryBlocks(after.toString());
assert.equal(oldQueries.length, 2); assert.deepEqual(currentQueries, oldQueries);
assert.deepEqual(oldQueries.map(hash), proof.queryDigests);
const compile = JSON.parse(rawOutputs.get('evidence/prune-exact-source-strict-compile-output.raw.json').toString());
assert.equal(compile.result, 'pass'); assert.equal(compile.strict, true); assert.equal(compile.noEmit, true);
assert.deepEqual(compile.diagnostics, []); assert.equal(compile.productInputs.length, 4);
for (const row of compile.productInputs) {
  const bytes = git(['show', `${compile.head}:${row.path}`]); assert.equal(hash(bytes), row.sha256);
  if (!write) assert.equal(git(['rev-parse', `HEAD:${row.path}`]).toString().trim(), row.blob);
}
const passed = rawOutputs.get('evidence/prune-exact-source-regressions-output.raw.json').toString();
assert.match(passed, /pass 5/); assert.match(passed, /fail 0/); assert.match(passed, /skipped 0/);
console.log(JSON.stringify({ result: 'pass', mode: write ? 'write-index' : 'verify-committed-Git', payloads: value.payloads.length,
  rawOutputs: rawOutputs.size, sourceHead: source.sourceHead, cases: 5, productCompilerInputs: 4,
  changedSqlCommentBytes: 4, executableSqlIdenticalAfterExcludingOnlyFullCommentLines: true,
  scope: 'Finite source/hash/compiler/evidence verification; no independent/native/live acceptance' }));
