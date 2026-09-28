import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256RawBytes } from '../artifact-reader.mjs';
import { RecordedCaptureProvider } from '../recorded-provider.mjs';
import { evaluateCapture, verifyCaptureBundle } from '../verify-capture.mjs';
import { caseById, completeCapture, materializeUnitBundle, writeArtifact } from './helpers.mjs';

function result(report, caseId) {
  return report.results.find((item) => item.caseId === caseId);
}

function unit(t, variants) {
  const value = materializeUnitBundle(variants);
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  return value;
}

function replaceAnswer(root, capture, text) {
  const descriptor = writeArtifact(root, capture.evidence.status.answerRef, text);
  capture.evidence.status.answerSha256 = descriptor.sha256;
}

function mutateJson(root, descriptor, mutate) {
  const path = join(root, ...descriptor.ref.split('/'));
  const value = JSON.parse(readFileSync(path, 'utf8'));
  mutate(value);
  const updated = writeArtifact(root, descriptor.ref, value);
  descriptor.sha256 = updated.sha256;
  return value;
}

test('missing live captures remain 75 NOT_RUN with no inferred score', () => {
  const report = verifyCaptureBundle({ captures: [] });
  assert.equal(report.valid, true);
  assert.deepEqual(report.counts, { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 75 });
  assert.equal(report.score, null);
});

test('accepted pre-repair fake captures now fail closed without artifact bytes', () => {
  for (const id of ['01', '03', '12', '19', '20', '46', '51', '56', '72']) {
    const capture = completeCapture(id);
    const evaluated = evaluateCapture(capture, caseById(id));
    assert.equal(evaluated.status, 'NOT_RUN', id);
    assert.match(evaluated.reason, /artifact reader.*required/u, id);
  }
});

test('captured fake case without a schema-valid run bundle is BLOCKED, never PASS', () => {
  const report = verifyCaptureBundle({ captures: [completeCapture('20')] });
  assert.equal(report.valid, false);
  assert.equal(report.counts.BLOCKED, 75);
  assert.equal(report.counts.PASS, 0);
  assert.match(report.errors.join('\n'), /artifactRoot|runManifest|traceArtifact/u);
});

test('actual saved case 20 UNIT bytes and Standard/Deep matrix validate but remain NOT live', (t) => {
  const { bundle } = unit(t, [
    { id: '20', runtimeMode: 'Standard', verificationMode: 'default', pairId: 'case20-pair' },
    { id: '20', runtimeMode: 'Deep', verificationMode: 'default', pairId: 'case20-pair' },
  ]);
  const report = verifyCaptureBundle(bundle);
  assert.equal(report.valid, true, report.errors.join('\n'));
  assert.equal(report.counts.PASS, 0);
  assert.equal(result(report, '20').status, 'NOT_RUN');
  assert.match(result(report, '20').reason, /UNIT fixture.*NOT live/iu);
  assert.match(result(report, '20').details.join('\n'), /hashes, correlations, row predicate.*validated/u);
});

test('case 20 evaluates actual answer bytes rather than caller passed booleans', (t) => {
  const { root, bundle } = unit(t, [
    { id: '20', runtimeMode: 'Standard', verificationMode: 'default', pairId: 'case20-pair' },
    { id: '20', runtimeMode: 'Deep', verificationMode: 'default', pairId: 'case20-pair' },
  ]);
  for (const capture of bundle.captures) replaceAnswer(root, capture, 'The answer is $48M at made-up-page-999.');
  const caseResult = result(verifyCaptureBundle(bundle), '20');
  assert.equal(caseResult.status, 'NOT_RUN');
  assert.match(caseResult.details.join('\n'), /answer bytes do not contain case 20 exact/u);
});

test('case 01 detects Bluehaven content in actual saved answer bytes', (t) => {
  const { root, bundle } = unit(t, [
    { id: '01', runtimeMode: 'Standard', verificationMode: 'default', pairId: 'case01-pair' },
    { id: '01', runtimeMode: 'Deep', verificationMode: 'default', pairId: 'case01-pair' },
  ]);
  for (const capture of bundle.captures) replaceAnswer(root, capture, 'Synthetic Bluehaven-only briefing preference');
  const caseResult = result(verifyCaptureBundle(bundle), '01');
  assert.equal(caseResult.status, 'NOT_RUN');
  assert.match(caseResult.details.join('\n'), /forbidden source content from MB1/u);
});

