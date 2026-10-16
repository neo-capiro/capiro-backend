import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as crypto from 'node:crypto';
import * as util from 'node:util';
import { createContext, Script } from 'node:vm';
import ts from 'typescript';

/** Composition qualification only: actual service and shared parsers; synthetic
 * signed-codec, current HTTP, facts and canonical budget owner ports. These mocks
 * do not qualify cryptography, JCS, producer facts, transport or physical DB cancel. */
class Refusal extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
interface Control { deadlineMs: number; assertActive(): void }
interface Principal { tenantId: string; actorId: string; clerkUserId: string }
interface Scope { jurisdiction: 'FL'; sessionKey: string; folderId: string | null; clientId: string | null }
interface Facts { resourceRevision: string; effectiveScope: Scope; clientResolution: { selector: string; clientId: string } | null }
interface Receipt { principal: Principal; identityRevision: string; resourceRevision: string; originalExpiresAtMs: number }
interface Envelope extends Receipt { operation: string; recipientPath: string }
interface Owner {
  authority(header: unknown, body: unknown, control: Control): Promise<Record<string, unknown>>;
  budget(header: unknown, body: unknown, control: Control): Promise<unknown>;
}
type Method = 'authority' | 'budget';
const PROBE_HEADER = 'synthetic-probe-purpose';
const DATA_HEADER = 'synthetic-data-purpose';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_CLIENT_ID = '44444444-4444-4444-8444-444444444444';
const NOW = 1_700_000_000_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture(configured = true) {
  const clock = { nowMs: NOW };
  // Date and all plain JSON objects are created inside the SAME source VM realm.
  // Do not inject host Object/Array/JSON: the actual closed parsers check prototypes.
  const vm = createContext({ clock, Buffer });
  new Script(`
    const NativeDate = Date;
    Date = class FakeDate extends NativeDate {
      constructor(value) { super(arguments.length ? value : clock.nowMs); }
      static now() { return clock.nowMs; }
    };
  `).runInContext(vm);
  const json = new Script('(text) => JSON.parse(text)').runInContext(vm) as (text: string) => unknown;
  const copy = <T>(value: T): T => json(JSON.stringify(value)) as T;
  // Deliberate test serializer, NOT a substitute qualification of trusted RFC8785.
  const canonicalize = new Script('(value) => JSON.stringify(value)').runInContext(vm) as (value: unknown) => string;
  function load(file: string, ports: Record<string, unknown>): Record<string, unknown> {
    const module = { exports: {} };
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true, esModuleInterop: true }, reportDiagnostics: true,
    });
    expect(compiled.diagnostics?.filter(row => row.category === ts.DiagnosticCategory.Error)).toEqual([]);
    const execute = new Script(`(function(require,module,exports){${compiled.outputText}\n})`, { filename: file }).runInContext(vm);
    execute((id: string) => {
      if (Object.hasOwn(ports, id)) return ports[id];
      throw new Error(`Unexpected runtime import: ${id}`);
    }, module, module.exports);
    return module.exports;
  }
  const shared = resolve(__dirname, '../../../../../packages/shared/src');
  const probe = load(resolve(shared, 'core-retained-authority-probe.ts'), {
    'node:crypto': crypto, 'node:util': util,
  });
  const request = load(resolve(shared, 'core-retained-read-request.ts'), {
    'node:crypto': crypto, 'node:util': util, './core-retained-authority-probe.js': probe,
  });
  const nest = {
    HttpException: Refusal,
    Injectable: () => () => undefined,
    Inject: () => () => undefined,
    ConflictException: class extends Refusal { constructor(message: string) { super(message, 409); } },
    RequestTimeoutException: class extends Refusal { constructor(message: string) { super(message, 408); } },
    ServiceUnavailableException: class extends Refusal { constructor(message: string) { super(message, 503); } },
    UnauthorizedException: class extends Refusal { constructor(message: string) { super(message, 401); } },
  };
  const Service = load(resolve(__dirname, 'retained-florida-read.service.ts'), {
    '@nestjs/common': nest,
    '@capiro/shared/core-retained-authority-probe': probe,
    '@capiro/shared/core-retained-read-request': request,
    './evidence.service.js': { Phase8EvidenceService: class {} },
    './florida-current-authority.service.js': { FloridaCurrentAuthorityService: class {} },
  }).RetainedFloridaReadService as new (facts: unknown, evidence: unknown, ports: unknown) => Owner;
  const principal: Principal = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    actorId: '22222222-2222-4222-8222-222222222222', clerkUserId: 'clerk-original',
  };
  const envelope: Envelope = {
    principal, identityRevision: 'a'.repeat(64), resourceRevision: 'b'.repeat(64),
    originalExpiresAtMs: NOW + 5_000, operation: 'get_florida_budget_project',
    recipientPath: '/intel-api/internal/legiwatch/retained-florida-budget',
  };
  const current = (): Receipt => copy({ principal: envelope.principal, identityRevision: envelope.identityRevision,
    resourceRevision: envelope.resourceRevision, originalExpiresAtMs: envelope.originalExpiresAtMs });
  const currentFacts = (): Facts => copy({ resourceRevision: envelope.resourceRevision,
    effectiveScope: { jurisdiction: 'FL', sessionKey: '2026', folderId: null, clientId: CLIENT_ID },
    clientResolution: { selector: 'client-choice', clientId: CLIENT_ID } });
  const selector = { schemaVersion: 1, sessionKey: '2026', folderId: null, clientSelector: 'client-choice' };
  const dataBody = copy({ schemaVersion: 1,
    request: { q: 'water', fiscalYear: '2026-27', projectId: '', sessionKey: '2026', clientId: 'client-choice', offset: '0' },
    context: { asOf: new Date(NOW).toISOString(), effectiveScope: currentFacts().effectiveScope,
      clientResolution: currentFacts().clientResolution } });
  const probeBody = copy({ schemaVersion: 1, selector });
  const events: string[] = [];
  const probeVerifier = jest.fn((header: unknown, _bounds: unknown) => {
    events.push('codec:probe');
    if (header !== PROBE_HEADER) throw new Refusal('wrong synthetic codec purpose', 401);
    // A probe has no data digest vector. Do not add one to make composition pass.
    return { principal: envelope.principal, identityRevision: envelope.identityRevision,
      originalExpiresAtMs: envelope.originalExpiresAtMs };
  });
  const dataVerifier = jest.fn((header: unknown, _bounds: unknown) => {
    events.push('codec:data');
    if (header !== DATA_HEADER) throw new Refusal('wrong synthetic codec purpose', 401);
    return envelope;
  });
  const probeCurrent = jest.fn(async (_header: unknown, _selector: unknown, _control: Control): Promise<Receipt> => {
    events.push('core:probe'); return current();
  });
  const dataCurrent = jest.fn(async (_header: unknown, _request: unknown, _context: unknown, _control: Control): Promise<Receipt> => {
    events.push('core:data'); return current();
  });
  const facts = jest.fn(async (_principal: unknown, _selector: unknown, _control: Control): Promise<Facts> => {
    events.push('facts'); return currentFacts();
  });
  // Shape is the canonical owner's budget DTO; this synthetic port does no SQL.
  const dto = Object.freeze({ scope: currentFacts().effectiveScope, fiscalYear: '2026-27', projects: [], nextOffset: null,
    documents: [], amounts: [], events: [], notice: 'Synthetic canonical budget DTO' });
  const budget = jest.fn(async (_context: unknown, _args: unknown): Promise<unknown> => { events.push('budget'); return dto; });
  const ports = { canonicalize, probeVerifier: { verifyCryptographically: probeVerifier },
    dataVerifier: { verifyCryptographically: dataVerifier },
    current: { verifyProbeCurrent: probeCurrent, verifyFloridaDataCurrent: dataCurrent } };
  const control: Control = { deadlineMs: NOW + 30_000, assertActive() {
    if (clock.nowMs >= control.deadlineMs) throw new Refusal('caller deadline', 408);
  } };
  const owner = new Service({ read: facts }, { budget }, configured ? ports : null);
  const invoke = (method: Method, header = method === 'authority' ? PROBE_HEADER : DATA_HEADER) =>
    owner[method](header, method === 'authority' ? probeBody : dataBody, control);
  return { clock, copy, canonicalize, owner, control, envelope, current, currentFacts, probeBody, dataBody, selector,
    probeVerifier, dataVerifier, probeCurrent, dataCurrent, facts, budget, dto, events, invoke };
}

