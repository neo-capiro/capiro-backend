import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { asCount, nextPageOf, rateOf, type RateReadProfile } from './tango-rest-page.js';
import { TangoDibbsClient, TangoDibbsHttpError, TangoDibbsEnvelopeError } from './tango-dibbs.client.js';
import { TangoSbirClient, TangoSbirHttpError, TangoSbirEnvelopeError } from './tango-sbir.client.js';
import { TangoSubawardClient, TangoSubawardHttpError } from './tango-subaward.client.js';
import { TangoNotConfiguredError } from './tango.errors.js';

const hashes = {
  dibbs: '905ba33964b001aa66c19c60df883c51976145887cd2b725e67c2e0ea0fd28c8',
  sbir: 'cf914eb4de8f76397d017d4f78932a8b6d5a75f0a76386f89339a7689eb9b766',
  subaward: '33a5629fb6b8ea83e4e5cf3cbf7b5b69e7b6cf27601392a081abfd32f68a39c1',
};
type Owner = keyof typeof hashes;
type Legacy = {
  asCount: typeof asCount;
  nextPageOf: typeof nextPageOf;
  rateOf: (headers: Headers) => ReturnType<typeof rateOf>;
};
const owners: Owner[] = ['dibbs', 'sbir', 'subaward'];
const profileFor = (owner: Owner): RateReadProfile => owner === 'subaward' ? 'captured' : 'interleaved';
function original(owner: Owner): Legacy {
  const file = path.resolve(__dirname, '../../../../../docs/cleanup-tango-page-leaf-conversion-20261012/evidence/originals', `tango-${owner}.client.ts.txt`);
  const text = readFileSync(file, 'utf8');
  expect(createHash('sha256').update(text).digest('hex')).toBe(hashes[owner]);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const nodes = source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && ['asCount', 'nextPageOf', 'rateOf'].includes(node.name?.text ?? ''));
  expect(nodes).toHaveLength(3);
  const code = ts.transpileModule(nodes.map((node) => 'export ' + node.getText(source)).join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  // Only pinned original pure declarations execute, in the same error realm.
  new Function('exports', 'URL', 'Number', 'Math', 'Error', code)(exports, URL, Number, Math, Error);
  return exports as Legacy;
}
function outcome(action: () => unknown): unknown {
  try { return { returned: action() }; }
  catch (error) { return { threw: { name: (error as Error).name, message: (error as Error).message } }; }
}