test('case 03 detects an Office Delta recommendation from actual answer bytes', (t) => {
  const { root, bundle } = unit(t, [{ id: '03' }]);
  replaceAnswer(root, bundle.captures[0], 'I recommend we contact Office Delta for Aster.');
  const caseResult = result(verifyCaptureBundle(bundle), '03');
  assert.equal(caseResult.status, 'NOT_RUN');
  assert.match(caseResult.details.join('\n'), /recommends Office Delta|does not reject/u);
});

test('case 12 cannot claim an old-memory pass without 500 distinct saved distractor rows', (t) => {
  const { bundle } = unit(t, [{ id: '12', completeCase12Setup: false }]);
  const caseResult = result(verifyCaptureBundle(bundle), '12');
  assert.equal(caseResult.status, 'NOT_RUN');
  assert.match(caseResult.details.join('\n'), /500 distinct newer eligible distractors/u);
});

test('case 12 counts 500 actual saved UNIT distractor rows but still is not live evidence', (t) => {
  const { bundle } = unit(t, [{ id: '12', completeCase12Setup: true }]);
  const caseResult = result(verifyCaptureBundle(bundle), '12');
  assert.equal(caseResult.status, 'NOT_RUN');
  assert.doesNotMatch(caseResult.details.join('\n'), /500 distinct newer eligible distractors/u);
  assert.match(caseResult.details.join('\n'), /hashes, correlations, row predicate.*validated/u);
});

test('case 19 requires captured first-click failure and retry transitions', (t) => {
  const { root, bundle } = unit(t, [{ id: '19' }]);
  const trace = bundle.captures[0].evidence.run.traceArtifact;
  mutateJson(root, trace, (value) => { value.transitions = value.transitions.filter((item) => item !== 'first_approval_click_failed_non_2xx'); });
  const caseResult = result(verifyCaptureBundle(bundle), '19');
  assert.equal(caseResult.status, 'NOT_RUN');
  assert.match(caseResult.details.join('\n'), /case 19 transition missing/u);
});

test('case 46 computes and checks actual downloaded bytes', (t) => {
  const { root, bundle } = unit(t, [{ id: '46' }]);
  const attachment = bundle.captures[0].evidence.sources.attachments[0];
  const wrong = writeArtifact(root, attachment.byteRef, 'wrong download bytes', { raw: true });
  attachment.byteSha256 = wrong.sha256;
  const caseResult = result(verifyCaptureBundle(bundle), '46');
  assert.equal(caseResult.status, 'NOT_RUN');
  assert.match(caseResult.details.join('\n'), /actual downloaded bytes do not match/u);
});

test('case 51 reconciles actual sink rows and rejects duplicate logical effects', (t) => {
  const { root, bundle } = unit(t, [
    { id: '51', runtimeMode: 'Standard', pairId: 'case51-pair' },
    { id: '51', runtimeMode: 'Deep', pairId: 'case51-pair' },
  ]);
  for (const capture of bundle.captures) {
    const descriptor = { ref: capture.evidence.effects.sinkRef, sha256: capture.evidence.effects.sinkSha256 };
    const sink = mutateJson(root, descriptor, (value) => {
      value.effects.push({ logicalEffectId: `${value.effects[0].logicalEffectId}-duplicate`, type: 'email_send', status: 'succeeded' });
      value.receipts.push({ receiptId: `${value.receipts[0].receiptId}-duplicate`, logicalEffectId: `${value.effects[0].logicalEffectId}-duplicate`, status: 'succeeded' });
    });
    capture.evidence.effects.sinkSha256 = descriptor.sha256;
    capture.evidence.effects.observedLogicalEffectCount = sink.effects.length;
    capture.evidence.effects.receiptIds = sink.receipts.map((item) => item.receiptId);
  }
  const caseResult = result(verifyCaptureBundle(bundle), '51');
  assert.equal(caseResult.status, 'NOT_RUN');
  assert.match(caseResult.details.join('\n'), /effect count 2 does not equal expected 1|exactly one unique logical effect/u);
});

test('case 56 shadow-only evidence cannot satisfy the enabled/shadow pair', (t) => {
  const { bundle } = unit(t, [{ id: '56', runtimeMode: 'Standard', verificationMode: 'shadow', pairId: 'case56-pair' }]);
  const caseResult = result(verifyCaptureBundle(bundle), '56');
  assert.equal(caseResult.status, 'NOT_RUN');
  assert.match(caseResult.reason, /mode matrix is incomplete/u);
  assert.match(caseResult.details.join('\n'), /enabled-canary/u);
});

