import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { createContext, Script } from 'node:vm';
import ts from 'typescript';

class Refusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function fixture() {
  const metadata: Array<{ kind: string; args: unknown[]; method?: string }> = [];
  const decorator = (kind: string) => (...args: unknown[]) => (_target: unknown, method?: string) => {
    metadata.push({ kind, args, method });
  };
  const nest = {
    Module: decorator('module'), Controller: decorator('controller'), Post: decorator('post'),
    Header: decorator('header'), HttpCode: decorator('status'), Inject: decorator('inject'),
    Req: decorator('req'), Res: decorator('res'), Body: decorator('body'),
    BadRequestException: class extends Refusal { constructor(message: string) { super(400, message); } },
    RequestTimeoutException: class extends Refusal { constructor(message: string) { super(408, message); } },
    ServiceUnavailableException: class extends Refusal { constructor(message: string) { super(503, message); } },
  };
  const vm = createContext({ Date, Promise, setTimeout, clearTimeout });
  const source = (name: string) => readFileSync(resolve(__dirname, name), 'utf8');
  function load(name: string, ports: Record<string, unknown>) {
    const module = { exports: {} as any };
    const output = ts.transpileModule(source(name), { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS, experimentalDecorators: true, esModuleInterop: true }, reportDiagnostics: true });
    expect(output.diagnostics?.filter(row => row.category === ts.DiagnosticCategory.Error)).toEqual([]);
    const execute = new Script(`(function(require,module,exports){${output.outputText}\n})`).runInContext(vm);
    execute((id: string) => {
      if (Object.hasOwn(ports, id)) return ports[id];
      throw new Error(`Unexpected runtime import: ${id}`);
    }, module, module.exports);
    return module.exports;
  }
  const request = load('retained-florida-request.ts', { '@nestjs/common': nest });
  const ports = Symbol('ports');
  class SourceToken { constructor(readonly facts: unknown, readonly evidence: unknown, readonly ports: unknown) {} }
  class EvidenceToken {}
  class FactsToken { constructor(readonly evidence: unknown) {} }
  const service = { RetainedFloridaReadService: SourceToken, RETAINED_FLORIDA_PORTS: ports };
  const Controller = load('retained-florida-read.controller.ts', {
    '@nestjs/common': nest, './retained-florida-read.service.js': service,
    './retained-florida-request.js': request,
  }).RetainedFloridaReadController;
  const Module = load('retained-florida-read.module.ts', {
    '@nestjs/common': nest, './evidence.service.js': { Phase8EvidenceService: EvidenceToken },
    './florida-current-authority.service.js': { FloridaCurrentAuthorityService: FactsToken },
    './retained-florida-read.controller.js': { RetainedFloridaReadController: Controller },
    './retained-florida-read.service.js': service,
  }).RetainedFloridaReadModule;
  const req: any = Object.assign(new EventEmitter(), { headers: { authorization: 'signed-header' } as Record<string, unknown>, aborted: false });
  const res: any = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false,
    headers: {} as Record<string, string>, setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; } });
  return { request: request.retainedFloridaRequest, Controller, Module, metadata, ports, SourceToken, EvidenceToken, FactsToken, req, res, source };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clean(f: ReturnType<typeof fixture>) {
  expect(f.req.listenerCount('aborted')).toBe(0);
  expect(f.res.listenerCount('close')).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
}

