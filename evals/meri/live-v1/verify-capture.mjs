import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cases } from './cases.mjs';
import { frozenFixture } from './fixture.mjs';
import { validateContract } from './validate-contract.mjs';

const lock = JSON.parse(await readFile(new URL('./contract-lock.json', import.meta.url), 'utf8'));
const caseById = new Map(cases.map((testCase) => [testCase.id, testCase]));
const SHA256 = /^[a-f0-9]{64}$/u;
const workspaceApprovalErrorCases = new Set(['19', '51']);
const attachmentHashCases = new Set(['41', '42', '44', '46']);

function valueAt(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function missingEvidencePaths(capture) {
  const required = [
    'evidence.run.runId',
    'evidence.run.conversationId',
    'evidence.run.traceId',
    'evidence.run.startedAt',
    'evidence.run.finishedAt',
    'evidence.auth.actorId',
    'evidence.auth.actorTenantId',
    'evidence.auth.selectedTenantId',
    'evidence.auth.sessionEvidenceRef',
    'evidence.runtime.mode',
    'evidence.runtime.effectiveModel',
    'evidence.runtime.modelStatus',
    'evidence.sources.expectedSourceIds',
    'evidence.sources.consultedSourceIds',
    'evidence.sources.citedSourceIds',
    'evidence.sources.citations',
    'evidence.sources.coverage',
    'evidence.sources.attachments',
    'evidence.effects.applicable',
    'evidence.effects.approvalRequired',
    'evidence.effects.receiptIds',
    'evidence.effects.observedLogicalEffectCount',
    'evidence.effects.authoritativeReadback',
    'evidence.effects.status',
    'evidence.status.terminal',
    'evidence.status.answerStatus',
    'evidence.status.answerRef',
    'evidence.status.answerSha256',
    'evidence.status.claimedCompleted',
    'evidence.ui.applicable',
    'evidence.ui.evidenceRefs',
  ];
  const missing = required.filter((path) => valueAt(capture, path) === undefined || valueAt(capture, path) === null);
  if (!Array.isArray(capture?.evidence?.runtime?.tools)) missing.push('evidence.runtime.tools');
  if (!Array.isArray(capture?.assertions)) missing.push('assertions');
  if (!capture?.rubric || typeof capture.rubric !== 'object') missing.push('rubric');
  return missing;
}

function fail(status, reason, details = []) {
  return { status, reason, details };
}

export function evaluateCapture(capture, testCase) {
  if (!capture || typeof capture !== 'object') return fail('NOT_RUN', 'capture is missing or malformed');
  const classification = capture.classification;
  if (!classification || typeof classification !== 'object') return fail('NOT_RUN', 'capture classification is missing');
  if (classification.setupStatus === 'BLOCKED_PREREQUISITE' || classification.setupStatus === 'STALE_TARGET') {
    return fail('BLOCKED', classification.reason || `setup status ${classification.setupStatus}`);
  }
  if (classification.setupStatus !== 'READY') return fail('BLOCKED', 'setup readiness was not proved');
  if (classification.executionStatus !== 'CAPTURED') {
    return fail('NOT_RUN', classification.reason || `execution status ${classification.executionStatus || 'missing'}`);
  }

  const missing = missingEvidencePaths(capture);
  if (missing.length > 0) return fail('NOT_RUN', 'required capture evidence is missing', missing);

  const defects = [];
  const evidence = capture.evidence;
  const actor = frozenFixture.actors[testCase.actor];
  const expectedTenant = actor.tenantId;
  const expectedClient = testCase.client;

  if (evidence.auth.actorId !== testCase.actor || evidence.auth.actorProven !== true) defects.push('authenticated actor was not proved');
  if (evidence.auth.actorTenantId !== expectedTenant || evidence.auth.selectedTenantId !== expectedTenant || evidence.auth.tenantProven !== true) {
    defects.push('tenant scope was not proved');
  }
  if (evidence.auth.selectedClientId !== expectedClient || evidence.auth.clientProven !== true) defects.push('selected client was not proved');

  const sourceEvidence = evidence.sources;
  const consulted = new Set(sourceEvidence.consultedSourceIds);
  const cited = new Set(sourceEvidence.citedSourceIds);
  const expected = new Set(sourceEvidence.expectedSourceIds);
  for (const sourceId of testCase.sourceIds) {
    if (!expected.has(sourceId)) defects.push(`expected source declaration is missing ${sourceId}`);
  }
  for (const sourceId of testCase.requiredSources) {
    if (!consulted.has(sourceId)) defects.push(`required source was not consulted: ${sourceId}`);
  }
  for (const sourceId of testCase.forbiddenSources) {
    if (consulted.has(sourceId) || cited.has(sourceId)) defects.push(`forbidden source leak: ${sourceId}`);
  }
  for (const sourceId of [...consulted, ...cited]) {
    const fixtureSource = frozenFixture.sources[sourceId];
    if (!fixtureSource) {
      defects.push(`unrecognized source ID: ${sourceId}`);
      continue;
    }
    if (fixtureSource.tenantId && fixtureSource.tenantId !== expectedTenant) defects.push(`cross-tenant source leak: ${sourceId}`);
    if (expectedClient && fixtureSource.clientId && fixtureSource.clientId !== expectedClient) defects.push(`cross-client source leak: ${sourceId}`);
  }
  for (const citation of sourceEvidence.citations) {
    if (!citation || !consulted.has(citation.sourceId) || !cited.has(citation.sourceId)) defects.push('citation is not joined to consulted and cited source IDs');
    if (!citation?.locator || !SHA256.test(citation?.passageSha256 ?? '') || citation?.consulted !== true) defects.push('citation locator/passage evidence is incomplete');
  }
  if (cited.size > 0 && sourceEvidence.citations.length === 0) defects.push('cited sources have no citation receipts');

  if (attachmentHashCases.has(testCase.id)) {
    const applicableAttachment = sourceEvidence.attachments.find((attachment) => attachment?.applicable === true);
    if (!applicableAttachment || !SHA256.test(applicableAttachment.byteSha256 ?? '')) defects.push('required attachment byte hash is missing');
    if (testCase.id === '46' && applicableAttachment?.byteSha256 !== frozenFixture.sources['ARTIFACT-BRIEF-1'].facts.byteSha256) {
      defects.push('artifact download byte hash does not match frozen fixture');
    }
  }

  const effects = evidence.effects;
  const expectedOperation = testCase.expectedOperation;
  if (effects.observedLogicalEffectCount > expectedOperation.maxLogicalEffectCount) defects.push('duplicate logical effect observed');
  if (effects.observedLogicalEffectCount !== expectedOperation.expectedLogicalEffectCount) {
    defects.push(`logical effect count ${effects.observedLogicalEffectCount} does not equal expected ${expectedOperation.expectedLogicalEffectCount}`);
  }
  if (expectedOperation.expectedLogicalEffectCount > 0) {
    if (effects.applicable !== true || effects.status !== 'succeeded') defects.push('expected effect is not authoritatively succeeded');
    if (!effects.operationId || effects.receiptIds.length === 0 || effects.authoritativeReadback !== true) defects.push('effect receipt/readback evidence is incomplete');
    if (expectedOperation.approvalRequired && (!effects.proposalId || !SHA256.test(effects.payloadSha256 ?? ''))) defects.push('approval proposal/payload binding is incomplete');
  } else if (effects.observedLogicalEffectCount !== 0) {
    defects.push('read-only or denied case observed a mutation');
  }

  if (!testCase.terminal.allowed.includes(evidence.status.terminal)) defects.push(`terminal state ${evidence.status.terminal} is not allowed`);
  if (!SHA256.test(evidence.status.answerSha256)) defects.push('answer hash is malformed');
  const latestToolByName = new Map();
  for (const tool of evidence.runtime.tools) {
    const previous = latestToolByName.get(tool.name);
    if (!previous || tool.attempt > previous.attempt) latestToolByName.set(tool.name, tool);
  }
  const failedTools = [...latestToolByName.values()].filter((tool) => ['partial', 'unavailable', 'denied', 'retryable_failure', 'permanent_failure', 'unknown_outcome', 'invalid_not_executed'].includes(tool.status));
  if (evidence.status.claimedCompleted === true && (evidence.runtime.modelStatus !== 'complete' || failedTools.length > 0)) {
    defects.push('false-success claim conflicts with model/tool status');
  }
  if (evidence.status.claimedCompleted === true && expectedOperation.expectedLogicalEffectCount > 0 && effects.status !== 'succeeded') {
    defects.push('false-success claim conflicts with effect status');
  }

  const ui = evidence.ui;
  if (testCase.surface === 'workspace' || testCase.surface === 'research') {
    if (ui.applicable !== true || !ui.route?.startsWith('/meri') || ui.evidenceRefs.length === 0 || ui.stayedInsideMeri !== true) {
      defects.push('required /meri UI evidence is incomplete');
    }
  } else if (ui.applicable !== false || !ui.notApplicableReason) {
    defects.push('API capture must explicitly explain why UI evidence is not applicable');
  }
  if (expectedOperation.approvalRequired && ui.approvalVisible !== true) defects.push('required approval UI was not observed');
  if (workspaceApprovalErrorCases.has(testCase.id) && ui.approvalErrorVisible !== true) defects.push('required approval error was not visible');

  const assertionById = new Map(capture.assertions.map((assertion) => [assertion?.id, assertion]));
  for (const gate of testCase.hardGates) {
    const assertion = assertionById.get(gate.id);
    if (!assertion) defects.push(`hard-gate assertion missing: ${gate.id}`);
    else if (assertion.passed !== true || !Array.isArray(assertion.evidenceRefs) || assertion.evidenceRefs.length === 0) defects.push(`hard-gate assertion failed: ${gate.id}`);
  }

  const rubric = capture.rubric;
  const scores = testCase.humanRubric.dimensions.map((dimension) => rubric?.dimensions?.[dimension]);
  if (rubric?.status !== 'GRADED' || !rubric.humanAdjudication || scores.some((score) => !Number.isInteger(score))) {
    defects.push('human rubric/adjudication is incomplete');
  } else {
    const total = scores.reduce((sum, score) => sum + score, 0);
    if (scores.some((score) => score < testCase.humanRubric.minimumPerDimension) || total < testCase.humanRubric.target) {
      defects.push(`human rubric failed: ${total}/10`);
    }
  }

  if (defects.length > 0) return fail('FAIL', 'captured execution violates contract', defects);
  return { status: 'PASS', reason: 'all deterministic evidence and human rubric requirements passed', details: [] };
}

export function verifyCaptureBundle(bundle = {}) {
  const contract = validateContract();
  const errors = [...contract.errors];
  const captures = Array.isArray(bundle.captures) ? bundle.captures : [];
  const ids = captures.map((capture) => capture?.caseId);
  if (new Set(ids).size !== ids.length) errors.push('capture bundle contains duplicate case IDs');
  for (const id of ids) if (!caseById.has(id)) errors.push(`capture bundle contains unknown case ID ${String(id)}`);

  if (captures.length > 0) {
    const runManifest = bundle.runManifest;
    const requiredRunPaths = [
      'captureRunId', 'checkoutSha',
      'deployed.apiSha', 'deployed.webSha', 'deployed.runtimeRelease', 'deployed.configHash', 'deployed.flagsHash',
      'target.environment', 'target.endpointIdentity',
      'fixture.namespace', 'fixture.version', 'fixture.sha256', 'fixture.clock', 'fixture.resetReceipt',
      'captureAdapter.name', 'captureAdapter.version', 'captureAdapter.writeExecution',
      'authPrerequisites.status', 'authPrerequisites.identitiesVerified',
    ];
    if (!runManifest || typeof runManifest !== 'object') {
      errors.push('captured cases require a runManifest');
    } else {
      for (const path of requiredRunPaths) {
        const value = valueAt(runManifest, path);
        if (value === undefined || value === null || value === '') errors.push(`runManifest is missing ${path}`);
      }
      if (!/^[a-f0-9]{40}$/u.test(runManifest.checkoutSha ?? '')) errors.push('runManifest checkoutSha is malformed');
      if (!SHA256.test(runManifest.deployed?.configHash ?? '') || !SHA256.test(runManifest.deployed?.flagsHash ?? '')) {
        errors.push('runManifest deployed config/flags hashes are malformed');
      }
      if (runManifest.target?.dedicatedEvalTenant !== true || runManifest.target?.networkExecutionAllowed !== true) {
        errors.push('captured cases require an explicit dedicated target and execution allowance');
      }
      if (runManifest.fixture?.version !== frozenFixture.version || runManifest.fixture?.sha256 !== lock.fixtureSha256 || runManifest.fixture?.clock !== frozenFixture.clock.local) {
        errors.push('runManifest fixture identity/clock is stale');
      }
      if (runManifest.captureAdapter?.writeExecution !== 'capture-only-live-adapter') errors.push('runManifest capture adapter boundary is invalid');
      if (runManifest.authPrerequisites?.status !== 'READY' || runManifest.authPrerequisites?.identitiesVerified !== true) {
        errors.push('runManifest authenticated identities are not ready');
      }
      const deployedDiffers = runManifest.deployed?.apiSha !== runManifest.checkoutSha || runManifest.deployed?.webSha !== runManifest.checkoutSha;
      if (deployedDiffers && !runManifest.deployed?.checkoutDifferenceReason) errors.push('deployed/checkout difference lacks an explicit reason');
    }
    if (!bundle.contract) errors.push('captured cases require frozen contract identity');
  }

  const declaredContract = bundle.contract;
  if (declaredContract) {
    if (declaredContract.fixtureVersion !== frozenFixture.version) errors.push('capture fixture version does not match contract');
    if (declaredContract.fixtureSha256 !== lock.fixtureSha256) errors.push('capture fixture hash does not match contract');
    if (declaredContract.contractSourceSha256 !== lock.contractSourceSha256) errors.push('capture source hash does not match contract');
  }

  const capturesById = new Map(captures.map((capture) => [capture.caseId, capture]));
  const results = cases.map((testCase) => {
    if (errors.length > 0) return { caseId: testCase.id, status: 'BLOCKED', reason: 'capture bundle integrity failure', details: errors };
    const capture = capturesById.get(testCase.id);
    if (!capture) return { caseId: testCase.id, status: 'NOT_RUN', reason: 'no capture exists', details: [] };
    return { caseId: testCase.id, ...evaluateCapture(capture, testCase) };
  });
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
  for (const result of results) counts[result.status] += 1;
  return {
    valid: errors.length === 0,
    errors,
    contract: {
      fixtureVersion: frozenFixture.version,
      fixtureSha256: lock.fixtureSha256,
      contractSourceSha256: lock.contractSourceSha256,
    },
    counts,
    score: counts.PASS + counts.FAIL === 0 ? null : counts.PASS / (counts.PASS + counts.FAIL),
    results,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node verify-capture.mjs <capture-bundle.json>');
  const bundle = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
  const report = verifyCaptureBundle(bundle);
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid || report.counts.FAIL > 0) process.exitCode = 1;
}
