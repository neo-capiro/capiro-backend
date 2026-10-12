'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
assert.deepEqual(Object.keys(process.env).sort(), ['PATH', 'XDG_CACHE_HOME']);
const filename = '/workspace/capirov2/node_modules/.pnpm/@prisma+engines@5.22.0/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node';
const hash = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
assert.equal(hash, '35860a5c0fb2f79e7b38c40747c4d212318d97e1910ca528b133c802716de0b8');
const probes = [];
function refused(kind) { probes.push(kind); throw new Error('native-version-only refusal: ' + kind); }
for (const name of ['node:net', 'node:tls', 'node:http', 'node:https']) {
  const m = require(name);
  for (const key of ['connect', 'createConnection', 'request', 'get']) if (typeof m[key] === 'function') m[key] = () => refused(name + '.' + key);
}
require('node:net').Socket.prototype.connect = () => refused('socket.connect');
global.fetch = () => refused('fetch');
for (const name of ['node:dns', 'node:dns/promises']) {
  const m = require(name);
  for (const key of Object.keys(m)) if (/^(lookup|resolve)/.test(key) && typeof m[key] === 'function') m[key] = () => refused('dns.' + key);
}
const cp = require('node:child_process');
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = () => refused('child_process.' + key);
const originalDlopen = process.dlopen;
process.dlopen = function (module, file, ...args) {
  assert.equal(file, filename, 'refusing unrelated native addon');
  return originalDlopen.call(this, module, file, ...args);
};
// Official5.22 chunk-G7LL2H2O uses QE.version().commit independently of QueryEngine construction.
const native = require(filename);
assert.equal(typeof native.version, 'function');
const version = native.version();
assert.equal(version.commit, '605197351a3c8bdd595af2d2a9bc3025bca48ea2');
assert.equal(probes.length, 0);
console.log(JSON.stringify({ source: '61e9b467295235829e7d8097368ce41b0434818a', filename, sha256: hash, exports: Object.keys(native), version, probes, clientRequiredOrInstantiated: false, queryEngineConstructed: false, connectOrQueryCalled: false, qualification: 'Native host NAPI addon loading and version only; no ARM64 execution, SQL/database/client/runtime qualification.' }, null, 2));
