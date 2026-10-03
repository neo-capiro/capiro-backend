import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const parent = 'C:/dev/main/outputs/meri-c2-20261003';
const out = parent + '/case01-native-setup-v4-review';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashed = path => ({ path, sha256: hash(readFileSync(path)) });
const files = [
  parent + '/run-case01-native-setup-v4.mjs',
  parent + '/case01-native-setup-v4-definition.mjs',
  out + '/definition-normalization.test.mjs', out + '/check-offline.mjs',
  out + '/prepare-v4.mjs', out + '/freeze-v4.mjs',
];
const priorPins = [
  [parent + '/run-case01-native-setup-v3.mjs', '39219647361b76d232d2dd4251e9a574277f814a502d601cdc4ca863826cfd43'],
  [parent + '/case01-native-setup-v1/case01-native-setup-inner.mjs', '632d00e47ec63fb8c0b49cfa0d166760bd16abbf5ded9b572c0a9cf235f9899d'],
  [parent + '/case01-native-setup-v1/case01-reviewed-rates-v2.json', '3531e09dfcce9f66b4ea2b3564db47bd72dc507cdcf1aecdda277b838007704e'],
  [parent + '/corpus-read-definition-input.json', '6c0a447dc99ed35642df735c38d09e02b12b33983fe461b707cd0c06a8a44478'],
  [parent + '/case01-native-setup-plan-v1-reconciliation.json', 'b59923080aace193f676921ff8a449ff62b7e527fda80135ec2080255727e232'],
];
for (const [path, expected] of priorPins) assert.equal(hash(readFileSync(path)), expected);
for (const mode of ['plan', 'execute']) assert.equal(existsSync(parent + '/case01-native-setup-' + mode + '-v2'), false);
mkdirSync(out + '/source');
const sourceFiles = files.map(path => {
  const bytes = readFileSync(path), mirror = out + '/source/' + path.split('/').at(-1);
  writeFileSync(mirror, bytes, { flag: 'wx' });
  return { ...hashed(path), mirror, mirrorSha256: hash(readFileSync(mirror)) };
});
const evidenceNames = readdirSync(out).filter(name => /\.(json|log|diff|md)$/.test(name));
const checkpoint = {
  schemaVersion: 1, frozenAt: new Date().toISOString(), status: 'FROZEN_FOR_INDEPENDENT_REVIEW_PREPARATION_ONLY',
  sourceFiles, preservedPins: priorPins.map(([path]) => hashed(path)),
  retainedDefinitions: ['definition-input.private.json', 'definition-readback.private.json', 'result.json'].map(name => hashed(parent + '/case01-native-setup-plan-v1/' + name)),
  evidence: evidenceNames.map(name => hashed(out + '/' + name)),
  validation: { normalizationTests: 41, normalizationPassed: 41, normalizationExit: 0, v3ExactComparisonRedExit: 1, receiptParserAndWrapperChecks: 14, receiptParserExit: 0, dispatcherSyntaxExit: 0 },
  unchanged: ['inner source', 'API source/image', 'rate bytes', 'task template', 'one-shot action count', 'receipt assembler and wrapper', 'cleanup and uncertain-outcome gates', 'old plan directories', 'repository sources'],
  execution: { dispatcherImported: false, dispatcherExecuted: false, remoteCalls: 0, providerCalls: 0, authCalls: 0, databaseCalls: 0, journalWrites: 0 },
  limits: 'Local saved-data normalization, syntax and extracted parser tests only. Fresh live task/state/canonical owner evidence remains unexecuted and unproved.'
};
writeFileSync(out + '/checkpoint.json', JSON.stringify(checkpoint, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ checkpoint: hashed(out + '/checkpoint.json'), sourceFiles }));
