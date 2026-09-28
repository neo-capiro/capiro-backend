import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
  assert.match(result(report, '20').details.join('\n'), /capture\/auth\/source authority remains unverified/u);
  assert.doesNotMatch(result(report, '20').details.join('\n'), /correlations validated/u);
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
  assert.match(caseResult.details.join('\n'), /capture\/auth\/source authority remains unverified/u);
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
  assert.equal(caseResult.status, 'BLOCKED');
  assert.match(caseResult.details.join('\n'), /receipt.*exact.*correlation|effect trace receipt/u);
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

test('malformed saved trace and sink records are schema-BLOCKED without throwing', (t) => {
  const mutations = [
    ['null transitions', [{ id: '12' }], (root, bundle) => mutateJson(root, bundle.captures[0].evidence.run.traceArtifact, (trace) => { trace.transitions = null; })],
    ['primitive trace record', [{ id: '12' }], (root, bundle) => mutateJson(root, bundle.captures[0].evidence.run.traceArtifact, (trace) => { trace.records[1] = null; })],
    ['primitive source record', [{ id: '12' }], (root, bundle) => mutateJson(root, bundle.captures[0].evidence.run.traceArtifact, (trace) => { trace.records[2] = 'malicious-source-record'; })],
    ['primitive sink receipt', [{ id: '51', runtimeMode: 'Standard', pairId: 'case51-pair' }, { id: '51', runtimeMode: 'Deep', pairId: 'case51-pair' }], (root, bundle) => {
      for (const capture of bundle.captures) {
        const descriptor = { ref: capture.evidence.effects.sinkRef, sha256: capture.evidence.effects.sinkSha256 };
        mutateJson(root, descriptor, (sink) => { sink.receipts[0] = null; });
        capture.evidence.effects.sinkSha256 = descriptor.sha256;
      }
    }],
  ];
  for (const [label, variants, mutate] of mutations) {
    const { root, bundle } = unit(t, variants);
    mutate(root, bundle);
    const caseResult = result(verifyCaptureBundle(bundle), variants[0].id);
    assert.equal(caseResult.status, 'BLOCKED', label);
    assert.match(`${caseResult.reason}\n${caseResult.details.join('\n')}`, /saved artifact schema validation failed|saved artifact schema violation/u, label);
  }
});

test('saved source records join declared runtime calls and exact authorization scope', (t) => {
  for (const mutation of ['phantom-tool', 'wrong-scope']) {
    const { root, bundle } = unit(t, [{ id: '12', completeCase12Setup: true }]);
    const trace = bundle.captures[0].evidence.run.traceArtifact;
    mutateJson(root, trace, (value) => {
      const source = value.records.find((record) => record.kind === 'source');
      if (mutation === 'phantom-tool') {
        source.toolCallId = 'phantom-not-in-runtime-tools';
        value.records.push({ ...value.records.find((record) => record.kind === 'tool'), callId: source.toolCallId });
      } else {
        source.authorizationScope = { ...source.authorizationScope, tenantId: 'wrong-tenant' };
      }
    });
    const caseResult = result(verifyCaptureBundle(bundle), '12');
    assert.equal(caseResult.status, 'BLOCKED', mutation);
    assert.match(caseResult.details.join('\n'), /declared-tool|authorization scope/u, mutation);
  }
});

test('citation locator and version bind the saved source metadata', (t) => {
  const { bundle } = unit(t, [
    { id: '20', runtimeMode: 'Standard', pairId: 'case20-pair' },
    { id: '20', runtimeMode: 'Deep', pairId: 'case20-pair' },
  ]);
  for (const capture of bundle.captures) {
    capture.evidence.sources.citations[0].locator = 'made-up-page-999';
    capture.evidence.sources.citations[0].version = 'invented-version';
  }
  const caseResult = result(verifyCaptureBundle(bundle), '20');
  assert.equal(caseResult.status, 'BLOCKED');
  assert.match(caseResult.details.join('\n'), /source→declared-tool→trace correlation/u);
});

test('sink receipt IDs bind exactly to proposal/effect trace records', (t) => {
  const { root, bundle } = unit(t, [
    { id: '51', runtimeMode: 'Standard', pairId: 'case51-pair' },
    { id: '51', runtimeMode: 'Deep', pairId: 'case51-pair' },
  ]);
  for (const capture of bundle.captures) {
    const descriptor = { ref: capture.evidence.effects.sinkRef, sha256: capture.evidence.effects.sinkSha256 };
    const sink = mutateJson(root, descriptor, (value) => { value.receipts[0].receiptId = `switched-${value.receipts[0].receiptId}`; });
    capture.evidence.effects.sinkSha256 = descriptor.sha256;
    capture.evidence.effects.receiptIds = [sink.receipts[0].receiptId];
  }
  const caseResult = result(verifyCaptureBundle(bundle), '51');
  assert.equal(caseResult.status, 'BLOCKED');
  assert.match(caseResult.details.join('\n'), /exact proposal→effect→receipt|no exact authoritative sink receipt/u);
});

test('incomplete mode matrix retains underlying BLOCKED artifact diagnostics', (t) => {
  const { bundle } = unit(t, [{ id: '20', runtimeMode: 'Standard' }]);
  bundle.captures[0].evidence.status.answerRef = '../invalid';
  const caseResult = result(verifyCaptureBundle(bundle), '20');
  assert.equal(caseResult.status, 'BLOCKED');
  assert.match(caseResult.reason, /integrity failure.*incomplete required mode matrix/u);
  assert.match(caseResult.details.join('\n'), /missing Deep\/default|traversal/u);
});

test('a symlink in an artifactRoot ancestor is refused', (t) => {
  const { root, bundle } = unit(t, [{ id: '12', completeCase12Setup: true }]);
  const alias = `${root}-parent-alias`;
  symlinkSync(dirname(root), alias, 'dir');
  t.after(() => rmSync(alias, { force: true }));
  bundle.artifactRoot = join(alias, basename(root));
  const report = verifyCaptureBundle(bundle);
  assert.equal(report.valid, false);
  assert.equal(report.counts.BLOCKED, 75);
  assert.match(report.errors.join('\n'), /artifactRoot contains a symlink component/u);
});

test('saved artifact reads enforce the byte bound before allocation', (t) => {
  const { root, bundle } = unit(t, [{ id: '12' }]);
  const answer = bundle.captures[0].evidence.status.answerRef;
  truncateSync(join(root, ...answer.split('/')), 16 * 1024 * 1024 + 1);
  const caseResult = result(verifyCaptureBundle(bundle), '12');
  assert.equal(caseResult.status, 'BLOCKED');
  assert.match(caseResult.details.join('\n'), /exceeds 16777216 bytes/u);
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