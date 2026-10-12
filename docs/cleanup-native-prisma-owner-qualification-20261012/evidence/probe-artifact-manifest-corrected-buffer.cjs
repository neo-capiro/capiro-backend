'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const p = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(p, 'native-prisma-owner-harness.cjs'), 'utf8');
const actual = JSON.parse(fs.readFileSync(path.join(p, 'ENGINE-CLIENT-IDENTITIES.json'), 'utf8'));
let manifest = actual, reads = 0;
const moduleValue = { exports: {} };
const fakeFs = { readFileSync(file) { if (file.endsWith('ENGINE-CLIENT-IDENTITIES.json')) return JSON.stringify(manifest); reads++; return fs.readFileSync(file); } };
vm.runInNewContext(source, { module: moduleValue, exports: moduleValue.exports, __dirname: p, URL, Buffer, process: { argv: [], env: {} }, require: (name) => {
  if (name === 'node:fs') return fakeFs;
  if (name === 'node:path') return path;
  if (name === 'node:assert/strict') return assert;
  if (name === 'node:crypto') return crypto;
  if (name.includes('native-contract-harness')) return { TARGET: {}, validateTarget() { throw new Error('Native target unavailable'); } };
  if (name === './canonical-native-loader.cjs') return { ROOT: path.resolve(p, '../..'), CORE_CLIENT: actual.clients[0].path, apiRequire() { throw new Error('Driver refused'); }, loadCanonical() { throw new Error('Owners refused'); }, verifyBindings() { throw new Error('Owner reads refused'); } };
  if (name === './fixture-assembly.cjs') return { assembleFixture() { throw new Error('Fixture refused'); } };
  throw new Error('Unexpected import');
} }, { filename: 'frozen-native-prisma-owner-harness.cjs' });
const rows = [];
for (const [name, value] of [['canonical complete manifest', actual], ['empty clients array', { ...actual, clients: [] }], ['one client removed', { ...actual, clients: actual.clients.slice(0, 1) }], ['all artifacts removed', { ...actual, clients: actual.clients.map((c) => ({ ...c, artifacts: [] })) }]]) {
  manifest = value; reads = 0; let accepted;
  try { moduleValue.exports.verifyArtifacts(); accepted = true; } catch { accepted = false; }
  rows.push({ name, accepted, artifactReads: reads, driverLoaded: false, sqlExecuted: false });
}
const result = { source: 'artifact guard correction from immutable ec6b; commit pending workspace disk' , manifestHashBoundBySealedPacket: true, cases: rows, qualification: 'Same four-input corpus. Candidate guard recomputes source equality; non-manifest reads include10artifacts+2boundsource schemas. No driver/client/SQL. Onlyp/ROOT/NodeBuffer/outputmetadata adaptation from originalprobe.' };
fs.writeFileSync(path.join(__dirname, '05-corrected-artifact-manifest-probe.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
