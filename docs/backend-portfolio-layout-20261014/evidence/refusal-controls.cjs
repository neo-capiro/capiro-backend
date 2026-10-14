const assert = require('node:assert/strict');
const fs = require('node:fs');
const probes = [
  ['sync protected read', () => fs.readFileSync('/tmp/engagement.service.ts')],
  ['sync protected open', () => fs.openSync('/tmp/engagement.service.ts')],
  ['protected stream', () => fs.createReadStream('/tmp/engagement.service.ts')],
  ['promise protected read', () => fs.promises.readFile('/tmp/engagement.service.ts')],
  ['promise protected open', () => fs.promises.open('/tmp/engagement.service.ts')],
  ['fetch', () => fetch('https://example.invalid')],
  ['child', () => require('node:child_process').spawn('untrusted')],
  ['socket', () => require('node:net').connect(12345, '127.0.0.1')],
  ['listener', () => require('node:net').createServer().listen(0)],
  ['HTTPS', () => require('node:https').get('https://example.invalid')],
  ['DNS', () => require('node:dns').lookup('example.invalid', () => {})],
  ['native engine', () => process.dlopen({}, '/tmp/libquery_engine.node')],
];
for (const [label, probe] of probes) assert.throws(probe, /PORTFOLIO_LAYOUT_TEST_REFUSAL/, label);
console.log(JSON.stringify({ total: probes.length, refusedBeforeEffects: probes.length,
  limits: 'Selected self-refusal controls; not arbitrary runtime containment or native database acceptance' }));
