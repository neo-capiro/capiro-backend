'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const ownedPorts = new Set();
const journal = { bindings: [], connections: 0, refused: [], closed: [] };
const refuse = label => { journal.refused.push(label); throw new Error('Source mock host refused: ' + label); };
const protectedPath = file => path.resolve(String(file)).replaceAll('\\', '/').endsWith('/apps/api/src/engagement/engagement.service.ts');
for (const method of ['readFileSync', 'readFile']) {
  const original = fs[method];
  fs[method] = function(file, ...args) { if (protectedPath(file)) refuse('protected reporting source'); return original.call(this, file, ...args); };
}
const read = fs.promises.readFile;
fs.promises.readFile = function(file, ...args) { if (protectedPath(file)) refuse('protected reporting source'); return read.call(this, file, ...args); };
const gitShow = cp.execFileSync;
cp.execFileSync = function(command, args, options) {
  const allowed = new Set(['apps/web/Dockerfile','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','apps/onboard-api/Dockerfile'].map(p => '0a76666dc57aa852586c35167426a540939c9918:' + p));
  if (command !== 'git' || !Array.isArray(args) || args.length !== 2 || args[0] !== 'show' || !allowed.has(args[1])) refuse('child command');
  return gitShow.call(this, command, args, options);
};
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'fork']) cp[method] = () => refuse('child ' + method);
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  if (args[0] !== 0 || args[1] !== '127.0.0.1' || (args.length > 2 && typeof args[2] !== 'function')) refuse('non-ephemeral/nonliteral mock bind');
  this.once('listening', () => {
    const address = this.address();
    if (!address || address.address !== '127.0.0.1' || !Number.isInteger(address.port)) refuse('mock bound address');
    ownedPorts.add(address.port); journal.bindings.push(address.port);
    this.once('close', () => { ownedPorts.delete(address.port); journal.closed.push(address.port); });
  });
  return listen.apply(this, args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = options && typeof options === 'object' ? (options.host ?? options.hostname) : args[1];
  const port = options && typeof options === 'object' ? options.port : options;
  if (host !== '127.0.0.1' || !Number.isInteger(Number(port)) || !ownedPorts.has(Number(port))) refuse('connection outside own mock ports');
  journal.connections++;
  return connect.apply(this, args);
};
for (const [name, methods] of [['node:tls', ['connect', 'createServer']], ['node:https', ['request', 'get', 'createServer']], ['node:dgram', ['createSocket']]]) {
  for (const method of methods) require(name)[method] = () => refuse(name + ':' + method);
}
const dns = require('node:dns');
for (const name of Object.keys(dns)) if (typeof dns[name] === 'function') dns[name] = () => refuse('DNS');
for (const name of Object.keys(dns.promises)) if (typeof dns.promises[name] === 'function') dns.promises[name] = () => refuse('DNS promises');
// Node's listen(0, literalIPv4) invokes dns.lookup even for the literal IP.
// Satisfy only that exact local callback with fixed data; never call a resolver.
dns.lookup = function(hostname, options, callback) {
  if (hostname !== '127.0.0.1') refuse('nonliteral DNS lookup');
  if (typeof options === 'function') { callback = options; options = undefined; }
  if (typeof callback !== 'function') refuse('DNS callback shape');
  journal.literalLocalLookups = (journal.literalLocalLookups ?? 0) + 1;
  process.nextTick(() => options && typeof options === 'object' && options.all === true
    ? callback(null, [{ address: '127.0.0.1', family: 4 }])
    : callback(null, '127.0.0.1', 4));
};
globalThis.fetch = () => refuse('fetch');
require('node:module').syncBuiltinESMExports();
process.on('exit', () => {
  journal.ownedPortsRemaining = [...ownedPorts];
  process.stderr.write('INDEPENDENT_MOCK_HOST_JOURNAL ' + JSON.stringify(journal) + '\n');
});
