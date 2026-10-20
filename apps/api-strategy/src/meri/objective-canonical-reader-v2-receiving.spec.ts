import { createHash, generateKeyPairSync } from 'node:crypto';
import type { Request } from 'express';
import { createObjectiveReaderV2Client } from '../../../api/src/auth/workload-authority/objective-reader-v2-client.js';
import { createObjectiveReaderV2Request, issueObjectiveReaderV2Jwt, verifyObjectiveReaderV2Jwt,
  type ObjectiveReaderV2Purpose } from '../../../api/src/auth/workload-authority/objective-reader-v2-jwt.js';
import { readerPurposes } from '../../../api/src/auth/workload-authority/objective-reader-v2-contract.js';
import { applicationHash } from '../planner/objective-canonical-application.js';
import type { CanonicalGenerationSubject } from '../planner/objective-canonical-authority.js';
import { canonicalGenerationAdmissionSha256 } from './objective-canonical-generation.js';
import { candidateJcsSha256 as jcs, createCanonicalRequestPublication } from './objective-canonical-request.js';
import { ObjectiveCanonicalResultOwner } from './objective-canonical-result-owner.js';
import { createCanonicalReaderV2Receiving, type CanonicalReaderV2NativeAcceptanceSource, type CanonicalReaderV2NativeSource,
  type CanonicalReaderV2ReceivingOptions } from './objective-canonical-reader-v2-receiving.js';

/** SYNTHETIC native rows/current-authority and credential-owner ports, HTTP and
 * process-local Ed25519 keys. Actual receiving + v2 client + JWT + canonical
 * publisher/acceptance/retained/result-owner factories execute unchanged.
 * No Meri custody/storage, live grant, SDK execution, database or mount claim. */
const NOW = 1_800_000_000_000;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
// Keep fixture objects in this test realm; native structuredClone in Jest's VM
// creates foreign prototypes that the production inert-data gates rightly deny.
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const purposes = Object.keys(readerPurposes) as ObjectiveReaderV2Purpose[];
const keys = Object.fromEntries(purposes.map(p => [p, generateKeyPairSync('ed25519')])) as Record<ObjectiveReaderV2Purpose, ReturnType<typeof generateKeyPairSync>>;
const trust = Object.fromEntries(purposes.map(p => [p, { purpose: p, issuer: `urn:synthetic:reader-receiving:${p}:v2`,
  kid: `${p}-synthetic-only`, publicKey: keys[p].publicKey }])) as Record<ObjectiveReaderV2Purpose,
  { purpose: ObjectiveReaderV2Purpose; issuer: string; kid: string; publicKey: typeof keys['active-source']['publicKey'] }>;
function resealRetained(value: any) {
  const { resultSha256: _discard, ...body } = value.result;
  value.result.resultSha256 = jcs(body); value.resultSha256 = value.result.resultSha256;
  const bytes = Buffer.from(JSON.stringify(value.result));
  value.rawFileSha256 = digest(bytes); value.file.object.sha256 = value.rawFileSha256; value.file.object.bytes = bytes.length;
  return value;
}

