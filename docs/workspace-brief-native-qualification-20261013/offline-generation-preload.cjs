'use strict';
const fs = require('node:fs');
const cp = require('node:child_process');
const generator = '/workspace/capirov2/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client/generator-build/index.js';
const refuse = kind => { throw new Error('OFFLINE_GENERATION_REFUSED: ' + kind); };
for (const name of ['node:net', 'node:tls']) {
  const module = require(name);
  for (const key of ['connect', 'createConnection']) module[key] = () => refuse(name + '.' + key);
}
require('node:net').Socket.prototype.connect = () => refuse('socket.connect');
for (const name of ['node:http', 'node:https'])
  for (const key of ['request', 'get']) require(name)[key] = () => refuse(name + '.' + key);
for (const module of [require('node:dns'), require('node:dns/promises')])
  for (const key of Object.keys(module)) if (/^(lookup|resolve)/.test(key)) module[key] = () => refuse('dns.' + key);
global.fetch = () => refuse('fetch');
const dlopen = process.dlopen;
process.dlopen = function(module, filename, ...args) {
  if (/query_engine|query-engine/.test(String(filename))) return refuse('native query engine load');
  return dlopen.call(this, module, filename, ...args);
};
const fork = cp.fork;
cp.fork = function(filename, args, options) {
  if (filename !== generator || args.length !== 0) return refuse('unapproved fork');
  if (Object.keys(options.env).sort().join(',') !== 'PATH,PRISMA_GENERATOR_INVOCATION,XDG_CACHE_HOME') return refuse('child environment');
  return fork(filename, args, { ...options, execArgv: [...options.execArgv, '--require', __filename] });
};
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) cp[key] = () => refuse('child_process.' + key);
const read = fs.readFileSync;
fs.readFileSync = function(filename, ...args) {
  if (/(?:^|\/)\.env(?:\.|$)/.test(String(filename))) return refuse('dotenv read');
  return read.call(this, filename, ...args);
};
