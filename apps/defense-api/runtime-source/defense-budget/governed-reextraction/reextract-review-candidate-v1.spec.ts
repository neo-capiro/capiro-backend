import { createHash, randomUUID } from 'node:crypto';
import { ReviewCandidateReextractionV1, type ReviewCandidateReextractionDependenciesV1 } from './reextract-review-candidate-v1.js';
import { reextractionRequestHashV1, type ReextractionOperationV1, type ReextractionRequestV1 } from './reextraction-repository-v1.js';
import type { ReextractionTargetV1 } from './reextraction-target-v1.js';
import type { ParserRouterTerminalOutputV1 } from '../parser-router/parser-router-v1.service.js';

// Orchestration tests only. SQL persistence/fencing are covered separately by the DB integration suite.
function harness() {
  const bytes = Buffer.from('isolated re-extraction source bytes');
  const sourceSha = createHash('sha256').update(bytes).digest('hex');
  const request: ReextractionRequestV1 = {
    operationId: randomUUID(), outboxRowId: randomUUID(), oldCandidateId: randomUUID(), expectedOldVerificationRunId: randomUUID(),
    expectedSourceSha256: sourceSha, expectedOldExtractionArtifactSha256: 'a'.repeat(64),
    actor: 'isolated-test', reason: 'Correct a verified attribution defect', releaseRevision: 'c'.repeat(40),
  };
  const target: ReextractionTargetV1 = {
    observationId: randomUUID(), cycleId: randomUUID(), sourceDocumentId: randomUUID(), sourceSha256: sourceSha,
    sourcePath: `/tmp/capiro-reextraction-tests/${request.operationId}/source.pdf`,
    sourceKey: 'army-test-source', component: 'ARMY', sourceUrl: 'https://example.test/source.pdf', title: 'Isolated source',
    fiscalYear: 2024, sourceFamily: 'pb_r2', budgetCycle: 'pb', documentType: 'r2',
    archiveBucket: 'test-archive', archiveS3Key: 'immutable-source', archiveVersionId: 'exact-version', byteSize: bytes.length,
  };
  let operation: ReextractionOperationV1 | null = null;
  const repository = {
    read: jest.fn(async () => operation),
    claim: jest.fn(async ({ snapshot, leaseToken }) => {
      operation = {
        id: request.operationId, request, snapshot, requestHash: reextractionRequestHashV1(request, snapshot),
        oldCandidateId: request.oldCandidateId, cycleId: target.cycleId, sourceDocumentId: target.sourceDocumentId,
        status: 'running', leaseToken, leasedUntil: new Date(Date.now() + 300000).toISOString(), attempts: 1,
        verificationCorrelations: [], terminal: null, candidateId: null, verificationRunId: null,
        lastError: null, closure: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      return { outcome: 'claimed' as const, operation };
    }),
    heartbeat: jest.fn(async () => true),
    complete: jest.fn(async (_context, terminal) => {
      operation = { ...operation!, status: 'completed', terminal, candidateId: terminal.candidateId, verificationRunId: terminal.verificationRunId };
      return true;
    }),
    fail: jest.fn(async () => { if (operation?.status === 'running') operation.status = 'failed'; return true; }),
    block: jest.fn(async () => { operation!.status = 'blocked'; return true; }),
    abandonExpired: jest.fn(async () => ({ outcome: 'ineligible' as const, operation })),
  };
  const terminal = {
    candidateId: randomUUID(), verificationRunId: randomUUID(), artifactId: 'new-artifact', artifactLocator: 's3://test/new?versionId=v',
    artifactContentSha256: 'b'.repeat(64), artifactByteSha256: 'd'.repeat(64),
    verifierDecision: 'REVIEW', finalState: 'TERMINAL_REVIEW',
  } as ParserRouterTerminalOutputV1;
  const parse = jest.fn(async (input: Parameters<ReviewCandidateReextractionDependenciesV1['parse']>[0]) => {
    await input.onTerminal!(terminal);
    return { decision: terminal.verifierDecision, finalState: terminal.finalState, artifactLocator: terminal.artifactLocator, outputPath: '/tmp/unused' };
  });
  const archive = { readMaterializedBytes: jest.fn(async () => ({ bytes, contentSha256: sourceSha })) };
  const resolveTarget = jest.fn(async () => target);
  const service = new ReviewCandidateReextractionV1({
    repository, resolveTarget, archive, parse, runtimeConfigSha256: 'e'.repeat(64), parserArtifactRoot: '/tmp/approved-parser-root',
    persistenceFence: () => async () => undefined,
  });
  return { service, request, target, repository, parse, archive, terminal, resolveTarget };
}

describe('named REVIEW re-extraction orchestration', () => {
  it('previews eligibility without creating an operation, reading S3, or parsing', async () => {
    const h = harness();
    expect((await h.service.run(h.request, { commit: false })).outcome).toBe('preview');
    expect(h.repository.claim).not.toHaveBeenCalled();
    expect(h.archive.readMaterializedBytes).not.toHaveBeenCalled();
    expect(h.parse).not.toHaveBeenCalled();
  });
  it('refuses corrupt archive bytes before parser execution', async () => {
    const h = harness();
    h.archive.readMaterializedBytes.mockResolvedValue({ bytes: Buffer.from('wrong'), contentSha256: h.request.expectedSourceSha256 });
    await expect(h.service.run(h.request, { commit: true })).rejects.toThrow('Archived source identity mismatch');
    expect(h.repository.block).toHaveBeenCalledTimes(1);
    expect(h.parse).not.toHaveBeenCalled();
  });
  it('uses exact archive version, raw cycle and production persistence with stable execution identity', async () => {
    const h = harness();
    const result = await h.service.run(h.request, { commit: true });
    expect(result).toMatchObject({ outcome: 'completed', persistedForReview: true, publication: 'not_performed' });
    expect(h.archive.readMaterializedBytes).toHaveBeenCalledWith({ bucket: h.target.archiveBucket, key: h.target.archiveS3Key, versionId: h.target.archiveVersionId });
    expect(h.parse.mock.calls[0]![0]).toMatchObject({
      cycleId: h.target.cycleId, sourcePath: h.target.sourcePath, sourceDocumentId: h.target.sourceDocumentId,
      sourceKey: h.target.sourceKey, component: 'ARMY', executionId: `reextract-${h.request.operationId}`,
      persistVerificationAudit: true, allowPaidParse: false, maxPaidPages: 0,
    });
    expect(result.operation?.candidateId).toBe(h.terminal.candidateId);
  });
  it('recovers checkpointed result after a post-verification scratch failure and does not parse twice', async () => {
    const h = harness();
    h.parse.mockImplementation(async input => { await input.onTerminal!(h.terminal); throw new Error('scratch copy failed'); });
    const first = await h.service.run(h.request, { commit: true });
    h.resolveTarget.mockRejectedValue(new Error('old candidate was subsequently corrected'));
    const recovered = await h.service.run(h.request, { commit: true });
    expect(first.operation?.candidateId).toBe(h.terminal.candidateId);
    expect(recovered.operation?.candidateId).toBe(h.terminal.candidateId);
    expect(h.parse).toHaveBeenCalledTimes(1);
    expect(h.repository.fail).not.toHaveBeenCalled();
  });
  it('refuses reuse of an operation ID with a different release or actor', async () => {
    const h = harness();
    await h.service.run(h.request, { commit: true });
    expect((await h.service.run({ ...h.request, releaseRevision: 'f'.repeat(40) }, { commit: true })).outcome).toBe('conflict');
    expect((await h.service.run({ ...h.request, actor: 'different-actor' }, { commit: true })).outcome).toBe('conflict');
    expect(h.parse).toHaveBeenCalledTimes(1);
  });
  it('does not call a persisted REJECT a review success', async () => {
    const h = harness(); h.terminal.verifierDecision = 'REJECT'; h.terminal.finalState = 'TERMINAL_REJECTED';
    const result = await h.service.run(h.request, { commit: true });
    expect(result.persistedForReview).toBe(false);
    expect(result.nextAction).toContain('No correction or approval');
  });
  it('refuses a parser that returns without checkpointing exact persisted IDs', async () => {
    const h = harness();
    h.parse.mockResolvedValue({ decision: 'REVIEW', finalState: 'TERMINAL_REVIEW', artifactLocator: 's3://test/a', outputPath: '/tmp/x' });
    await expect(h.service.run(h.request, { commit: true })).rejects.toThrow('without a durable terminal checkpoint');
  });
  it('reports unchanged artifact content without authorizing correction', async () => {
    const h = harness(); h.terminal.artifactContentSha256 = h.request.expectedOldExtractionArtifactSha256;
    const result = await h.service.run(h.request, { commit: true });
    expect(result.extractionChanged).toBe(false);
    expect(result.nextAction).toContain('unchanged');
  });
});
