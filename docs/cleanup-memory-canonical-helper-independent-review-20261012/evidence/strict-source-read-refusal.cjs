require('./no-external-ports.cjs');
const fs = require('node:fs');
const path = require('node:path');
const refused = value => typeof value === 'string' && /\/src\/engagement\/engagement\.service\.ts$/.test(path.resolve(value));
for (const name of ['readFileSync', 'readFile']) {
  const original = fs[name];
  fs[name] = function (value, ...options) {
    if (refused(value)) throw new Error(`Memory contract host refused unselected protected implementation read: ${value}`);
    return original.call(this, value, ...options);
  };
}
const original = fs.promises.readFile;
fs.promises.readFile = function (value, ...options) {
  if (refused(value)) throw new Error(`Memory contract host refused unselected protected implementation read: ${value}`);
  return original.call(this, value, ...options);
};
require('node:module').syncBuiltinESMExports();
