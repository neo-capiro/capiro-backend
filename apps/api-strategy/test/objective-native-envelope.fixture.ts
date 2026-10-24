import { createHash } from 'node:crypto';
import { privateRequestJcsSha256 as hash } from '../src/meri/objective-canonical-request.js';
import { canonicalGenerationAdmissionSha256 } from '../src/meri/objective-canonical-generation.js';

/** Synthetic native journal/file rows for existing Planner SQL/algorithm fixtures.
 * No SDK execution, authorization or actual object custody is claimed. The
 * separate paired-owner fixture binds the genuine private wire composition. */
export function nativeObjectiveEnvelope(admission: any, publication: any, binding: any, resultBody: any) {
  const sourceAdmissionSha256 = canonicalGenerationAdmissionSha256(admission);
  const request = { requestId: admission.generationRequestId, prompt: publication.executionContext.prompt,
    skill: null, window: null, windowRequest: null };
  const sourceRequestSha256 = hash(request), policyRevision = 'synthetic-native-policy';
  const scopes = [{ tenantId: binding.tenantId, kind: 'client', resourceId: admission.canonical.clientId, policyRevision }];
  const versions = { promptVersion: 'synthetic-prompt', toolsVersion: 'synthetic-tools', skillsVersion: 'synthetic-skills' };
  const sessionId = binding.attemptId, captureSequence = 3;
  const kind = admission.expectedStrategyVersionId === null ? 'objective.strategy.draft' : 'objective.strategy.regeneration';
  const path = kind === 'objective.strategy.draft' ? 'meri-objective-strategy-draft.result.json' : 'meri-objective-strategy-regeneration.result.json';
  const observation = { sessionId, completedAtMs: resultBody.completedAtMs, state: resultBody.state, payloadSha256: resultBody.payloadSha256 };
  const execution = { ...resultBody.execution, receiptRef: binding.runId, bindingSha256: hash(binding), receiptSha256: hash({
    schemaVersion: 1, operation: 'strategy.draft', sourceAdmissionSha256, sourceRequestSha256,
    typedRequestSha256: publication.requestSha256, bindingSha256: hash(binding), provider: resultBody.execution.provider,
    model: resultBody.execution.model, receiptRef: binding.runId, ...observation,
  }) };
  const { resultSha256: _oldHash, ...body } = resultBody;
  const unsigned = { ...body, resultRef: binding.runId, execution };
  const result = { ...unsigned, resultSha256: hash(unsigned) }, bytes = Buffer.from(JSON.stringify(result));
  const object = { objectId: 'synthetic-native-object', versionId: 'synthetic-native-version',
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, scopes };
  const sdkSession = { binding, key: { projectKey: 'synthetic-project', sessionId }, ownerSha256: 'a'.repeat(64), entriesCount: 1 };
  const files = { workspace: { schemaVersion: 1, binding, scopes,
    entries: [{ path, kind: 'file', executable: false, object }] }, tasks: [] };
  const contextSha256 = hash({ window: null, skill: null, scopes });
  const proof = { kind: 'native-session', sdkSession, files, checkpointId: binding.runId,
    checkpointSha256: hash({ sdkSession, files }), versions, scopes, sourceRequestSha256, contextSha256, lastEventSequence: captureSequence };
  const selection = { sourceAdmission: admission, request: publication.request,
    executionContext: publication.executionContext, queuedType: publication.request.input.typeHint };
  const record = { schemaVersion: 1, generationJobId: admission.generationJobId, binding, sourceAdmissionSha256,
    sourceRequestSha256, typedRequestSha256: publication.requestSha256, selectionSha256: hash(selection),
    effectExpiresAtMs: Math.min(admission.effectExpiresAtMs, publication.request.originalExpiresAtMs), selection };
  const typedResult = { schemaVersion: 1, kind, path, sourceAdmissionSha256, sourceRequestSha256,
    typedRequestSha256: publication.requestSha256, resultRef: binding.runId, resultSha256: result.resultSha256,
    fileSha256: object.sha256, bytes: bytes.length, execution, observation };
  const typedSelection = { binding, acceptedRequest: request, sourceAdmissionSha256, sourceRequestSha256,
    strategy: { schemaVersion: 1, operation: 'strategy.draft', request: publication.request,
      requestSha256: publication.requestSha256, executionContext: publication.executionContext, queuedType: selection.queuedType,
      executionSelection: { provider: execution.provider, model: execution.model } } };
  return { schemaVersion: 1, record, request, run: { binding, state: 'completed', policyRevision, scopes, versions },
    completion: { binding, scopes, selectedClientId: admission.canonical.clientId, completionId: binding.runId,
      checkpointId: binding.runId, captureSequence, sourceRequest: request, sourceRequestSha256, contextSha256, versions,
      verifiedEventId: binding.workerId, completedEventId: binding.attemptId, typedResult, typedSelection,
      kind: 'native-session', sessionId, filesRequestSha256: 'b'.repeat(64), state: 'PUBLISHED', proof },
    file: { path, object, base64: bytes.toString('base64') } };
}
