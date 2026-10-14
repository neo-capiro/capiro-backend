const fs = require('node:fs');
const path = require('node:path');
const fail = (action) => { throw new Error(`PORTFOLIO_LAYOUT_TEST_REFUSAL:${action}`); };
function inspect(value) {
  if (value instanceof URL) value = value.pathname;
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') return;
  const file = path.resolve(value);
  if (/(?:^|[\\/])engagement\.service\.(?:ts|js)$/.test(file)) fail('protected reporting source');
}
for (const name of ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream']) {
  const original = fs[name]; fs[name] = function (value, ...args) { inspect(value); return original.call(this, value, ...args); };
}
for (const name of ['readFile', 'open']) {
  const original = fs.promises[name]; fs.promises[name] = function (value, ...args) { inspect(value); return original.call(this, value, ...args); };
}
global.fetch = () => fail('fetch');
const child = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[name] = () => fail(`child:${name}`);
const net = require('node:net');
net.connect = net.createConnection = () => fail('network connect');
net.Socket.prototype.connect = () => fail('socket connect');
net.Server.prototype.listen = () => fail('listener');
const tls = require('node:tls'); tls.connect = () => fail('TLS');
for (const module of [require('node:http'), require('node:https')])
  for (const name of ['request', 'get']) module[name] = () => fail(`HTTP:${name}`);
const dns = require('node:dns');
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'reverse']) {
  dns[name] = () => fail(`DNS:${name}`);
  if (dns.promises[name]) dns.promises[name] = () => fail(`DNS promises:${name}`);
}
const dlopen = process.dlopen;
process.dlopen = function (module, filename, ...args) {
  if (/query[_-]engine|schema[_-]engine/i.test(String(filename))) fail('native Prisma engine');
  return dlopen.call(this, module, filename, ...args);
};
