require('./no-external-ports.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
function checked(value) {
  const text = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
  if (typeof text === 'string' && path.resolve(text).includes('/apps/web/')) throw new Error('Independent fixture qualification refused live Web read: ' + text);
  if (typeof text === 'string' && path.resolve(text).endsWith('/apps/api/src/engagement/engagement.service.ts')) throw new Error('Independent fixture qualification refused protected reporting body read');
}
for (const name of ['readFileSync', 'readFile']) {
  const old = fs[name];
  fs[name] = function(value, ...args) { checked(value); return old.call(this, value, ...args); };
}
const oldPromiseRead = fs.promises.readFile;
fs.promises.readFile = function(value, ...args) { checked(value); return oldPromiseRead.call(this, value, ...args); };
