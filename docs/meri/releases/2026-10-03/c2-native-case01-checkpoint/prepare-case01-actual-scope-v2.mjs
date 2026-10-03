import assert from 'node:assert/strict';
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildCase01Scope } from './case01-native-bootstrap-v2/run-case01-native.mjs';
import { inspectCase01Scope } from '../../meri-c1-20261002/evals/meri/live-v1/case01-live-capture.mjs';
const root = 'C:/dev/main/outputs/meri-c2-20261003';
const repo = 'C:/dev/main/meri-c1-20261002';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
};
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
assert.equal(git('status', '--porcelain'), '');
assert.equal(git('rev-parse', 'HEAD'), 'b7918cd947e6cc7fb8c83ee171e5fa50e483e7aa');
assert.equal(hash(readFileSync(root + '/case01-native-bootstrap-v2/run-case01-native.mjs')), '655cc278a1a76ff55cf7a0ceae96ccfc325a016e0e3a0d53c21f43f276c171d1');
assert.equal(hash(readFileSync(root + '/case01-native-bootstrap-v2/read-only-review-v2.json')), '156288f5096f8e40fdaa469e059f7e831e4d0d23535eba7aee8d852b0841f5e9');
const result = read(root + '/case01-native-setup-execute-v3/result.json');
assert.equal(result.status, 'BOUND_AND_BUDGET_READ_BACK');
assert.equal(result.exitCode, 0);
assert.equal(result.cleanup.taskStopped, true);
assert.equal(result.cleanup.taskDefinitionInactive, true);
assert.deepEqual(result.failures, []);
assert.equal(result.observedFailures.some(x => x.fatal), false);
const receipt = root + '/case01-native-setup-execute-v3/inner-receipt.jsonl';
assert.equal(result.innerReceipt.sha256, hash(readFileSync(receipt)));
const manifest = root + '/case01-recovered-auth-scope.private.json';
assert.equal(hash(readFileSync(manifest)), 'ed9c3b1c11014825b29ee2879796e20b3f0023959ed9e478337180b96ed7a062');
const input = read(root + '/case01-native-bootstrap-v2/scope-input.template.json');
Object.assign(input, {
  expectedWebSha: '78ad5805679a3045b1fc10fb19beafa7f76e4e64',
  operatorSourceSha: git('rev-parse', 'HEAD'), manifestSha256: hash(readFileSync(manifest)),
  setupReceiptPath: receipt, setupReceiptSha256: hash(readFileSync(receipt)),
});
const built = buildCase01Scope(input);
const staticInspection = inspectCase01Scope({ ...built.config, conversationId: built.config.captureRunId }, { MERI_LIVE_BEARER_TOKEN: 'static-shape-inspection-only' });
const scopePath = root + '/case01-native-actual-scope-v2.json';
assert.equal(existsSync(scopePath), false);
save(scopePath, input);
save(root + '/case01-native-actual-scope-v2-inspection.json', {
  status: 'ACTUAL_SETUP_SCOPE_STATIC_INSPECTION_PASS', recordedAt: new Date().toISOString(),
  scopePath, scopeSha256: hash(readFileSync(scopePath)), setupResultSha256: hash(readFileSync(root + '/case01-native-setup-execute-v3/result.json')),
  setupProof: built.setupProof, staticInspection, operatorSourceSha: input.operatorSourceSha,
  scopeAuthority: false, fixtureAuthority: false, captureAuthority: false,
  journalWrites: 0, providerCalls: 0, conversationCreations: 0,
});
console.log(JSON.stringify({ status: 'ACTUAL_SETUP_SCOPE_STATIC_INSPECTION_PASS', scopePath, scopeSha256: hash(readFileSync(scopePath)), setupProof: built.setupProof }));
