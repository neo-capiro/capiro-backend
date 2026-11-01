import { stageSamPage, sha256Bytes, createPrivateEvidenceDirectory } from './sam-finite-evidence.js';

function input(fetcher: typeof fetch, maxBytes = 2048) {
  const files = new Map<string, Buffer>();
  return { files, options: { apiKey: 'synthetic-secret', piid: '000123', file: 'page-1.bin',
    evidence: { write: (name: string, data: Uint8Array) => { files.set(name, Buffer.from(data)); } },
    maxBytes, responseMs: 100, remaining: () => 1000, now: () => Date.parse('2026-11-01T12:00:00Z'), fetch: fetcher } };
}
afterEach(() => { jest.useRealTimers(); });
describe('finite SAM raw evidence and single-attempt streaming', () => {
  it('retains byte-exact chunks across UTF-8 boundaries and does not trust Content-Length', async () => {
    const raw = Buffer.from('{"awardSummary":[{"label":"é","awardDetails":{"dollars":{"actionObligation":70368744177664.01}}}]}');
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of raw) controller.enqueue(Uint8Array.of(byte)); controller.close();
    } }), { headers: { 'Content-Length': '1' } });
    const fetcher = jest.fn(async () => response);
    const h = input(fetcher as typeof fetch);
    const page = await stageSamPage(h.options);
    expect(h.files.get('page-1.bin')).toEqual(raw); expect(page.sha256).toBe(sha256Bytes(raw));
    expect(page.records[0]!.awardDetails!.dollars!.actionObligation).toEqual({ $samDecimalLexeme: '70368744177664.01' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls as unknown[][])[0]![1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  });
  it('retains only bounded exact prefix evidence and cancels when a chunk exceeds the remaining body allowance', async () => {
    const cancel = jest.fn();
    const fetcher = jest.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('abcdefg')); }, cancel })));
    const h = input(fetcher as typeof fetch, 6);
    await expect(stageSamPage(h.options)).rejects.toThrow('SOURCE_BODY_LIMIT');
    expect(h.files.get('page-1.bin')!.toString()).toBe('abcdef'); expect(cancel).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    Buffer.from([0xff]), Buffer.from('{'), Buffer.from('null'),
    Buffer.from(JSON.stringify({ awardSummary: Array.from({ length: 101 }, () => ({})) })),
    Buffer.from(JSON.stringify({ awardSummary: [null] })),
    Buffer.from(JSON.stringify({ awardSummary: [], totalRecords: '100' })),
    Buffer.from('{"awardSummary":[{"awardDetails":{"dollars":{"actionObligation":{"$samDecimalLexeme":"1"}}}}]}'),
  ])('retains malformed source bytes and refuses parsing/shape (%#)', async (raw) => {
    const h = input(jest.fn(async () => new Response(raw)) as typeof fetch);
    await expect(stageSamPage(h.options)).rejects.toThrow(); expect(h.files.get('page-1.bin')).toEqual(raw);
  });
  it('does not retry HTTP errors or redirect/transport failure and scrubs key-bearing error messages', async () => {
    const fetcher = jest.fn(async () => new Response('synthetic rejection body', { status: 503 }));
    const h = input(fetcher as typeof fetch);
    await expect(stageSamPage(h.options)).rejects.toThrow('SOURCE_HTTP_503'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(h.files.get('page-1.bin')!.toString()).toBe('synthetic rejection body');
    const failed = input(jest.fn(async () => { throw new Error('redirect to https://example.gov/?api_key=synthetic-secret'); }) as typeof fetch);
    await expect(stageSamPage(failed.options)).rejects.toThrow('SOURCE_TRANSPORT_OR_PARSE_FAILURE');
  });
  it('keeps the response timer active while the body is pending, and awaits cancellation', async () => {
    jest.useFakeTimers();
    const fetcher = jest.fn(async (_url: unknown, options?: RequestInit) => new Response(new ReadableStream({ start(controller) {
      options!.signal!.addEventListener('abort', () => controller.error(new Error('aborted')));
    } })));
    const h = input(fetcher as typeof fetch);
    const rejection = expect(stageSamPage(h.options)).rejects.toThrow('SOURCE_RESPONSE_TIMEOUT');
    await jest.advanceTimersByTimeAsync(101); await rejection;
    expect(fetcher).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  });
  it('refuses a delayed no-body response even if transport resolves after abort', async () => {
    jest.useFakeTimers();
    const h = input(jest.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(null, { status: 204 })), 101))) as typeof fetch);
    const rejection = expect(stageSamPage(h.options)).rejects.toThrow('SOURCE_RESPONSE_TIMEOUT');
    await jest.advanceTimersByTimeAsync(102); await rejection; expect(jest.getTimerCount()).toBe(0);
  });
  it('requires explicit POSIX private evidence and never treats Windows chmod as private ACL enforcement', () => {
    expect(() => createPrivateEvidenceDirectory('relative-output')).toThrow('PRIVATE_POSIX_EVIDENCE_DIRECTORY_REQUIRED');
  });
});
