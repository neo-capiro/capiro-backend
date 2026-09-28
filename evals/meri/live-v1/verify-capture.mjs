import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases } from './cases.mjs';
import { evaluateDeterministicEvidence, expectedModeMatrix } from './deterministic-predicates.mjs';
import { frozenFixture } from './fixture.mjs';
import { ArtifactIntegrityError, OwnedArtifactReader } from './artifact-reader.mjs';
import { validateJsonSchema } from './lib/schema-validator.mjs';
import { validateContract } from './validate-contract.mjs';

const lock = JSON.parse(readFileSync(new URL('./contract-lock.json', import.meta.url), 'utf8'));
const captureSchema = JSON.parse(readFileSync(new URL('./capture.schema.json', import.meta.url), 'utf8'));
const caseById = new Map(cases.map((testCase) => [testCase.id, testCase]));
const SHA256 = /^[a-f0-9]{64}$/u;
const FAILED_TOOL_STATUSES = new Set(['partial', 'unavailable', 'denied', 'retryable_failure', 'permanent_failure', 'unknown_outcome', 'invalid_not_executed']);

function fail(status, reason, details = []) {
  return { status, reason, details };
}

function artifact(ref, sha256) {
  return ref === null || ref === undefined ? null : { ref, sha256 };
}

function readCaptureArtifacts(reader, capture) {
  const evidence = capture.evidence;
  const passages = new Map();
  for (const citation of evidence.sources.citations) {
    if (passages.has(citation.sourceId)) throw new ArtifactIntegrityError(`duplicate passage artifact for source ${citation.sourceId}`);
    passages.set(citation.sourceId, reader.readText(artifact(citation.passageRef, citation.passageSha256)));
  }
  const downloads = new Map();
  const downloadReceipts = new Map();
  for (const attachment of evidence.sources.attachments) {
    if (attachment.byteRef) downloads.set(attachment.attachmentId, reader.readBytes(artifact(attachment.byteRef, attachment.byteSha256)));
    if (attachment.downloadReceiptRef) downloadReceipts.set(attachment.attachmentId, reader.readJson(artifact(attachment.downloadReceiptRef, attachment.downloadReceiptSha256)));
  }
  const payload = evidence.effects.payloadRef ? reader.readBytes(artifact(evidence.effects.payloadRef, evidence.effects.payloadSha256)) : null;
  const sink = evidence.effects.sinkRef ? reader.readJson(artifact(evidence.effects.sinkRef, evidence.effects.sinkSha256)) : null;
  const setup = evidence.setup.artifact ? reader.readJson(evidence.setup.artifact) : null;
  const adjudication = capture.rubric.adjudicationRef
    ? reader.readJson(artifact(capture.rubric.adjudicationRef, capture.rubric.adjudicationSha256))
    : null;
  const acceptance = evidence.predicate.artifact ? reader.readJson(evidence.predicate.artifact) : null;
  return {
    answer: reader.readText(artifact(evidence.status.answerRef, evidence.status.answerSha256)),
    trace: reader.readJson(evidence.run.traceArtifact),
    auth: reader.readJson(artifact(evidence.auth.sessionEvidenceRef, evidence.auth.sessionEvidenceSha256)),
    passages,
    downloads,
    downloadReceipts,
    payload,
    sink,
    setup,
    adjudication,
    acceptance,
    ui: evidence.ui.evidenceArtifacts.map((descriptor) => reader.readJson(descriptor)),
  };
}

