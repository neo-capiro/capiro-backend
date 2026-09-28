import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCapture, verifyCaptureBundle } from '../verify-capture.mjs';
import { RecordedCaptureProvider } from '../recorded-provider.mjs';
import { caseById, completeCapture } from './helpers.mjs';

const HASH = 'a'.repeat(64);

test('missing live case capture remains NOT_RUN and never inferred PASS', () => {
  const report = verifyCaptureBundle({ captures: [] });
  assert.equal(report.valid, true);
  assert.deepEqual(report.counts, { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 75 });
  assert.equal(report.score, null);
});

test('captured case without run manifest is BLOCKED, never inferred PASS', () => {
  const report = verifyCaptureBundle({ captures: [completeCapture('01')] });
  assert.equal(report.valid, false);
  assert.equal(report.counts.BLOCKED, 75);
  assert.equal(report.counts.PASS, 0);
  assert.match(report.errors.join('\n'), /runManifest/u);
});

test('malformed capture with missing run evidence is NOT_RUN', () => {
  const capture = completeCapture('01');
  delete capture.evidence.run;
  const result = evaluateCapture(capture, caseById('01'));
  assert.equal(result.status, 'NOT_RUN');
  assert.match(result.details.join('\n'), /evidence\.run/u);
});

test('actual verifier rejects a forbidden cross-client source leak', () => {
  const capture = completeCapture('01');
  capture.evidence.sources.consultedSourceIds.push('MB1');
  capture.evidence.sources.citedSourceIds.push('MB1');
  capture.evidence.sources.citations.push({
    sourceId: 'MB1', version: 'fixture-v1', locator: 'fixture:MB1', passageSha256: HASH, consulted: true,
  });
  const result = evaluateCapture(capture, caseById('01'));
  assert.equal(result.status, 'FAIL');
  assert.match(result.details.join('\n'), /forbidden source leak|cross-client source leak/u);
});

test('actual verifier rejects duplicated logical effect', () => {
  const capture = completeCapture('51');
  capture.evidence.effects.observedLogicalEffectCount = 2;
  const result = evaluateCapture(capture, caseById('51'));
  assert.equal(result.status, 'FAIL');
  assert.match(result.details.join('\n'), /duplicate logical effect/u);
});

test('actual verifier rejects false success over failed tool status', () => {
  const capture = completeCapture('01');
  capture.evidence.runtime.tools[0].status = 'permanent_failure';
  capture.evidence.status.claimedCompleted = true;
  const result = evaluateCapture(capture, caseById('01'));
  assert.equal(result.status, 'FAIL');
  assert.match(result.details.join('\n'), /false-success/u);
});

test('recorded grading provider refuses embedded write execution request', async () => {
  const provider = new RecordedCaptureProvider([{ caseId: '51', output: 'saved output', outputSha256: HASH, writeRequest: { send: true } }]);
  await assert.rejects(provider.callApi('', { vars: { caseId: '51' } }), /refuses network or write execution/u);
});
