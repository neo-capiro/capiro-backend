import { cases } from '../cases.mjs';
import { frozenFixture } from '../fixture.mjs';

const HASH = 'a'.repeat(64);

export function caseById(id) {
  return cases.find((testCase) => testCase.id === id);
}

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
    classification: {
      setupStatus: 'READY',
      executionStatus: 'CAPTURED',
      failureBoundary: 'none',
      reason: null,
    },
    evidence: {
      run: {
        runId: `run-${id}`,
        conversationId: `conversation-${id}`,
        traceId: `trace-${id}`,
        planId: null,
        stepIds: [`step-${id}`],
        startedAt: '2026-09-26T16:00:00.000Z',
        finishedAt: '2026-09-26T16:00:01.000Z',
      },
      auth: {
        actorId: testCase.actor,
        actorTenantId,
        selectedTenantId: actorTenantId,
        selectedClientId: testCase.client,
        sessionEvidenceRef: `auth-${id}`,
        actorProven: true,
        tenantProven: true,
        clientProven: true,
      },
      runtime: {
        mode: testCase.surface === 'research' ? 'Deep' : 'Standard',
        effectiveModel: 'synthetic-verifier-test-model',
        modelStatus: 'complete',
        modelAttempts: 1,
        tools: [{
          callId: `call-${id}`,
          name: `fixture-tool-${id}`,
          attempt: 1,
          status: 'complete',
          sourceIds: consulted,
          operationId: hasEffect ? `operation-${id}` : null,
        }],
      },
      sources: {
        expectedSourceIds: [...testCase.sourceIds],
        consultedSourceIds: consulted,
        citedSourceIds: consulted,
        citations: consulted.map((sourceId) => ({
          sourceId,
          version: 'fixture-v1',
          locator: `fixture:${sourceId}`,
          passageSha256: HASH,
          consulted: true,
        })),
        coverage: 'complete',
        attachments: [{
          applicable: false,
          notApplicableReason: 'not an attachment verifier test',
          attachmentId: null,
          byteSha256: null,
          downloadReceiptRef: null,
        }],
      },
      effects: {
        applicable: hasEffect,
        notApplicableReason: hasEffect ? null : 'read-only case',
        approvalRequired: testCase.expectedOperation.approvalRequired,
        proposalId: testCase.expectedOperation.approvalRequired ? `proposal-${id}` : null,
        operationId: hasEffect ? `operation-${id}` : null,
        payloadSha256: testCase.expectedOperation.approvalRequired ? HASH : null,
        receiptIds: hasEffect ? [`receipt-${id}`] : [],
        observedLogicalEffectCount: effectCount,
        authoritativeReadback: true,
        status: hasEffect ? 'succeeded' : 'not_applicable',
      },
      status: {
        terminal: testCase.terminal.allowed[0],
        answerStatus: testCase.terminal.allowed[0],
        answerRef: `answer-${id}`,
        answerSha256: HASH,
        claimedCompleted: true,
      },
      ui: {
        applicable: uiApplicable,
        notApplicableReason: uiApplicable ? null : 'APIRequestContext capture has no UI step',
        route: uiApplicable ? '/meri' : null,
        evidenceRefs: uiApplicable ? [`ui-${id}`] : [],
        approvalVisible: testCase.expectedOperation.approvalRequired ? true : null,
        approvalErrorVisible: id === '19' || id === '51' ? true : null,
        persistedAfterReload: uiApplicable ? true : null,
        stayedInsideMeri: uiApplicable ? true : null,
      },
    },
    assertions: testCase.hardGates.map((gate) => ({ id: gate.id, passed: true, evidenceRefs: [`assertion-${id}`] })),
    rubric: {
      status: 'GRADED',
      grader: 'synthetic verifier contract test',
      humanAdjudication: 'synthetic verifier contract test only',
      dimensions: {
        factual_support: 2,
        evidence_coverage_citation_validity: 2,
        client_relevance: 2,
        directness_clarity: 2,
        actionable_judgment: 2,
      },
    },
  };
}
