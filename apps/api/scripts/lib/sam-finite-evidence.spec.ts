import { stageSamPage, sha256Bytes, createPrivateEvidenceDirectory } from './sam-finite-evidence.js';
import fs = require('node:fs');
import { dirname, join, resolve } from 'node:path';

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

/** Portable call-order proof; this deliberately does not claim native POSIX crash durability. */
function withPrivateFs(work: (events: string[], fsync: jest.SpyInstance) => void) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
  const events: string[] = [];
  try {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => 1000 });
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => { events.push('mkdir'); return undefined; });
    jest.spyOn(fs, 'lstatSync').mockImplementation(() => {
      events.push('validate');
      return { mode: 0o40700, uid: 1000, isDirectory: () => true, isSymbolicLink: () => false } as fs.Stats;
    });
    jest.spyOn(fs, 'openSync').mockImplementation((path) => { events.push(`open:${String(path)}`); return 7; });
    const fsync = jest.spyOn(fs, 'fsyncSync').mockImplementation(() => { events.push('fsync'); });
    jest.spyOn(fs, 'closeSync').mockImplementation(() => { events.push('close'); });
    jest.spyOn(fs, 'writeSync').mockImplementation((...args: unknown[]) => { events.push('write'); return Number(args[3]); });
    work(events, fsync);
  } finally {
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', platform);
    if (getuid) Object.defineProperty(process, 'getuid', getuid);
    else delete (process as unknown as Record<string, unknown>).getuid;
  }
}
describe('private run-directory creation durability', () => {
  it('syncs and closes the parent after validation and before returning the evidence writer', () => {
    withPrivateFs((events) => {
      const directory = resolve('synthetic-parent/new-run');
      const evidence = createPrivateEvidenceDirectory(directory);
      expect(events).toEqual(['mkdir', 'validate', `open:${dirname(directory)}`, 'fsync', 'close']);
      events.push('provider-can-start');
      evidence.write('write-intent.json', Buffer.from('{}'));
      expect(events).toEqual(['mkdir', 'validate', `open:${dirname(directory)}`, 'fsync', 'close', 'provider-can-start',
        `open:${join(directory, 'write-intent.json')}`, 'write', 'fsync', 'close', `open:${directory}`, 'fsync', 'close']);
    });
  });
  it('closes the parent descriptor and refuses writer admission when parent fsync fails', () => {
    withPrivateFs((events, fsync) => {
      const directory = resolve('synthetic-parent/new-run');
      fsync.mockImplementation(() => { events.push('fsync-failed'); throw new Error('synthetic fsync failure'); });
      expect(() => createPrivateEvidenceDirectory(directory)).toThrow('synthetic fsync failure');
      expect(events).toEqual(['mkdir', 'validate', `open:${dirname(directory)}`, 'fsync-failed', 'close']);
      expect(fs.writeSync).not.toHaveBeenCalled(); expect(fs.mkdirSync).toHaveBeenCalledTimes(1);
    });
  });
  it('does not retry or close a nonexistent descriptor when opening the parent fails', () => {
    withPrivateFs((events) => {
      jest.spyOn(fs, 'openSync').mockImplementation(() => { events.push('open-failed'); throw new Error('synthetic open failure'); });
      expect(() => createPrivateEvidenceDirectory(resolve('synthetic-parent/new-run'))).toThrow('synthetic open failure');
      expect(events).toEqual(['mkdir', 'validate', 'open-failed']); expect(fs.closeSync).not.toHaveBeenCalled();
      expect(fs.writeSync).not.toHaveBeenCalled(); expect(fs.mkdirSync).toHaveBeenCalledTimes(1);
    });
  });
});