function validateDeclaredEvidence(capture, testCase, artifacts, captureRunId) {
  const defects = [];
  const evidence = capture.evidence;
  const actor = frozenFixture.actors[testCase.actor];
  if (evidence.auth.actorId !== testCase.actor || evidence.auth.actorTenantId !== actor.tenantId || evidence.auth.selectedTenantId !== actor.tenantId) {
    defects.push('captured actor/tenant does not match the case contract');
  }
  if (evidence.auth.selectedClientId !== testCase.client) defects.push('captured client does not match the case contract');

  const expected = new Set(evidence.sources.expectedSourceIds);
  const consulted = new Set(evidence.sources.consultedSourceIds);
  const cited = new Set(evidence.sources.citedSourceIds);
  if (expected.size !== evidence.sources.expectedSourceIds.length || consulted.size !== evidence.sources.consultedSourceIds.length || cited.size !== evidence.sources.citedSourceIds.length) {
    defects.push('source ID arrays contain duplicates');
  }
  for (const sourceId of testCase.sourceIds) if (!expected.has(sourceId)) defects.push(`expected source declaration is missing ${sourceId}`);
  for (const sourceId of testCase.requiredSources) if (!consulted.has(sourceId)) defects.push(`required source was not consulted: ${sourceId}`);
  for (const sourceId of testCase.forbiddenSources) if (consulted.has(sourceId) || cited.has(sourceId)) defects.push(`forbidden source leak: ${sourceId}`);
  for (const sourceId of [...consulted, ...cited]) {
    const fixtureSource = frozenFixture.sources[sourceId];
    if (!fixtureSource) defects.push(`unrecognized source ID: ${sourceId}`);
    else {
      if (fixtureSource.tenantId && fixtureSource.tenantId !== actor.tenantId) defects.push(`cross-tenant source leak: ${sourceId}`);
      if (testCase.client && fixtureSource.clientId && fixtureSource.clientId !== testCase.client) defects.push(`cross-client source leak: ${sourceId}`);
    }
  }
  for (const citation of evidence.sources.citations) {
    if (!consulted.has(citation.sourceId) || !cited.has(citation.sourceId)) defects.push(`citation ${citation.sourceId} is not joined to consulted and cited IDs`);
    if (!artifacts.passages.has(citation.sourceId)) defects.push(`citation ${citation.sourceId} has no verified passage bytes`);
  }
  if (cited.size > 0 && artifacts.passages.size !== cited.size) defects.push('cited source count does not match verified passage artifacts');
  if (artifacts.setup && (artifacts.setup.schemaVersion !== 1 || artifacts.setup.captureRunId !== captureRunId || artifacts.setup.caseId !== capture.caseId)) {
    defects.push('setup artifact is not capture-run/case correlated');
  }
  if (evidence.predicate.applicable === true && !artifacts.acceptance) defects.push('applicable row predicate artifact is missing');
  if (evidence.predicate.applicable === false && artifacts.acceptance) defects.push('non-applicable row predicate unexpectedly has an artifact');
  for (const attachment of evidence.sources.attachments.filter((item) => item.applicable === true)) {
    const bytes = artifacts.downloads.get(attachment.attachmentId);
    const receipt = artifacts.downloadReceipts.get(attachment.attachmentId);
    if (!bytes || !receipt) defects.push(`attachment ${String(attachment.attachmentId)} lacks downloaded bytes or receipt artifact`);
    else if (receipt.captureRunId !== captureRunId || receipt.caseId !== capture.caseId || receipt.runId !== evidence.run.runId || receipt.traceId !== evidence.run.traceId || receipt.byteSha256 !== bytes.sha256) {
      defects.push(`attachment ${String(attachment.attachmentId)} receipt is not bound to downloaded bytes and run`);
    }
  }

  const expectedOperation = testCase.expectedOperation;
  const effects = evidence.effects;
  if (expectedOperation.expectedLogicalEffectCount === 0) {
    if (artifacts.sink || artifacts.payload || effects.receiptIds.length > 0 || effects.observedLogicalEffectCount !== 0) defects.push('read-only case contains effect artifacts or receipts');
  } else {
    if (!artifacts.sink || !artifacts.payload) defects.push('effect payload and authoritative sink artifacts are required');
    const sinkEffects = Array.isArray(artifacts.sink?.effects) ? artifacts.sink.effects : [];
    const sinkReceipts = Array.isArray(artifacts.sink?.receipts) ? artifacts.sink.receipts : [];
    const uniqueEffects = new Set(sinkEffects.map((item) => item?.logicalEffectId));
    if (uniqueEffects.size !== sinkEffects.length) defects.push('authoritative sink contains duplicate logical effect IDs');
    if (sinkEffects.length !== expectedOperation.expectedLogicalEffectCount) defects.push(`authoritative sink effect count ${sinkEffects.length} does not equal expected ${expectedOperation.expectedLogicalEffectCount}`);
    if (effects.observedLogicalEffectCount !== sinkEffects.length) defects.push('declared effect count does not match authoritative sink rows');
    if (new Set(sinkReceipts.map((item) => item?.receiptId)).size !== sinkReceipts.length) defects.push('authoritative sink contains duplicate receipt IDs');
    if (effects.receiptIds.length !== sinkReceipts.length || effects.receiptIds.some((id) => !sinkReceipts.some((item) => item?.receiptId === id))) defects.push('declared receipts do not match authoritative sink receipts');
  }

  if (!testCase.terminal.allowed.includes(evidence.status.terminal)) defects.push(`terminal state ${evidence.status.terminal} is not allowed`);
  const latestToolByName = new Map();
  for (const tool of evidence.runtime.tools) {
    const previous = latestToolByName.get(tool.name);
    if (!previous || tool.attempt > previous.attempt) latestToolByName.set(tool.name, tool);
  }
  const failedTools = [...latestToolByName.values()].filter((tool) => FAILED_TOOL_STATUSES.has(tool.status));
  if (evidence.status.claimedCompleted === true && (evidence.runtime.modelStatus !== 'complete' || failedTools.length > 0)) defects.push('false-success claim conflicts with recorded tool/model status');

  if (testCase.surface === 'workspace' || testCase.surface === 'research') {
    if (evidence.ui.applicable !== true || !evidence.ui.route?.startsWith('/meri') || artifacts.ui.length === 0) defects.push('required /meri UI artifacts are missing');
  } else if (evidence.ui.applicable !== false || artifacts.ui.length !== 0) defects.push('API capture has unexpected UI artifacts');

  const adjudication = artifacts.adjudication;
  if (!adjudication) defects.push('human adjudication artifact is missing');
  else {
    if (adjudication.schemaVersion !== 1 || adjudication.captureRunId !== captureRunId || adjudication.caseId !== capture.caseId || adjudication.runId !== evidence.run.runId) defects.push('human adjudication is not run/case correlated');
    if (adjudication.grader !== capture.rubric.grader || adjudication.adjudication !== capture.rubric.humanAdjudication) defects.push('human adjudication artifact does not match declared grader/text');
    const dimensions = testCase.humanRubric.dimensions.map((dimension) => adjudication.dimensions?.[dimension]);
    if (dimensions.some((score) => !Number.isInteger(score) || score < 0 || score > 2)) defects.push('human adjudication dimensions are invalid');
    else {
      const total = dimensions.reduce((sum, score) => sum + score, 0);
      if (dimensions.some((score) => score < testCase.humanRubric.minimumPerDimension) || total < testCase.humanRubric.target) defects.push(`human rubric failed: ${total}/10`);
    }
  }
  return defects;
}

