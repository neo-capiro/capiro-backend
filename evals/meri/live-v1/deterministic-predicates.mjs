import { frozenFixture } from './fixture.mjs';
import { structuredExecutionRequirements } from './execution-requirements.mjs';

const IMPLEMENTED_CASES = new Set(['01', '03', '12', '19', '20', '46', '51', '56', '72']);

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

function validateCorrelations(capture, artifacts, captureRunId) {
  const defects = validateTraceShape(artifacts.trace, capture, captureRunId);
  const { trace } = artifacts;
  if (!Array.isArray(trace?.records)) return defects;
  const run = capture.evidence.run;
  const records = trace.records;
  const bound = (record) => record?.runId === run.runId && record?.traceId === run.traceId && record?.caseId === capture.caseId;
  for (const record of records) if (!bound(record)) defects.push(`trace ${String(record?.kind)} record is not run/case correlated`);

  for (const tool of capture.evidence.runtime.tools) {
    const match = records.find((record) => record.kind === 'tool' && record.callId === tool.callId);
    if (!match || match.status !== tool.status || match.operationId !== tool.operationId) defects.push(`tool call ${tool.callId} lacks a correlated trace record`);
  }
  for (const citation of capture.evidence.sources.citations) {
    const passage = artifacts.passages.get(citation.sourceId);
    const sourceRecord = records.find((record) => record.kind === 'source' && record.sourceId === citation.sourceId && record.passageSha256 === passage?.sha256);
    const toolRecord = sourceRecord && records.find((record) => record.kind === 'tool' && record.callId === sourceRecord.toolCallId);
    if (!sourceRecord || !toolRecord || !toolRecord.sourceIds?.includes(citation.sourceId)) {
      defects.push(`source ${citation.sourceId} lacks source→tool→run correlation`);
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
    const proposal = records.find((record) => record.kind === 'proposal' && record.proposalId === effects.proposalId && record.payloadSha256 === artifacts.payload.sha256);
    const effect = records.find((record) => record.kind === 'effect' && record.operationId === effects.operationId && record.proposalId === effects.proposalId);
    if (!proposal || !effect) defects.push('proposal→effect trace correlation is incomplete');
  }
  for (const ui of artifacts.ui) {
    if (ui.captureRunId !== captureRunId || ui.runId !== run.runId || ui.traceId !== run.traceId || ui.caseId !== capture.caseId) {
      defects.push('UI artifact is not run/case correlated');
    }
    if (ui.operationId && ui.operationId !== capture.evidence.effects.operationId) defects.push('UI operation is not correlated to captured effect');
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
    if (!hasAll(answer, ['monthly', 'fiscal year', 'budget stage', 'citations', 'action owner', 'MA1-v2'])) defects.push('answer does not establish every case 01 exact fact and source version');
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

export function evaluateDeterministicEvidence(capture, testCase, artifacts, captureRunId) {
  const defects = [
    ...validateCorrelations(capture, artifacts, captureRunId),
    ...validateExecutionRequirements(capture, artifacts.trace),
    ...commonLeakDefects(capture, testCase, artifacts.answer.text, artifacts.passages),
  ];
  if (!IMPLEMENTED_CASES.has(capture.caseId)) {
    return { implemented: false, defects, reason: `case ${capture.caseId} row-specific deterministic predicate is not implemented` };
  }
  defects.push(...casePredicate(capture, artifacts));
  return { implemented: true, defects, reason: null };
}

export function expectedModeMatrix(caseId) {
  return structuredExecutionRequirements[caseId]?.modeMatrix ?? [];
}