function fixture(selectedType = 'authorization') {
  const originalDto = { clientId: id(3), type: selectedType, goal: 'Original private job input', meriContext: null, ownerUserId: null,
    targetDate: null, attachmentIds: [] };
  const admission = { schemaVersion: 1, namespace: 'capiro.objective-strategy.admission:v1',
    canonical: { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4), canonicalStrategyId: id(5), canonicalProjectId: id(6),
      bindingVersion: 2, epoch: 1, requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 2, snapshotHash: 'a'.repeat(64) },
    actorUserId: id(9), clerkUserId: 'synthetic_clerk_é', consentId: id(12), controlVersion: 3,
    generationJobId: id(10), generationRequestId: id(11), admittedAtMs: NOW - 100000, effectExpiresAtMs: NOW + 50000, expectedStrategyVersionId: null };
  const coreSource = { clientId: id(3), objectiveId: id(4), objectiveVersion: 2, objectiveRevisionId: id(8) };
  const intent = { outcome: 'Original outcome', governmentProblem: 'Original government problem', askType: 'both', minimumWin: 'Original minimum', limits: '' };
  const prompt = 'Original governed prompt, é and 😀.\n';
  const publication = createCanonicalRequestPublication({ admission, dto: originalDto,
    context: { schemaVersion: 1, tenantId: id(2), clerkUserId: admission.clerkUserId, requestId: id(11), source: coreSource, intent,
      snapshotSha256: admission.canonical.snapshotHash, sourceDigest: applicationHash({ source: coreSource, intent }), packetId: id(20),
      compiledAt: new Date(NOW - 99000).toISOString(), coverageDigest: 'b'.repeat(64), promptSha256: digest(prompt), evidence: [] },
    prompt, owners: [{ ownerRef: 'owner:synthetic', clerkUserId: admission.clerkUserId }],
    delegation: { ref: id(30), revision: 'synthetic-original-delegation:1', issuedAtMs: NOW - 101000, absoluteExpiresAtMs: NOW + 100000 },
    requestedAtMs: NOW - 98000, effectExpiresAtMs: NOW + 40000 });
  const binding = { tenantId: id(2), actorId: admission.clerkUserId, conversationId: id(40), runId: id(41), attemptId: id(42), workerId: id(43), writerFence: 1 };
  const acceptedRequestSha256 = jcs({ requestId: admission.generationRequestId, prompt, skill: null, window: null, windowRequest: null });
  const acceptance = { schemaVersion: 1, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission), sourceBinding: binding,
    sourceRequestSha256: acceptedRequestSha256, acceptedAtMs: NOW - 97000,
    issuance: { issuanceKey: applicationHash(binding), binding, requestSha256: acceptedRequestSha256, expiresAtMs: NOW + 30000,
      grantId: id(44), capabilitySha256: 'd'.repeat(64), factsSha256: 'e'.repeat(64) } };
  const subject: CanonicalGenerationSubject = { phase: 'accept', generationJobId: admission.generationJobId,
    requestSha256: applicationHash({ schemaVersion: 1, generationJobId: admission.generationJobId }) };
  const grant = { tenantId: id(2), actorUserId: id(9), clerkUserId: admission.clerkUserId, consentId: id(12), controlVersion: 3,
    requestSha256: subject.requestSha256, checkedAtMs: NOW, expiresAtMs: NOW + 10000, delegationExpiresAtMs: NOW + 50000, claimExpiresAtMs: NOW + 40000 };
  const h = jcs({ binding, kind: 'completion' }), completionId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const execution = { provider: 'synthetic-provider', model: 'synthetic-model', receiptRef: completionId, receiptSha256: 'f'.repeat(64), bindingSha256: jcs(binding) };
  const payload = { type: selectedType, rationale: 'Synthetic exact rationale', summary: 'Synthetic exact summary',
    nodes: [{ sourceNodeKey: 'prepare', kind: 'action', subject: 'deliverable', title: 'Prepare original ask', note: null, status: 'suggested', ownerRef: null,
      startsOn: '2028-02-29', endsOn: null, openEnded: false, sources: [], dependsOn: [] }],
    coverage: { complete: true, omitted: [], assumptions: [], sources: [], pendingSources: [] } };
  const result = { candidateVersion: publication.request.candidateVersion, operation: 'strategy.draft', requestId: admission.generationRequestId,
    jobId: admission.generationJobId, requestSha256: publication.requestSha256, inputSha256: publication.request.inputSha256,
    sourceSha256: jcs(publication.request.source), contextSha256: publication.request.context.contextSha256, basisSha256: null,
    binding: copy(binding), execution: copy(execution), resultRef: completionId, completedAtMs: NOW - 90000, state: 'succeeded',
    payload, payloadSha256: jcs(payload), issues: [], resultSha256: '' };
  const { resultSha256: _discard, ...body } = result; result.resultSha256 = jcs(body);
  const resultBytes = Buffer.from(JSON.stringify(result));
  const retained = { schemaVersion: 1, generationJobId: admission.generationJobId, binding: copy(binding),
    sourceAdmissionSha256: acceptance.sourceAdmissionSha256, sourceRequestSha256: acceptedRequestSha256, typedRequestSha256: publication.requestSha256,
    completionId, checkpointId: id(50), checkpointSha256: '1'.repeat(64), resultRef: completionId, resultSha256: result.resultSha256,
    file: { path: 'meri-objective-strategy-draft.result.json', object: { objectId: id(60), versionId: 'synthetic-immutable-version',
      sha256: digest(resultBytes), bytes: resultBytes.length, scopes: [{ tenantId: id(2), kind: 'client', resourceId: id(3), policyRevision: 'b'.repeat(64) }] } },
    rawFileSha256: digest(resultBytes), execution, result, checkedAtMs: NOW, expiresAtMs: NOW + 1000 };
  const observation = { schemaVersion: 2, purpose: 'active-source', generationJobId: admission.generationJobId,
    sourceAdmission: admission, sourceAdmissionSha256: acceptance.sourceAdmissionSha256, binding, sourceRequestSha256: acceptedRequestSha256,
    issuance: acceptance.issuance, typedRequestSha256: publication.requestSha256, executionContextSha256: jcs(publication.executionContext),
    acceptedRequestId: admission.generationRequestId, acceptedPromptSha256: publication.executionContext.promptSha256,
    queuedType: selectedType, runState: 'running', checkedAtMs: NOW, expiresAtMs: NOW + 1000 };
  const state: { now: number; allowed: boolean; acceptance: unknown | null; nativeAcceptance: number; nativeRetained: number; credentials: number;
    clientCount: number; http: number; nativeMutation?: (mode: string, count: number, value: any) => unknown;
    wireMutation?: (mode: string, value: any) => unknown; onCredential?: () => void; events: string[] } = {
    now: NOW, allowed: true, acceptance: null, nativeAcceptance: 0, nativeRetained: 0, credentials: 0, clientCount: 0, http: 0, events: [],
  };
  const source = (): CanonicalReaderV2NativeSource => ({ originalDto: copy(originalDto), admission: copy(admission), publication: copy(publication),
    acceptance: copy(state.acceptance), checkedAtMs: state.now, expiresAtMs: state.now + 1500 });
  const nativeOwner = {
    async readAcceptance(_http: Request, input: CanonicalGenerationSubject) {
      state.nativeAcceptance++; state.events.push('native-acceptance'); if (!state.allowed) throw Error('SYNTHETIC_NATIVE_REVOKED');
      expect(input).toEqual(subject); const value = { ...source(), grant: { ...grant, checkedAtMs: state.now } };
      return (state.nativeMutation?.('acceptance', state.nativeAcceptance, value) ?? value) as CanonicalReaderV2NativeAcceptanceSource;
    },
    async readRetained(selector: { generationJobId: string; sourceAdmissionSha256: string }) {
      state.nativeRetained++; state.events.push('native-retained'); if (!state.allowed) throw Error('SYNTHETIC_NATIVE_REVOKED');
      expect(Object.keys(selector).sort()).toEqual(['generationJobId', 'sourceAdmissionSha256']);
      expect(selector).toEqual({ generationJobId: admission.generationJobId, sourceAdmissionSha256: acceptance.sourceAdmissionSha256 });
      const value = source(); return (state.nativeMutation?.('retained', state.nativeRetained, value) ?? value) as CanonicalReaderV2NativeSource;
    },
  };
  const createClient: NonNullable<CanonicalReaderV2ReceivingOptions['createClient']> = parsers => {
    state.clientCount++;
    return createObjectiveReaderV2Client({ enabled: true, origin: 'https://synthetic-meri.example', parsers, trust, now: () => state.now,
      credentialOwner: {
        async issue(request) { state.credentials++; state.events.push('credential'); if (!state.allowed) throw Error('SYNTHETIC_NATIVE_REVOKED');
          state.onCredential?.(); return { token: issueObjectiveReaderV2Jwt(request, { purpose: request.purpose, issuer: trust[request.purpose].issuer,
            kid: trust[request.purpose].kid, privateKey: keys[request.purpose].privateKey },
            { jti: id(70), nowSeconds: Math.floor(state.now / 1000), expiresAtSeconds: Math.floor(state.now / 1000) + 10 }), expiresAtMs: Math.floor(state.now / 1000) * 1000 + 10000 }; },
        async revalidate() { if (!state.allowed) throw Error('SYNTHETIC_NATIVE_REVOKED'); return true; },
      }, transport: (async (url, init) => {
        state.http++; state.events.push('synthetic-http');
        const requestBody = JSON.parse(Buffer.from(init!.body as Uint8Array).toString()), purpose = requestBody.purpose as ObjectiveReaderV2Purpose;
        expect(url).toBe('https://synthetic-meri.example' + readerPurposes[purpose].path);
        const request = createObjectiveReaderV2Request(purpose, { generationJobId: requestBody.generationJobId, sourceAdmissionSha256: requestBody.sourceAdmissionSha256 });
        expect(Buffer.from(request.body).equals(Buffer.from(init!.body as Uint8Array))).toBe(true);
        verifyObjectiveReaderV2Jwt((init!.headers as Record<string, string>).authorization!.slice(7), request, { ...trust[purpose], nowSeconds: Math.floor(state.now / 1000) });
        const value = copy(purpose === 'retained-result' ? retained : observation);
        value.checkedAtMs = state.now; value.expiresAtMs = state.now + 1000;
        const changed = state.wireMutation?.(purpose, value) ?? value;
        return new Response(JSON.stringify(changed), { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch });
  };
  const options: CanonicalReaderV2ReceivingOptions = { enabled: true, nativeOwner, createClient, now: () => state.now };
  const http = {} as Request;
  const observe = () => createCanonicalReaderV2Receiving(options).observeAcceptance(http, subject, { signal: new AbortController().signal });
  const read = () => createCanonicalReaderV2Receiving(options).retainedBridge.read({ generationJobId: admission.generationJobId, binding,
    sourceAdmissionSha256: acceptance.sourceAdmissionSha256 }, { signal: new AbortController().signal });
  return { originalDto, admission, publication, acceptance, subject, grant, binding, retained, observation, state, options, http, observe, read };
}

describe('initial canonical v2 receiving source composition', () => {
  test('actual v2 client/JWT/canonical factories produce exact proof after two fresh native owner reads', async () => {
    const f = fixture(), proof = await f.observe();
    expect(proof.sourceAdmission).toEqual(f.admission); expect(proof.sourceBinding).toEqual(f.binding);
    expect(proof.typedRequestSha256).toBe(f.publication.requestSha256);
    expect(proof.executionContextSha256).toBe(jcs(f.publication.executionContext));
    expect(proof.acceptedPromptSha256).toBe(f.publication.executionContext.promptSha256);
    expect(proof.grant.expiresAtMs).toBe(NOW + 1000); expect(f.state.nativeAcceptance).toBe(2);
    expect(f.state.events).toEqual(['native-acceptance', 'credential', 'synthetic-http', 'native-acceptance']);
    expect(Object.isFrozen(proof.issuance.binding)).toBe(true);
  });
  test('exact accepted replay keeps original issuance, request and binding without issuing another native grant', async () => {
    const f = fixture(); f.state.acceptance = copy(f.acceptance);
    const first = await f.observe(), second = await f.observe();
    expect(first.issuance).toEqual(f.acceptance.issuance); expect(second).toEqual(first); expect(f.state.nativeAcceptance).toBe(4);
  });
  test('existing result owner composes the v2 bridge and actual retained verifier against native original source', async () => {
    const f = fixture(); f.state.acceptance = copy(f.acceptance);
    const receiving = createCanonicalReaderV2Receiving(f.options), owner = new ObjectiveCanonicalResultOwner(receiving.retainedBridge);
    const result = await owner.read({ generationJobId: f.admission.generationJobId, binding: f.binding, sourceAdmissionSha256: f.acceptance.sourceAdmissionSha256 },
      { signal: new AbortController().signal });
    expect(result).toEqual(f.retained); expect(f.state.nativeRetained).toBe(2); expect(f.state.clientCount).toBe(1);
  });
  test('historical retained read does not renew expired execution or original effect custody', async () => {
    const f = fixture(); f.state.acceptance = copy(f.acceptance); f.state.now = NOW + 200000;
    const result = await f.read() as typeof f.retained;
    expect(result.result.completedAtMs).toBe(NOW - 90000); expect(f.acceptance.issuance.expiresAtMs).toBe(NOW + 30000);
    expect(result.checkedAtMs).toBe(f.state.now);
  });
  test.each(['needs-information', 'refused'])('actual typed %s receipt remains private terminal evidence without an application payload', async outcome => {
    const f = fixture(); f.state.acceptance = copy(f.acceptance);
    f.state.wireMutation = (_kind, value) => { value.result.state = outcome; value.result.payload = null; value.result.payloadSha256 = jcs(null);
      value.result.issues = [{ code: 'SYNTHETIC_TYPED_OUTCOME', message: 'Private source fixture only.' }]; return resealRetained(value); };
    const result = await f.read() as typeof f.retained;
    expect(result.result.state).toBe(outcome); expect(result.result.payload).toBeNull(); expect(f.state.nativeRetained).toBe(2);
  });
  test('generic failed run labels and empty or malformed non-success issues cannot become retained result evidence', async () => {
    for (const outcome of ['failed', 'cancelled', 'uncertain', 'needs-information']) {
      const f = fixture(); f.state.acceptance = copy(f.acceptance);
      f.state.wireMutation = (_kind, value) => { value.result.state = outcome; value.result.payload = null;
        value.result.payloadSha256 = jcs(null); value.result.issues = []; return resealRetained(value); };
      await expect(f.read()).rejects.toThrow();
    }
  });
  test('disabled/missing native owner or credential client is unavailable before any dependency I/O', async () => {
    const f = fixture(); let touched = false;
    const poison = Object.defineProperty({ enabled: false }, 'nativeOwner', { get() { touched = true; throw Error('never'); } });
    for (const options of [{}, poison, { ...f.options, nativeOwner: undefined }, { ...f.options, createClient: undefined }]) {
      const owner = createCanonicalReaderV2Receiving(options); expect(owner.retainedBridge.available()).toBe(false);
      await expect(owner.observeAcceptance(f.http, f.subject, { signal: new AbortController().signal })).rejects.toThrow();
    }
    expect(touched).toBe(false); expect(f.state.events).toEqual([]);
  });
  test('matching echoed JSON or caller binding cannot bypass a missing/revoked native owner', async () => {
    const f = fixture(); f.state.allowed = false; f.state.acceptance = copy(f.acceptance);
    await expect(f.observe()).rejects.toThrow(); await expect(f.read()).rejects.toThrow(); expect(f.state.http).toBe(0);
  });
  test('caller binding is comparison only and never enters the native custody selector', async () => {
    const f = fixture(); f.state.acceptance = copy(f.acceptance);
    await expect(createCanonicalReaderV2Receiving(f.options).retainedBridge.read({ generationJobId: f.admission.generationJobId,
      sourceAdmissionSha256: f.acceptance.sourceAdmissionSha256, binding: { ...f.binding, workerId: id(99) } },
      { signal: new AbortController().signal })).rejects.toThrow();
    expect(f.state.nativeRetained).toBe(1); expect(f.state.http).toBe(0);
  });
  test.each(['queuedType', 'typedRequestSha256', 'executionContextSha256', 'acceptedPromptSha256', 'acceptedRequestId'])('rejects Meri %s conflicting with original publication', async key => {
    const f = fixture(); f.state.wireMutation = (_mode, value) => ({ ...value, [key]: key.endsWith('Sha256') ? '9'.repeat(64) : key === 'queuedType' ? 'regulatory' : id(99) });
    await expect(f.observe()).rejects.toThrow();
  });
  test('a self-consistent publication/type does not replace the independently loaded original job DTO', async () => {
    const f = fixture(), other = fixture('regulatory');
    f.state.nativeMutation = (_mode, _count, value) => ({ ...value, publication: other.publication });
    await expect(f.observe()).rejects.toThrow(); expect(f.state.clientCount).toBe(0);
  });
  test('fresh native read cannot change selected type, source revision, accepted source or grant identity during transport', async () => {
    const mutations = [(_mode: string, count: number, value: any) => count === 2 ? { ...value, originalDto: fixture('regulatory').originalDto,
      publication: fixture('regulatory').publication } : value,
    (_mode: string, count: number, value: any) => { if (count === 2) value.admission.canonical.requestedObjectiveRevisionId = id(99); return value; },
    (_mode: string, count: number, value: any) => { if (count === 2) value.grant.claimExpiresAtMs++; return value; }];
    for (const mutate of mutations) { const f = fixture(); f.state.nativeMutation = mutate; await expect(f.observe()).rejects.toThrow(); }
  });
  test('native grant revocation after authenticated HTTP cannot return a positive proof', async () => {
    const f = fixture(); f.state.nativeMutation = (_mode, count, value) => { if (count === 2) throw Error('SYNTHETIC_AFTER_REVOKED'); return value; };
    await expect(f.observe()).rejects.toThrow(); expect(f.state.http).toBe(1); expect(f.state.nativeAcceptance).toBe(2);
  });
  test('source expiry during the last native check refuses acceptance and retained success', async () => {
    for (const mode of ['acceptance', 'retained']) {
      const f = fixture(); f.state.acceptance = copy(f.acceptance);
      f.state.nativeMutation = (_kind, count, value) => { if (count === 2) { f.state.now = NOW + 1000; value.checkedAtMs = f.state.now; value.expiresAtMs = f.state.now + 1500; } return value; };
      await expect(mode === 'acceptance' ? f.observe() : f.read()).rejects.toThrow();
    }
  });
  test('a first native grant expiring during final recheck cannot be renewed by a later fresh grant', async () => {
    const f = fixture();
    f.state.nativeMutation = (_mode, count, value) => {
      if (count === 1) value.grant.expiresAtMs = NOW + 50;
      if (count === 2) { f.state.now = NOW + 100; value.checkedAtMs = f.state.now; value.expiresAtMs = f.state.now + 1500; value.grant.checkedAtMs = f.state.now; }
      return value;
    };
    await expect(f.observe()).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    expect(f.state.nativeAcceptance).toBe(2); expect(f.state.http).toBe(1);
  });
  test.each(['acceptance', 'retained'] as const)('%s rechecks caller abort after final native read resolution before returning', async mode => {
    const f = fixture(), controller = new AbortController(); f.state.acceptance = copy(f.acceptance);
    const originalAcceptance = f.options.nativeOwner!.readAcceptance, originalRetained = f.options.nativeOwner!.readRetained;
    f.options.nativeOwner!.readAcceptance = async (...args) => {
      const value = await originalAcceptance(...args);
      if (f.state.nativeAcceptance === 2) queueMicrotask(() => queueMicrotask(() => controller.abort()));
      return value;
    };
    f.options.nativeOwner!.readRetained = async (...args) => {
      const value = await originalRetained(...args);
      if (f.state.nativeRetained === 2) queueMicrotask(() => queueMicrotask(() => controller.abort()));
      return value;
    };
    const adapter = createCanonicalReaderV2Receiving(f.options);
    const pending = mode === 'acceptance' ? adapter.observeAcceptance(f.http, f.subject, { signal: controller.signal }) :
      adapter.retainedBridge.read({ generationJobId: f.admission.generationJobId, binding: f.binding,
        sourceAdmissionSha256: f.acceptance.sourceAdmissionSha256 }, { signal: controller.signal });
    await expect(pending).rejects.toThrow('AUTHORITY_UNAVAILABLE'); expect(controller.signal.aborted).toBe(true);
    expect(mode === 'acceptance' ? f.state.nativeAcceptance : f.state.nativeRetained).toBe(2);
  });
  test('stale native authority and non-monotonic operation clocks fail before positive receipt', async () => {
    const f = fixture(); f.state.nativeMutation = (_kind, _count, value) => ({ ...value, checkedAtMs: NOW - 1 });
    await expect(f.observe()).rejects.toThrow(); expect(f.state.http).toBe(0);
    const g = fixture(); g.state.onCredential = () => { g.state.now--; };
    await expect(g.observe()).rejects.toThrow();
  });
  test('retained result must match exact original acceptance and timely immutable result/file digests', async () => {
    for (const key of ['sourceRequestSha256', 'typedRequestSha256', 'rawFileSha256', 'resultSha256']) {
      const f = fixture(); f.state.acceptance = copy(f.acceptance); f.state.wireMutation = (_kind, value) => ({ ...value, [key]: '9'.repeat(64) });
      await expect(f.read()).rejects.toThrow();
    }
  });
  test('conflicting accepted replay and changed historical acceptance stay closed', async () => {
    const f = fixture(); f.state.acceptance = { ...copy(f.acceptance), sourceRequestSha256: '9'.repeat(64),
      issuance: { ...copy(f.acceptance.issuance), requestSha256: '9'.repeat(64) } };
    await expect(f.observe()).rejects.toThrow();
    const g = fixture(); g.state.acceptance = copy(g.acceptance);
    g.state.nativeMutation = (_kind, count, value) => { if (count === 2) value.acceptance.issuance.factsSha256 = '9'.repeat(64); return value; };
    await expect(g.read()).rejects.toThrow();
  });
  test('regeneration and non-accept phases remain unavailable under frozen initial-only v2', async () => {
    const f = fixture(); f.state.nativeMutation = (_kind, _count, value) => { value.admission.expectedStrategyVersionId = id(99); return value; };
    await expect(f.observe()).rejects.toThrow(); expect(f.state.clientCount).toBe(0);
    const g = fixture(); await expect(createCanonicalReaderV2Receiving(g.options).observeAcceptance(g.http,
      { ...g.subject, phase: 'complete' }, { signal: new AbortController().signal })).rejects.toThrow(); expect(g.state.events).toEqual([]);
  });
  test('caller cancellation exits an unresolved native owner and creates no credential/HTTP work', async () => {
    const f = fixture(), controller = new AbortController();
    f.options.nativeOwner!.readAcceptance = () => new Promise(() => undefined);
    const pending = createCanonicalReaderV2Receiving(f.options).observeAcceptance(f.http, f.subject, { signal: controller.signal });
    controller.abort(); await expect(pending).rejects.toThrow(); expect(f.state.credentials).toBe(0);
  });
  test('parallel reads create independent immutable parser closures without shared options mutation', async () => {
    const f = fixture(); f.state.acceptance = copy(f.acceptance);
    const adapter = createCanonicalReaderV2Receiving(f.options);
    const [proof, result] = await Promise.all([adapter.observeAcceptance(f.http, f.subject, { signal: new AbortController().signal }),
      adapter.retainedBridge.read({ generationJobId: f.admission.generationJobId, sourceAdmissionSha256: f.acceptance.sourceAdmissionSha256, binding: f.binding },
        { signal: new AbortController().signal })]);
    expect(proof.sourceBinding).toEqual(f.binding); expect(result).toEqual(f.retained); expect(f.state.clientCount).toBe(2);
  });
});
