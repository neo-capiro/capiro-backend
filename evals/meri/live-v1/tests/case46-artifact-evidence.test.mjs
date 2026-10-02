import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCase46ArtifactDownload, inspectCase46ArtifactReload, CASE46_EXPECTED } from '../case46-artifact-evidence.mjs';
import { AUTHORIZED_TENANTS } from '../fixture-provisioning/contract.mjs';

const id = (digit) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
export function fixture() {
  const scope = { caseId: '46', captureRunId: id('1'), tenantId: AUTHORIZED_TENANTS.T1.id, tenantSlug: AUTHORIZED_TENANTS.T1.slug,
    role: 'standard_user', actorLogicalId: 'PAT', clientLogicalId: 'ASTER', userId: id('2'), clientId: id('3'), conversationId: id('4'), proposalId: id('5'), clerkUserId: 'user_SyntheticPat', apiSha: 'a'.repeat(40), webSha: 'b'.repeat(40) };
  const receipt = { version: 1, kind: 'meri_text_artifact_creation', tenantId: scope.tenantId, userId: scope.userId, clientId: scope.clientId,
    conversationId: scope.conversationId, actionProposalId: scope.proposalId, artifactId: id('6'), operationId: id('7'), filename: CASE46_EXPECTED.filename,
    mimeType: 'text/plain', sha256: CASE46_EXPECTED.byteSha256, byteLength: 28,
    currentAction: { version: 1, kind: 'meri_text_artifact_current_action', proposalId: scope.proposalId, status: 'succeeded', artifactEffectCount: 1,
      attemptCount: 2, approvedBy: scope.userId, approvedAt: '2026-10-02T00:00:00.000Z', executedAt: '2026-10-02T00:00:01.000Z' } };
  const input = { scope, responseBytes: Buffer.from(CASE46_EXPECTED.utf8Bytes), downloadedBytes: Buffer.from(CASE46_EXPECTED.utf8Bytes), suggestedFilename: CASE46_EXPECTED.filename,
    headers: { 'content-disposition': `attachment; filename="${CASE46_EXPECTED.filename}"`, 'content-type': 'text/plain; charset=utf-8', 'content-length': '28',
      'x-capiro-release-sha': scope.apiSha, 'x-capiro-artifact-byte-authority': 'persisted_at_creation_v1', 'x-capiro-artifact-sha256': CASE46_EXPECTED.byteSha256,
      'x-capiro-artifact-id': receipt.artifactId, 'x-capiro-artifact-operation-id': receipt.operationId } };
  const encode = () => { input.headers['x-capiro-artifact-creation-receipt'] = Buffer.from(JSON.stringify(receipt)).toString('base64url'); return input; };
  return { input: encode(), receipt, encode };
}

test('exact frozen bytes and actual single effect permit a second execution attempt without granting LIVE acceptance', () => {
  const { input } = fixture(), result = inspectCase46ArtifactDownload(input);
  assert.equal(result.currentAction.artifactEffectCount, 1);
  assert.equal(result.currentAction.attemptCount, 2);
  assert.equal(result.liveAcceptance, 'NOT_RUN');
  assert.equal(result.fullFile01Acceptance, false);
  assert.equal(inspectCase46ArtifactReload(result, structuredClone(result)).status, 'DETERMINISTIC_DOWNLOAD_CHECK_ONLY');
});

test('download and HTTP bytes, filename, source and native authority must all match', () => {
  for (const change of [
    (x) => { x.downloadedBytes = Buffer.from('Synthetic Aster briefing v1\r\n'); },
    (x) => { x.responseBytes = Buffer.from('changed'); },
    (x) => { x.suggestedFilename = 'other.txt'; },
    (x) => { x.headers['x-capiro-release-sha'] = 'c'.repeat(40); },
    (x) => { x.headers['x-capiro-artifact-byte-authority'] = 'regenerated_legacy'; },
    (x) => { x.headers['x-capiro-artifact-operation-id'] = id('8'); },
  ]) {
    const { input } = fixture(); change(input); assert.throws(() => inspectCase46ArtifactDownload(input));
  }
});

test('caller metadata and a successful proposal cannot hide duplicates, foreign owners or absent approval', () => {
  for (const change of [
    (x) => { x.tenantId = AUTHORIZED_TENANTS.T2.id; },
    (x) => { x.clientId = id('8'); },
    (x) => { x.userId = id('8'); },
    (x) => { x.conversationId = id('8'); },
    (x) => { x.actionProposalId = id('8'); },
    (x) => { x.currentAction.artifactEffectCount = 2; },
    (x) => { x.currentAction.artifactEffectCount = 0; },
    (x) => { x.currentAction.approvedBy = null; },
    (x) => { x.currentAction.approvedAt = null; },
    (x) => { x.currentAction.status = 'executing'; },
    (x) => { delete x.currentAction; },
  ]) {
    const f = fixture(); change(f.receipt); assert.throws(() => inspectCase46ArtifactDownload(f.encode()));
  }
});

test('reload may not silently replace the operation or its current owner receipt', () => {
  const { input } = fixture(), first = inspectCase46ArtifactDownload(input);
  for (const key of ['operationId', 'artifactId', 'proposalId', 'receiptSha256'])
    assert.throws(() => inspectCase46ArtifactReload(first, { ...first, [key]: 'changed' }));
});
