import { createHash } from 'node:crypto';
import { CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import { privateRequestJcsSha256 as hash } from './objective-canonical-request.js';
import { readNativeObjectiveAcceptance, nativeObject as object } from './objective-native-reader.js';

const fail = (): never => { throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED'); };
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const sha = (v: any) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: any) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);

/** Decode the actual published native journal and raw stored file. No old
 * checkpoint or newly minted read-expiry receipt is synthesized here. */
export function readNativeObjectiveCompletion(raw: unknown,
  expected: { admission: unknown; acceptance: any; publication: any }, path: string) {
  hash(raw);
  if (Buffer.byteLength(JSON.stringify(raw)) > 8 * 1024 * 1024) return fail();
  const v = object(raw, ['schemaVersion','record','request','run','completion','file']);
  const accepted = readNativeObjectiveAcceptance({ schemaVersion: v.schemaVersion,
    record: v.record, request: v.request, run: v.run }, expected);
  const a = expected.acceptance, b = accepted.sourceBinding;
  if (!same(b, a.sourceBinding) || accepted.sourceAdmissionSha256 !== a.sourceAdmissionSha256 ||
      accepted.sourceRequestSha256 !== a.sourceRequestSha256 || accepted.effectExpiresAtMs !== a.effectExpiresAtMs ||
      accepted.run.state !== 'completed') return fail();
  const p = object(v.completion, ['binding','scopes','selectedClientId','completionId','checkpointId','captureSequence',
    'sourceRequest','sourceRequestSha256','contextSha256','versions','verifiedEventId','completedEventId',
    'typedResult','typedSelection','kind','sessionId','filesRequestSha256','state','proof']);
  const proof = object(p.proof, ['kind','sdkSession','files','checkpointId','checkpointSha256','versions','scopes',
    'sourceRequestSha256','contextSha256','lastEventSequence']);
  const session = object(proof.sdkSession, ['binding','key','ownerSha256','entriesCount']);
  const key = object(session.key, ['projectKey','sessionId']);
  if (p.kind !== 'native-session' || p.state !== 'PUBLISHED' || proof.kind !== p.kind ||
      !same(p.binding, b) || !same(session.binding, b) || p.completionId !== b.runId || p.checkpointId !== b.runId ||
      proof.checkpointId !== b.runId || !same(p.sourceRequest, accepted.request) ||
      p.sourceRequestSha256 !== a.sourceRequestSha256 || proof.sourceRequestSha256 !== p.sourceRequestSha256 ||
      p.selectedClientId !== accepted.sourceAdmission.canonical.clientId || !same(p.scopes, accepted.run.scopes) ||
      !same(proof.scopes, p.scopes) || !same(p.versions, accepted.run.versions) || !same(proof.versions, p.versions) ||
      p.contextSha256 !== hash({ window: accepted.request.window, skill: accepted.request.skill, scopes: p.scopes }) ||
      proof.contextSha256 !== p.contextSha256 || !Number.isSafeInteger(p.captureSequence) || p.captureSequence < 1 ||
      proof.lastEventSequence !== p.captureSequence || !uuid(p.verifiedEventId) || !uuid(p.completedEventId) ||
      !sha(p.filesRequestSha256) || !uuid(p.sessionId) || key.sessionId !== p.sessionId ||
      typeof key.projectKey !== 'string' || !key.projectKey || key.projectKey.length > 256 ||
      !sha(session.ownerSha256) || !Number.isSafeInteger(session.entriesCount) || session.entriesCount < 1 ||
      session.entriesCount > 100000 || proof.checkpointSha256 !== hash({ sdkSession: session, files: proof.files })) return fail();
  const files = object(proof.files, ['workspace','tasks']), workspace = files.workspace;
  if (!workspace || !same(workspace.binding, b) || !same(workspace.scopes, p.scopes) ||
      !Array.isArray(workspace.entries) || !Array.isArray(files.tasks) || workspace.entries.length + files.tasks.length > 256) return fail();
  const rows = workspace.entries.filter((e: any) => e.path === path);
  if (rows.length !== 1 || rows[0].kind !== 'file' || rows[0].executable !== false) return fail();
  const f = object(v.file, ['path','object','base64']);
  const ref = object(f.object, ['objectId','versionId','sha256','bytes','scopes']);
  if (f.path !== path || !same(ref, rows[0].object) || !same(ref.scopes, p.scopes) ||
      typeof ref.objectId !== 'string' || !ref.objectId || ref.objectId.length > 1024 ||
      typeof ref.versionId !== 'string' || !ref.versionId || ['null','pending'].includes(ref.versionId) ||
      !sha(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > 2 * 1024 * 1024 ||
      typeof f.base64 !== 'string' || f.base64.length !== Math.ceil(ref.bytes / 3) * 4) return fail();
  const bytes = Buffer.from(f.base64, 'base64');
  if (bytes.length !== ref.bytes || bytes.toString('base64') !== f.base64 ||
      createHash('sha256').update(bytes).digest('hex') !== ref.sha256) return fail();
  let result: any;
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail(); }
  const descriptor = object(p.typedResult, ['schemaVersion','kind','path','sourceAdmissionSha256','sourceRequestSha256',
    'typedRequestSha256','resultRef','resultSha256','fileSha256','bytes','execution','observation']);
  const observation = object(descriptor.observation, ['sessionId','completedAtMs','state','payloadSha256']);
  const execution = object(descriptor.execution, ['provider','model','receiptRef','receiptSha256','bindingSha256']);
  const selection = object(p.typedSelection, ['binding','acceptedRequest','sourceAdmissionSha256','strategy','sourceRequestSha256']);
  const strategy = object(selection.strategy, ['schemaVersion','operation','request','requestSha256','executionContext','queuedType','executionSelection']);
  const expectedKind = path === 'meri-objective-strategy-draft.result.json' ? 'objective.strategy.draft' : 'objective.strategy.regeneration';
  if (descriptor.schemaVersion !== 1 || descriptor.kind !== expectedKind || descriptor.path !== path ||
      descriptor.sourceAdmissionSha256 !== a.sourceAdmissionSha256 || descriptor.sourceRequestSha256 !== a.sourceRequestSha256 ||
      descriptor.typedRequestSha256 !== expected.publication.requestSha256 || descriptor.resultRef !== b.runId ||
      descriptor.fileSha256 !== ref.sha256 || descriptor.bytes !== ref.bytes ||
      descriptor.resultSha256 !== result.resultSha256 || !same(execution, result.execution) ||
      execution.receiptRef !== b.runId || execution.bindingSha256 !== hash(b) ||
      observation.sessionId !== p.sessionId || observation.completedAtMs !== result.completedAtMs ||
      observation.state !== result.state || observation.payloadSha256 !== result.payloadSha256 ||
      !same(selection.binding,b) || !same(selection.acceptedRequest,accepted.request) ||
      selection.sourceAdmissionSha256 !== a.sourceAdmissionSha256 || selection.sourceRequestSha256 !== a.sourceRequestSha256 ||
      strategy.schemaVersion !== 1 || strategy.operation !== 'strategy.draft' ||
      !same(strategy.request,expected.publication.request) || strategy.requestSha256 !== descriptor.typedRequestSha256 ||
      !same(strategy.executionContext,expected.publication.executionContext) || strategy.queuedType !== accepted.record.selection.queuedType ||
      !same(strategy.executionSelection,{provider:execution.provider,model:execution.model}) ||
      execution.receiptSha256 !== hash({schemaVersion:1,operation:'strategy.draft',
        sourceAdmissionSha256:descriptor.sourceAdmissionSha256,sourceRequestSha256:descriptor.sourceRequestSha256,
        typedRequestSha256:descriptor.typedRequestSha256,bindingSha256:execution.bindingSha256,
        provider:execution.provider,model:execution.model,receiptRef:execution.receiptRef,
        sessionId:observation.sessionId,completedAtMs:observation.completedAtMs,state:observation.state,
        payloadSha256:observation.payloadSha256})) return fail();
  return { schemaVersion: 1, generationJobId: accepted.record.generationJobId, binding:b,
    sourceAdmissionSha256:a.sourceAdmissionSha256,sourceRequestSha256:a.sourceRequestSha256,
    typedRequestSha256:expected.publication.requestSha256,completionId:p.completionId,
    checkpointId:p.checkpointId,checkpointSha256:proof.checkpointSha256,resultRef:descriptor.resultRef,
    resultSha256:descriptor.resultSha256,file:{path:f.path,object:ref},rawFileSha256:ref.sha256,
    execution,result };
}
