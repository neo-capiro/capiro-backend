import { frozenFixture } from './fixture.mjs';
import { structuredExecutionRequirements } from './execution-requirements.mjs';
import {
  acceptanceEvidenceSchema,
  authArtifactSchema,
  sinkArtifactSchema,
  traceArtifactSchema,
  uiArtifactSchema,
} from './artifact-schemas.mjs';
import { validateJsonSchema } from './lib/schema-validator.mjs';
import { evaluateSavedEvidenceCase, savedEvidenceCaseIds } from './saved-evidence-predicates.mjs';

const ROW_COVERAGE_IMPLEMENTED_CASES = new Set([
  '01', '03', '12', '13', '14', '15', '16', '17', '18', '19', '20', '46', '51', '56', '72',
]);
const SOURCE_QUALIFICATION_INCOMPLETE_CASES = new Set(['40', '41', '42', '43', '44', '45']);

function folded(value) {
  return value.normalize('NFC').toLocaleLowerCase('en-US').replace(/[’']/gu, "'").replace(/\s+/gu, ' ').trim();
}

function hasAll(text, values) {
  return values.every((value) => text.includes(folded(value)));
}

function validateTraceShape(trace, capture, captureRunId) {
  const defects = [];
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return ['trace artifact must be an object'];
  const run = capture.evidence.run;
  const expected = {
    schemaVersion: 1,
    captureRunId,
    caseId: capture.caseId,
    runId: run.runId,
    conversationId: run.conversationId,
    traceId: run.traceId,
  };
  for (const [key, value] of Object.entries(expected)) if (trace[key] !== value) defects.push(`trace ${key} is not bound to capture`);
  if (!Array.isArray(trace.records)) defects.push('trace records are missing');
  if (!Array.isArray(trace.transitions)) defects.push('trace transitions are missing');
  return defects;
}

function validateArtifactShapes(artifacts) {
  const defects = validateJsonSchema(artifacts.trace, traceArtifactSchema, { path: 'trace artifact' });
  defects.push(...validateJsonSchema(artifacts.auth, authArtifactSchema, { path: 'auth artifact' }));
  if (artifacts.sink !== null) defects.push(...validateJsonSchema(artifacts.sink, sinkArtifactSchema, { path: 'sink artifact' }));
  for (const ui of artifacts.ui) defects.push(...validateJsonSchema(ui, uiArtifactSchema, { path: 'UI artifact' }));
  if (artifacts.acceptance !== null) defects.push(...validateJsonSchema(artifacts.acceptance, acceptanceEvidenceSchema, { path: 'predicate artifact' }));
  return defects.map((defect) => `saved artifact schema violation: ${defect}`);
}

function sameAuthorizationScope(scope, auth) {
  return scope?.sessionId === auth?.sessionId
    && scope?.actorId === auth?.actorId
    && scope?.tenantId === auth?.selectedTenantId
    && scope?.clientId === auth?.selectedClientId;
}

function savedAuthorizationScope(scope, artifacts) {
  if (sameAuthorizationScope(scope, artifacts.auth)) return true;
  const session = artifacts.acceptance?.memory?.sessions?.find((item) => item.sessionId === scope?.sessionId);
  const actor = frozenFixture.actors[session?.actorId];
  return session?.actorId === scope?.actorId
    && session?.tenantId === scope?.tenantId
    && session?.clientId === scope?.clientId
    && JSON.stringify(session.currentRoles) === JSON.stringify(actor?.currentRoles)
    && JSON.stringify(session.ethicalWalls) === JSON.stringify(actor?.ethicalWalls);
}

function validateCorrelations(capture, artifacts, captureRunId) {
  const defects = validateTraceShape(artifacts.trace, capture, captureRunId);
  const { trace } = artifacts;
  if (!Array.isArray(trace?.records)) return defects;
  const run = capture.evidence.run;
  const records = trace.records;
  const bound = (record) => record?.runId === run.runId && record?.traceId === run.traceId && record?.caseId === capture.caseId;
  for (const record of records) if (!bound(record)) defects.push(`trace ${String(record?.kind)} record is not run/case correlated`);

  const declaredTools = new Map(capture.evidence.runtime.tools.map((tool) => [tool.callId, tool]));
  for (const tool of capture.evidence.runtime.tools) {
    const match = records.find((record) => record.kind === 'tool' && record.callId === tool.callId);
    if (!match || match.status !== tool.status || match.operationId !== tool.operationId || match.name !== tool.name) defects.push(`tool call ${tool.callId} lacks a correlated trace record`);
    else if (!savedAuthorizationScope(match.authorizationScope, artifacts)) defects.push(`tool call ${tool.callId} authorization scope is not bound to a saved authenticated session`);
  }
  for (const citation of capture.evidence.sources.citations) {
    const passage = artifacts.passages.get(citation.sourceId);
    const sourceRecord = records.find((record) => record.kind === 'source'
      && record.sourceId === citation.sourceId
      && record.passageSha256 === passage?.sha256
      && record.version === citation.version
      && record.locator === citation.locator);
    const toolRecord = sourceRecord && records.find((record) => record.kind === 'tool' && record.callId === sourceRecord.toolCallId);
    const declaredTool = sourceRecord && declaredTools.get(sourceRecord.toolCallId);
    if (!sourceRecord || !toolRecord || !declaredTool || !toolRecord.sourceIds.includes(citation.sourceId) || !declaredTool.sourceIds.includes(citation.sourceId)) {
      defects.push(`source ${citation.sourceId} lacks source→declared-tool→trace correlation`);
    } else if (!sameAuthorizationScope(sourceRecord.authorizationScope, artifacts.auth)
      || !sameAuthorizationScope(toolRecord.authorizationScope, artifacts.auth)
      || JSON.stringify(sourceRecord.authorizationScope) !== JSON.stringify(toolRecord.authorizationScope)) {
      defects.push(`source ${citation.sourceId} authorization scope is not bound to its declared tool and saved session`);
    }
  }
  if (artifacts.auth) {
    const auth = artifacts.auth;
    const expectedAuth = capture.evidence.auth;
    for (const key of ['actorId', 'actorTenantId', 'selectedTenantId', 'selectedClientId']) {
      if (auth[key] !== expectedAuth[key]) defects.push(`auth artifact ${key} is not bound to capture`);
    }
    if (auth.captureRunId !== captureRunId || auth.runId !== run.runId || auth.traceId !== run.traceId || auth.caseId !== capture.caseId) {
      defects.push('auth artifact is not run/case correlated');
    }
    const authRecord = records.find((record) => record.kind === 'auth' && record.sessionId === auth.sessionId);
    if (!authRecord) defects.push('auth artifact lacks correlated trace record');
    const actor = frozenFixture.actors[auth.actorId];
    if (!actor
      || JSON.stringify(auth.currentRoles) !== JSON.stringify(actor.currentRoles)
      || JSON.stringify(auth.ethicalWalls) !== JSON.stringify(actor.ethicalWalls)) {
      defects.push('auth artifact current role/wall authority does not exactly match the frozen actor');
    }
  }
  if (artifacts.payload && artifacts.sink) {
    const effects = capture.evidence.effects;
    const sink = artifacts.sink;
    for (const key of ['operationId', 'proposalId', 'payloadSha256']) {
      if (sink[key] !== effects[key]) defects.push(`sink ${key} is not bound to effect capture`);
    }
    if (sink.payloadSha256 !== artifacts.payload.sha256) defects.push('sink payload hash does not match actual payload bytes');
    if (sink.captureRunId !== captureRunId || sink.runId !== run.runId || sink.traceId !== run.traceId || sink.caseId !== capture.caseId) {
      defects.push('sink artifact is not run/case correlated');
    }
    const proposals = records.filter((record) => record.kind === 'proposal' && record.proposalId === effects.proposalId && record.payloadSha256 === artifacts.payload.sha256);
    if (proposals.length !== 1) defects.push('proposal→effect trace correlation is incomplete');
    if (new Set(sink.receipts.map((receipt) => receipt.receiptId)).size !== sink.receipts.length) defects.push('authoritative sink receipt IDs are not unique');
    for (const receipt of sink.receipts) {
      const sinkEffect = sink.effects.find((item) => item.logicalEffectId === receipt.logicalEffectId);
      const receiptTraceEffects = records.filter((record) => record.kind === 'effect'
        && record.operationId === effects.operationId
        && record.proposalId === effects.proposalId
        && record.receiptId === receipt.receiptId);
      if (!sinkEffect || receiptTraceEffects.length !== 1 || receiptTraceEffects[0].logicalEffectId !== receipt.logicalEffectId) {
        defects.push(`sink receipt ${receipt.receiptId} lacks exact proposal→effect→receipt trace correlation`);
      }
    }
    const traceEffects = records.filter((record) => record.kind === 'effect');
    for (const traceEffect of traceEffects) {
      const sinkReceipts = sink.receipts.filter((receipt) => receipt.receiptId === traceEffect.receiptId
        && receipt.logicalEffectId === traceEffect.logicalEffectId);
      const sinkEffects = sink.effects.filter((item) => item.logicalEffectId === traceEffect.logicalEffectId);
      if (traceEffect.operationId !== effects.operationId
        || traceEffect.proposalId !== effects.proposalId
        || sinkReceipts.length !== 1
        || sinkEffects.length !== 1) {
        defects.push(`unexpected extra effect trace record ${traceEffect.receiptId} is not accounted for exactly once by the authoritative sink operation/proposal/effect/receipt`);
      }
    }
  } else {
    for (const traceEffect of records.filter((record) => record.kind === 'effect')) {
      defects.push(`unexpected extra effect trace record ${traceEffect.receiptId} has no authoritative sink operation/proposal/effect/receipt`);
    }
  }
  for (const ui of artifacts.ui) {
    if (ui.captureRunId !== captureRunId || ui.runId !== run.runId || ui.traceId !== run.traceId || ui.caseId !== capture.caseId) {
      defects.push('UI artifact is not run/case correlated');
    }
    if (ui.operationId && ui.operationId !== capture.evidence.effects.operationId) defects.push('UI operation is not correlated to captured effect');
    if (ui.sessionId !== artifacts.auth?.sessionId
      || ui.actorId !== artifacts.auth?.actorId
      || ui.tenantId !== artifacts.auth?.selectedTenantId
      || ui.clientId !== artifacts.auth?.selectedClientId) defects.push('UI artifact authorization scope is not bound to the saved session');
  }
  return defects;
}

function validateExecutionRequirements(capture, trace) {
  const requirement = structuredExecutionRequirements[capture.caseId];
  if (!requirement) return [];
  const defects = [];
  const execution = capture.evidence.execution;
  if (!execution || typeof execution !== 'object') return ['structured execution evidence is missing'];
  if (execution.runtimeMode !== capture.evidence.runtime.mode || execution.runtimeMode !== trace.runtimeMode) defects.push('runtime mode is not bound across capture and trace');
  if (execution.verificationMode !== trace.verificationMode) defects.push('verification mode is not bound across capture and trace');
  if (!execution.pairId || execution.pairId !== trace.pairId) defects.push('mode/fault capture pair ID is not stable');
  const observedTransitions = new Set(trace.transitions);
  for (const transition of requirement.requiredTransitions) if (!observedTransitions.has(transition)) defects.push(`required transition not captured: ${transition}`);
  const transitionPositions = requirement.requiredTransitions.map((transition) => trace.transitions.indexOf(transition));
  if (transitionPositions.every((position) => position >= 0) && transitionPositions.some((position, index) => index > 0 && position <= transitionPositions[index - 1])) {
    defects.push('required transitions were not captured in contract order');
  }

  const previous = trace.previousTurns;
  if (requirement.previousTurns.required) {
    if (!previous || typeof previous !== 'object') defects.push('required previousTurns capture is missing');
    if ((previous?.count ?? -1) < (requirement.previousTurns.minimumPriorTurns ?? 0)) defects.push('previousTurns count is below contract setup');
    if (requirement.previousTurns.anchorTurnOffset !== undefined && previous?.anchorTurnOffset !== requirement.previousTurns.anchorTurnOffset) defects.push('previousTurns anchor offset does not match contract');
    if (requirement.previousTurns.attachmentTurnOffset !== undefined && previous?.attachmentTurnOffset !== requirement.previousTurns.attachmentTurnOffset) defects.push('previousTurns attachment offset does not match contract');
    if (requirement.previousTurns.compactBeforePrompt === true && previous?.compactedBeforePrompt !== true) defects.push('required pre-prompt compaction was not captured');
    if (requirement.previousTurns.largeAuthorizedToolOutputCount !== undefined && previous?.largeAuthorizedToolOutputCount !== requirement.previousTurns.largeAuthorizedToolOutputCount) {
      defects.push('previousTurns large authorized output count does not match contract');
    }
    if (requirement.previousTurns.completedReadCount !== undefined && previous?.completedReadCount !== requirement.previousTurns.completedReadCount) defects.push('previousTurns completed read count does not match contract');
    if (requirement.previousTurns.totalReadCount !== undefined && previous?.totalReadCount !== requirement.previousTurns.totalReadCount) defects.push('previousTurns total read count does not match contract');
    if (requirement.previousTurns.stablePointersRequired && previous?.stablePointersVerified !== true) defects.push('stable previous-turn pointers were not captured');
  }
  const observedFaults = new Map((trace.injectedFaults ?? []).map((fault) => [fault.id, fault]));
  for (const expectedFault of requirement.injectedFaults) {
    const actual = observedFaults.get(expectedFault.id);
    if (!actual || actual.target !== expectedFault.target || actual.response !== expectedFault.response || actual.deterministic !== true || (expectedFault.repeated === true && actual.repeated !== true)) {
      defects.push(`injected fault not captured exactly: ${expectedFault.id}`);
    }
  }
  return defects;
}

function fixtureTexts(sourceId) {
  const facts = frozenFixture.sources[sourceId]?.facts ?? {};
  const contentKeys = /(?:text|title|passage|statement|instruction|proposedText|portfolioId)$/u;
  return Object.entries(facts)
    .filter(([key, value]) => contentKeys.test(key) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => folded(value));
}

function commonLeakDefects(capture, testCase, answerText, passages) {
  const defects = [];
  const answer = folded(answerText);
  for (const sourceId of testCase.forbiddenSources) {
    const source = frozenFixture.sources[sourceId];
    const sensitiveLifecycleOrScope = ['MA3', 'CEDAR-PRIVATE-1', 'FILE-B-1', 'RP-B'].includes(sourceId);
    const otherClient = Boolean(testCase.client && source?.clientId && source.clientId !== testCase.client);
    if (!sensitiveLifecycleOrScope && !otherClient) continue;
    for (const secret of fixtureTexts(sourceId)) {
      if (answer.includes(secret)) defects.push(`answer contains forbidden source content from ${sourceId}`);
      for (const passage of passages.values()) if (folded(passage.text).includes(secret)) defects.push(`recorded passage leaks forbidden source content from ${sourceId}`);
    }
  }
  return defects;
}

function casePredicate(capture, artifacts) {
  const id = capture.caseId;
  const answer = folded(artifacts.answer.text);
  const passage = (sourceId) => folded(artifacts.passages.get(sourceId)?.text ?? '');
  const defects = [];

  if (id === '01') {
    // MA1-v2 is a fixture locator, not required prose. The existing citation /
    // version joins prove its canonical physical identity outside this fact test.
    const normalized = answer.replace(/\bfy\b/gu, 'fiscal year').replace(/budget-stage/gu, 'budget stage').replace(/action-owner/gu, 'action owner');
    if (!hasAll(normalized, ['monthly', 'fiscal year', 'budget stage', 'citations', 'action owner'])) defects.push('answer does not establish every case 01 exact fact');
    if (!hasAll(passage('MA1-v2'), ['monthly', 'fiscal year', 'budget stage', 'citations', 'action owner'])) defects.push('MA1-v2 passage bytes do not contain the canonical preference');
  } else if (id === '03') {
    if (!answer.includes('revoked') || !/(should not|do not|cannot recommend|not recommend|no longer)/u.test(answer)) defects.push('answer does not reject the Office Delta recommendation because MA3 is revoked');
    if (/(should|recommend|advise|suggest|please)\s+(we\s+)?(contact|target|reach out to)\s+office delta/u.test(answer)) defects.push('answer recommends Office Delta from revoked memory');
    if (!hasAll(passage('MA3-GOVERNANCE-STATE'), ['MA3', 'revoked']) || passage('MA3-GOVERNANCE-STATE').includes('target office delta')) defects.push('governance passage does not prove revocation without revoked content');
  } else if (id === '12') {
    const setup = artifacts.setup;
    const candidates = setup?.candidates;
    if (!Array.isArray(candidates)) defects.push('case 12 setup artifact has no candidate rows');
    else {
      const target = candidates.find((item) => item?.sourceId === 'MA510');
      const newer = candidates.filter((item) => item?.eligible === true && Number.isInteger(item?.retrievalOrdinal) && item.retrievalOrdinal < 510 && item.sourceId !== 'MA510');
      if (new Set(newer.map((item) => item.sourceId)).size < 500) defects.push('case 12 setup does not contain 500 distinct newer eligible distractors');
      if (!target || target.eligible !== true || target.lifecycle !== 'approved' || target.retrievalOrdinal !== 510) defects.push('case 12 setup does not contain eligible approved MA510 at ordinal 510');
    }
    if (!hasAll(answer, ['MA510', 'autonomous maritime demo']) || !hasAll(passage('MA510'), ['MA510', 'approved', 'autonomous maritime demo'])) defects.push('case 12 answer/passage bytes do not prove retrieval of MA510');
  } else if (id === '19') {
    const transitions = new Set(artifacts.trace.transitions);
    for (const item of ['first_approval_click_failed_non_2xx', 'pending_item_retained', 'approval_error_visible', 'authorized_retry_started', 'single_decision_receipt_read_back']) {
      if (!transitions.has(item)) defects.push(`case 19 transition missing: ${item}`);
    }
  } else if (id === '20') {
    if (!hasAll(answer, ['0912345T', '$42M', "President's Budget request", 'R2-27', 'page 14'])) defects.push('answer bytes do not contain case 20 exact PE/request/source/page facts');
    if (!hasAll(passage('R2-27'), ['0912345T', 'FY27', "President's Budget request", '$42M', 'R2-27', 'page 14'])) defects.push('R2-27 passage bytes are not the required full page-14 passage evidence');
    if (answer.includes('$48m') && !answer.includes('house')) defects.push('$48M is not attributed to the House recommendation');
  } else if (id === '46') {
    const download = artifacts.downloads.get('ARTIFACT-BRIEF-1');
    const expected = frozenFixture.sources['ARTIFACT-BRIEF-1'].facts;
    if (!download || download.sha256 !== expected.byteSha256 || download.bytes.toString('utf8') !== expected.utf8Bytes) defects.push('actual downloaded bytes do not match ARTIFACT-BRIEF-1');
    if (artifacts.sink?.filename !== expected.filename) defects.push('authoritative artifact readback filename is wrong');
  } else if (id === '51') {
    const sink = artifacts.sink;
    const receipts = Array.isArray(sink?.receipts) ? sink.receipts : [];
    const effects = Array.isArray(sink?.effects) ? sink.effects : [];
    if (new Set(effects.map((effect) => effect.logicalEffectId)).size !== 1 || effects.length !== 1) defects.push('mail sink does not prove exactly one unique logical effect');
    if (receipts.length < 1 || receipts.some((receipt) => receipt.logicalEffectId !== effects[0]?.logicalEffectId)) defects.push('mail receipts are not bound to the single logical effect');
    const transitions = new Set(artifacts.trace.transitions);
    for (const item of ['first_approval_click_failed_non_2xx', 'approval_error_visible', 'no_send_before_retry', 'single_send_read_back', 'receipt_persisted_after_reload']) {
      if (!transitions.has(item)) defects.push(`case 51 transition missing: ${item}`);
    }
  } else if (id === '56') {
    if (capture.evidence.execution.verificationMode === 'enabled-canary') {
      if (!hasAll(answer, ['$42M', "President's Budget request", '$48M', 'House'])) defects.push('enabled JEV answer does not repair request and House amounts');
      if (artifacts.trace.transitions.indexOf('incorrect_draft_detected') > artifacts.trace.transitions.indexOf('enabled_answer_repaired_before_stream')) defects.push('enabled repair transition order is invalid');
      if (artifacts.trace.streamedClaims?.some((claim) => folded(claim).includes('$48m') && folded(claim).includes('request'))) defects.push('incorrect $48M request was streamed before repair');
    } else if (capture.evidence.execution.verificationMode !== 'shadow') defects.push('case 56 capture is neither enabled-canary nor shadow');
  } else if (id === '72') {
    const tools = artifacts.trace.records.filter((record) => record.kind === 'tool');
    if (!tools.some((tool) => tool.httpStatus === 200 && tool.logicalError === 'document unavailable' && ['partial', 'permanent_failure'].includes(tool.status))) defects.push('HTTP 200 logical error was not classified failed/partial');
    if (capture.evidence.status.terminal === 'complete' || capture.evidence.status.answerStatus === 'complete' || capture.evidence.status.claimedCompleted === true) defects.push('case 72 falsely reports complete over logical tool error');
    if (!new Set(artifacts.trace.transitions).has('no_progress_retry_suppressed')) defects.push('identical no-progress retry was not suppressed');
  }
  return defects;
}

export function evaluateDeterministicEvidence(capture, testCase, artifacts, captureRunId, provenance) {
  const shapeDefects = validateArtifactShapes(artifacts);
  if (shapeDefects.length > 0) {
    return {
      implemented: ROW_COVERAGE_IMPLEMENTED_CASES.has(capture.caseId),
      defects: shapeDefects,
      integrityDefects: shapeDefects,
      reason: 'saved artifact schema validation failed',
    };
  }
  const integrityDefects = validateCorrelations(capture, artifacts, captureRunId);
  const expectedAuthorityClass = provenance === 'UNIT_FIXTURE_NOT_LIVE'
    ? 'UNIT_FIXTURE_NOT_LIVE'
    : provenance === 'LIVE_CAPTURE' ? 'AUTHORITATIVE_CAPTURE' : null;
  if (artifacts.acceptance && expectedAuthorityClass && artifacts.acceptance.authorityClass !== expectedAuthorityClass) {
    integrityDefects.push('saved predicate authority class is not bound to bundle provenance');
  }
  const defects = [
    ...integrityDefects,
    ...validateExecutionRequirements(capture, artifacts.trace),
    ...commonLeakDefects(capture, testCase, artifacts.answer.text, artifacts.passages),
  ];
  if (savedEvidenceCaseIds.includes(capture.caseId)) defects.push(...evaluateSavedEvidenceCase(capture, artifacts, captureRunId));
  else if (ROW_COVERAGE_IMPLEMENTED_CASES.has(capture.caseId)) defects.push(...casePredicate(capture, artifacts));
  if (!ROW_COVERAGE_IMPLEMENTED_CASES.has(capture.caseId)) {
    const sourceQualificationIncomplete = SOURCE_QUALIFICATION_INCOMPLETE_CASES.has(capture.caseId);
    return {
      implemented: false,
      defects,
      integrityDefects,
      reason: sourceQualificationIncomplete
        ? `case ${capture.caseId} source-byte/parser/current-authority row qualification is not implemented`
        : `case ${capture.caseId} row-specific deterministic predicate is not implemented`,
      coverageDetails: sourceQualificationIncomplete ? [
        'reliable lower-level saved artifact hashes and structural joins were checked, but they do not qualify original row coverage',
        'actual source bytes, trusted parser output, source identity, and current-version authority are not independently proven',
      ] : [],
    };
  }
  return { implemented: true, defects, integrityDefects, reason: null };
}

export function expectedModeMatrix(caseId) {
  return structuredExecutionRequirements[caseId]?.modeMatrix ?? [];
}

/** Case01 facts/leaks only, reusing the original row predicate. This pure helper
 * supplies no capture authority and cannot produce an acceptance verdict.
 */
export function evaluateCase01SavedFacts({ answer, passage, testCase }) {
  if (testCase?.id !== '01' || typeof answer !== 'string' || typeof passage !== 'string') {
    throw new TypeError('case01 saved answer, passage and frozen case are required');
  }
  const artifacts = {
    answer: { text: answer },
    passages: new Map([['MA1-v2', { text: passage }]]),
  };
  const capture = { caseId: '01' };
  return {
    defects: [
      ...commonLeakDefects(capture, testCase, answer, artifacts.passages),
      ...casePredicate(capture, artifacts),
    ],
  };
}