export function evaluateCapture(capture, testCase, context = {}) {
  if (!capture || typeof capture !== 'object') return fail('NOT_RUN', 'capture is missing or malformed');
  const classification = capture.classification;
  if (!classification || typeof classification !== 'object') return fail('NOT_RUN', 'capture classification is missing');
  if (classification.setupStatus === 'BLOCKED_PREREQUISITE' || classification.setupStatus === 'STALE_TARGET') return fail('BLOCKED', classification.reason || `setup status ${classification.setupStatus}`);
  if (classification.setupStatus !== 'READY') return fail('BLOCKED', 'setup readiness was not proved');
  if (classification.executionStatus !== 'CAPTURED') return fail('NOT_RUN', classification.reason || `execution status ${classification.executionStatus || 'missing'}`);
  if (!context.reader || !context.captureRunId) return fail('NOT_RUN', 'artifact reader and capture-run binding are required; caller booleans/references are not evidence');

  let artifacts;
  try {
    artifacts = readCaptureArtifacts(context.reader, capture);
  } catch (error) {
    if (error instanceof ArtifactIntegrityError || error?.code) return fail('BLOCKED', 'artifact integrity verification failed', [error.message]);
    throw error;
  }
  let deterministic;
  let declaredDefects;
  try {
    deterministic = evaluateDeterministicEvidence(capture, testCase, artifacts, context.captureRunId, context.provenance);
    if (deterministic.integrityDefects.length > 0) {
      return fail('BLOCKED', deterministic.reason || 'saved artifact correlation/integrity verification failed', deterministic.integrityDefects);
    }
    declaredDefects = validateDeclaredEvidence(capture, testCase, artifacts, context.captureRunId);
  } catch (error) {
    return fail('BLOCKED', 'capture evidence evaluation failed closed', [`${error?.name || 'Error'}: ${error?.message || String(error)}`]);
  }
  const defects = [...declaredDefects, ...deterministic.defects];
  if (!deterministic.implemented) return fail('NOT_RUN', deterministic.reason, defects);

  const authorityReason = context.provenance === 'UNIT_FIXTURE_NOT_LIVE'
    ? 'unit fixture artifacts are explicitly NOT live evidence'
    : 'offline capture/auth/source authority verification is not implemented';
  const authorityStatus = context.provenance === 'UNIT_FIXTURE_NOT_LIVE' ? 'NOT_RUN' : 'BLOCKED';
  if (defects.length > 0) return fail(authorityStatus, authorityReason, defects);
  return fail(authorityStatus, authorityReason, ['saved artifact hashes and structural joins were checked, but capture/auth/source authority remains unverified']);
}

