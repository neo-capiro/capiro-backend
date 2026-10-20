import { createHash } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import { applicationHash } from '../../planner/objective-canonical-application.js';
import type { CanonicalGenerationSubject, ObjectiveCanonicalWorkloadAuthority } from '../../planner/objective-canonical-authority.js';
import { GENERATION_ADMISSION, GENERATION_ACCEPTANCE, GENERATION_REQUEST, canonicalGenerationAdmissionSha256, generationLedgerId } from '../objective-canonical-generation.js';
import { generationMarker } from '../objective-canonical-producer-ledger.js';
import { createCanonicalRequestPublication, candidateJcsSha256 as jcs } from '../objective-canonical-request.js';
import { canonicalPublicationInputHash, canonicalPublicationSha256 } from '../objective-canonical-request-ledger.js';
import type { CanonicalReaderV2Prisma, CanonicalReaderV2RetainedAccessOwner } from '../objective-canonical-reader-v2-native-owner.js';

/** SYNTHETIC native rows/authorization/Prisma transactions only. Actual source
 * publisher, admission/resource identities and custody hashes run unchanged.
 * No real database, native grant, Meri custody, SDK or execution is claimed. */
export const nativeReaderFixtureNow = 1_800_000_000_000;
export const nativeReaderFixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const id = nativeReaderFixtureId, NOW = nativeReaderFixtureNow;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
export function nativeReaderV2Fixture(type = 'authorization') {
  const originalDto = { clientId: id(3), type, goal: 'Original private native input', meriContext: null, ownerUserId: null, targetDate: null, attachmentIds: [] };
  const snapshot = { id: id(4), clientId: id(3), version: 2, outcome: 'Original outcome', governmentProblem: 'Original government problem',
    askType: 'both', minimumWin: 'Original minimum', limits: '' };
  const source = { clientId: id(3), objectiveId: id(4), objectiveVersion: 2, objectiveRevisionId: id(8) };
  const intent = { outcome: snapshot.outcome, governmentProblem: snapshot.governmentProblem, askType: snapshot.askType, minimumWin: snapshot.minimumWin, limits: snapshot.limits };
  const admission = { schemaVersion: 1, namespace: 'capiro.objective-strategy.admission:v1',
    canonical: { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4), canonicalStrategyId: id(5), canonicalProjectId: id(6),
      bindingVersion: 2, epoch: 1, requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 2, snapshotHash: applicationHash(snapshot) },
    actorUserId: id(9), clerkUserId: 'synthetic_native_clerk', consentId: id(12), controlVersion: 3, generationJobId: id(10), generationRequestId: id(11),
    admittedAtMs: NOW - 100000, effectExpiresAtMs: NOW + 50000, expectedStrategyVersionId: null };
  const prompt = 'Literal original native prompt, é and 😀.\n';
  const sourceDigest = applicationHash({ source, intent }), coverageDigest = 'b'.repeat(64), localDigest = 'c'.repeat(64), externalDigest = 'd'.repeat(64), historyDigest = 'e'.repeat(64);
  const context = { state: 'complete', issues: [], reobservedAt: null, sourceDigest, coverageDigest, packetId: id(20), compiledAt: new Date(NOW - 99000).toISOString(),
    inputDigest: applicationHash({ sourceDigest, coverageDigest, packetId: id(20), requestId: id(11), type, localDigest, externalDigest, historyDigest, promptDigest: applicationHash(prompt) }) };
  const publication = createCanonicalRequestPublication({ admission, dto: originalDto,
    context: { schemaVersion: 1, tenantId: id(2), clerkUserId: admission.clerkUserId, requestId: id(11), source, intent, snapshotSha256: admission.canonical.snapshotHash,
      sourceDigest, packetId: id(20), compiledAt: context.compiledAt, coverageDigest, promptSha256: sha(prompt), evidence: [] }, prompt,
    owners: [{ ownerRef: 'owner:synthetic-native', clerkUserId: admission.clerkUserId }],
    delegation: { ref: id(30), revision: 'synthetic-native-delegation:1', issuedAtMs: NOW - 101000, absoluteExpiresAtMs: NOW + 100000 },
    requestedAtMs: NOW - 98000, effectExpiresAtMs: NOW + 40000 });
  const request = { requestId: id(11), clientId: id(3), objective: { objectiveId: id(4), objectiveVersion: 2 }, type };
  const input = { bearer: null, dto: copy(originalDto), objectiveGeneration: { request, fingerprint: applicationHash(request), receipt: { source: copy(source), context: copy(context) } },
    canonicalGeneration: generationMarker(admission as any) };
  const compiled = { tenantId: id(2), clerkUserId: admission.clerkUserId, requestId: id(11), type, source: copy(source), intent: copy(intent),
    context: copy(context), localDigest, externalDigest, historyDigest };
  const published = { schemaVersion: 1, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission), inputSha256: canonicalPublicationInputHash(input as any),
    publicationSha256: canonicalPublicationSha256(publication), compiled, publication };
  const binding = { tenantId: id(2), actorId: admission.clerkUserId, conversationId: id(40), runId: id(41), attemptId: id(42), workerId: id(43), writerFence: 1 };
  const acceptedRequestSha256 = jcs({ requestId: id(11), prompt, skill: null, window: null, windowRequest: null });
  const acceptance = { schemaVersion: 1, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission), sourceBinding: copy(binding), sourceRequestSha256: acceptedRequestSha256,
    acceptedAtMs: NOW - 97000, issuance: { issuanceKey: applicationHash(binding), binding: copy(binding), requestSha256: acceptedRequestSha256, expiresAtMs: NOW + 30000,
      grantId: id(44), capabilitySha256: 'd'.repeat(64), factsSha256: 'e'.repeat(64) } };
  const subject: CanonicalGenerationSubject = { phase: 'accept', generationJobId: id(10), requestSha256: applicationHash({ schemaVersion: 1, generationJobId: id(10) }) };
  const grant = { tenantId: id(2), actorUserId: id(9), clerkUserId: admission.clerkUserId, consentId: id(12), controlVersion: 3, requestSha256: subject.requestSha256,
    checkedAtMs: NOW, expiresAtMs: NOW + 10000, delegationExpiresAtMs: NOW + 50000, claimExpiresAtMs: NOW + 40000 };
  const h = jcs({ binding, kind: 'completion' }), completionId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const execution = { provider: 'synthetic-provider', model: 'synthetic-model', receiptRef: completionId, receiptSha256: 'f'.repeat(64), bindingSha256: jcs(binding) };
  const payload = { type, rationale: 'Synthetic exact rationale', summary: 'Synthetic exact summary', nodes: [{ sourceNodeKey: 'prepare', kind: 'action', subject: 'deliverable',
    title: 'Prepare original ask', note: null, status: 'suggested', ownerRef: null, startsOn: '2028-02-29', endsOn: null, openEnded: false, sources: [], dependsOn: [] }],
    coverage: { complete: true, omitted: [], assumptions: [], sources: [], pendingSources: [] } };
  const result = { candidateVersion: publication.request.candidateVersion, operation: 'strategy.draft', requestId: id(11), jobId: id(10), requestSha256: publication.requestSha256,
    inputSha256: publication.request.inputSha256, sourceSha256: jcs(publication.request.source), contextSha256: publication.request.context.contextSha256, basisSha256: null,
    binding: copy(binding), execution: copy(execution), resultRef: completionId, completedAtMs: NOW - 90000, state: 'succeeded', payload, payloadSha256: jcs(payload), issues: [], resultSha256: '' };
  const { resultSha256: _unused, ...resultBody } = result; result.resultSha256 = jcs(resultBody); const resultBytes = Buffer.from(JSON.stringify(result));
  const retainedReceipt = { schemaVersion: 1, generationJobId: id(10), binding: copy(binding), sourceAdmissionSha256: acceptance.sourceAdmissionSha256,
    sourceRequestSha256: acceptedRequestSha256, typedRequestSha256: publication.requestSha256, completionId, checkpointId: id(50), checkpointSha256: '1'.repeat(64),
    resultRef: completionId, resultSha256: result.resultSha256, file: { path: 'meri-objective-strategy-draft.result.json', object: { objectId: id(60),
      versionId: 'synthetic-immutable-version', sha256: sha(resultBytes), bytes: resultBytes.length, scopes: [{ tenantId: id(2), kind: 'client', resourceId: id(3), policyRevision: 'b'.repeat(64) }] } },
    rawFileSha256: sha(resultBytes), execution: copy(execution), result, checkedAtMs: NOW, expiresAtMs: NOW + 1000 };
  const observation = { schemaVersion: 2, purpose: 'active-source', generationJobId: id(10), sourceAdmission: copy(admission), sourceAdmissionSha256: acceptance.sourceAdmissionSha256,
    binding: copy(binding), sourceRequestSha256: acceptedRequestSha256, issuance: copy(acceptance.issuance), typedRequestSha256: publication.requestSha256,
    executionContextSha256: jcs(publication.executionContext), acceptedRequestId: id(11), acceptedPromptSha256: publication.executionContext.promptSha256,
    queuedType: type, runState: 'running', checkedAtMs: NOW, expiresAtMs: NOW + 1000 };
  const job = { id: id(10), tenantId: id(2), clientId: id(3), ownerUserId: admission.clerkUserId, status: 'queued', attempt: 1, claimedBy: null, claimedAt: null,
    strategyId: null, input: copy(input) };
  const state = { now: NOW, allowed: true, retainedAllowed: true, acl: true, objectiveExists: true, revisionExists: true, memoryWall: false, wallAllowed: true,
    acceptancePresent: false, activeTransactions: 0, verifies: 0, generationChecks: 0, retainedChecks: 0, authorizes: 0, transactions: 0,
    timeoutMs: [] as number[], events: [] as string[], onQuery: undefined as undefined | ((sql: string, values: unknown[]) => void),
    beforeCommit: undefined as undefined | (() => void), afterCommit: undefined as undefined | (() => void),
    beforeGenerationCheck: undefined as undefined | (() => void), beforeRetainedCheck: undefined as undefined | (() => void),
    grantOverride: undefined as undefined | ((value: typeof grant) => unknown), accessOverride: undefined as undefined | ((value: any) => unknown) };
  const resourceData = new Map<string, unknown>([[GENERATION_ADMISSION, admission], [GENERATION_REQUEST, published], [GENERATION_ACCEPTANCE, acceptance]]);
  const tx = {
    async $queryRaw(parts: TemplateStringsArray, ...values: unknown[]) {
      const sql = parts.join('?'); state.events.push('sql'); state.onQuery?.(sql, values);
      if (/FROM sp_draft_job/.test(sql)) { state.events.push('job-lock'); return [{ id: job.id }]; }
      if (/FROM client_objective_revisions/.test(sql)) return state.revisionExists ? [{ snapshot: copy(snapshot) }] : [];
      if (/FROM tenants t/.test(sql)) return state.acl ? [{ actorUserId: admission.actorUserId, memoryWall: state.memoryWall }] : [];
      if (/FROM client_memory_access/.test(sql)) return state.wallAllowed ? [{ id: id(88) }] : [];
      if (/FROM client_objectives/.test(sql)) return state.objectiveExists ? [{ id: id(4) }] : [];
      if (/clock_timestamp/.test(sql)) return [{ nowMs: String(state.now) }]; throw Error('Unexpected synthetic SQL: ' + sql);
    }, spDraftJob: { async findFirst(args: any) {
      state.events.push('job-read'); return args.where.tenantId === job.tenantId && args.where.id === job.id &&
        (!args.where.ownerUserId || args.where.ownerUserId === job.ownerUserId) ? copy(job) : null;
    } }, spPlannerResource: { async findFirst(args: any) {
      state.events.push('resource-read'); if (args.where.tenantId !== id(2)) return null;
      for (const [kind, value] of resourceData) if (generationLedgerId(kind as any, id(2), admission.clerkUserId, id(10)) === args.where.id) {
        if (kind === GENERATION_ACCEPTANCE && !state.acceptancePresent) return null;
        return { tenantId: id(2), id: args.where.id, kind, ownerId: admission.clerkUserId, archived: false, projectId: null, version: 1, shareTokenHash: null, data: copy(value) };
      } return null;
    } },
  } as unknown as Prisma.TransactionClient;
  const prisma: CanonicalReaderV2Prisma = { async withTenant(tenantId, run, options) {
    if (tenantId !== id(2)) throw Error('SYNTHETIC_WRONG_SCOPE'); state.transactions++; state.timeoutMs.push(options?.timeoutMs ?? 0);
    state.activeTransactions++; state.events.push('tx-open');
    try { const value = await run(tx); state.beforeCommit?.(); state.events.push('tx-commit'); state.activeTransactions--; state.afterCommit?.(); return value; }
    catch (error) { if (state.activeTransactions) state.activeTransactions--; state.events.push('tx-rollback'); throw error; }
  } };
  const baseAuthority: ObjectiveCanonicalWorkloadAuthority = {
    async verifyGeneration(_http, actual) { state.verifies++; state.events.push('verify-generation');
      if (state.activeTransactions || !state.allowed || applicationHash(actual) !== applicationHash(subject)) throw Error('SYNTHETIC_AUTHORITY_UNAVAILABLE');
      const value = { ...copy(grant), checkedAtMs: state.now }; return (state.grantOverride?.(value) ?? value) as typeof grant; },
    async assertGenerationCurrent(actualTx) { state.generationChecks++; state.events.push('generation-current'); state.beforeGenerationCheck?.();
      if (actualTx !== tx || !state.activeTransactions || !state.allowed) throw Error('SYNTHETIC_NATIVE_REVOKED'); },
    async verifyGenerationAcceptance() { throw Error('SYNTHETIC_BASE_OBSERVER_MUST_NOT_BE_CALLED'); },
    async verify() { throw Error('SYNTHETIC_UNALLOCATED_APPLICATION_AUTHORITY'); },
    async assertCurrent() { throw Error('SYNTHETIC_UNALLOCATED_APPLICATION_AUTHORITY'); },
  };
  const retainedAccess: CanonicalReaderV2RetainedAccessOwner = {
    async authorize(selector) { state.authorizes++; state.events.push('authorize-retained');
      if (state.activeTransactions || !state.retainedAllowed || selector.generationJobId !== id(10) || selector.sourceAdmissionSha256 !== acceptance.sourceAdmissionSha256) throw Error('SYNTHETIC_RETAINED_UNAVAILABLE');
      const value = { purpose: 'retained-result-read' as const, tenantId: id(2), clientId: id(3), objectiveId: id(4), actorUserId: id(9), clerkUserId: admission.clerkUserId,
        generationJobId: id(10), sourceAdmissionSha256: acceptance.sourceAdmissionSha256, checkedAtMs: state.now, expiresAtMs: state.now + 2000 };
      return (state.accessOverride?.(value) ?? value) as typeof value; },
    async assertCurrent(actualTx) { state.retainedChecks++; state.events.push('retained-current'); state.beforeRetainedCheck?.();
      if (actualTx !== tx || !state.activeTransactions || !state.retainedAllowed) throw Error('SYNTHETIC_RETAINED_REVOKED'); },
  };
  const clock = () => state.now;
  return { prisma, baseAuthority, authority: baseAuthority, retainedAccess, clock, now: clock, admission, publication, originalDto, acceptance, binding,
    observation, retainedReceipt, subject, grant, snapshot, source, intent, input, job, published, resourceData, state, tx };
}
