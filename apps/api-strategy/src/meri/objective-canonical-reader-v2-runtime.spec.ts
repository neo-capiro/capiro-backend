import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import type { Request } from 'express';
import { createObjectiveReaderV2Client } from '../../../api/src/auth/workload-authority/objective-reader-v2-client.js';
import { readerPurposes } from '../../../api/src/auth/workload-authority/objective-reader-v2-contract.js';
import { createObjectiveReaderV2Request, issueObjectiveReaderV2Jwt, verifyObjectiveReaderV2Jwt,
  type ObjectiveReaderV2Purpose } from '../../../api/src/auth/workload-authority/objective-reader-v2-jwt.js';
import { ObjectiveCanonicalWorkloadAuthority } from '../planner/objective-canonical-authority.js';
import { candidateJcsSha256 } from './objective-canonical-request.js';
import { ObjectiveCanonicalResultOwner } from './objective-canonical-result-owner.js';
import { createCanonicalReaderV2Runtime, OBJECTIVE_CANONICAL_READER_V2_RUNTIME,
  type CanonicalReaderV2Runtime, type CanonicalReaderV2RuntimeBindings } from './objective-canonical-reader-v2-runtime.js';
import { nativeReaderV2Fixture, nativeReaderFixtureNow as NOW, nativeReaderFixtureId as id } from './test/objective-canonical-reader-v2-native.fixture.js';