describe.each(owners)('Tango REST leaf differential against frozen %s', (owner) => {
  const legacy = original(owner);
  const profile = profileFor(owner);
  const countValues = [undefined, null, '', ' ', 0, -1, 1.9, '2.9', true, false, NaN, Infinity, -Infinity, 'NaN', '1e3', [], [2], {}, 2n, Symbol('count')];
  test.each(countValues.map((value, index) => ({ value, index })))('count coercion $index retains original result/throw', ({ value }) => {
    expect(outcome(() => asCount(value))).toEqual(outcome(() => legacy.asCount(value)));
  });
  test('inherited count, getter sampling, valueOf and thrown identity stay unchanged', () => {
    expect(asCount(Object.create({ count: '12.8' }).count)).toBe(legacy.asCount(Object.create({ count: '12.8' }).count));
    let reads = 0;
    const input = { get count() { reads++; return '7.9'; } };
    expect(asCount(input.count)).toBe(7); expect(reads).toBe(1);
    expect(asCount(Object.create({ valueOf: () => 4.9 }))).toBe(legacy.asCount(Object.create({ valueOf: () => 4.9 })));
    const marker = new Error('synthetic conversion');
    const throws = { valueOf() { throw marker; } };
    for (const convert of [asCount, legacy.asCount]) {
      try { convert(throws); throw new Error('expected original coercion throw'); }
      catch (error) { expect(error).toBe(marker); }
    }
  });
  const nextValues = [undefined, null, '', ' ', 0, {}, new String('?page=2'), '?page=2', '/api/x/?page=3', 'https://other.invalid/x?page=4', 'http://other.invalid/x?page=5', '//other.invalid/x?page=6', '?page=0', '?page=-1', '?page=2.5', '?page=NaN', '?page=Infinity', '?page=1e3', '?page=', '?page=2&page=7', 'https://[invalid/?page=2', 'javascript:opaque?page=8', '__proto__?page=9'];
  test.each(nextValues.map((value, index) => ({ value, index })))('next-page coercion $index only extracts original page', ({ value }) => {
    expect(nextPageOf(value, 'https://tango.makegov.com')).toBe(legacy.nextPageOf(value, 'https://tango.makegov.com'));
  });
  test('invalid base and inherited next retain original behavior', () => {
    expect(nextPageOf('?page=2', 'not a URL')).toBe(legacy.nextPageOf('?page=2', 'not a URL'));
    expect(nextPageOf(Object.create({ next: '?page=3' }).next, 'https://tango.makegov.com')).toBe(3);
  });
  const headerValues = [null, '', ' ', '0', '-2', '3.9', '1e6', 'Infinity', 'NaN', 'Wed, 21 Oct 2015 07:28:00 GMT', undefined, 2, false];
  test.each(headerValues.map((value, index) => ({ value, index })))('rate coercion $index retains result and read order', ({ value }) => {
    const run = (parse: (headers: Headers) => unknown) => {
      const reads: string[] = [];
      const headers = { get(name: string) { reads.push(name); return name === 'x-ratelimit-type' ? null : value; } };
      return { rate: parse(headers as unknown as Headers), reads };
    };
    expect(run((headers) => rateOf(headers, profile))).toEqual(run(legacy.rateOf));
  });
  test('native Headers and empty type retain original metadata', () => {
    for (const headers of [new Headers(), new Headers({ 'x-ratelimit-remaining': '4.5', 'x-ratelimit-limit': '25', 'x-ratelimit-reset-in': '-1', 'retry-after': '2', 'x-ratelimit-type': 'burst' }), new Headers({ 'x-ratelimit-type': '' })]) {
      expect(rateOf(headers, profile)).toEqual(legacy.rateOf(headers));
    }
  });
  test('inherited/getter get lookup retains receiver and per-header lookup', () => {
    const run = (parse: (headers: Headers) => unknown) => {
      let reads = 0;
      const headers = Object.create({ get get() { reads++; return function(this: { marker: string }, name: string) { expect(this.marker).toBe('receiver'); return name === 'retry-after' ? '3' : null; }; } });
      headers.marker = 'receiver';
      return { rate: parse(headers), reads };
    };
    expect(run((headers) => rateOf(headers, profile))).toEqual(run(legacy.rateOf));
    expect(run((headers) => rateOf(headers, profile)).reads).toBe(5);
    expect(outcome(() => rateOf({} as Headers, profile))).toEqual(outcome(() => legacy.rateOf({} as Headers)));
    const marker = new Error('synthetic get failure');
    const headers = Object.create({ get() { throw marker; } });
    for (const parse of [(value: Headers) => rateOf(value, profile), legacy.rateOf]) {
      try { parse(headers); throw new Error('expected header throw'); }
      catch (error) { expect(error).toBe(marker); }
    }
  });
  test.each(['stable', 'throwing', 'mutating'] as const)('object-valued header %s profile retains every effect', (kind) => {
    const run = (parse: (headers: Headers) => unknown) => {
      const trace: string[] = []; let state = 0;
      const marker = new Error('synthetic numeric coercion failure');
      const headers = { get(name: string) {
        trace.push(`get:${name}:state=${state}`);
        if (name === 'x-ratelimit-type') return null;
        const captured = state;
        return { valueOf() { trace.push('coerce:' + name); if (kind === 'throwing') throw marker; state++; return kind === 'mutating' ? captured : 2; } };
      } };
      const result = outcome(() => parse(headers as unknown as Headers));
      return { result, trace };
    };
    const actual = run((headers) => rateOf(headers, profile));
    expect(actual).toEqual(run(legacy.rateOf));
    if (kind === 'throwing') expect(actual.trace).toHaveLength(profile === 'captured' ? 5 : 2);
    if (kind === 'mutating') expect((actual.result as { returned: { limit: number } }).returned.limit).toBe(profile === 'captured' ? 0 : 1);
  });
  test('rate calls retain no metadata between responses', () => {
    rateOf(new Headers({ 'retry-after': '3' }), profile);
    expect(rateOf(new Headers(), profile)).toBeNull();
    expect(rateOf(new Headers({ 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }), profile)?.retryAfter ?? null).toBeNull();
  });
});

