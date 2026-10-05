import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sha256Bytes, sha256Stable } from '../artifact-collector.mjs';
import { CASE46_SCOPE, inspectCase46CurrentReadback, assertCase46ReceiptJoins } from '../case46-receipt-joins.mjs';
import { CASE46_EXPECTED } from '../case46-artifact-evidence.mjs';
import { inspectCase46Stream, currentCase46CaptureAuthority, executeCase46LiveCapture } from '../case46-live-capture.mjs';
import { gradeCase46CapturedOutcome, inspectCase46HumanAdjudication } from '../grade-case46-capture.mjs';

import { case46Sample } from './case46-fixture.mjs';

test('actual owner wire shapes join; authorized retry2 with one effect is valid deterministic evidence only', () => {
  const result = assertCase46ReceiptJoins(case46Sample());
  assert.equal(result.status, 'SAVED_CHECKS_ONLY'); assert.equal(result.liveAcceptance, 'NOT_RUN');
  assert.equal(result.fullFile01Acceptance, false);
});

const faults = {
  actor: x => { x.after.actorUserId = randomUUID(); },
  client: x => { x.scope.clientId = randomUUID(); },
  source_version: x => { x.after.source.rowVersion = '987654'; },
  source_bytes: x => { x.after.source.contentSha256 = '4'.repeat(64); },
  original_prompt: x => { x.after.originalPromptSha256 = sha256Bytes('replacement'); },
  phase: x => { x.after.phase = 'AWAITING_APPROVAL'; },
  duplicate_turn: x => { x.after.counts.userTurns = 2; },
  duplicate_artifact: x => { x.after.counts.artifactEffects = 2; },
  uncertain_usage: x => { x.after.providerUsage.allAttemptsSettled = false; },
  wrong_cost: x => { x.after.providerUsage.costMicros = 3000001; },
  readonly_receipt: x => { x.after.providerUsage.kind = 'server_readonly_capture'; },
  forged_qualification: x => { x.scope.qualification.maxCostMicros = 2; },
  assistant_text: x => { x.assistant.body += 'changed'; },
  saved_usage: x => { x.assistant.metadata.governedArtifactCaptureReceipt.costMicros += 1; },
  operation: x => { x.after.effect.operationId = randomUUID(); },
  reload: x => { x.ui.rounds[1].checked.artifactId = randomUUID(); },
  approval_count: x => { x.ui.approvalRequests = 2; },
  extra_write: x => { x.ui.blockedWrites = 1; },
  expired: x => { x.now = x.after.expiresAt; },
  ready_has_usage: x => { x.before.providerUsage = x.after.providerUsage; },
};
for (const [name, mutate] of Object.entries(faults)) test(`rejects ${name}`, () => {
  const input = case46Sample(); mutate(input); assert.throws(() => assertCase46ReceiptJoins(input), /CASE46_/u);
});

test('one original pending create_word stream is distinct from readonly or repeated writes', () => {
  const x = case46Sample();
  const events = [{ type: 'turn_accepted' }, { type: 'tool_call', tool: 'create_word' },
    { type: 'pending_approval', tool: 'create_word', proposalId: x.proposed.proposalId },
    { type: 'text', text: x.assistant.body }, { type: 'done', messageId: x.assistant.id }];
  const wire = rows => rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join('');
  assert.equal(inspectCase46Stream(wire(events), x.scope).proposalId, x.proposed.proposalId);
  assert.throws(() => inspectCase46Stream(wire([...events, events[1]]), x.scope), /CASE46_/u);
  const readonly = structuredClone(events); readonly.at(-1).serverReadonlyCaptureReceipt = {};
  assert.throws(() => inspectCase46Stream(wire(readonly), x.scope), /CASE46_/u);
  const read = { type: 'tool_call', tool: 'read_client_documents' };
  assert.equal(inspectCase46Stream(wire([events[0], read, read, ...events.slice(1)]), x.scope).proposalId, x.proposed.proposalId);
  assert.throws(() => inspectCase46Stream(wire([events[0], events[1], read, ...events.slice(2)]), x.scope), /STREAM_TOOL_SCOPE/u);
  assert.throws(() => inspectCase46Stream(wire([events[0], { type: 'tool_call', tool: 'send_email' }, ...events.slice(1)]), x.scope), /STREAM_TOOL_SCOPE/u);
});

test('JSON lookalikes cannot submit, settle capture authority, or grade LIVE', async () => {
  assert.throws(() => currentCase46CaptureAuthority({ status: 'CAPTURE_COMPLETE', caseId: '46' }), /AUTHENTICATED_OUTCOME/u);
  assert.throws(() => gradeCase46CapturedOutcome({ status: 'CAPTURE_COMPLETE', caseId: '46' }), /AUTHENTICATED_OUTCOME/u);
  await assert.rejects(() => executeCase46LiveCapture({ kind: 'meri-case46-native-session' }), /AUTHENTICATED_CAPABILITY/u);
});

test('human visual/rubric grading remains separate and bound to saved evidence', () => {
  const now = Date.now(), binding = { captureRunId: randomUUID(), turnId: randomUUID(), answerSha256: 'a'.repeat(64),
    evidenceSha256: 'b'.repeat(64), completedAt: now - 1000, screenshotSha256s: ['c'.repeat(64), 'd'.repeat(64)] };
  const human = { ...binding, schemaVersion: 1, kind: 'meri-case46-human-adjudication', caseId: '46', reviewer: 'test reviewer',
    rationale: 'test rubric only', reference: 'original row46', reviewedAt: new Date(now).toISOString(),
    approvalAndReceiptVisible: true, downloadAndReloadVisible: true,
    scores: { factual_support: 2, evidence_coverage_citation_validity: 2, client_relevance: 2, directness_clarity: 2, actionable_judgment: 1 } };
  assert.equal(inspectCase46HumanAdjudication(human, binding, now).meetsRubric, true);
  assert.equal(inspectCase46HumanAdjudication({ ...human, downloadAndReloadVisible: false }, binding, now).meetsRubric, false);
  assert.throws(() => inspectCase46HumanAdjudication({ ...human, evidenceSha256: 'f'.repeat(64) }, binding, now));
});
