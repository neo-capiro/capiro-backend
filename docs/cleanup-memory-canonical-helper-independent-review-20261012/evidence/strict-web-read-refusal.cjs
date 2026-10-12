require('./strict-source-read-refusal.cjs');
const fs = require('node:fs'), path = require('node:path');
const denied = value => typeof value === 'string' && path.resolve(value).includes('/apps/web/');
for (const name of ['readFileSync', 'readFile']) {
  const original = fs[name];
  fs[name] = function (value, ...options) {
    if (denied(value)) throw new Error(`Memory contract host refused Web source read: ${value}`);
    return original.call(this, value, ...options);
  };
}
const original = fs.promises.readFile;
fs.promises.readFile = function (value, ...options) {
  if (denied(value)) throw new Error(`Memory contract host refused Web source read: ${value}`);
  return original.call(this, value, ...options);
};
require('node:module').syncBuiltinESMExports();
