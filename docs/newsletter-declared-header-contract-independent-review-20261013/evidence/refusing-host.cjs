'use strict';
const Module = require('node:module');
const fs = require('node:fs');
const url = require('node:url');
const deny = () => { throw new Error('Independent inert header review refuses external effect'); };
const owners = Object.fromEntries(['node:net', 'node:http', 'node:https', 'node:tls', 'node:dgram', 'node:dns', 'node:child_process'].map(name=>[name,require(name)]));
for (const [name,keys] of Object.entries({
  'node:net':['connect','createConnection','createServer'],
  'node:http':['request','get','createServer'],
  'node:https':['request','get','createServer'],
  'node:tls':['connect','createServer'],
  'node:dgram':['createSocket'],
  'node:child_process':['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'],
})) for (const key of keys) owners[name][key]=deny;
owners['node:net'].Server.prototype.listen=deny;
owners['node:net'].Socket.prototype.connect=deny;
for (const key of Object.keys(owners['node:dns'])) if (/^(?:lookup|resolve|reverse)/.test(key) && typeof owners['node:dns'][key]==='function') owners['node:dns'][key]=deny;
for (const key of Object.keys(owners['node:dns'].promises)) if (typeof owners['node:dns'].promises[key]==='function' && key!=='Resolver') owners['node:dns'].promises[key]=deny;
globalThis.fetch = deny;
const forbidden = value => {
  let p = value;
  if (p instanceof URL) p = url.fileURLToPath(p);
  if (Buffer.isBuffer(p)) p = p.toString();
  return typeof p === 'string' && /(?:^|\/)apps\/api\/src\/engagement\/engagement\.service\.ts$/.test(p);
};
for (const key of ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream']) {
  const original = fs[key];
  fs[key] = function(value, ...args) { if (forbidden(value)) deny(); return original.call(this, value, ...args); };
}
for (const key of ['readFile', 'open']) {
  const original = fs.promises[key];
  fs.promises[key] = function(value, ...args) { if (forbidden(value)) deny(); return original.call(this, value, ...args); };
}
Module.syncBuiltinESMExports();