function validateRunManifest(bundle, errors) {
  const runManifest = bundle.runManifest;
  if (!runManifest || typeof runManifest !== 'object') {
    errors.push('captured cases require a runManifest');
    return;
  }
  if (!/^[a-f0-9]{40}$/u.test(runManifest.checkoutSha ?? '')) errors.push('runManifest checkoutSha is malformed');
  if (!SHA256.test(runManifest.deployed?.configHash ?? '') || !SHA256.test(runManifest.deployed?.flagsHash ?? '')) errors.push('runManifest deployed config/flags hashes are malformed');
  if (runManifest.target?.dedicatedEvalTenant !== true || runManifest.target?.networkExecutionAllowed !== true) errors.push('captured cases require an explicit dedicated target and execution allowance');
  if (runManifest.fixture?.version !== frozenFixture.version || runManifest.fixture?.sha256 !== lock.fixtureSha256 || runManifest.fixture?.clock !== frozenFixture.clock.local) errors.push('runManifest fixture identity/clock is stale');
  if (runManifest.captureAdapter?.writeExecution !== 'capture-only-live-adapter') errors.push('runManifest capture adapter boundary is invalid');
  if (runManifest.authPrerequisites?.status !== 'READY' || runManifest.authPrerequisites?.identitiesVerified !== true) errors.push('runManifest authenticated identities are not ready');
  const deployedDiffers = runManifest.deployed?.apiSha !== runManifest.checkoutSha || runManifest.deployed?.webSha !== runManifest.checkoutSha;
  if (deployedDiffers && !runManifest.deployed?.checkoutDifferenceReason) errors.push('deployed/checkout difference lacks an explicit reason');
}

