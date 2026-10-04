import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  case14WriteEvidence,
  createCase14ApprovalWriteGuard,
  inspectCase14WriteEvidence,
} from '../case14-approval-capture.mjs';

const origin = 'https://os.capiro.ai';
const preference = '/api/clio/vnext/preferences';
const candidateId = '11111111-1111-4111-8111-111111111111';
const approval = `/api/memory/review/candidates/${candidateId}/approve`;
const request = (method, path, body = '{}') => ({
  method: () => method,
  url: () => path.startsWith('http') ? path : origin + path,
  postData: () => body,
});

test('exact preference PUTs are counted as denied, never continued', () => {
  const guard = createCase14ApprovalWriteGuard(candidateId);
  for (let n = 0; n < 3; n++) assert.equal(guard.decide(request('PUT', preference)), 'abort');
  assert.deepEqual(guard.snapshot().blockedWriteRequests.map((x) => x.kind), [
    'blocked_panel_preference',
    'blocked_panel_preference',
    'blocked_panel_preference',
  ]);
  guard.assertBeforeIntent();
});

test('unexpected pre-arm writes prevent intent and approval forwarding', () => {
  const guard = createCase14ApprovalWriteGuard('11111111-1111-4111-8111-111111111111');
  assert.equal(guard.decide(request('POST', '/api/other')), 'abort');
  assert.throws(() => guard.assertBeforeIntent());
  assert.throws(() => guard.arm());
  assert.equal(guard.snapshot().applicationApprovalSubmissions, 0);
});

test('foreign, query, wrong-method and overbound preference variants stay denied and invalidate accounting', () => {
  for (const item of [
    request('PUT', 'https://foreign.invalid' + preference),
    request('PUT', preference + '?key=value'),
    request('POST', preference),
  ]) {
    const guard = createCase14ApprovalWriteGuard('11111111-1111-4111-8111-111111111111');
    assert.equal(guard.decide(item), 'abort');
    assert.throws(() => guard.assertBeforeIntent());
  }
  const guard = createCase14ApprovalWriteGuard('11111111-1111-4111-8111-111111111111');
  for (let n = 0; n < 4; n++) guard.decide(request('PUT', preference));
  assert.throws(() => guard.assertBeforeIntent());
  const malformed = {
    applicationApprovalSubmissions: 1,
    synthesisSubmissionCount: 0,
    blockedWrites: 1,
    blockedPreferenceWrites: 1,
    blockedWriteRequests: [{ method: 'POST', path: preference, phase: 'initial', kind: 'blocked_panel_preference' }],
  };
  assert.throws(() => inspectCase14WriteEvidence(malformed));
});

test('single exact armed approval is continued; duplicate and altered approvals are aborted', () => {
  const guard = createCase14ApprovalWriteGuard('11111111-1111-4111-8111-111111111111');
  guard.arm();
  assert.equal(guard.decide(request('POST', approval)), 'continue');
  assert.equal(guard.decide(request('POST', approval)), 'abort');
  assert.equal(guard.decide(request('POST', approval + '?retry=1')), 'abort');
  assert.equal(guard.snapshot().applicationApprovalSubmissions, 1);
});

test('evidence requires exact bounded accounting, with strict historical zero-write compatibility', () => {
  assert.equal(inspectCase14WriteEvidence({
    applicationApprovalSubmissions: 1,
    synthesisSubmissionCount: 0,
    blockedWrites: 0,
  }), true);
  const evidence = case14WriteEvidence(createCase14ApprovalWriteGuard('11111111-1111-4111-8111-111111111111'));
  evidence.applicationApprovalSubmissions = 1;
  evidence.synthesisSubmissionCount = 0;
  assert.equal(inspectCase14WriteEvidence(evidence), true);
  assert.throws(() => inspectCase14WriteEvidence({
    applicationApprovalSubmissions: 1,
    synthesisSubmissionCount: 0,
    blockedWrites: 1,
  }));
});
