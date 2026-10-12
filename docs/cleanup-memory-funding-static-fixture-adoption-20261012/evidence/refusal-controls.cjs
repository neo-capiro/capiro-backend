require('./web-read-refusal.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const checks = [
  ['Web read', () => require('node:fs').readFileSync(path.join(root, 'apps/web/src/components/MemoryFileEditor.tsx'))],
  ['net connection', () => require('node:net').connect({ host: 'invalid.test', port: 1 })],
  ['socket connection', () => new (require('node:net').Socket)().connect({ host: 'invalid.test', port: 1 })],
  ['http request', () => require('node:http').request('http://invalid.test')],
  ['https request', () => require('node:https').request('https://invalid.test')],
  ['DNS lookup', () => require('node:dns').lookup('invalid.test', () => {})],
  ['fetch', () => fetch('https://invalid.test')],
  ['child process', () => require('node:child_process').spawn('must-not-run')],
];
for (const [name, callback] of checks) assert.throws(callback, /refused/, name);
console.log(JSON.stringify({ controls: checks.map(([name]) => ({ name, refused: true })), actualSocketOrChildCreated: false }, null, 2));
