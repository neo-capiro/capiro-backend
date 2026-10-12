require('./no-external-ports.cjs');
const fs = require('node:fs');
const path = require('node:path');
const denied = value => typeof value === 'string' && path.resolve(value).includes('/apps/web/');
const read = fs.readFileSync;
fs.readFileSync = function (value, ...options) {
  if (denied(value)) throw new Error(`Static-fixture qualification refused Web read: ${value}`);
  return read.call(this, value, ...options);
};
const asyncRead = fs.readFile;
fs.readFile = function (value, ...options) {
  if (denied(value)) throw new Error(`Static-fixture qualification refused Web read: ${value}`);
  return asyncRead.call(this, value, ...options);
};
const promisedRead = fs.promises.readFile;
fs.promises.readFile = function (value, ...options) {
  if (denied(value)) throw new Error(`Static-fixture qualification refused Web read: ${value}`);
  return promisedRead.call(this, value, ...options);
};