const clients = [
  { name: 'dibbs', make: (fetchImpl: typeof fetch) => new TangoDibbsClient({ apiKey: 'synthetic-key', fetchImpl }), request: (client: TangoDibbsClient) => client.listRfqs(), error: TangoDibbsHttpError, envelope: TangoDibbsEnvelopeError },
  { name: 'sbir', make: (fetchImpl: typeof fetch) => new TangoSbirClient({ apiKey: 'synthetic-key', fetchImpl }), request: (client: TangoSbirClient) => client.listTopics(), error: TangoSbirHttpError, envelope: TangoSbirEnvelopeError },
  { name: 'subaward', make: (fetchImpl: typeof fetch) => new TangoSubawardClient({ apiKey: 'synthetic-key', fetchImpl }), request: (client: TangoSubawardClient) => client.listSubawards(), error: TangoSubawardHttpError, envelope: null },
];
describe.each(clients)('actual $name REST client retains its own boundary', (row) => {
  // The heterogeneous clients share only the test invocation, not a new API.
  const invoke = (fetchImpl: typeof fetch) => (row.request as (client: unknown) => Promise<unknown>)(row.make(fetchImpl));
  test('successful native Headers metadata and page extraction remain intact', async () => {
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ results: [{ key: 'synthetic' }], count: '3.9', next: 'http://other.invalid/?page=2' }), { headers: { 'retry-after': '2', 'x-ratelimit-limit': '25' } }));
    const result = await invoke(fetchImpl as typeof fetch) as { totalCount: number; nextPage: number; rate: { retryAfter: number } };
    expect(result.totalCount).toBe(3); expect(result.nextPage).toBe(2); expect(result.rate.retryAfter).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl.mock.calls as unknown as [unknown, RequestInit][])[0]![1];
    expect(init.method).toBe('GET'); expect(init.headers).toEqual({ Accept: 'application/json', 'X-API-KEY': 'synthetic-key' });
  });
  test('missing results keep the original envelope distinction', async () => {
    const promise = invoke((async () => new Response('{}')) as typeof fetch);
    if (row.envelope) await expect(promise).rejects.toBeInstanceOf(row.envelope);
    else await expect(promise).resolves.toMatchObject({ items: [], totalCount: null, nextPage: null, rate: null });
  });
  test('invalid JSON preserves own error class and status', async () => {
    const promise = invoke((async () => new Response('not json', { status: 200 })) as typeof fetch);
    if (row.envelope) await expect(promise).rejects.toBeInstanceOf(row.envelope);
    else await expect(promise).rejects.toMatchObject({ name: 'TangoSubawardHttpError', status: 200 });
  });
  test('429 is one request and retains own failing-rate and redaction profile', async () => {
    const fetchImpl = jest.fn(async () => new Response('synthetic-key synthetic-key', { status: 429, headers: { 'retry-after': '2' } }));
    let thrown: unknown;
    try { await invoke(fetchImpl as typeof fetch); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(row.error); expect(fetchImpl).toHaveBeenCalledTimes(1);
    if (row.name === 'subaward') { expect(thrown).not.toHaveProperty('rate'); expect((thrown as Error).message).toContain('[REDACTED] synthetic-key'); }
    else { expect(thrown).toMatchObject({ status: 429, isRateLimited: true, rate: { retryAfter: 2 } }); expect((thrown as Error).message).toContain('[REDACTED] [REDACTED]'); }
  });
  test('transport and abort errors preserve own status-zero mapping', async () => {
    await expect(invoke((async () => { throw new Error('synthetic transport'); }) as typeof fetch)).rejects.toMatchObject({ status: 0, message: 'synthetic transport' });
    const abort = new Error('synthetic abort'); abort.name = 'AbortError';
    await expect(invoke((async () => { throw abort; }) as typeof fetch)).rejects.toMatchObject({ status: 0, message: expect.stringContaining('timed out after 30000ms') });
  });
});
test('all unconfigured actual clients refuse before the inert fetch', async () => {
  const fetchImpl = jest.fn();
  await expect(new TangoDibbsClient({ fetchImpl }).listRfqs()).rejects.toBeInstanceOf(TangoNotConfiguredError);
  await expect(new TangoSbirClient({ fetchImpl }).listTopics()).rejects.toBeInstanceOf(TangoNotConfiguredError);
  await expect(new TangoSubawardClient({ fetchImpl }).listSubawards()).rejects.toBeInstanceOf(TangoNotConfiguredError);
  expect(fetchImpl).not.toHaveBeenCalled();
});
