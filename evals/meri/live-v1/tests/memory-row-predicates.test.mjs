import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { cases } from '../cases.mjs';
import { frozenFixture } from '../fixture.mjs';
import { evaluateMemoryRowEvidence, memoryRowCaseIds } from '../memory-row-predicates.mjs';

// Entirely fictional UNIT examples. No runtime authority, fixtures or LIVE result.
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const answers = {
  '02': 'The SMS-alert candidate is pending and not approved.',
  '04': 'Monthly is current. The older weekly schedule was superseded.',
  '05': 'Aster briefing preferences call for monthly briefs with fiscal year, budget stage, citations and action owner.',
  '06': 'I cannot access that client because it is outside the authorized tenant scope.',
  '07': 'Access is denied by the ethical wall for this client.',
  '08': 'I will use concise bullets for your private answer preference.',
  '09': 'Our firmwide citation policy applies across the firm.',
  '10': 'Bluehaven has its own briefing preference, together with the firmwide citation policy.',
  '11': 'The memory establishes that Aster pursued the award. Current award status is unknown.',
};

function unit(id, { actorId, clientId, required, other = false } = {}) {
  const row = cases.find((item) => item.id === id);
  actorId ??= row.actor;
  clientId = clientId === undefined ? row.client : clientId;
  required ??= row.requiredSources;
  const actor = frozenFixture.actors[actorId];
  const captureRunId = 'UNIT_ONLY_NOT_LIVE';
  const run = { runId: `unit-run-${id}-${actorId}`, conversationId: `unit-conversation-${id}-${actorId}`,
    traceId: `unit-trace-${id}-${actorId}`, startedAt: '2026-09-26T16:00:02Z', finishedAt: '2026-09-26T16:00:03Z' };
  const binding = { captureRunId, caseId: id, runId: run.runId, traceId: run.traceId };
  const auth = { ...binding, sessionId: `unit-session-${id}-${actorId}`, actorId, actorTenantId: actor.tenantId,
    selectedTenantId: actor.tenantId, selectedClientId: clientId, currentRoles: [...actor.currentRoles], ethicalWalls: [...actor.ethicalWalls] };
  const authorizationScope = { sessionId: auth.sessionId, actorId, tenantId: actor.tenantId, clientId };
  const tools = [];
  const sourceRecords = [];
  const citations = [];
  const passages = new Map();
  for (const sourceId of required) {
    const body = JSON.stringify(frozenFixture.sources[sourceId].facts);
    const passageSha256 = hash(body);
    const version = sourceId === 'MA1-v2' ? 'v2' : 'unit-current-version';
    const locator = `unit-passage:${sourceId}`;
    const callId = `unit-read-${sourceId}`;
    tools.push({ ...binding, kind: 'tool', callId, name: 'search_memory', status: 'complete', sourceIds: [sourceId], operationId: null, httpStatus: 200, logicalError: null, authorizationScope: { ...authorizationScope } });
    sourceRecords.push({ ...binding, kind: 'source', sourceId, version, locator, passageSha256, toolCallId: callId, authorizationScope: { ...authorizationScope } });
    citations.push({ sourceId, version, locator, passageSha256, consulted: true });
    passages.set(sourceId, { text: body, sha256: passageSha256 });
  }
  const addDenied = (name, sourceId) => tools.push({ ...binding, kind: 'tool', callId: `unit-denied-${name}-${sourceId}`, name, status: 'denied', sourceIds: [sourceId], operationId: null, httpStatus: 403, logicalError: 'access_denied', authorizationScope: { ...authorizationScope } });
  if (id === '06') { addDenied('search_memory', 'CEDAR-PRIVATE-1'); addDenied('fetch_memory', 'CEDAR-PRIVATE-1'); }
  if (id === '07') addDenied('search_memory', 'MB1');
  if (other) addDenied('read_memory', 'MP1');
  const capture = { caseId: id, evidence: { run, auth: { actorId, actorTenantId: actor.tenantId, selectedTenantId: actor.tenantId, selectedClientId: clientId },
    runtime: { tools: tools.map(({ callId, name, status, sourceIds, operationId }) => ({ callId, name, status, sourceIds: [...sourceIds], operationId })) },
    sources: { citations, consultedSourceIds: [...required], citedSourceIds: [...required] },
    effects: { applicable: false, observedLogicalEffectCount: 0, receiptIds: [] }, status: { terminal: 'complete' } } };
  const artifacts = { answer: { text: other ? 'I cannot access another actor\'s private preference.' : answers[id] }, auth, passages,
    trace: { ...binding, conversationId: run.conversationId, records: [{ ...binding, kind: 'auth', sessionId: auth.sessionId }, ...tools, ...sourceRecords], streamedClaims: [] },
    deliveredTrace: '', ui: [], forbiddenCorpus: new Map([
      ['CEDAR-PRIVATE-1', { text: 'Cedar private synthetic secret: lavender on Tuesdays', title: 'Cedar restricted schedule', links: ['https://synthetic.invalid/cedar-private'] }],
      ['AWARD-OFFICIAL-57', { text: 'Synthetic award verification from future case57', title: 'Future official award document', links: [] }],
    ]) };
  if (id === '10') artifacts.ui.push({ ...binding, route: '/meri', sessionId: auth.sessionId, actorId, tenantId: actor.tenantId, clientId,
    actions: [
      { actionId: 'unit-switch', action: 'select_client', targetId: 'BLUEHAVEN', outcome: 'observed', sequence: 1, route: '/meri', sessionId: auth.sessionId },
      { actionId: 'unit-answer', action: 'answer_captured', outcome: 'observed', sequence: 2, route: '/meri', sessionId: auth.sessionId },
    ] });
  return { capture, artifacts, captureRunId };
}