describe('actual unmounted signed-only Intel controller and response lifetime source', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1_700_000_000_000); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('pins two POST200/no-store routes under the actual Intel prefix without native/service guards', () => {
    const f = fixture();
    expect(f.metadata.find(row => row.kind === 'controller')?.args).toEqual(['internal/legiwatch']);
    expect(f.metadata.filter(row => row.kind === 'post').map(row => [row.method, row.args[0]])).toEqual([
      ['authority', 'retained-florida-authority'], ['budget', 'retained-florida-budget'],
    ]);
    for (const method of ['authority', 'budget']) {
      expect(f.metadata.find(row => row.kind === 'status' && row.method === method)?.args).toEqual([200]);
      expect(f.metadata.filter(row => row.kind === 'header' && row.method === method).map(row => row.args))
        .toContainEqual(['Cache-Control', 'no-store']);
    }
    const text = f.source('retained-florida-read.controller.ts');
    for (const forbidden of ['UseGuards', 'TenantGuard', 'serviceSecret', 'Bearer ', 'tenantContext']) expect(text).not.toContain(forbidden);
    expect(readFileSync(resolve(__dirname, '../../main.ts'), 'utf8')).toContain("app.setGlobalPrefix('intel-api'");
    for (const file of ['../../app.module.ts', '../tracker.module.ts']) {
      expect(readFileSync(resolve(__dirname, file), 'utf8')).not.toContain('RetainedFloridaReadModule');
    }
  });

  it('forwards only the authorization header to the correct fixed service method and cleans up', async () => {
    const f = fixture();
    const source = { authority: jest.fn(async () => ({ kind: 'probe' })), budget: jest.fn(async () => ({ kind: 'data' })) };
    const owner = new f.Controller(source);
    const body = { authorization: 'body-is-not-authentication', secret: 'body-is-not-authentication' };
    expect(await owner.authority(f.req, f.res, body)).toEqual({ kind: 'probe' });
    expect(source.authority).toHaveBeenCalledWith('signed-header', body, expect.objectContaining({ deadlineMs: Date.now() + 30_000 }));
    expect(source.budget).not.toHaveBeenCalled();
    clean(f);
    expect(await owner.budget(f.req, f.res, body)).toEqual({ kind: 'data' });
    expect(source.budget).toHaveBeenCalledWith('signed-header', body, expect.any(Object));
    expect(source.authority).toHaveBeenCalledTimes(1);
    expect(f.res.headers['cache-control']).toBe('no-store');
    clean(f);
  });

  it('propagates a probe-purpose denial without falling through to data or native authentication', async () => {
    const f = fixture();
    const source = { authority: jest.fn(async () => { throw new Refusal(401, 'wrong purpose'); }), budget: jest.fn() };
    f.req.headers.authorization = 'Bearer cannot-be-native-fallback';
    await expect(new f.Controller(source).authority(f.req, f.res, {})).rejects.toMatchObject({ status: 401 });
    expect(source.authority).toHaveBeenCalledWith(f.req.headers.authorization, {}, expect.any(Object));
    expect(source.budget).not.toHaveBeenCalled();
    expect(f.res.headers['cache-control']).toBe('no-store');
    clean(f);
  });

  it('keeps malformed deadline400 and missing-source503 denials no-store with no leaked latch', async () => {
    const f = fixture();
    f.req.headers['x-meri-deadline-at'] = ['duplicate'];
    await expect(new f.Controller(null).budget(f.req, f.res, {})).rejects.toMatchObject({ status: 400 });
    expect(f.res.headers['cache-control']).toBe('no-store'); clean(f);
    delete f.req.headers['x-meri-deadline-at'];
    await expect(new f.Controller(null).budget(f.req, f.res, {})).rejects.toMatchObject({ status: 503 });
    expect(f.res.headers['cache-control']).toBe('no-store'); clean(f);
  });

  it('defaults ports to null and requires a genuine evidence provider without importing Tracker', () => {
    const f = fixture();
    const definition: any = f.metadata.find(row => row.kind === 'module')?.args[0];
    expect(definition.imports ?? []).toEqual([]);
    expect(definition.providers.find((provider: any) => provider.provide === f.ports).useValue).toBeNull();
    const provider = definition.providers.find((value: any) => value.provide === f.SourceToken);
    expect(provider.inject).toEqual([{ token: f.EvidenceToken, optional: true }, f.ports]);
    const evidence = new f.EvidenceToken();
    expect(provider.useFactory(undefined, {})).toBeNull();
    expect(provider.useFactory({ budget() {} }, {})).toBeNull();
    expect(provider.useFactory(evidence, null)).toBeNull();
    const bound = provider.useFactory(evidence, {});
    expect(bound).toBeInstanceOf(f.SourceToken);
    expect(bound.evidence).toBe(evidence);
    expect(bound.facts).toBeInstanceOf(f.FactsToken);
    expect(bound.facts.evidence).toBe(evidence);
    expect(f.Module.register().providers).toEqual([{ provide: f.ports, useValue: null }]);
    expect(f.source('retained-florida-read.module.ts')).not.toContain("from '../tracker.module");
  });

  it('caps all lifetimes at30s and accepts only a shorter absolute caller deadline', () => {
    const f = fixture();
    f.req.headers['x-meri-deadline-at'] = String(Date.now() + 90_000);
    let control = f.request(f.req, f.res); expect(control.deadlineMs).toBe(Date.now() + 30_000); control.close();
    f.req.headers['x-meri-deadline-at'] = String(Date.now() + 17);
    control = f.request(f.req, f.res); expect(control.deadlineMs).toBe(Date.now() + 17); control.close(); clean(f);
  });

  it.each(['', ' 123', '+123', '-123', '1.5', '1e3', 'NaN', '123,456', '9007199254740993', ['123'], null, {}])
  ('rejects malformed deadline syntax before adding listeners: %j', supplied => {
    const f = fixture(); f.req.headers['x-meri-deadline-at'] = supplied;
    let failure: unknown;
    try { f.request(f.req, f.res); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: 400 }); clean(f);
  });

  it.each(['aborted', 'destroyed', 'finished', 'expired'])('refuses inactive %s before any operation', async kind => {
    const f = fixture();
    if (kind === 'aborted') f.req.aborted = true;
    if (kind === 'destroyed') f.res.destroyed = true;
    if (kind === 'finished') f.res.writableFinished = true;
    if (kind === 'expired') f.req.headers['x-meri-deadline-at'] = String(Date.now());
    const control = f.request(f.req, f.res); const operation = jest.fn();
    await expect(control.run(operation)).rejects.toMatchObject({ status: 408 });
    expect(operation).not.toHaveBeenCalled(); control.close(); clean(f);
  });

  it.each(['aborted', 'close'])('latches %s during pending I/O and consumes later settlement', async event => {
    const f = fixture(); const control = f.request(f.req, f.res); const io = deferred<string>();
    const pending = control.run(() => io.promise);
    const refusal = expect(pending).rejects.toMatchObject({ status: 408 });
    await Promise.resolve();
    if (event === 'aborted') { f.req.aborted = true; f.req.emit('aborted'); } else f.res.emit('close');
    await refusal; control.close();
    io.reject(new Error('late I/O rejection is consumed by the race'));
    await Promise.resolve(); clean(f);
  });

  it('returns deadline408 through the controller and removes only its own listeners/timer', async () => {
    const f = fixture(); const io = deferred<unknown>();
    f.req.headers['x-meri-deadline-at'] = String(Date.now() + 20);
    const unrelated = () => {};
    f.req.on('aborted', unrelated);
    const source = { authority: jest.fn(() => io.promise), budget: jest.fn() };
    const refusal = expect(new f.Controller(source).authority(f.req, f.res, {})).rejects.toMatchObject({ status: 408 });
    await jest.advanceTimersByTimeAsync(20); await refusal;
    expect(f.res.headers['cache-control']).toBe('no-store');
    expect(f.req.listeners('aborted')).toEqual([unrelated]);
    f.req.removeListener('aborted', unrelated);
    io.resolve({ tooLate: true }); await Promise.resolve(); clean(f);
  });

  it.each(['destroyed', 'clock'])('refuses a late result when %s changed before a delayed timer fires', async kind => {
    const f = fixture(); const control = f.request(f.req, f.res); const io = deferred<string>();
    const refusal = expect(control.run(() => io.promise)).rejects.toMatchObject({ status: 408 });
    await Promise.resolve();
    if (kind === 'destroyed') f.res.destroyed = true; else jest.setSystemTime(Date.now() + 30_001);
    io.resolve('too late'); await refusal; control.close(); clean(f);
  });
});