function aggregateCaseResults(testCase, captures, evaluations) {
  if (captures.length === 0) return { caseId: testCase.id, status: 'NOT_RUN', reason: 'no capture exists', details: [] };
  const matrix = expectedModeMatrix(testCase.id);
  if (matrix.length > 0) {
    const actualKeys = new Set(captures.map((capture) => `${capture.evidence.execution.runtimeMode}\u0000${capture.evidence.execution.verificationMode}`));
    const missing = matrix.filter((entry) => !actualKeys.has(`${entry.runtimeMode}\u0000${entry.verificationMode}`));
    if (missing.length > 0) {
      const blocked = evaluations.find((evaluation) => evaluation.status === 'BLOCKED');
      return {
        caseId: testCase.id,
        status: blocked ? 'BLOCKED' : 'NOT_RUN',
        reason: blocked ? 'capture integrity failure with incomplete required mode matrix' : 'required mode matrix is incomplete',
        details: [
          ...missing.map((entry) => `missing ${entry.runtimeMode}/${entry.verificationMode} capture (${entry.disposition})`),
          ...evaluations.flatMap((evaluation) => evaluation.details),
        ],
      };
    }
    const pairIds = new Set(captures.map((capture) => capture.evidence.execution.pairId));
    if (pairIds.size !== 1) return { caseId: testCase.id, status: 'BLOCKED', reason: 'mode captures do not share one stable pair ID', details: [...pairIds] };
  }
  const precedence = ['BLOCKED', 'FAIL', 'NOT_RUN', 'PASS'];
  const status = precedence.find((candidate) => evaluations.some((evaluation) => evaluation.status === candidate)) ?? 'NOT_RUN';
  const selected = evaluations.find((evaluation) => evaluation.status === status) ?? evaluations[0];
  return { caseId: testCase.id, status, reason: selected.reason, details: evaluations.flatMap((evaluation) => evaluation.details) };
}

export function verifyCaptureBundle(bundle = {}) {
  const contract = validateContract();
  const errors = [...contract.errors];
  if (bundle.captures !== undefined && !Array.isArray(bundle.captures)) errors.push('capture bundle captures must be an array');
  const captures = Array.isArray(bundle.captures) ? bundle.captures : [];
  let reader = null;

  const declaredContract = bundle.contract;
  if (declaredContract) {
    if (declaredContract.fixtureVersion !== frozenFixture.version) errors.push('capture fixture version does not match contract');
    if (declaredContract.fixtureSha256 !== lock.fixtureSha256) errors.push('capture fixture hash does not match contract');
    if (declaredContract.contractSourceSha256 !== lock.contractSourceSha256) errors.push('capture source hash does not match contract');
  }

  if (captures.length > 0) {
    errors.push(...validateJsonSchema(bundle, captureSchema));
    validateRunManifest(bundle, errors);

    const keys = captures.map((capture) => `${capture?.caseId}\u0000${capture?.evidence?.execution?.runtimeMode}\u0000${capture?.evidence?.execution?.verificationMode}`);
    if (new Set(keys).size !== keys.length) errors.push('capture bundle contains duplicate case/mode variants');
    for (const capture of captures) if (!caseById.has(capture?.caseId)) errors.push(`capture bundle contains unknown case ID ${String(capture?.caseId)}`);

    if (errors.length === 0) {
      try {
        reader = new OwnedArtifactReader(bundle.artifactRoot, {
          ownerSha256: bundle.ownerSha256,
          captureRunId: bundle.runManifest.captureRunId,
          fixtureVersion: frozenFixture.version,
          fixtureSha256: lock.fixtureSha256,
          contractSourceSha256: lock.contractSourceSha256,
        });
      } catch (error) {
        errors.push(`artifact bundle ownership/integrity failure: ${error.message}`);
      }
    }
  }

  const grouped = new Map(cases.map((testCase) => [testCase.id, []]));
  for (const capture of captures) if (grouped.has(capture?.caseId)) grouped.get(capture.caseId).push(capture);
  const results = cases.map((testCase) => {
    if (errors.length > 0) return { caseId: testCase.id, status: 'BLOCKED', reason: 'capture bundle integrity failure', details: errors };
    const caseCaptures = grouped.get(testCase.id);
    const evaluations = caseCaptures.map((capture) => evaluateCapture(capture, testCase, {
      reader,
      captureRunId: bundle.runManifest.captureRunId,
      provenance: reader.owner.provenance,
    }));
    return aggregateCaseResults(testCase, caseCaptures, evaluations);
  });
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0 };
  for (const result of results) counts[result.status] += 1;
  return {
    valid: errors.length === 0,
    errors,
    contract: { fixtureVersion: frozenFixture.version, fixtureSha256: lock.fixtureSha256, contractSourceSha256: lock.contractSourceSha256 },
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