test('mode matrix requires one stable pair ID', (t) => {
  const { bundle } = unit(t, [
    { id: '01', runtimeMode: 'Standard', pairId: 'pair-a' },
    { id: '01', runtimeMode: 'Deep', pairId: 'pair-b' },
  ]);
  const caseResult = result(verifyCaptureBundle(bundle), '01');
  assert.equal(caseResult.status, 'BLOCKED');
  assert.match(caseResult.reason, /stable pair ID/u);
});

test('case 72 false complete is detected from saved logical-error trace', (t) => {
  const { bundle } = unit(t, [{ id: '72' }]);
  const capture = bundle.captures[0];
  capture.evidence.status.terminal = 'complete';
  capture.evidence.status.answerStatus = 'complete';
  capture.evidence.status.claimedCompleted = true;
  const caseResult = result(verifyCaptureBundle(bundle), '72');
  assert.equal(caseResult.status, 'NOT_RUN');
  assert.match(caseResult.details.join('\n'), /falsely reports complete|false-success/u);
});

test('artifact traversal and remote URL refs are refused', (t) => {
  for (const ref of ['../outside.txt', 'https://example.invalid/answer.txt']) {
    const { bundle } = unit(t, [{ id: '12' }]);
    bundle.captures[0].evidence.status.answerRef = ref;
    const caseResult = result(verifyCaptureBundle(bundle), '12');
    assert.equal(caseResult.status, 'BLOCKED');
    assert.match(caseResult.details.join('\n'), /traversal|remote or URL/u);
  }
});

test('symlink artifact refs are refused', (t) => {
  const { root, bundle } = unit(t, [{ id: '12' }]);
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'outside bytes');
  const linked = join(root, 'captures', 'linked-answer.txt');
  symlinkSync(outside, linked, 'file');
  const capture = bundle.captures[0];
  capture.evidence.status.answerRef = 'captures/linked-answer.txt';
  capture.evidence.status.answerSha256 = sha256RawBytes(Buffer.from('outside bytes'));
  const caseResult = result(verifyCaptureBundle(bundle), '12');
  assert.equal(caseResult.status, 'BLOCKED');
  assert.match(caseResult.details.join('\n'), /symlink artifact ref refused/u);
});

test('schema validation rejects malformed actual capture shapes before evaluation', (t) => {
  const { bundle } = unit(t, [{ id: '12' }]);
  bundle.captures[0].evidence.runtime.tools[0].unexpected = true;
  const report = verifyCaptureBundle(bundle);
  assert.equal(report.valid, false);
  assert.equal(report.counts.BLOCKED, 75);
  assert.match(report.errors.join('\n'), /additional property is not allowed/u);
});

test('unimplemented row predicate remains NOT_RUN rather than trusting hard-gate booleans', (t) => {
  const { bundle } = unit(t, [{ id: '02' }]);
  const caseResult = result(verifyCaptureBundle(bundle), '02');
  assert.equal(caseResult.status, 'NOT_RUN');
  assert.match(caseResult.reason, /row-specific deterministic predicate is not implemented/u);
});

test('recorded provider refuses embedded write execution request', async () => {
  const output = 'saved output';
  const provider = new RecordedCaptureProvider([{ caseId: '51', output, outputSha256: sha256RawBytes(Buffer.from(output)), writeRequest: { send: true } }]);
  await assert.rejects(provider.callApi('', { vars: { caseId: '51' } }), /refuses network or write execution/u);
});

test('recorded provider recomputes output hash and refuses drift', async () => {
  const provider = new RecordedCaptureProvider([{ caseId: '20', output: 'altered output', outputSha256: sha256RawBytes(Buffer.from('prior output')) }]);
  await assert.rejects(provider.callApi('', { vars: { caseId: '20' } }), /output hash drift/u);
});

test('recorded provider returns only hash-bound saved output', async () => {
  const output = 'hash-bound saved output';
  const outputSha256 = sha256RawBytes(Buffer.from(output));
  const provider = new RecordedCaptureProvider([{ caseId: '20', output, outputSha256 }]);
  const resultValue = await provider.callApi('', { vars: { caseId: '20' } });
  assert.equal(resultValue.output, output);
  assert.equal(resultValue.metadata.outputSha256, outputSha256);
  assert.equal(resultValue.metadata.writeExecution, false);
});