/** SYNTHETIC stored rows/Prisma transactions, native and credential decisions,
 * HTTPS responses and ephemeral Ed25519 keys only. Actual Core runtime, native
 * source reconstruction, canonical parsers, receiving, client/JWT and result
 * owner run unchanged. This proves no live auth, Meri custody or SQL durability.
 * The unconnected native requests below model the internal workload HTTP read,
 * never the earlier browser request or ownership of Planner continuation. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const purposes = Object.keys(readerPurposes) as ObjectiveReaderV2Purpose[];
const keys = Object.fromEntries(purposes.map(purpose => [purpose, generateKeyPairSync('ed25519')])) as
  Record<ObjectiveReaderV2Purpose, ReturnType<typeof generateKeyPairSync>>;
const trust = Object.fromEntries(purposes.map(purpose => [purpose, { purpose,
  issuer: `urn:synthetic:core-runtime:${purpose}:v2`, kid: `${purpose}-synthetic-only`, publicKey: keys[purpose].publicKey }])) as
  Record<ObjectiveReaderV2Purpose, { purpose: ObjectiveReaderV2Purpose; issuer: string; kid: string;
    publicKey: typeof keys['active-source']['publicKey'] }>;
const requests: IncomingMessage[] = [];
function internalRequest(complete = false): Request {
  const http = new IncomingMessage(new Socket()); http.complete = complete; requests.push(http);
  return http as Request;
}
afterEach(() => { for (const request of requests.splice(0)) request.destroy(); jest.restoreAllMocks(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const f = nativeReaderV2Fixture();
  const clientState = { factories: 0, credentials: 0, revalidations: 0, http: 0, allowed: true,
    purposes: [] as ObjectiveReaderV2Purpose[], signals: [] as AbortSignal[],
    beforeHttp: undefined as undefined | ((purpose: ObjectiveReaderV2Purpose, signal: AbortSignal) => void | Promise<void>),
    afterHttp: undefined as undefined | ((purpose: ObjectiveReaderV2Purpose) => void),
    mutateWire: undefined as undefined | ((purpose: ObjectiveReaderV2Purpose, value: any) => unknown) };
  const createClient: CanonicalReaderV2RuntimeBindings['createClient'] = parsers => {
    clientState.factories++;
    return createObjectiveReaderV2Client({ enabled: true, origin: 'https://synthetic-meri.example', trust, parsers, now: f.clock,
      credentialOwner: {
        async issue(request) {
          expect(f.state.activeTransactions).toBe(0); clientState.credentials++; f.state.events.push('synthetic-credential');
          if (!clientState.allowed) throw Error('SYNTHETIC_CREDENTIAL_REVOKED');
          const at = Math.floor(f.state.now / 1000);
          return { token: issueObjectiveReaderV2Jwt(request, { purpose: request.purpose, issuer: trust[request.purpose].issuer,
            kid: trust[request.purpose].kid, privateKey: keys[request.purpose].privateKey },
            { jti: id(70), nowSeconds: at, expiresAtSeconds: at + 10 }), expiresAtMs: (at + 10) * 1000 };
        },
        async revalidate() {
          expect(f.state.activeTransactions).toBe(0); clientState.revalidations++;
          if (!clientState.allowed) throw Error('SYNTHETIC_CREDENTIAL_REVOKED'); return true;
        },
      },
      transport: (async (url, init) => {
        expect(f.state.activeTransactions).toBe(0); clientState.http++; f.state.events.push('synthetic-http');
        const body = JSON.parse(Buffer.from(init!.body as Uint8Array).toString()), purpose = body.purpose as ObjectiveReaderV2Purpose;
        const signal = init!.signal!; clientState.signals.push(signal); clientState.purposes.push(purpose);
        expect(url).toBe('https://synthetic-meri.example' + readerPurposes[purpose].path);
        const request = createObjectiveReaderV2Request(purpose, { generationJobId: body.generationJobId, sourceAdmissionSha256: body.sourceAdmissionSha256 });
        expect(Buffer.from(request.body).equals(Buffer.from(init!.body as Uint8Array))).toBe(true);
        verifyObjectiveReaderV2Jwt((init!.headers as Record<string, string>).authorization!.slice(7), request,
          { ...trust[purpose], nowSeconds: Math.floor(f.state.now / 1000) });
        await clientState.beforeHttp?.(purpose, signal);
        const value = copy(purpose === 'retained-result' ? f.retainedReceipt : f.observation);
        value.checkedAtMs = f.state.now; value.expiresAtMs = f.state.now + 1000;
        const wire = clientState.mutateWire?.(purpose, value) ?? value;
        clientState.afterHttp?.(purpose);
        return new Response(JSON.stringify(wire), { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
  };
  const bindings: CanonicalReaderV2RuntimeBindings = { prisma: f.prisma, authority: f.baseAuthority,
    retainedAccess: f.retainedAccess, createClient, now: f.clock };
  const runtime = createCanonicalReaderV2Runtime({ enabled: true, bindings });
  const source = { generationJobId: f.admission.generationJobId, binding: f.binding, sourceAdmissionSha256: f.acceptance.sourceAdmissionSha256 };
  const accept = (http = internalRequest()) => runtime.authority.verifyGenerationAcceptance(http, f.subject);
  const retained = (signal = new AbortController().signal) => runtime.resultOwner.read(source, { signal });
  return { ...f, bindings, runtime, clientState, accept, retained, retainedSource: source };
}

describe('Core canonical reader v2 runtime source composition', () => {
  test('actual runtime composes two native source transactions with real canonical receiving, client and JWT', async () => {
    const f = setup(), baseObserver = jest.spyOn(f.baseAuthority, 'verifyGenerationAcceptance');
    const http = internalRequest(), proof = await f.accept(http);
    expect(proof.sourceAdmission).toEqual(f.admission); expect(proof.sourceBinding).toEqual(f.binding);
    expect(proof.issuance).toEqual(f.acceptance.issuance); expect(proof.sourceRequestSha256).toBe(f.acceptance.sourceRequestSha256);
    expect(proof.typedRequestSha256).toBe(f.publication.requestSha256);
    expect(proof.executionContextSha256).toBe(candidateJcsSha256(f.publication.executionContext));
    expect(proof.acceptedRequestId).toBe(f.admission.generationRequestId);
    expect(proof.acceptedPromptSha256).toBe(f.publication.executionContext.promptSha256);
    expect(proof.grant.expiresAtMs).toBe(NOW + 1000); expect(Object.isFrozen(proof.issuance.binding)).toBe(true);
    expect(f.state.transactions).toBe(2); expect(f.state.generationChecks).toBe(4); expect(f.state.verifies).toBe(2);
    expect(f.state.activeTransactions).toBe(0); expect(f.clientState.purposes).toEqual(['active-source']);
    expect(baseObserver).not.toHaveBeenCalled();
    expect(f.state.events.indexOf('tx-commit')).toBeLessThan(f.state.events.indexOf('synthetic-credential'));
    expect(f.state.events.lastIndexOf('tx-open')).toBeGreaterThan(f.state.events.indexOf('synthetic-http'));
    expect(http.listenerCount('aborted')).toBe(0); expect(http.listenerCount('close')).toBe(0);
  });

  test('exact persisted acceptance replay retains original issuance through the native source owner', async () => {
    const f = setup(); f.state.acceptancePresent = true;
    const first = await f.accept(), second = await f.accept();
    expect(first).toEqual(second); expect(first.issuance).toEqual(f.acceptance.issuance);
    expect(f.state.transactions).toBe(4); expect(f.state.generationChecks).toBe(8);
    expect(f.clientState.purposes).toEqual(['active-source', 'active-source']);
  });

  test('same runtime result owner reads actual retained receipt through independent current native access after original expiry', async () => {
    const f = setup(); f.state.acceptancePresent = true; f.state.now = NOW + 200000;
    const receipt = await f.retained() as typeof f.retainedReceipt;
    expect(receipt).toEqual({ ...f.retainedReceipt, checkedAtMs: f.state.now, expiresAtMs: f.state.now + 1000 });
    expect(receipt.result.completedAtMs).toBe(NOW - 90000); expect(f.acceptance.issuance.expiresAtMs).toBe(NOW + 30000);
    expect(f.state.authorizes).toBe(2); expect(f.state.retainedChecks).toBe(4); expect(f.state.verifies).toBe(0);
    expect(f.clientState.purposes).toEqual(['retained-result']); expect(f.state.activeTransactions).toBe(0);
  });

  test('default-off construction never reads binding accessors, resolves owners, constructs clients or performs I/O', async () => {
    const f = setup(); let touched = 0;
    const bindingsPoison = Object.defineProperty({ enabled: false }, 'bindings', { get() { touched++; throw Error('never'); } });
    const flagPoison = Object.defineProperty({}, 'enabled', { get() { touched++; throw Error('never'); } });
    for (const options of [{}, bindingsPoison, flagPoison, { enabled: false, bindings: f.bindings }]) {
      const runtime = createCanonicalReaderV2Runtime(options);
      await expect(runtime.authority.verifyGenerationAcceptance(internalRequest(), f.subject)).rejects.toThrow('AUTHORITY_UNAVAILABLE');
      await expect(runtime.resultOwner.read(f.retainedSource, { signal: new AbortController().signal })).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    }
    expect(touched).toBe(0); expect(f.state.events).toEqual([]); expect(f.clientState.factories).toBe(0);
    expect(f.clientState.credentials).toBe(0); expect(f.clientState.http).toBe(0);
  });

  test('missing genuine server bindings stay closed before native or HTTP work', async () => {
    const f = setup();
    for (const name of ['prisma', 'authority', 'retainedAccess', 'createClient'] as const) {
      const runtime = createCanonicalReaderV2Runtime({ enabled: true, bindings: { ...f.bindings, [name]: undefined } as never });
      await expect(runtime.authority.verifyGenerationAcceptance(internalRequest(), f.subject)).rejects.toThrow('AUTHORITY_UNAVAILABLE');
      await expect(runtime.resultOwner.read(f.retainedSource, { signal: new AbortController().signal })).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    }
    expect(f.state.events).toEqual([]); expect(f.clientState.factories).toBe(0);
  });

  test('base verification and currentness methods retain exact native owner arguments and outcomes', async () => {
    const f = setup(), http = internalRequest();
    const verifyGeneration = jest.spyOn(f.baseAuthority, 'verifyGeneration'), generationCurrent = jest.spyOn(f.baseAuthority, 'assertGenerationCurrent');
    const verify = jest.spyOn(f.baseAuthority, 'verify'), current = jest.spyOn(f.baseAuthority, 'assertCurrent');
    const runtime = createCanonicalReaderV2Runtime({ enabled: true, bindings: f.bindings });
    const grant = await runtime.authority.verifyGeneration(http, f.subject);
    expect(grant).toEqual(f.grant); expect(verifyGeneration).toHaveBeenCalledWith(http, f.subject);
    await f.prisma.withTenant(f.admission.canonical.tenantId, tx => runtime.authority.assertGenerationCurrent(tx, grant, f.subject));
    expect(generationCurrent).toHaveBeenCalledWith(f.tx, grant, f.subject);
    const subject = { purpose: 'retained-result-read' as const, applicationRequestId: id(80), requestSha256: null };
    await expect(runtime.authority.verify(http, subject)).rejects.toThrow('SYNTHETIC_UNALLOCATED_APPLICATION_AUTHORITY');
    await expect(runtime.authority.assertCurrent(f.tx, {} as never, subject)).rejects.toThrow('SYNTHETIC_UNALLOCATED_APPLICATION_AUTHORITY');
    expect(verify).toHaveBeenCalledWith(http, subject); expect(current).toHaveBeenCalledWith(f.tx, {}, subject);
    expect(f.clientState.factories).toBe(0); expect(f.clientState.http).toBe(0);
  });

  test('base class methods keep their original instance and are never replaced by the acceptance observer', async () => {
    const f = setup();
    class NativeBase extends ObjectiveCanonicalWorkloadAuthority {
      constructor(private readonly owner: typeof f.baseAuthority) { super(); }
      override verifyGeneration(...args: Parameters<typeof f.baseAuthority.verifyGeneration>) { return this.owner.verifyGeneration(...args); }
      override assertGenerationCurrent(...args: Parameters<typeof f.baseAuthority.assertGenerationCurrent>) { return this.owner.assertGenerationCurrent(...args); }
    }
    const runtime = createCanonicalReaderV2Runtime({ enabled: true, bindings: { ...f.bindings, authority: new NativeBase(f.baseAuthority) } });
    expect((await runtime.authority.verifyGenerationAcceptance(internalRequest(), f.subject)).sourceAdmission).toEqual(f.admission);
    expect(f.state.verifies).toBe(2); expect(f.state.generationChecks).toBe(4);
  });

  test.each(['plain', 'proxy', 'already-aborted'] as const)('%s request is denied before native authentication or transport', async kind => {
    const f = setup(); let http: Request;
    if (kind === 'plain') http = {} as Request;
    else if (kind === 'proxy') http = new Proxy(internalRequest(), {});
    else { http = internalRequest(); http.aborted = true; }
    await expect(f.accept(http)).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    expect(f.state.events).toEqual([]); expect(f.clientState.http).toBe(0);
  });

  test.each(['aborted', 'close'] as const)('internal %s during HTTP denies the pending read and removes only owned listeners', async event => {
    const f = setup(), entered = deferred(), release = deferred(), http = internalRequest();
    const existingAbort = jest.fn(), existingClose = jest.fn(); http.on('aborted', existingAbort); http.on('close', existingClose);
    f.clientState.beforeHttp = async () => { entered.resolve(); await release.promise; };
    const pending = f.accept(http), rejected = expect(pending).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    await entered.promise; http.emit(event); await rejected; release.resolve();
    expect(f.clientState.signals[0]!.aborted).toBe(true); expect(f.state.verifies).toBe(1);
    expect(http.listenerCount('aborted')).toBe(1); expect(http.listenerCount('close')).toBe(1);
    expect(http.listeners('aborted')).toEqual([existingAbort]); expect(http.listeners('close')).toEqual([existingClose]);
    expect(event === 'aborted' ? existingAbort : existingClose).toHaveBeenCalledTimes(1);
    http.removeListener('aborted', existingAbort); http.removeListener('close', existingClose);
  });

  test('normal complete internal close does not cancel the read; success cleans listeners', async () => {
    const f = setup(), entered = deferred(), release = deferred(), http = internalRequest(true);
    f.clientState.beforeHttp = async () => { entered.resolve(); await release.promise; };
    const pending = f.accept(http); await entered.promise; http.emit('close');
    expect(f.clientState.signals[0]!.aborted).toBe(false); release.resolve();
    expect((await pending).sourceBinding).toEqual(f.binding); expect(f.state.verifies).toBe(2);
    expect(http.listenerCount('aborted')).toBe(0); expect(http.listenerCount('close')).toBe(0);
  });

  test.each(['close', 'destroy'] as const)('completed request whose actual socket emits %s still cancels observation and cleans listeners', async event => {
    const f = setup(), entered = deferred(), release = deferred(), http = internalRequest(true);
    const existingClose = jest.fn(); http.socket.on('close', existingClose);
    f.clientState.beforeHttp = async () => { entered.resolve(); await release.promise; };
    const pending = f.accept(http), rejected = expect(pending).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    await entered.promise;
    if (event === 'destroy') http.socket.destroy(); else http.socket.emit('close');
    await rejected; release.resolve();
    expect(f.clientState.signals[0]!.aborted).toBe(true); expect(f.state.verifies).toBe(1);
    expect(http.listenerCount('aborted')).toBe(0); expect(http.listenerCount('close')).toBe(0);
    expect(http.socket.listeners('close')).toEqual([existingClose]); expect(existingClose).toHaveBeenCalledTimes(1);
    http.socket.removeListener('close', existingClose);
  });

  test('an initially destroyed native socket denies before native authentication', async () => {
    const f = setup(), http = internalRequest(true); http.socket.destroy();
    await expect(f.accept(http)).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    expect(f.state.events).toEqual([]); expect(f.clientState.http).toBe(0);
    expect(http.listenerCount('aborted')).toBe(0); expect(http.listenerCount('close')).toBe(0);
  });

  test('premature internal close during native transaction denies and cleans listeners without transport', async () => {
    const f = setup(), http = internalRequest();
    f.state.beforeGenerationCheck = () => http.emit('close');
    await expect(f.accept(http)).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    expect(f.clientState.http).toBe(0); expect(f.state.events).toContain('tx-rollback');
    expect(http.listenerCount('aborted')).toBe(0); expect(http.listenerCount('close')).toBe(0);
  });

  test('final committed native read still cannot release a proof after an internal abort', async () => {
    const f = setup(), http = internalRequest();
    f.state.afterCommit = () => { if (f.state.transactions === 2) http.emit('aborted'); };
    await expect(f.accept(http)).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    expect(f.state.events.filter(value => value === 'tx-commit')).toHaveLength(2);
    expect(http.listenerCount('aborted')).toBe(0); expect(http.listenerCount('close')).toBe(0);
  });

  test('acceptance rechecks current native authority after the Meri response', async () => {
    const f = setup(), http = internalRequest(); f.clientState.afterHttp = () => { f.state.allowed = false; };
    await expect(f.accept(http)).rejects.toThrow('AUTHORITY_UNAVAILABLE'); expect(f.clientState.http).toBe(1);
    expect(f.state.verifies).toBe(2); expect(http.listenerCount('aborted')).toBe(0); expect(http.listenerCount('close')).toBe(0);
  });

  test.each(['principal', 'acl', 'source', 'credential'] as const)('retained receipt cannot survive late %s revocation or drift', async kind => {
    const f = setup(); f.state.acceptancePresent = true;
    f.clientState.afterHttp = () => {
      if (kind === 'principal') f.state.retainedAllowed = false;
      if (kind === 'acl') f.state.acl = false;
      if (kind === 'source') f.snapshot.minimumWin = 'Changed after immutable result response';
      if (kind === 'credential') f.clientState.allowed = false;
    };
    await expect(f.retained()).rejects.toThrow('AUTHORITY_UNAVAILABLE'); expect(f.clientState.http).toBe(1);
    expect(f.state.activeTransactions).toBe(0);
  });

  test('result owner rejects a caller binding mismatch before credentials or transport despite a valid retained selector', async () => {
    const f = setup(); f.state.acceptancePresent = true;
    await expect(f.runtime.resultOwner.read({ ...f.retainedSource, binding: { ...f.binding, writerFence: 2 } },
      { signal: new AbortController().signal })).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    expect(f.state.authorizes).toBe(1); expect(f.clientState.credentials).toBe(0); expect(f.clientState.http).toBe(0);
  });

  test('real PlannerModule metadata supplies one shared zero-argument default-off runtime to both owner providers', async () => {
    // Unrelated providers are inert source stubs; do not bootstrap Meri,
    // schedulers, Prisma, application auth, listeners or ordinary chat here.
    const stubs: [string, string][] = [
      ['../planner/planner.controller.js', 'PlannerController'], ['../planner/planner.service.js', 'PlannerService'],
      ['../planner/planner-links.service.js', 'PlannerLinksService'], ['../planner/planner-attachments.service.js', 'PlannerAttachmentsService'],
      ['../planner/planner-attachments.controller.js', 'PlannerAttachmentsController'], ['../planner/planner-context.guard.js', 'PlannerContextGuard'],
      ['../planner/planner-public.controller.js', 'PlannerPublicController'], ['../planner/planner-scheduler.service.js', 'PlannerSchedulerService'],
      ['../planner/planner-form-files.service.js', 'PlannerFormFilesService'], ['../planner/planner-public-form.guard.js', 'PlannerPublicFormGuard'],
      ['../planner/planner-capacity.controller.js', 'PlannerCapacityController'], ['../planner/planner-capacity.service.js', 'PlannerCapacityService'],
      ['../planner/objective-canonical-application.controller.js', 'ObjectiveCanonicalApplicationController'],
      ['../planner/objective-canonical-application.service.js', 'ObjectiveCanonicalApplicationService'],
      ['./objective-canonical-producer.controller.js', 'ObjectiveCanonicalProducerController'], ['./objective-canonical-producer.service.js', 'ObjectiveCanonicalProducerService'],
      ['./objective-canonical-request.controller.js', 'ObjectiveCanonicalRequestController'], ['./objective-canonical-request.service.js', 'ObjectiveCanonicalRequestService'],
      ['./objective-canonical-owner-directory.js', 'ObjectiveCanonicalOwnerDirectory'], ['./strategy-context-plane.client.js', 'StrategyContextPlaneClient'],
      ['./meri.module.js', 'MeriModule'], ['./objective-canonical-completion.controller.js', 'ObjectiveCanonicalCompletionController'],
      ['./objective-canonical-completion.service.js', 'ObjectiveCanonicalCompletionService'], ['./objective-canonical-terminal.controller.js', 'ObjectiveCanonicalTerminalController'],
      ['./objective-canonical-terminal.service.js', 'ObjectiveCanonicalTerminalService'],
      ['../planner/objective-planner-continuation.runtime.js', 'ObjectivePlannerContinuationRuntime'],
      ['../planner/objective-planner-continuation.worker.js', 'ObjectivePlannerContinuationWorker'],
    ];
    for (const [path, name] of stubs) jest.doMock(path, () => ({ [name]: class InertSourceOnlyProvider {} }));
    const { PlannerModule } = require('../planner/planner.module.js') as { PlannerModule: Function };
    type Provider = { provide: unknown; inject?: unknown[]; useFactory: (...args: any[]) => any };
    const providers = Reflect.getMetadata('providers', PlannerModule) as (Provider | Function)[];
    const provider = (token: unknown) => providers.find((value): value is Provider => typeof value === 'object' && value.provide === token)!;
    const root = provider(OBJECTIVE_CANONICAL_READER_V2_RUNTIME);
    expect(root).toBeDefined(); expect(root.inject).toBeUndefined(); expect(root.useFactory.length).toBe(0);
    const runtime = root.useFactory() as CanonicalReaderV2Runtime;
    const acceptance = provider(ObjectiveCanonicalWorkloadAuthority), result = provider(ObjectiveCanonicalResultOwner);
    expect(acceptance.inject).toEqual([OBJECTIVE_CANONICAL_READER_V2_RUNTIME]); expect(result.inject).toEqual(acceptance.inject);
    expect(acceptance.useFactory(runtime)).toBe(runtime.authority); expect(result.useFactory(runtime)).toBe(runtime.resultOwner);
    expect(runtime.authority).toBeInstanceOf(ObjectiveCanonicalWorkloadAuthority); expect(runtime.resultOwner).toBeInstanceOf(ObjectiveCanonicalResultOwner);
    const f = nativeReaderV2Fixture();
    await expect(runtime.authority.verifyGenerationAcceptance(internalRequest(), f.subject)).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    await expect(runtime.resultOwner.read({ generationJobId: f.admission.generationJobId, binding: f.binding,
      sourceAdmissionSha256: f.acceptance.sourceAdmissionSha256 }, { signal: new AbortController().signal })).rejects.toThrow('AUTHORITY_UNAVAILABLE');
    expect(f.state.events).toEqual([]);
  });
});