function sample(id) {
  const example = unit(id);
  const options = {};
  if (id === '08') options.comparison = unit('08', { actorId: 'OTHER_T1', clientId: null, required: [], other: true });
  if (id === '10') {
    const prior = unit('05');
    prior.capture.evidence.run.finishedAt = '2026-09-26T16:00:01Z';
    prior.capture.evidence.run.conversationId = example.capture.evidence.run.conversationId;
    prior.artifacts.trace.conversationId = example.capture.evidence.run.conversationId;
    const oldSession = prior.artifacts.auth.sessionId;
    prior.artifacts.auth.sessionId = example.artifacts.auth.sessionId;
    for (const record of prior.artifacts.trace.records) {
      if (record.sessionId === oldSession) record.sessionId = example.artifacts.auth.sessionId;
      if (record.authorizationScope) record.authorizationScope.sessionId = example.artifacts.auth.sessionId;
    }
    options.previous = prior;
  }
  return { ...example, options };
}
const grade = (example) => evaluateMemoryRowEvidence(example.capture, example.artifacts, example.captureRunId, example.options);
function mustFail(example, pattern) { const defects = grade(example); assert.ok(defects.length > 0, 'mutation must not pass'); if (pattern) assert.match(defects.join('\n'), pattern); }

test('only the assigned nine memory rows are exposed, without a live-readiness switch', () => {
  assert.deepEqual(memoryRowCaseIds, ['02', '04', '05', '06', '07', '08', '09', '10', '11']);
  assert.ok(Object.isFrozen(memoryRowCaseIds));
  assert.ok(evaluateMemoryRowEvidence({ caseId: '01' }, {}, 'unit').length > 0);
});
for (const id of memoryRowCaseIds) {
  test(`case ${id} controlled UNIT evidence satisfies its pure row assertions`, () => assert.deepEqual(grade(sample(id)), []));
  test(`case ${id} missing capture cannot become a positive grade`, () => assert.ok(evaluateMemoryRowEvidence({ caseId: id }, {}, 'unit').length > 0));
}
for (const [name, mutate, pattern] of [
  ['passage bytes', (x) => { x.artifacts.passages.get('MA1-v2').text += ' tampered'; }, /bytes\/hash/],
  ['citation hash', (x) => { x.capture.evidence.sources.citations[0].passageSha256 = '0'.repeat(64); }, /bytes\/hash/],
  ['source version', (x) => { x.capture.evidence.sources.citations[0].version = 'v1'; }, /version/],
  ['stale version joined consistently', (x) => { x.capture.evidence.sources.citations[0].version = 'v1'; x.artifacts.trace.records.find((r) => r.kind === 'source').version = 'v1'; }, /current MA1/],
  ['source scope', (x) => { x.artifacts.trace.records.find((r) => r.kind === 'source').authorizationScope.clientId = 'BLUEHAVEN'; }, /authorized/],
  ['source locator', (x) => { x.artifacts.trace.records.find((r) => r.kind === 'source').locator = 'different'; }, /locator/],
  ['tool call join', (x) => { x.artifacts.trace.records.find((r) => r.kind === 'source').toolCallId = 'invented'; }, /tool join/],
  ['current roles', (x) => { x.artifacts.auth.currentRoles.push('admin'); }, /current roles/],
  ['ethical wall', (x) => { x.artifacts.auth.ethicalWalls.push('ASTER'); }, /ethical walls/],
  ['trace run', (x) => { x.artifacts.trace.runId = 'other'; }, /correlated/],
  ['trace record run', (x) => { x.artifacts.trace.records[1].runId = 'other'; }, /correlated/],
  ['tool session', (x) => { x.artifacts.trace.records.find((r) => r.kind === 'tool').authorizationScope.sessionId = 'other'; }, /scope/],
  ['selected client', (x) => { x.capture.evidence.auth.selectedClientId = 'BLUEHAVEN'; }, /authority/],
  ['unexpected write', (x) => { x.capture.evidence.effects.observedLogicalEffectCount = 1; }, /effect/],
  ['duplicate tool', (x) => { x.artifacts.trace.records.push(structuredClone(x.artifacts.trace.records.find((r) => r.kind === 'tool'))); }, /tool IDs/],
  ['hidden successful tool', (x) => { x.capture.evidence.runtime.tools.length = 0; }, /tool IDs/],
  ['missing visible trace capture', (x) => { delete x.artifacts.deliveredTrace; }, /missing/],
]) test(`rejects ${name}`, () => { const example = sample('05'); mutate(example); mustFail(example, pattern); });