describe('actual retained Florida service composition with synthetic owner ports', () => {
  it.each<Method>(['authority', 'budget'])('%s rejects null ports503 before codec or owner I/O', async method => {
    const f = fixture(false);
    await expect(f.invoke(method)).rejects.toMatchObject({ status: 503 });
    expect(f.events).toEqual([]);
  });

  it.each<Method>(['authority', 'budget'])('%s uses its actual closed parser before codec or owner I/O', async method => {
    const f = fixture();
    await expect(f.owner[method](method === 'authority' ? PROBE_HEADER : DATA_HEADER,
      f.copy({ schemaVersion: 1, unexpected: true }), f.control)).rejects.toMatchObject({ status: method === 'authority' ? 401 : 400 });
    expect(f.events).toEqual([]);
  });

  it.each<Method>(['authority', 'budget'])('%s preserves a wrong-purpose codec denial without another verifier or owner', async method => {
    const f = fixture();
    await expect(f.invoke(method, method === 'authority' ? DATA_HEADER : PROBE_HEADER)).rejects.toMatchObject({ status: 401 });
    expect(f.events).toEqual([method === 'authority' ? 'codec:probe' : 'codec:data']);
    expect(method === 'authority' ? f.dataVerifier : f.probeVerifier).not.toHaveBeenCalled();
    expect(f.budget).not.toHaveBeenCalled();
  });

  it.each(['operation', 'recipientPath'] as const)('rejects wrong data %s before any current facts or budget I/O', async field => {
    const f = fixture();
    f.envelope[field] = field === 'operation' ? 'get_research_portfolio' : '/intel-api/internal/legiwatch/retained-florida-authority';
    await expect(f.invoke('budget')).rejects.toMatchObject({ status: 401 });
    expect(f.events).toEqual(['codec:data']);
  });

  it('reads probe current authority around local facts without a data verifier, digest vector or budget call', async () => {
    const f = fixture();
    f.probeCurrent.mockImplementationOnce(async () => {
      f.events.push('core:probe'); return { ...f.current(), originalExpiresAtMs: NOW + 4_000 };
    }).mockImplementationOnce(async () => {
      f.events.push('core:probe'); return { ...f.current(), originalExpiresAtMs: NOW + 3_000 };
    });
    const result = await f.invoke('authority');
    expect(f.events).toEqual(['codec:probe', 'core:probe', 'facts', 'core:probe']);
    expect(f.probeVerifier).toHaveBeenCalledWith(PROBE_HEADER, {
      nowMs: NOW, deadlineMs: NOW + 30_000, selector: f.selector,
    });
    expect(f.probeVerifier.mock.calls[0][1]).not.toHaveProperty('expectedDigests');
    expect(result).toEqual({ schemaVersion: 1, principal: f.envelope.principal, identityRevision: f.envelope.identityRevision,
      ...f.currentFacts(), checkedAtMs: NOW, originalExpiresAtMs: NOW + 3_000 });
    expect(f.dataVerifier).not.toHaveBeenCalled();
    expect(f.dataCurrent).not.toHaveBeenCalled();
    expect(f.budget).not.toHaveBeenCalled();
    for (const call of f.probeCurrent.mock.calls) expect(call[2].deadlineMs).toBe(NOW + 5_000);
    expect(f.facts.mock.calls[0][2].deadlineMs).toBe(NOW + 5_000);
  });

  it('passes actual parsed three-digest bounds and normalized arguments to the canonical owner and releases its exact DTO last', async () => {
    const f = fixture();
    const result = await f.invoke('budget');
    expect(result).toBe(f.dto);
    expect(f.events).toEqual(['codec:data', 'core:data', 'facts', 'budget', 'facts', 'core:data']);
    const bounds = f.dataVerifier.mock.calls[0][1] as { nowMs: number; deadlineMs: number; expectedDigests: Record<string, string> };
    expect(bounds.nowMs).toBe(NOW); expect(bounds.deadlineMs).toBe(NOW + 30_000);
    expect(Object.keys(bounds.expectedDigests).sort()).toEqual(['normalizationContextSha256', 'normalizedArgsSha256', 'rawRequestSha256']);
    for (const digest of Object.values(bounds.expectedDigests)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(f.budget).toHaveBeenCalledWith({ tenantId: f.envelope.principal.tenantId,
      clerkUserId: f.envelope.principal.clerkUserId, role: null },
    { q: 'water', fiscalYear: '2026-27', projectId: '', offset: 0, sessionKey: '2026', folderId: null, clientId: CLIENT_ID });
    for (const call of f.dataCurrent.mock.calls) {
      expect(call.slice(0, 3)).toEqual([DATA_HEADER, f.dataBody.request, f.dataBody.context]);
      expect(call[3].deadlineMs).toBe(NOW + 5_000);
    }
    expect(f.probeVerifier).not.toHaveBeenCalled(); expect(f.probeCurrent).not.toHaveBeenCalled();
    expect(f.facts).toHaveBeenCalledTimes(2);
  });

  it.each(['principal', 'identityRevision', 'resourceRevision', 'extendedExpiry', 'expired'] as const)(
    'withholds budget for first Core %s mismatch before any local facts', async field => {
      const f = fixture(); const receipt = f.current();
      if (field === 'principal') receipt.principal.actorId = '55555555-5555-4555-8555-555555555555';
      if (field === 'identityRevision') receipt.identityRevision = 'c'.repeat(64);
      if (field === 'resourceRevision') receipt.resourceRevision = 'c'.repeat(64);
      if (field === 'extendedExpiry') receipt.originalExpiresAtMs++;
      if (field === 'expired') receipt.originalExpiresAtMs = NOW;
      f.dataCurrent.mockResolvedValueOnce(receipt);
      await expect(f.invoke('budget')).rejects.toMatchObject({ status: 409 });
      expect(f.events).toEqual(['codec:data']); // overridden mock intentionally has no recorder
      expect(f.dataCurrent).toHaveBeenCalledTimes(1); expect(f.facts).not.toHaveBeenCalled(); expect(f.budget).not.toHaveBeenCalled();
    });

  it.each(['principal', 'identityRevision'] as const)('withholds probe local facts for first Core %s mismatch', async field => {
    const f = fixture(); const receipt = f.current();
    if (field === 'principal') receipt.principal.tenantId = OTHER_CLIENT_ID;
    else receipt.identityRevision = 'c'.repeat(64);
    f.probeCurrent.mockResolvedValueOnce(receipt);
    await expect(f.invoke('authority')).rejects.toMatchObject({ status: 409 });
    expect(f.probeCurrent).toHaveBeenCalledTimes(1); expect(f.facts).not.toHaveBeenCalled(); expect(f.budget).not.toHaveBeenCalled();
  });

  it.each(['resourceRevision', 'effectiveScope', 'clientResolution'] as const)(
    'withholds budget for pre-read producer %s drift', async field => {
      const f = fixture(); const facts = f.currentFacts();
      if (field === 'resourceRevision') facts.resourceRevision = 'c'.repeat(64);
      if (field === 'effectiveScope') facts.effectiveScope.clientId = OTHER_CLIENT_ID;
      if (field === 'clientResolution') facts.clientResolution = { selector: 'different-selector', clientId: CLIENT_ID };
      f.facts.mockResolvedValueOnce(facts);
      await expect(f.invoke('budget')).rejects.toMatchObject({ status: 409 });
      expect(f.facts).toHaveBeenCalledTimes(1); expect(f.budget).not.toHaveBeenCalled(); expect(f.dataCurrent).toHaveBeenCalledTimes(1);
    });

  it.each(['resourceRevision', 'effectiveScope', 'clientResolution'] as const)(
    'withholds an already computed DTO for post-read producer %s drift before another Core call', async field => {
      const f = fixture(); const after = f.currentFacts();
      if (field === 'resourceRevision') after.resourceRevision = 'c'.repeat(64);
      if (field === 'effectiveScope') after.effectiveScope.sessionKey = '2027';
      if (field === 'clientResolution') after.clientResolution = null;
      f.facts.mockResolvedValueOnce(f.currentFacts()).mockResolvedValueOnce(after);
      await expect(f.invoke('budget')).rejects.toMatchObject({ status: 409 });
      expect(f.budget).toHaveBeenCalledTimes(1); expect(f.facts).toHaveBeenCalledTimes(2); expect(f.dataCurrent).toHaveBeenCalledTimes(1);
    });

  it.each(['principal', 'identityRevision', 'resourceRevision'] as const)(
    'withholds computed budget for final Core %s mismatch', async field => {
      const f = fixture(); const last = f.current();
      if (field === 'principal') last.principal.clerkUserId = 'different-clerk';
      if (field === 'identityRevision') last.identityRevision = 'c'.repeat(64);
      if (field === 'resourceRevision') last.resourceRevision = 'c'.repeat(64);
      f.dataCurrent.mockResolvedValueOnce(f.current()).mockResolvedValueOnce(last);
      await expect(f.invoke('budget')).rejects.toMatchObject({ status: 409 });
      expect(f.budget).toHaveBeenCalledTimes(1); expect(f.facts).toHaveBeenCalledTimes(2); expect(f.dataCurrent).toHaveBeenCalledTimes(2);
    });

  it('withholds computed budget on final current-authority revocation', async () => {
    const f = fixture();
    f.dataCurrent.mockResolvedValueOnce(f.current()).mockRejectedValueOnce(new Refusal('revoked', 403));
    await expect(f.invoke('budget')).rejects.toMatchObject({ status: 403 });
    expect(f.budget).toHaveBeenCalledTimes(1); expect(f.facts).toHaveBeenCalledTimes(2); expect(f.dataCurrent).toHaveBeenCalledTimes(2);
  });

  it.each<Method>(['authority', 'budget'])('%s rejects a signed cutoff already reached before online I/O', async method => {
    const f = fixture(); f.envelope.originalExpiresAtMs = NOW;
    await expect(f.invoke(method)).rejects.toMatchObject({ status: 408 });
    expect(f.events).toEqual([method === 'authority' ? 'codec:probe' : 'codec:data']);
  });

  it.each<Method>(['authority', 'budget'])('%s retains the earlier caller deadline in every online owner control', async method => {
    const f = fixture(); f.control.deadlineMs = NOW + 1_000;
    await f.invoke(method);
    const calls = method === 'authority' ? f.probeCurrent.mock.calls.map(call => call[2]) : f.dataCurrent.mock.calls.map(call => call[3]);
    for (const control of [...calls, ...f.facts.mock.calls.map(call => call[2])]) expect(control.deadlineMs).toBe(NOW + 1_000);
  });

  it.each<Method>(['authority', 'budget'])('%s cannot extend signed cutoff while the first Core await settles', async method => {
    const f = fixture(); const entered = deferred<void>(); const gate = deferred<Receipt>();
    const hold = async () => { entered.resolve(); return gate.promise; };
    if (method === 'authority') f.probeCurrent.mockImplementationOnce(hold);
    else f.dataCurrent.mockImplementationOnce(hold);
    const pending = f.invoke(method); const denied = expect(pending).rejects.toMatchObject({ status: 408 });
    await entered.promise;
    f.control.deadlineMs = NOW + 120_000; // caller extension cannot replace the signed bound
    f.clock.nowMs = f.envelope.originalExpiresAtMs; gate.resolve(f.current());
    await denied;
    expect(f.facts).not.toHaveBeenCalled(); expect(f.budget).not.toHaveBeenCalled();
    expect(method === 'authority' ? f.probeCurrent : f.dataCurrent).toHaveBeenCalledTimes(1);
  });

  it.each<Method>(['authority', 'budget'])('%s performs no next owner I/O after signed cutoff while local facts await settles', async method => {
    const f = fixture(); const entered = deferred<void>(); const gate = deferred<Facts>();
    f.facts.mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    const pending = f.invoke(method); const denied = expect(pending).rejects.toMatchObject({ status: 408 });
    await entered.promise; f.clock.nowMs = f.envelope.originalExpiresAtMs; gate.resolve(f.currentFacts());
    await denied;
    expect(f.facts).toHaveBeenCalledTimes(1); expect(f.budget).not.toHaveBeenCalled();
    expect(method === 'authority' ? f.probeCurrent : f.dataCurrent).toHaveBeenCalledTimes(1);
  });

  it('performs no post-budget facts/current I/O and releases no DTO after cutoff while canonical budget awaits', async () => {
    const f = fixture(); const entered = deferred<void>(); const gate = deferred<unknown>();
    f.budget.mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    const pending = f.invoke('budget'); const denied = expect(pending).rejects.toMatchObject({ status: 408 });
    await entered.promise; f.clock.nowMs = f.envelope.originalExpiresAtMs; gate.resolve(f.dto);
    await denied;
    expect(f.budget).toHaveBeenCalledTimes(1); expect(f.facts).toHaveBeenCalledTimes(1); expect(f.dataCurrent).toHaveBeenCalledTimes(1);
  });
});
