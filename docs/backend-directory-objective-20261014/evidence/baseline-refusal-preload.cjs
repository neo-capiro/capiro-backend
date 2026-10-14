const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const target = path.join(root, 'apps/api/src/clients/client-targets.service.ts');
const original = fs.readFileSync;
const baseline = original(path.join(__dirname, 'baseline-client-targets.source.txt'));
let reads = 0;
fs.readFileSync = function(file, options, ...args) {
  if (typeof file === 'string' && path.resolve(file) === target) {
    reads++;
    return typeof options === 'string' || options?.encoding ? baseline.toString(typeof options === 'string' ? options : options.encoding) : Buffer.from(baseline);
  }
  return original.call(this, file, options, ...args);
};
process.on('exit', () => fs.writeFileSync(path.join(__dirname, 'baseline-overlay-receipt.json'), JSON.stringify({
  sourceHead: 'be12f4a2a2ecec43b5d02ea279d9448763415e24', sourceBlob: 'f79f0568d1c521afacf2249693a97d6b16be8efb',
  target, overlaidReads: reads, note: 'Jest baseline transpilation received exact Git service bytes without changing any product source.'
}, null, 2) + '\n'));
require('./source-refusal-preload.cjs');
