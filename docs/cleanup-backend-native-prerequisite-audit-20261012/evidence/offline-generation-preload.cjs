'use strict';
// Task-local refusal probes, not an OS containment or production policy change.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = '/tmp/capirov2-local-native-prerequisite-20261012';
const generator = '/workspace/capirov2/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client/generator-build/index.js';
const probes = [];
function refuse(kind) { probes.push(kind); throw new Error('offline-qualification refusal: ' + kind); }
for (const name of ['node:net', 'node:tls']) {
  const m = require(name);
  for (const key of ['connect', 'createConnection']) if (typeof m[key] === 'function') m[key] = () => refuse(name + '.' + key);
}
require('node:net').Socket.prototype.connect = () => refuse('socket.connect');
for (const name of ['node:http', 'node:https']) {
  const m = require(name);
  for (const key of ['request', 'get']) m[key] = () => refuse(name + '.' + key);
}
for (const m of [require('node:dns'), require('node:dns/promises')]) {
  for (const key of Object.keys(m)) if (/^(lookup|resolve)/.test(key) && typeof m[key] === 'function') m[key] = () => refuse('dns.' + key);
}
global.fetch = () => refuse('fetch');
const originalDlopen = process.dlopen;
process.dlopen = function (module, filename, ...args) {
  if (/query_engine|query-engine/.test(String(filename))) return refuse('query-engine load');
  return originalDlopen.call(this, module, filename, ...args);
};
const originalFork = cp.fork;
cp.fork = function (filename, args, options) {
  if (filename !== generator || args.length !== 0) return refuse('unapproved fork');
  const keys = Object.keys(options.env).sort();
  if (keys.join(',') !== 'PATH,PRISMA_GENERATOR_INVOCATION,XDG_CACHE_HOME') return refuse('unexpected child environment');
  return originalFork(filename, args, { ...options, execArgv: [...options.execArgv, '--require', __filename] });
};
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) cp[key] = () => refuse('child_process.' + key);
const originalRead = fs.readFileSync;
fs.readFileSync = function (filename, ...args) {
  if (typeof filename === 'string' && /(^|\/)\.env(?:\.|$)/.test(filename)) return refuse('dotenv read');
  return originalRead.call(this, filename, ...args);
};
const originalWrite = fs.writeFileSync;
process.on('exit', () => {
  originalWrite(path.join(root, 'probe-' + process.pid + '.json'), JSON.stringify({ pid: process.pid, generatorChild: process.env.PRISMA_GENERATOR_INVOCATION === 'true', probes }) + '\n');
});
