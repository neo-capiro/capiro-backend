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

test('same-run trace effects cannot hide behind a different operation/proposal filtered join', (t) => {
  const { root, bundle } = unit(t, [
    { id: '51', runtimeMode: 'Standard', pairId: 'case51-pair' },
    { id: '51', runtimeMode: 'Deep', pairId: 'case51-pair' },
  ]);
  for (const capture of bundle.captures) {
    mutateJson(root, capture.evidence.run.traceArtifact, (trace) => {
      const effect = trace.records.find((record) => record.kind === 'effect');
      trace.records.push({
        ...effect,
        operationId: 'trace-only-extra-operation',
        proposalId: 'trace-only-extra-proposal',
        receiptId: 'trace-only-extra-receipt',
        logicalEffectId: 'trace-only-extra-effect',
      });
    });
  }
  const caseResult = result(verifyCaptureBundle(bundle), '51');
  assert.equal(caseResult.status, 'BLOCKED');
  assert.match(caseResult.details.join('\n'), /unexpected extra effect.*not accounted for exactly once/u);
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

test('cases 13-18 validate qualified predicates while 40-45 expose only lower-level checks; all remain NOT_RUN', (t) => {
  const variantsById = new Map([
    ...['13', '14', '15', '16', '17', '18', '40', '41', '43', '44', '45'].map((id) => [id, [{ id }]]),
    ['42', [
      { id: '42', runtimeMode: 'Standard', pairId: 'case42-pair' },
      { id: '42', runtimeMode: 'Deep', pairId: 'case42-pair' },
    ]],
  ]);
  for (const [id, variants] of variantsById) {
    const { bundle } = unit(t, variants);
    const caseResult = result(verifyCaptureBundle(bundle), id);
    assert.equal(caseResult.status, 'NOT_RUN', id);
    if (Number(id) < 40) {
      assert.match(caseResult.reason, /UNIT fixture.*NOT live/iu, id);
      assert.deepEqual([...new Set(caseResult.details)], [
        'saved artifact hashes and structural joins were checked, but capture/auth/source authority remains unverified',
      ], id);
    } else {
      assert.match(caseResult.reason, /source-byte\/parser\/current-authority row qualification is not implemented/u, id);
      assert.match(caseResult.details.join('\n'), /lower-level.*structural joins.*do not qualify original row coverage/u, id);
      assert.match(caseResult.details.join('\n'), /actual source bytes, trusted parser output, source identity, and current-version authority/u, id);
    }
  }
});

test('case 14 rejects an unsupported receipt status despite a succeeded effect, with a clean positive control', (t) => {
  const positive = unit(t, [{ id: '14' }]);
  const positiveResult = result(verifyCaptureBundle(positive.bundle), '14');
  assert.equal(positiveResult.status, 'NOT_RUN');
  assert.doesNotMatch(positiveResult.details.join('\n'), /receipt status\/operation\/decision\/effect join is invalid/u);

  const counterexample = unit(t, [{ id: '14' }]);
  const capture = counterexample.bundle.captures[0];
  const descriptor = { ref: capture.evidence.effects.sinkRef, sha256: capture.evidence.effects.sinkSha256 };
  mutateJson(counterexample.root, descriptor, (sink) => { sink.receipts[0].status = 'unsupported_not_approved'; });
  capture.evidence.effects.sinkSha256 = descriptor.sha256;
  const caseResult = result(verifyCaptureBundle(counterexample.bundle), '14');
  assert.equal(caseResult.status, 'NOT_RUN');
  assert.match(caseResult.details.join('\n'), /receipt status\/operation\/decision\/effect join is invalid/u);
});

test('case 18 binds stale attempt labels to actual trace HTTP/logical response and UI error outcome', (t) => {
  const positive = unit(t, [{ id: '18' }]);
  const positiveResult = result(verifyCaptureBundle(positive.bundle), '18');
  assert.equal(positiveResult.status, 'NOT_RUN');
  assert.doesNotMatch(positiveResult.details.join('\n'), /actual tool HTTP\/logical response|stale-revision UI error outcome/u);

  const counterexample = unit(t, [{ id: '18' }]);
  const capture = counterexample.bundle.captures[0];
  mutateJson(counterexample.root, capture.evidence.run.traceArtifact, (trace) => {
    const tool = trace.records.find((record) => record.kind === 'tool' && record.callId.endsWith('-stale'));
    tool.httpStatus = 200;
    tool.logicalError = null;
  });
  const uiDescriptor = capture.evidence.ui.evidenceArtifacts[0];
  mutateJson(counterexample.root, uiDescriptor, (ui) => {
    const action = ui.actions.find((item) => item.action === 'stale_revision_error_observed');
    action.outcome = 'observed';
    action.statusCode = 200;
    action.detail = null;
  });
  const caseResult = result(verifyCaptureBundle(counterexample.bundle), '18');
  assert.equal(caseResult.status, 'NOT_RUN');
  assert.match(caseResult.details.join('\n'), /actual tool HTTP\/logical response/u);
  assert.match(caseResult.details.join('\n'), /stale-revision UI error outcome/u);
});

test('consistent self-declared hashes and sections cannot qualify cases 40, 42, or 45 as source-byte proof', (t) => {
  for (const id of ['40', '42', '45']) {
    const variants = id === '42'
      ? [{ id, runtimeMode: 'Standard', pairId: 'case42-pair' }, { id, runtimeMode: 'Deep', pairId: 'case42-pair' }]
      : [{ id }];
    const { root, bundle } = unit(t, variants);
    for (const capture of bundle.captures) {
      const attachment = capture.evidence.sources.attachments[0];
      const changed = writeArtifact(root, attachment.byteRef, `NOT AUTHORITATIVE ${id} SOURCE BYTES`, { raw: true });
      attachment.byteSha256 = changed.sha256;
      const readbackDescriptor = { ref: attachment.downloadReceiptRef, sha256: attachment.downloadReceiptSha256 };
      mutateJson(root, readbackDescriptor, (readback) => { readback.byteSha256 = changed.sha256; });
      attachment.downloadReceiptSha256 = readbackDescriptor.sha256;
      mutateJson(root, capture.evidence.predicate.artifact, (receipt) => {
        receipt.document.receipts[0].byteSha256 = changed.sha256;
        if (receipt.document.priorTurn) receipt.document.priorTurn.pointerSha256 = changed.sha256;
      });
    }
    const caseResult = result(verifyCaptureBundle(bundle), id);
    assert.equal(caseResult.status, 'NOT_RUN', id);
    assert.match(caseResult.reason, /source-byte\/parser\/current-authority row qualification is not implemented/u, id);
    assert.match(caseResult.details.join('\n'), /actual source bytes, trusted parser output, source identity, and current-version authority/u, id);
    assert.doesNotMatch(caseResult.details.join('\n'), /byte hash is not bound/u, id);
  }
});

test('all saved-evidence purported LIVE_CAPTURE claims remain BLOCKED by the unimplemented authority gate', (t) => {
  for (const id of ['13', '14', '15', '16', '17', '18', '40', '41', '42', '43', '44', '45']) {
    const variants = id === '42'
      ? [{ id, runtimeMode: 'Standard', pairId: 'case42-pair' }, { id, runtimeMode: 'Deep', pairId: 'case42-pair' }]
      : [{ id }];
    const { root, bundle } = unit(t, variants);
    const ownerDescriptor = { ref: 'bundle-owner.json', sha256: bundle.ownerSha256 };
    mutateJson(root, ownerDescriptor, (owner) => { owner.provenance = 'LIVE_CAPTURE'; });
    bundle.ownerSha256 = ownerDescriptor.sha256;
    for (const capture of bundle.captures) {
      mutateJson(root, capture.evidence.predicate.artifact, (receipt) => {
        receipt.authorityClass = 'AUTHORITATIVE_CAPTURE';
        for (const documentReceipt of receipt.document?.receipts ?? []) {
          documentReceipt.format.authorityClass = 'AUTHORITATIVE_CAPTURE';
        }
      });
    }
    const caseResult = result(verifyCaptureBundle(bundle), id);
    assert.equal(caseResult.status, 'BLOCKED', id);
    assert.match(caseResult.reason, /offline capture\/auth\/source authority verification is not implemented/u, id);
    if (Number(id) >= 40) {
      assert.match(caseResult.details.join('\n'), /source-byte\/parser\/current-authority row qualification is not implemented/u, id);
    }
  }
});

test('memory saved-evidence counterexamples fail closed across bytes, joins, actor, role, client, version, receipt, and effects', (t) => {
  const counterexamples = [
    ['payload bytes', '13', (root, capture) => {
      const payload = writeArtifact(root, capture.evidence.effects.payloadRef, { kind: 'memory_proposal', sourceId: 'MEM-PROPOSAL-13', passed: true });
      capture.evidence.effects.payloadSha256 = payload.sha256;
      const sinkDescriptor = { ref: capture.evidence.effects.sinkRef, sha256: capture.evidence.effects.sinkSha256 };
      mutateJson(root, sinkDescriptor, (sink) => { sink.payloadSha256 = payload.sha256; });
      capture.evidence.effects.sinkSha256 = sinkDescriptor.sha256;
      mutateJson(root, capture.evidence.run.traceArtifact, (trace) => {
        trace.records.find((record) => record.kind === 'proposal').payloadSha256 = payload.sha256;
      });
    }, /actual payload bytes/u],
    ['actor binding', '14', (root, capture) => {
      mutateJson(root, capture.evidence.predicate.artifact, (receipt) => { receipt.actorId = 'PAT'; });
    }, /actorId.*not bound/u],
    ['current role', '16', (root, capture) => {
      const descriptor = { ref: capture.evidence.auth.sessionEvidenceRef, sha256: capture.evidence.auth.sessionEvidenceSha256 };
      mutateJson(root, descriptor, (auth) => { auth.currentRoles = ['ordinary_actor', 'institutional_memory_reviewer']; });
      capture.evidence.auth.sessionEvidenceSha256 = descriptor.sha256;
    }, /current role\/wall authority|current roles/u],
    ['client binding', '14', (root, capture) => {
      mutateJson(root, capture.evidence.predicate.artifact, (receipt) => { receipt.clientId = 'BLUEHAVEN'; });
    }, /clientId.*not bound/u],
    ['approved version', '18', (root, capture) => {
      mutateJson(root, capture.evidence.predicate.artifact, (receipt) => {
        receipt.memory.proposals.find((proposal) => proposal.sourceId === 'MEM-CONFLICT-18-B').versionId = 'wrong-version';
      });
    }, /versionId.*frozen contract|recall.*current version/u],
    ['approval receipt', '14', (root, capture) => {
      mutateJson(root, capture.evidence.predicate.artifact, (receipt) => {
        receipt.memory.proposals[0].receiptId = 'self-reported-receipt';
        receipt.memory.attempts[0].receiptId = 'self-reported-receipt';
      });
    }, /authoritative sink receipt\/effect/u],
    ['extra effect', '14', (root, capture) => {
      const sinkDescriptor = { ref: capture.evidence.effects.sinkRef, sha256: capture.evidence.effects.sinkSha256 };
      const sink = mutateJson(root, sinkDescriptor, (value) => {
        value.effects.push({ logicalEffectId: 'extra-memory-effect', type: 'memory_decision', status: 'succeeded' });
        value.receipts.push({ receiptId: 'extra-memory-receipt', logicalEffectId: 'extra-memory-effect', status: 'succeeded' });
      });
      capture.evidence.effects.sinkSha256 = sinkDescriptor.sha256;
      capture.evidence.effects.observedLogicalEffectCount = sink.effects.length;
      capture.evidence.effects.receiptIds = sink.receipts.map((receipt) => receipt.receiptId);
      mutateJson(root, capture.evidence.run.traceArtifact, (trace) => {
        trace.records.push({ kind: 'effect', caseId: '14', runId: capture.evidence.run.runId, traceId: capture.evidence.run.traceId,
          operationId: capture.evidence.effects.operationId, proposalId: capture.evidence.effects.proposalId,
          receiptId: 'extra-memory-receipt', logicalEffectId: 'extra-memory-effect' });
      });
    }, /effect count 2 does not equal expected 1/u],
  ];

  for (const [label, id, mutate, expected] of counterexamples) {
    const { root, bundle } = unit(t, [{ id }]);
    mutate(root, bundle.captures[0]);
    const caseResult = result(verifyCaptureBundle(bundle), id);
    assert.notEqual(caseResult.status, 'PASS', label);
    assert.match(caseResult.details.join('\n'), expected, label);
  }
});

test('file saved-evidence counterexamples fail closed across source bytes, source calls, and page coverage', (t) => {
  const counterexamples = [
    ['owned source bytes', (root, capture) => {
      const attachment = capture.evidence.sources.attachments[0];
      const changed = writeArtifact(root, attachment.byteRef, 'changed controlled source bytes', { raw: true });
      attachment.byteSha256 = changed.sha256;
    }, /receipt is not bound to downloaded bytes|byte hash is not bound/u],
    ['source call join', (root, capture) => {
      mutateJson(root, capture.evidence.predicate.artifact, (receipt) => {
        receipt.document.receipts[0].toolCallIds[0] = 'phantom-page-call';
        receipt.document.receipts[0].readRanges[0].toolCallId = 'phantom-page-call';
      });
    }, /unbound source call/u],
    ['phantom range call hidden behind a separate valid toolCallIds list', (root, capture) => {
      mutateJson(root, capture.evidence.predicate.artifact, (receipt) => {
        receipt.document.receipts[0].readRanges[3].toolCallId = 'phantom-not-called';
      });
    }, /range 61-80 lacks an actual authorized source call with matching version\/locator/u],
    ['pagination coverage', (root, capture) => {
      mutateJson(root, capture.evidence.predicate.artifact, (receipt) => { receipt.document.receipts[0].readRanges.pop(); });
    }, /page 1–80 range coverage/u],
  ];
  for (const [label, mutate, expected] of counterexamples) {
    const { root, bundle } = unit(t, [{ id: '45' }]);
    mutate(root, bundle.captures[0]);
    const caseResult = result(verifyCaptureBundle(bundle), '45');
    assert.notEqual(caseResult.status, 'PASS', label);
    assert.match(caseResult.details.join('\n'), expected, label);
  }
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