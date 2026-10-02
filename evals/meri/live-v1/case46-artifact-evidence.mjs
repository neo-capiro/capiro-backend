import { createHash } from 'node:crypto';
import { frozenFixture } from './fixture.mjs';
import { AUTHORIZED_TENANTS } from './fixture-provisioning/contract.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const need = (value, code) => { if (!value) throw new Error(`CASE46_ARTIFACT_${code}`); };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const CASE46_EXPECTED = Object.freeze({ ...frozenFixture.sources['ARTIFACT-BRIEF-1'].facts });

/** Scope validation is not a write grant or LIVE capture capability. */
export function inspectCase46ArtifactScope(scope) {
  need(scope?.caseId === '46' && UUID.test(scope.captureRunId ?? '') &&
    scope.tenantId === AUTHORIZED_TENANTS.T1.id && scope.tenantSlug === AUTHORIZED_TENANTS.T1.slug &&
    scope.role === 'standard_user' && scope.actorLogicalId === 'PAT' && scope.clientLogicalId === 'ASTER', 'SCOPE');
  for (const key of ['userId', 'clientId', 'conversationId', 'proposalId']) need(UUID.test(scope[key] ?? ''), 'IDENTITY');
  need(/^user_[A-Za-z0-9]+$/u.test(scope.clerkUserId ?? '') && SHA.test(scope.apiSha ?? '') && SHA.test(scope.webSha ?? ''), 'DEPLOYMENT');
  return structuredClone(scope);
}

/** Inspect actual download and current owner bytes. Caller objects can establish
 * a deterministic check only; this function never issues LIVE acceptance. */
export function inspectCase46ArtifactDownload({ scope, headers, responseBytes, downloadedBytes, suggestedFilename }) {
  inspectCase46ArtifactScope(scope);
  const expected = CASE46_EXPECTED;
  need(Buffer.isBuffer(responseBytes) && Buffer.isBuffer(downloadedBytes) &&
    responseBytes.length === Buffer.byteLength(expected.utf8Bytes) && responseBytes.equals(downloadedBytes) &&
    hash(downloadedBytes) === expected.byteSha256 && downloadedBytes.toString('utf8') === expected.utf8Bytes, 'FROZEN_BYTES');
  need(suggestedFilename === expected.filename && headers['content-disposition'] === `attachment; filename="${expected.filename}"` &&
    /^text\/plain(?:;\s*charset=utf-8)?$/iu.test(headers['content-type'] ?? '') &&
    headers['content-length'] === String(responseBytes.length) && headers['x-capiro-release-sha'] === scope.apiSha &&
    headers['x-capiro-artifact-byte-authority'] === 'persisted_at_creation_v1' &&
    headers['x-capiro-artifact-sha256'] === expected.byteSha256, 'DOWNLOAD_HEADERS');
  const encoded = headers['x-capiro-artifact-creation-receipt'];
  need(typeof encoded === 'string' && encoded.length <= 8192 && /^[A-Za-z0-9_-]+$/u.test(encoded), 'RECEIPT_ENCODING');
  const bytes = Buffer.from(encoded, 'base64url');
  need(bytes.toString('base64url') === encoded, 'RECEIPT_ENCODING');
  const receipt = JSON.parse(bytes.toString('utf8'));
  need(receipt?.version === 1 && receipt.kind === 'meri_text_artifact_creation' &&
    receipt.tenantId === scope.tenantId && receipt.userId === scope.userId && receipt.clientId === scope.clientId &&
    receipt.conversationId === scope.conversationId && receipt.actionProposalId === scope.proposalId &&
    UUID.test(receipt.artifactId ?? '') && UUID.test(receipt.operationId ?? '') &&
    receipt.artifactId === headers['x-capiro-artifact-id'] && receipt.operationId === headers['x-capiro-artifact-operation-id'] &&
    receipt.filename === expected.filename && receipt.mimeType === 'text/plain' &&
    receipt.sha256 === expected.byteSha256 && receipt.byteLength === downloadedBytes.length, 'CREATION_JOIN');
  const action = receipt.currentAction;
  need(action?.version === 1 && action.kind === 'meri_text_artifact_current_action' &&
    action.proposalId === scope.proposalId && action.status === 'succeeded' && action.artifactEffectCount === 1 &&
    Number.isSafeInteger(action.attemptCount) && action.attemptCount >= 1 &&
    action.approvedBy === scope.userId && Number.isFinite(Date.parse(action.approvedAt)) &&
    Number.isFinite(Date.parse(action.executedAt)) && Date.parse(action.approvedAt) <= Date.parse(action.executedAt), 'CURRENT_ACTION');
  return Object.freeze({
    status: 'DETERMINISTIC_DOWNLOAD_CHECK_ONLY', caseId: '46',
    artifactId: receipt.artifactId, operationId: receipt.operationId, proposalId: receipt.actionProposalId,
    filename: receipt.filename, sha256: receipt.sha256, byteLength: receipt.byteLength,
    currentAction: structuredClone(action), receiptSha256: hash(bytes),
    liveAcceptance: 'NOT_RUN', fullFile01Acceptance: false,
  });
}

export function inspectCase46ArtifactReload(first, afterReload) {
  for (const key of ['artifactId', 'operationId', 'proposalId', 'filename', 'sha256', 'byteLength', 'receiptSha256'])
    need(first?.[key] === afterReload?.[key], 'RELOAD_CHANGED');
  need(first?.status === 'DETERMINISTIC_DOWNLOAD_CHECK_ONLY' && afterReload?.status === first.status, 'RELOAD_STATUS');
  return { status: 'DETERMINISTIC_DOWNLOAD_CHECK_ONLY', liveAcceptance: 'NOT_RUN', fullFile01Acceptance: false };
}