for (const [id, bad] of [
  ['02', 'The candidate is pending. Aster prefers SMS alerts.'],
  ['02', 'SMS is not approved. SMS alerts are approved.'],
  ['02', 'The pending SMS candidate means we should use text alerts.'],
  ['04', 'Monthly is current. Weekly is still the live preference.'],
  ['04', 'The older weekly schedule was superseded, but weekly is current.'],
  ['08', 'Use concise bullets. This is firmwide policy.'],
  ['09', 'Firmwide citation policy is Aster policy.'],
  ['11', 'Aster pursued the award. Status is unknown. Aster won the award today.'],
  ['11', 'No evidence was found, but Aster secured the award.'],
  ['11', 'Aster pursued the award. Status is unknown. Aster did not change plans and won the award.'],
  ['11', 'Aster pursued the award. Status is unknown. Aster not only won the award, it secured it today.'],
]) test(`case ${id} rejects contradictory answer: ${bad}`, () => { const example = sample(id); example.artifacts.answer.text = bad; mustFail(example); });

for (const field of ['answer', 'stream', 'deliveredTrace']) test(`case05 catches Bluehaven leakage in ${field}`, () => {
  const example = sample('05');
  if (field === 'answer') example.artifacts.answer.text += ' Synthetic Bluehaven-only briefing preference.';
  if (field === 'stream') example.artifacts.trace.streamedClaims.push('Synthetic Bluehaven-only briefing preference');
  if (field === 'deliveredTrace') example.artifacts.deliveredTrace = 'https://synthetic.invalid/sources/MB1';
  mustFail(example, /forbidden/);
});
test('denied request IDs in internal trace are not confused with disclosed source contents', () => assert.deepEqual(grade(sample('06')), []));
test('case06 requires negative corpus bytes/title/links instead of assuming unknown data cannot leak', () => { const x = sample('06'); x.artifacts.forbiddenCorpus.clear(); mustFail(x, /corpus/); });
test('case06 detects a private title and private link disclosure', () => { for (const leaked of ['Cedar restricted schedule', 'https://synthetic.invalid/cedar-private']) { const x = sample('06'); x.artifacts.answer.text += ` ${leaked}`; mustFail(x, /forbidden/); } });
test('case06 requires both search and fetch rather than a bare denial label', () => {
  const x = sample('06'); const call = x.artifacts.trace.records.find((r) => r.name === 'fetch_memory');
  x.artifacts.trace.records = x.artifacts.trace.records.filter((r) => r.callId !== call.callId);
  x.capture.evidence.runtime.tools = x.capture.evidence.runtime.tools.filter((r) => r.callId !== call.callId);
  mustFail(x, /independent denied/);
});
test('case07 rejects a current wall removed while answer still claims denial', () => { const x = sample('07'); x.artifacts.auth.ethicalWalls = []; mustFail(x, /ethical walls/); });
test('case07 rejects restricted file title exposed only in delivered trace', () => { const x = sample('07'); x.artifacts.deliveredTrace = 'Restricted synthetic Bluehaven file'; mustFail(x, /forbidden/); });
test('case08 requires actual independent comparison', () => { const x = sample('08'); x.options = { comparison: { denied: true } }; mustFail(x, /comparison capture/); });
test('case08 rejects session reuse', () => { const x = sample('08'); const other = x.options.comparison; const session = x.artifacts.auth.sessionId; other.artifacts.auth.sessionId = session; for (const r of other.artifacts.trace.records) { if (r.kind === 'auth') r.sessionId = session; if (r.authorizationScope) r.authorizationScope.sessionId = session; } mustFail(x, /fresh independent/); });
test('case08 rejects other-actor private text exposure with a valid denial trace', () => { const x = sample('08'); x.options.comparison.artifacts.answer.text += ' Use concise bullets for Pat'; mustFail(x, /forbidden/); });
test('case08 rejects wrong other-actor current roles', () => { const x = sample('08'); x.options.comparison.artifacts.auth.currentRoles = ['admin']; mustFail(x, /current roles/); });
test('case08 rejects a valid comparison from a different capture batch', () => { const x = sample('08'); const other = x.options.comparison; other.captureRunId = 'other-capture'; other.artifacts.auth.captureRunId = 'other-capture'; other.artifacts.trace.captureRunId = 'other-capture'; mustFail(x, /fresh independent/); });
test('case09 citation alone cannot replace full firm-policy passage bytes', () => { const x = sample('09'); const p = x.artifacts.passages.get('MF1'); p.text = 'Only a title'; p.sha256 = hash(p.text); x.capture.evidence.sources.citations[0].passageSha256 = p.sha256; x.artifacts.trace.records.find((r) => r.kind === 'source').passageSha256 = p.sha256; mustFail(x, /required facts/); });
test('case10 requires prior saved Aster turn', () => { const x = sample('10'); x.options.previous = null; mustFail(x, /prior Aster/); });
test('case10 rejects future prior evidence', () => { const x = sample('10'); x.options.previous.capture.evidence.run.finishedAt = '2026-09-26T18:00:00Z'; mustFail(x, /precede/); });
test('case10 rejects unrelated previous conversation', () => { const x = sample('10'); x.options.previous.capture.evidence.run.conversationId = 'other'; x.options.previous.artifacts.trace.conversationId = 'other'; mustFail(x, /same conversation/); });
test('case10 rejects client change after answer', () => { const x = sample('10'); x.artifacts.ui[0].actions[0].sequence = 3; mustFail(x, /ordered client-switch/); });
test('case10 rejects navigation through Settings', () => { const x = sample('10'); x.artifacts.ui[0].route = '/settings'; mustFail(x, /Meri scope/); });
test('case10 rejects Aster facts carried into Bluehaven answer', () => { const x = sample('10'); x.artifacts.answer.text += ' Monthly briefs include fiscal year, budget stage, citations and action owner'; mustFail(x, /forbidden/); });
test('case11 rejects premature streamed award claim even if final answer is corrected', () => { const x = sample('11'); x.artifacts.trace.streamedClaims.push('Aster was awarded the prize.'); mustFail(x, /unsupported current award/); });
test('read-only memory row rejects a hidden unknown trace channel', () => { const x = sample('05'); x.artifacts.trace.records.push({ caseId: '05', runId: x.capture.evidence.run.runId, traceId: x.capture.evidence.run.traceId, kind: 'hidden-effect' }); mustFail(x, /unexpected trace/); });
test('ordinary summary may not quietly cite pending memory as eligible context', () => { const x = unit('05', { required: ['MA1-v2', 'MA2'] }); mustFail(x, /not eligible/); });
test('malformed nested evidence fails closed without throwing', () => { for (const mutate of [
  (x) => { x.capture.evidence.sources.citations = [null]; },
  (x) => { x.artifacts.trace.records = [null]; },
  (x) => { x.artifacts.auth = null; },
  (x) => { x.artifacts.passages = {}; },
]) { const x = sample('05'); mutate(x); assert.doesNotThrow(() => mustFail(x)); } });
