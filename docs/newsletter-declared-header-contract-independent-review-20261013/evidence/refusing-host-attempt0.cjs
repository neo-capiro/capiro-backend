'use strict';
const Module = require('node:module');
const fs = require('node:fs');
const url = require('node:url');
const deny = () => { throw new Error('Independent inert header review refuses external effect'); };
for (const name of ['node:net', 'node:http', 'node:https', 'node:tls', 'node:dgram', 'node:dns', 'node:child_process']) {
  const owner = require(name);
  for (const key of Object.keys(owner)) if (typeof owner[key] === 'function') {
    try { owner[key] = deny; } catch {}
  }
}
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
