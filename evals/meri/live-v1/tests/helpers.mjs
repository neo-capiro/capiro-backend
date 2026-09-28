import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cases } from '../cases.mjs';
import { structuredExecutionRequirements } from '../execution-requirements.mjs';
import { frozenFixture } from '../fixture.mjs';

const lock = JSON.parse(readFileSync(new URL('../contract-lock.json', import.meta.url), 'utf8'));
const HASH = 'a'.repeat(64);

export function caseById(id) {
  return cases.find((testCase) => testCase.id === id);
}

// This intentionally reproduces the pre-repair fake capture shape accepted by the old verifier.
export function completeCapture(id) {
  const testCase = caseById(id);
  if (!testCase) throw new Error(`unknown case ${id}`);
  const actorTenantId = frozenFixture.actors[testCase.actor].tenantId;
  const consulted = [...testCase.requiredSources];
  const effectCount = testCase.expectedOperation.expectedLogicalEffectCount;
  const hasEffect = effectCount > 0;
  const uiApplicable = testCase.surface !== 'api';
  return {
    caseId: id,
    classification: { setupStatus: 'READY', executionStatus: 'CAPTURED', failureBoundary: 'none', reason: null },
    evidence: {
      run: { runId: `run-${id}`, conversationId: `conversation-${id}`, traceId: `trace-${id}`, planId: null, stepIds: [`step-${id}`], startedAt: '2026-09-26T16:00:00.000Z', finishedAt: '2026-09-26T16:00:01.000Z' },
      auth: { actorId: testCase.actor, actorTenantId, selectedTenantId: actorTenantId, selectedClientId: testCase.client, sessionEvidenceRef: `auth-${id}`, actorProven: true, tenantProven: true, clientProven: true },
      runtime: { mode: testCase.surface === 'research' ? 'Deep' : 'Standard', effectiveModel: 'fake-model', modelStatus: 'complete', modelAttempts: 1, tools: [{ callId: `call-${id}`, name: `fake-tool-${id}`, attempt: 1, status: 'complete', sourceIds: consulted, operationId: hasEffect ? `operation-${id}` : null }] },
      sources: {
        expectedSourceIds: [...testCase.sourceIds], consultedSourceIds: consulted, citedSourceIds: consulted,
        citations: consulted.map((sourceId) => ({ sourceId, version: 'fake-v1', locator: 'made-up-page-999', passageSha256: HASH, consulted: true })),
        coverage: 'complete', attachments: [{ applicable: false, notApplicableReason: 'fake', attachmentId: null, byteSha256: null, downloadReceiptRef: null }],
      },
      effects: { applicable: hasEffect, notApplicableReason: hasEffect ? null : 'read-only', approvalRequired: testCase.expectedOperation.approvalRequired, proposalId: hasEffect ? `proposal-${id}` : null, operationId: hasEffect ? `operation-${id}` : null, payloadSha256: hasEffect ? HASH : null, receiptIds: hasEffect ? [`receipt-${id}`] : [], observedLogicalEffectCount: effectCount, authoritativeReadback: true, status: hasEffect ? 'succeeded' : 'not_applicable' },
      status: { terminal: testCase.terminal.allowed[0], answerStatus: testCase.terminal.allowed[0], answerRef: `answer-${id}`, answerSha256: HASH, claimedCompleted: true },
      ui: { applicable: uiApplicable, notApplicableReason: uiApplicable ? null : 'fake API capture', route: uiApplicable ? '/meri' : null, evidenceRefs: uiApplicable ? [`ui-${id}`] : [], approvalVisible: hasEffect ? true : null, approvalErrorVisible: ['19', '51'].includes(id) ? true : null, persistedAfterReload: uiApplicable ? true : null, stayedInsideMeri: uiApplicable ? true : null },
    },
    assertions: testCase.hardGates.map((gate) => ({ id: gate.id, passed: true, evidenceRefs: [`fake-${id}`] })),
    rubric: { status: 'GRADED', grader: 'fake', humanAdjudication: 'fake', dimensions: { factual_support: 2, evidence_coverage_citation_validity: 2, client_relevance: 2, directness_clarity: 2, actionable_judgment: 2 } },
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function writeArtifact(root, ref, value, { raw = false } = {}) {
  const bytes = raw ? Buffer.from(value) : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  const path = join(root, ...ref.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
  return { ref, sha256: sha256(bytes) };
}

function sourcePassage(sourceId) {
  if (sourceId === 'MA1-v2') return 'MA1-v2 approved memory: Monthly briefs include fiscal year, budget stage, citations and action owner.';
  if (sourceId === 'MA3-GOVERNANCE-STATE') return 'Governance receipt for MA3: lifecycle revoked; contentIncluded false.';
  if (sourceId === 'MA510') return 'MA510 approved institutional memory: autonomous maritime demo.';
  if (sourceId === 'R2-27') return "R2-27 full passage, page 14: PE 0912345T FY27 President's Budget request is $42M.";
  if (sourceId === 'HOUSE-27') return 'HOUSE-27 full passage: House recommendation for PE 0912345T is $48M.';
  return `${sourceId} saved controlled UNIT fixture passage: ${JSON.stringify(frozenFixture.sources[sourceId]?.facts ?? {})}`;
}

function answerFor(id, verificationMode) {
  const answers = {
    '01': 'Aster prefers monthly briefs that include fiscal year, budget stage, citations, and an action owner. Source: MA1-v2.',
    '03': 'MA3 is revoked, so we should not contact Office Delta based on that memory.',
    '12': 'MA510 says autonomous maritime demo.',
    '19': 'The first approval failed visibly; the authorized retry completed with one decision receipt.',
    '20': "PE 0912345T's FY27 President's Budget request is $42M in R2-27, page 14.",
    '46': 'The briefing is available as aster-synthetic-briefing.txt.',
    '51': 'The approved follow-up was sent once and has a durable receipt.',
    '56': verificationMode === 'shadow' ? 'The draft called $48M the request.' : "The FY27 President's Budget request is $42M; $48M is the House recommendation.",
    '72': 'The memo is unavailable; I could not complete the read.',
  };
  return answers[id] ?? `Controlled UNIT fixture answer for ${id}.`;
}

function extraTransitions(id) {
  if (id === '19') return ['first_approval_click_failed_non_2xx', 'pending_item_retained', 'approval_error_visible', 'authorized_retry_started', 'single_decision_receipt_read_back'];
  if (id === '51') return ['first_approval_click_failed_non_2xx', 'approval_error_visible', 'no_send_before_retry', 'single_send_read_back', 'receipt_persisted_after_reload'];
  return [];
}

function makeCapture(root, id, { runtimeMode = 'Standard', verificationMode = 'default', pairId = `pair-${id}`, completeCase12Setup = false } = {}) {
  const testCase = caseById(id);
  const suffix = `${id}-${runtimeMode.toLowerCase()}-${verificationMode}`;
  const runId = `run-${suffix}`;
  const traceId = `trace-${suffix}`;
  const conversationId = `conversation-${id}`;
  const actorTenantId = frozenFixture.actors[testCase.actor].tenantId;
  const consulted = [...testCase.requiredSources];
  const hasEffect = testCase.expectedOperation.expectedLogicalEffectCount > 0;
  const operationId = hasEffect ? `operation-${suffix}` : null;
  const proposalId = hasEffect ? `proposal-${suffix}` : null;
  const receiptId = hasEffect ? `receipt-${suffix}` : null;
  const logicalEffectId = hasEffect ? `effect-${suffix}` : null;
  const captureRunId = 'unit-capture-run';
  const prefix = `captures/${suffix}`;

  const answer = writeArtifact(root, `${prefix}/answer.txt`, answerFor(id, verificationMode));
  const passageDescriptors = new Map(consulted.map((sourceId) => [sourceId, writeArtifact(root, `${prefix}/passages/${sourceId}.txt`, sourcePassage(sourceId))]));
  const payload = hasEffect ? writeArtifact(root, `${prefix}/payload.json`, { caseId: id, operationId, proposalId }) : null;
  const sinkValue = hasEffect ? {
    schemaVersion: 1, captureRunId, caseId: id, runId, traceId, operationId, proposalId, payloadSha256: payload.sha256,
    filename: id === '46' ? frozenFixture.sources['ARTIFACT-BRIEF-1'].facts.filename : null,
    receipts: [{ receiptId, logicalEffectId, status: 'succeeded' }],
    effects: [{ logicalEffectId, type: testCase.expectedOperation.kind, status: 'succeeded' }],
  } : null;
  const sink = sinkValue ? writeArtifact(root, `${prefix}/sink.json`, sinkValue) : null;

  const authValue = { schemaVersion: 1, captureRunId, caseId: id, runId, traceId, sessionId: `session-${suffix}`, actorId: testCase.actor, actorTenantId, selectedTenantId: actorTenantId, selectedClientId: testCase.client, issuer: 'unit-fixture-not-live' };
  const auth = writeArtifact(root, `${prefix}/auth.json`, authValue);
  const uiValue = testCase.surface === 'api' ? null : { schemaVersion: 1, captureRunId, caseId: id, runId, traceId, operationId, proposalId, route: '/meri', event: 'controlled-unit-ui-record' };
  const ui = uiValue ? writeArtifact(root, `${prefix}/ui.json`, uiValue) : null;
  const adjudicationValue = { schemaVersion: 1, captureRunId, caseId: id, runId, grader: 'unit-human-fixture', adjudication: 'Controlled UNIT fixture; NOT live.', dimensions: { factual_support: 2, evidence_coverage_citation_validity: 2, client_relevance: 2, directness_clarity: 2, actionable_judgment: 2 } };
  const adjudication = writeArtifact(root, `${prefix}/adjudication.json`, adjudicationValue);

  let setup = null;
  if (id === '12') {
    const candidates = completeCase12Setup
      ? [...Array.from({ length: 500 }, (_, index) => ({ sourceId: `DISTRACTOR-${String(index + 1).padStart(3, '0')}`, eligible: true, retrievalOrdinal: index + 1 })), { sourceId: 'MA510', eligible: true, lifecycle: 'approved', retrievalOrdinal: 510 }]
      : [{ sourceId: 'MA510', eligible: true, lifecycle: 'approved', retrievalOrdinal: 510 }];
    setup = writeArtifact(root, `${prefix}/setup.json`, { schemaVersion: 1, captureRunId, caseId: id, candidates });
  }

  let download = null;
  let downloadReceipt = null;
  if (id === '46') {
    const artifactFixture = frozenFixture.sources['ARTIFACT-BRIEF-1'].facts;
    download = writeArtifact(root, `${prefix}/downloads/${artifactFixture.filename}`, artifactFixture.utf8Bytes, { raw: true });
    downloadReceipt = writeArtifact(root, `${prefix}/download-receipt.json`, { schemaVersion: 1, captureRunId, caseId: id, runId, traceId, operationId, byteSha256: download.sha256 });
  }

  const requirements = structuredExecutionRequirements[id];
  const transitions = [...new Set([...(requirements?.requiredTransitions ?? []), ...extraTransitions(id)])];
  const previousTurns = requirements?.previousTurns?.required ? {
    count: requirements.previousTurns.minimumPriorTurns ?? 0,
    anchorTurnOffset: requirements.previousTurns.anchorTurnOffset,
    attachmentTurnOffset: requirements.previousTurns.attachmentTurnOffset,
    compactedBeforePrompt: requirements.previousTurns.compactBeforePrompt,
    largeAuthorizedToolOutputCount: requirements.previousTurns.largeAuthorizedToolOutputCount,
    completedReadCount: requirements.previousTurns.completedReadCount,
    totalReadCount: requirements.previousTurns.totalReadCount,
    stablePointersVerified: requirements.previousTurns.stablePointersRequired ? true : undefined,
  } : null;
  const injectedFaults = (requirements?.injectedFaults ?? []).map((fault) => ({ ...fault }));
  const toolRecords = consulted.map((sourceId, index) => ({ kind: 'tool', caseId: id, runId, traceId, callId: `call-${suffix}-${index}`, name: `controlled-tool-${sourceId}`, status: id === '72' ? 'partial' : 'complete', sourceIds: [sourceId], operationId, httpStatus: id === '72' ? 200 : 200, logicalError: id === '72' ? 'document unavailable' : null }));
  const sourceRecords = consulted.map((sourceId, index) => ({ kind: 'source', caseId: id, runId, traceId, sourceId, passageSha256: passageDescriptors.get(sourceId).sha256, toolCallId: `call-${suffix}-${index}` }));
  const effectRecords = hasEffect ? [
    { kind: 'proposal', caseId: id, runId, traceId, proposalId, payloadSha256: payload.sha256 },
    { kind: 'effect', caseId: id, runId, traceId, operationId, proposalId, receiptId, logicalEffectId },
  ] : [];
  const traceValue = {
    schemaVersion: 1, captureRunId, caseId: id, runId, conversationId, traceId, runtimeMode, verificationMode, pairId,
    previousTurns, injectedFaults, transitions, streamedClaims: [],
    records: [{ kind: 'auth', caseId: id, runId, traceId, sessionId: authValue.sessionId }, ...toolRecords, ...sourceRecords, ...effectRecords],
  };
  const trace = writeArtifact(root, `${prefix}/trace.json`, traceValue);

  return {
    caseId: id,
    classification: { setupStatus: 'READY', executionStatus: 'CAPTURED', failureBoundary: 'none', reason: null },
    evidence: {
      run: { runId, conversationId, traceId, planId: null, stepIds: [`step-${suffix}`], startedAt: '2026-09-26T16:00:00.000Z', finishedAt: '2026-09-26T16:00:01.000Z', traceArtifact: trace },
      auth: { actorId: testCase.actor, actorTenantId, selectedTenantId: actorTenantId, selectedClientId: testCase.client, sessionEvidenceRef: auth.ref, sessionEvidenceSha256: auth.sha256, actorProven: true, tenantProven: true, clientProven: true },
      runtime: { mode: runtimeMode, effectiveModel: 'controlled-unit-model', modelStatus: id === '72' ? 'incomplete' : 'complete', modelAttempts: 1, tools: toolRecords.map(({ callId, name, status, sourceIds, operationId: toolOperationId }, index) => ({ callId, name, attempt: index + 1, status, sourceIds, operationId: toolOperationId })) },
      setup: { applicable: Boolean(setup), notApplicableReason: setup ? null : 'no row-specific setup artifact used by this UNIT fixture', artifact: setup },
      execution: { runtimeMode, verificationMode, pairId },
      sources: {
        expectedSourceIds: [...testCase.sourceIds], consultedSourceIds: consulted, citedSourceIds: consulted,
        citations: consulted.map((sourceId) => ({ sourceId, version: 'controlled-unit-v1', locator: `unit:${sourceId}`, passageRef: passageDescriptors.get(sourceId).ref, passageSha256: passageDescriptors.get(sourceId).sha256, consulted: true })),
        coverage: 'complete',
        attachments: [{ applicable: id === '46', notApplicableReason: id === '46' ? null : 'not an attachment case', attachmentId: id === '46' ? 'ARTIFACT-BRIEF-1' : null, byteRef: download?.ref ?? null, byteSha256: download?.sha256 ?? null, downloadReceiptRef: downloadReceipt?.ref ?? null, downloadReceiptSha256: downloadReceipt?.sha256 ?? null }],
      },
      effects: { applicable: hasEffect, notApplicableReason: hasEffect ? null : 'read-only case', approvalRequired: testCase.expectedOperation.approvalRequired, proposalId, operationId, payloadRef: payload?.ref ?? null, payloadSha256: payload?.sha256 ?? null, sinkRef: sink?.ref ?? null, sinkSha256: sink?.sha256 ?? null, receiptIds: receiptId ? [receiptId] : [], observedLogicalEffectCount: hasEffect ? 1 : 0, authoritativeReadback: hasEffect, status: hasEffect ? 'succeeded' : 'not_applicable' },
      status: { terminal: id === '72' ? 'partial' : testCase.terminal.allowed[0], answerStatus: id === '72' ? 'partial' : testCase.terminal.allowed[0], answerRef: answer.ref, answerSha256: answer.sha256, claimedCompleted: id !== '72' },
      ui: { applicable: Boolean(ui), notApplicableReason: ui ? null : 'API capture has no UI artifact', route: ui ? '/meri' : null, evidenceRefs: ui ? [ui.ref] : [], evidenceArtifacts: ui ? [ui] : [], approvalVisible: hasEffect ? true : null, approvalErrorVisible: ['19', '51'].includes(id) ? true : null, persistedAfterReload: ui ? true : null, stayedInsideMeri: ui ? true : null },
    },
    assertions: testCase.hardGates.map((gate) => ({ id: gate.id, passed: true, evidenceRefs: ['caller-boolean-deliberately-ignored'] })),
    rubric: { status: 'GRADED', grader: adjudicationValue.grader, humanAdjudication: adjudicationValue.adjudication, adjudicationRef: adjudication.ref, adjudicationSha256: adjudication.sha256, dimensions: adjudicationValue.dimensions },
  };
}

export function materializeUnitBundle(variants) {
  const scratch = process.env.TMPDIR || process.cwd();
  const root = mkdtempSync(join(scratch, 'meri-live-v1-unit-'));
  const captures = variants.map((variant) => makeCapture(root, variant.id, variant));
  const ownerValue = { schemaVersion: 1, kind: 'meri-live-v1-artifact-bundle', provenance: 'UNIT_FIXTURE_NOT_LIVE', captureRunId: 'unit-capture-run', fixtureVersion: frozenFixture.version, fixtureSha256: lock.fixtureSha256, contractSourceSha256: lock.contractSourceSha256 };
  const owner = writeArtifact(root, 'bundle-owner.json', ownerValue);
  const checkoutSha = 'f34923daf9ba86eed6e42aca94b7f8e0c273f1b8';
  return {
    root,
    bundle: {
      schemaVersion: 1,
      contract: { fixtureVersion: frozenFixture.version, fixtureSha256: lock.fixtureSha256, contractSourceSha256: lock.contractSourceSha256 },
      artifactRoot: root,
      ownerSha256: owner.sha256,
      runManifest: {
        captureRunId: 'unit-capture-run', checkoutSha,
        deployed: { apiSha: checkoutSha, webSha: checkoutSha, runtimeRelease: 'unit-not-live', configHash: HASH, flagsHash: HASH, checkoutDifferenceReason: null },
        target: { environment: 'isolated-local', endpointIdentity: 'controlled-unit-fixture-not-live', dedicatedEvalTenant: true, networkExecutionAllowed: true },
        fixture: { namespace: 'UNIT_FIXTURE_NOT_LIVE', version: frozenFixture.version, sha256: lock.fixtureSha256, clock: frozenFixture.clock.local, resetReceipt: 'unit-reset-not-live' },
        captureAdapter: { name: 'controlled-unit-fixture', version: '1', writeExecution: 'capture-only-live-adapter' },
        authPrerequisites: { status: 'READY', identitiesVerified: true, reason: null },
      },
      captures,
    },
  };
}