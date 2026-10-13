'use strict';
const fs = require('node:fs');
const refuse = () => { throw new Error('SCHEMA_DIFF_NETWORK_REFUSED'); };
for (const name of ['node:net', 'node:tls']) {
  const module = require(name);
  for (const key of ['connect', 'createConnection']) module[key] = refuse;
}
require('node:net').Socket.prototype.connect = refuse;
for (const name of ['node:http', 'node:https'])
  for (const key of ['request', 'get']) require(name)[key] = refuse;
global.fetch = refuse;
const read = fs.readFileSync;
fs.readFileSync = function(filename, ...args) {
  if (/(?:^|\/)\.env(?:\.|$)/.test(String(filename))) throw new Error('SCHEMA_DIFF_DOTENV_REFUSED');
  return read.call(this, filename, ...args);
};
