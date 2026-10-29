import { readMemoryRetentionWitness } from './witness.js';

const configuration = {
  origin: 'https://control.example.invalid',
  secret: 'synthetic-retention-service-secret',
};
const zero = { schemaVersion: 1, sequence: 0, entrySha256: null };
const read = (reply: () => Response | Promise<Response>, extra = {}) =>
  readMemoryRetentionWitness({
    ...configuration,
    fetchImpl: jest.fn(async () => reply()) as typeof fetch,
    ...extra,
  });

it('reads each fresh private position with the existing transport credential and no user identity', async () => {
  const fetchImpl = jest.fn(async (_input: string | URL | Request, _options?: RequestInit) =>
    Response.json(zero),
  );
  for (let i = 0; i < 2; i++)
    expect(await readMemoryRetentionWitness({ ...configuration, fetchImpl })).toEqual({
      sequence: 0,
      entrySha256: null,
    });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls[0]?.[0]).toEqual(
    new URL('https://control.example.invalid/v1/internal/retention/serving-witness'),
  );
  expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
    method: 'GET',
    redirect: 'error',
    headers: {
      'x-internal-service-secret': configuration.secret,
      accept: 'application/json',
      'accept-encoding': 'identity',
      'cache-control': 'no-store',
    },
  });
  const positive = { ...zero, sequence: 3, entrySha256: 'a'.repeat(64) };
  expect(await read(() => Response.json(positive))).toEqual({
    sequence: 3,
    entrySha256: 'a'.repeat(64),
  });
});

it('refuses missing, insecure or non-origin configuration without transport', async () => {
  const fetchImpl = jest.fn();
  for (const origin of [
    '',
    'http://control.invalid',
    'https://user:password@control.invalid',
    'https://control.invalid/path',
    'https://control.invalid/?query=1',
  ])
    expect(await readMemoryRetentionWitness({ ...configuration, origin, fetchImpl })).toBeNull();
  for (const secret of ['', 'short', 'synthetic secret contains whitespace'])
    expect(await readMemoryRetentionWitness({ ...configuration, secret, fetchImpl })).toBeNull();
  expect(fetchImpl).not.toHaveBeenCalled();
});

it.each([
  { ...zero, extra: 'not content-free' },
  { ...zero, schemaVersion: 2 },
  { ...zero, sequence: -1 },
  { ...zero, sequence: 1 },
  { ...zero, sequence: '0' },
  { ...zero, entrySha256: 'a'.repeat(64) },
  { ...zero, sequence: Number.MAX_SAFE_INTEGER + 1, entrySha256: 'a'.repeat(64) },
])('refuses an invalid closed position %#', async (value) => {
  expect(await read(() => Response.json(value))).toBeNull();
});

it('refuses redirects, unverified responses, encodings, oversized and invalid UTF-8 bodies', async () => {
  for (const response of [
    new Response(null, { status: 302 }),
    Response.json(zero, { status: 503 }),
    new Response('{}', { headers: { 'content-type': 'text/plain' } }),
    Response.json(zero, { headers: { 'content-encoding': 'gzip' } }),
    Response.json(zero, { headers: { 'content-length': '1024' } }),
    new Response(' '.repeat(513), { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
  ])
    expect(await read(() => response)).toBeNull();
});

it('bounds a stuck fetch and body, aborts transport and discards late results', async () => {
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>((r) => {
    resolve = r;
  });
  const fetchImpl = jest.fn((_input: unknown, options?: RequestInit) => {
    expect(options?.signal).toBeDefined();
    return pending;
  });
  expect(
    await readMemoryRetentionWitness({
      ...configuration,
      fetchImpl: fetchImpl as typeof fetch,
      timeoutMs: 20,
    }),
  ).toBeNull();
  expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  let cancelled = false;
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
  await new Promise((r) => setImmediate(r));
  expect(cancelled).toBe(true);
  let bodyCancelled = false;
  expect(
    await read(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              bodyCancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      { timeoutMs: 20 },
    ),
  ).toBeNull();
  expect(bodyCancelled).toBe(true);
});
