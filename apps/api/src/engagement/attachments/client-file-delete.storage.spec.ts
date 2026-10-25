import { DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import {
  inspectFileDeleteObject,
  removeFileDeleteObject,
  type FileDeleteObject,
} from './client-file-delete.storage.js';

const snapshot: FileDeleteObject = {
  bucket: 'synthetic-bucket',
  key: 'folder/reviewed file+name.txt',
  etag: '"reviewed-etag"',
};
type Request = { method: string; path: string; headers: Record<string, string>; query: Record<string, unknown> };
type Response = { statusCode: number; headers: Record<string, string>; body: Buffer };
type Step = (request: Request, signal?: AbortSignal) => Response | Promise<Response>;
const response = (
  statusCode: number,
  headers: Record<string, string> = {},
  body = '',
): Response => ({
  statusCode,
  headers,
  body: Buffer.from(body),
});
const present =
  (etag = snapshot.etag!) =>
  () =>
    response(200, { etag });
const failure = (status: number, name: string) => () =>
  response(status, { 'x-amzn-errortype': name }, `<Error><Code>${name}</Code></Error>`);
const missing = () => failure(404, 'NotFound');
const denied = () => failure(403, 'AccessDenied');
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const listing = (keys: string[] = [], truncated = false) =>
  `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
  `<Name>${xml(snapshot.bucket)}</Name><Prefix>${xml(snapshot.key)}</Prefix><MaxKeys>1</MaxKeys>` +
  `<KeyCount>${keys.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>` +
  (truncated ? '<NextContinuationToken>synthetic-next</NextContinuationToken>' : '') +
  keys.map((key) => `<Contents><Key>${xml(key)}</Key><ETag>&quot;untrusted-list-etag&quot;</ETag></Contents>`).join('') +
  '</ListBucketResult>';
const listed = (keys: string[] = [], truncated = false): Step => () =>
  response(200, {}, listing(keys, truncated));
const clients: S3Client[] = [];

function storage(...steps: Step[]) {
  const handle = jest.fn(async (request: Request, options?: { abortSignal?: AbortSignal }) => {
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
    const step = steps.shift();
    if (!step) throw new Error('Unexpected storage request');
    return { response: await step(request, options?.abortSignal) };
  });
  const destroy = jest.fn();
  // Synthetic credentials and transport: actual SDK serialization, no network/provider calls.
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: 'https://s3.synthetic.invalid',
    forcePathStyle: true,
    credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
    maxAttempts: 1,
    requestHandler: { handle, destroy },
  });
  clients.push(s3);
  const send = jest.spyOn(s3, 'send');
  return { s3, send, handle, destroy, remove: () => removeFileDeleteObject(s3, snapshot) };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  jest.useRealTimers();
});

test('inspects an object and reuses the supplied client for exact conditional deletion and readback', async () => {
  const h = storage(present(), present(), () => response(204), missing());
  const retained = await inspectFileDeleteObject(h.s3, snapshot.bucket, snapshot.key);
  expect(retained).toEqual(snapshot);
  await expect(removeFileDeleteObject(h.s3, retained)).resolves.toBeUndefined();
  expect(h.send.mock.calls.map(([command]) => command.input)).toEqual([
    { Bucket: snapshot.bucket, Key: snapshot.key },
    { Bucket: snapshot.bucket, Key: snapshot.key },
    { Bucket: snapshot.bucket, Key: snapshot.key, IfMatch: snapshot.etag },
    { Bucket: snapshot.bucket, Key: snapshot.key },
  ]);
  expect(h.send.mock.calls[2]![0]).toBeInstanceOf(DeleteObjectCommand);
  expect(h.handle.mock.calls.map(([request]) => request.method)).toEqual([
    'HEAD',
    'HEAD',
    'DELETE',
    'HEAD',
  ]);
  expect(
    h.handle.mock.calls.every(
      ([request]) => request.path === '/synthetic-bucket/folder/reviewed%20file%2Bname.txt',
    ),
  ).toBe(true);
  expect(h.handle.mock.calls[2]![0].headers['if-match']).toBe(snapshot.etag);
  expect(h.destroy).not.toHaveBeenCalled();
});

test.each(['NotFound', 'NoSuchKey'])('strict 404 %s records absence without listing', async (name) => {
  const h = storage(failure(404, name), failure(404, name));
  const retained = await inspectFileDeleteObject(h.s3, snapshot.bucket, snapshot.key);
  expect(retained).toEqual({ ...snapshot, etag: null });
  await expect(removeFileDeleteObject(h.s3, retained)).resolves.toBeUndefined();
  expect(h.send.mock.calls.every(([command]) => command instanceof HeadObjectCommand)).toBe(true);
});

test('a retry after a lost delete acknowledgement observes absence without another delete', async () => {
  const lost = new Error('Lost delete acknowledgement');
  const h = storage(
    present(),
    () => {
      throw lost;
    },
    missing(),
  );
  await expect(h.remove()).rejects.toBe(lost);
  expect(h.handle).toHaveBeenCalledTimes(2);
  await expect(h.remove()).resolves.toBeUndefined();
  expect(h.handle.mock.calls.map(([request]) => request.method)).toEqual([
    'HEAD',
    'DELETE',
    'HEAD',
  ]);
});

test('an already absent recorded object succeeds without deletion', async () => {
  const h = storage(missing());
  await expect(h.remove()).resolves.toBeUndefined();
  expect(h.handle).toHaveBeenCalledTimes(1);
});

test('a replacement observed before deletion is refused without a delete', async () => {
  const h = storage(present('"replacement"'));
  await expect(h.remove()).rejects.toMatchObject({ status: 409 });
  expect(h.handle.mock.calls.map(([request]) => request.method)).toEqual(['HEAD']);
});

test('an absent snapshot never authorizes deletion of a newly present object', async () => {
  const h = storage(present());
  await expect(removeFileDeleteObject(h.s3, { ...snapshot, etag: null })).rejects.toMatchObject({
    status: 409,
  });
  expect(h.handle.mock.calls.map(([request]) => request.method)).toEqual(['HEAD']);
});

test.each([
  ['PreconditionFailed', 412],
  ['ConditionalRequestConflict', 409],
  ['NoSuchKey', 404],
] as const)('delete %s succeeds only when a new HEAD observes absence', async (name, status) => {
  const h = storage(present(), failure(status, name), missing());
  await expect(h.remove()).resolves.toBeUndefined();
  expect(h.handle.mock.calls.map(([request]) => request.method)).toEqual([
    'HEAD',
    'DELETE',
    'HEAD',
  ]);
});

test.each([
  ['PreconditionFailed', 412],
  ['ConditionalRequestConflict', 409],
  ['NoSuchKey', 404],
] as const)(
  'delete %s preserves a concurrently changed object without retrying the delete',
  async (name, status) => {
    const h = storage(present(), failure(status, name), present('"replacement"'));
    await expect(h.remove()).rejects.toMatchObject({ name, $metadata: { httpStatusCode: status } });
    expect(h.handle.mock.calls.map(([request]) => request.method)).toEqual([
      'HEAD',
      'DELETE',
      'HEAD',
    ]);
    expect(h.handle.mock.calls[1]![0].headers['if-match']).toBe(snapshot.etag);
  },
);

test('a 412 with the same object still present is not success and does not retry deletion', async () => {
  const h = storage(present(), failure(412, 'PreconditionFailed'), present());
  await expect(h.remove()).rejects.toMatchObject({ name: 'PreconditionFailed' });
  expect(h.handle).toHaveBeenCalledTimes(3);
});

test.each([snapshot.etag!, '"replacement"'])(
  'a successful delete response followed by ETag %s is not verified absence',
  async (etag) => {
    const h = storage(present(), () => response(204), present(etag));
    await expect(h.remove()).rejects.toMatchObject({ status: 409 });
    expect(h.handle).toHaveBeenCalledTimes(3);
  },
);

test.each([
  [403, 'AccessDenied'],
  [500, 'InternalError'],
  [404, 'NoSuchBucket'],
  [404, 'InvalidRequest'],
  [403, 'NotFound'],
] as const)('HEAD %s %s is never absence', async (status, name) => {
  const h = storage(failure(status, name), ...(status === 403 ? [failure(status, name)] : []));
  await expect(h.remove()).rejects.toMatchObject({ name, $metadata: { httpStatusCode: status } });
  expect(h.handle).toHaveBeenCalledTimes(status === 403 ? 2 : 1);
});

test.each([
  [403, 'AccessDenied'],
  [500, 'InternalError'],
  [404, 'NoSuchBucket'],
] as const)(
  'DELETE %s %s remains an error without treating it as an object conflict',
  async (status, name) => {
    const h = storage(present(), failure(status, name));
    await expect(h.remove()).rejects.toMatchObject({ name, $metadata: { httpStatusCode: status } });
    expect(h.handle).toHaveBeenCalledTimes(2);
  },
);

test.each([() => response(204), failure(412, 'PreconditionFailed')])(
  'a failed absence verification remains an error after a successful or conflicted delete',
  async (deletion) => {
    const h = storage(present(), deletion, denied(), denied());
    await expect(h.remove()).rejects.toMatchObject({ name: 'AccessDenied' });
    expect(h.handle).toHaveBeenCalledTimes(4);
  },
);

test.each([undefined, '', '*', '  *  '])(
  'a HEAD with unusable ETag %s is never absence',
  async (etag) => {
    const h = storage(() => response(200, etag === undefined ? {} : { etag }));
    await expect(h.remove()).rejects.toThrow('exact object ETag');
    expect(h.handle).toHaveBeenCalledTimes(1);
  },
);

test.each(['', '*', '  *  '])(
  'a saved ETag %s cannot weaken the delete condition',
  async (etag) => {
    const h = storage();
    await expect(removeFileDeleteObject(h.s3, { ...snapshot, etag })).rejects.toThrow(
      'exact retained',
    );
    expect(h.send).not.toHaveBeenCalled();
  },
);

test('the recorded key and ETag are fixed before awaiting storage', async () => {
  const retained = { ...snapshot };
  const h = storage(
    () => {
      retained.key = 'another-key';
      retained.bucket = 'another-bucket';
      retained.etag = '"replacement"';
      return response(200, { etag: snapshot.etag! });
    },
    () => response(204),
    missing(),
  );
  await removeFileDeleteObject(h.s3, retained);
  expect(h.send.mock.calls[1]![0].input).toEqual({
    Bucket: snapshot.bucket,
    Key: snapshot.key,
    IfMatch: snapshot.etag,
  });
});

test.each(['HEAD', 'DELETE', 'verification', 'LIST'])(
  'a stalled %s is aborted and cannot resolve as absence',
  async (phase) => {
    jest.useFakeTimers();
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let signal: AbortSignal | undefined;
    const stall: Step = (_request, abortSignal) => {
      signal = abortSignal;
      began();
      // Also prove the bound holds if a transport fails to settle on abort.
      return new Promise<Response>(() => {});
    };
    const h = storage(
      ...(phase === 'HEAD'
        ? [stall]
        : phase === 'DELETE'
          ? [present(), stall]
          : phase === 'LIST'
            ? [denied(), stall]
            : [present(), () => response(204), stall]),
    );
    const result = expect(h.remove()).rejects.toMatchObject({ name: 'TimeoutError' });
    await started;
    await jest.advanceTimersByTimeAsync(10_000);
    await result;
    expect(signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  },
);

test.each([{ keys: [] }, { keys: [snapshot.key + '.neighbor'] }])(
  'HEAD403 with a coherent exact-prefix list $keys proves only target absence',
  async ({ keys }) => {
    const h = storage(denied(), listed(keys));
    await expect(inspectFileDeleteObject(h.s3, snapshot.bucket, snapshot.key)).resolves.toEqual({
      ...snapshot, etag: null,
    });
    expect(h.send.mock.calls[1]![0]).toBeInstanceOf(ListObjectsV2Command);
    expect(h.send.mock.calls[1]![0].input).toEqual({ Bucket: snapshot.bucket, Prefix: snapshot.key, MaxKeys: 1 });
    expect(h.handle.mock.calls.map(([request]) => request.method)).toEqual(['HEAD', 'GET']);
    const request = h.handle.mock.calls[1]![0];
    expect(request.path).toBe('/synthetic-bucket/');
    expect(request.query).toMatchObject({ 'list-type': '2', prefix: snapshot.key, 'max-keys': '1' });
    for (const excluded of ['delimiter', 'start-after', 'continuation-token'])
      expect(request.query).not.toHaveProperty(excluded);
  },
);

test('a first prefix neighbor proves exact-key absence even when further neighbors are truncated', async () => {
  const h = storage(denied(), listed([snapshot.key + '.neighbor'], true));
  await expect(h.remove()).resolves.toBeUndefined();
  expect(h.handle).toHaveBeenCalledTimes(2);
});

test.each([false, true])('an exact listed target (truncated=%s) never supplies delete authority or absence', async (truncated) => {
  const h = storage(denied(), listed([snapshot.key], truncated));
  await expect(h.remove()).rejects.toMatchObject({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
  expect(h.handle.mock.calls.map(([request]) => request.method)).toEqual(['HEAD', 'GET']);
});

test.each([
  ['denied', failure(403, 'AccessDenied')],
  ['server error', failure(500, 'InternalError')],
  ['missing bucket', failure(404, 'NoSuchBucket')],
] as const)('HEAD403 followed by LIST %s remains an error', async (_name, step) => {
  const h = storage(denied(), step);
  await expect(h.remove()).rejects.toThrow();
  expect(h.handle.mock.calls.map(([request]) => request.method)).toEqual(['HEAD', 'GET']);
});

test.each([
  ['empty response', ''],
  ['missing fields', '<ListBucketResult/>'],
  ['wrong bucket', listing().replace(snapshot.bucket, 'other-bucket')],
  ['wrong prefix', listing().replace(xml(snapshot.key), 'other-prefix')],
  ['wrong maximum', listing().replace('<MaxKeys>1', '<MaxKeys>2')],
  ['missing count', listing().replace('<KeyCount>0</KeyCount>', '')],
  ['inconsistent count', listing().replace('<KeyCount>0', '<KeyCount>1')],
  ['missing truncated flag', listing().replace('<IsTruncated>false</IsTruncated>', '')],
  ['empty truncated listing', listing([], true)],
  ['missing continuation token', listing([snapshot.key + '.neighbor'], true).replace('<NextContinuationToken>synthetic-next</NextContinuationToken>', '')],
  ['outside prefix', listing(['different-key'])],
  ['missing object key', listing([snapshot.key]).replace(`<Key>${xml(snapshot.key)}</Key>`, '')],
  ['too many results', listing([snapshot.key + '.a', snapshot.key + '.b'])],
  ['delimiter groups', listing().replace('</ListBucketResult>', '<CommonPrefixes><Prefix>group/</Prefix></CommonPrefixes></ListBucketResult>')],
])('HEAD403 with incoherent LIST %s cannot prove absence', async (_name, body) => {
  const h = storage(denied(), () => response(200, {}, body));
  await expect(h.remove()).rejects.toThrow();
  expect(h.handle.mock.calls.map(([request]) => request.method)).toEqual(['HEAD', 'GET']);
});

test.each([() => response(204), failure(412, 'PreconditionFailed')])(
  'after a successful or conflicted conditional delete, HEAD403 plus LIST absence completes readback',
  async (deletion) => {
    const h = storage(present(), deletion, denied(), listed());
    await expect(h.remove()).resolves.toBeUndefined();
    expect(h.handle.mock.calls.map(([request]) => request.method)).toEqual(['HEAD', 'DELETE', 'HEAD', 'GET']);
    expect(h.handle.mock.calls[1]![0].headers['if-match']).toBe(snapshot.etag);
  },
);

test('a listed target after a conditional conflict remains pending without another delete', async () => {
  const h = storage(present(), failure(412, 'PreconditionFailed'), denied(), listed([snapshot.key]));
  await expect(h.remove()).rejects.toMatchObject({ name: 'AccessDenied' });
  expect(h.handle.mock.calls.map(([request]) => request.method)).toEqual(['HEAD', 'DELETE', 'HEAD', 'GET']);
});

test('a retry after lost delete acknowledgement can prove absence through HEAD403 and bounded LIST', async () => {
  const lost = new Error('Lost delete acknowledgement');
  const h = storage(present(), () => { throw lost; }, denied(), listed());
  await expect(h.remove()).rejects.toBe(lost);
  await expect(h.remove()).resolves.toBeUndefined();
  expect(h.handle.mock.calls.map(([request]) => request.method)).toEqual(['HEAD', 'DELETE', 'HEAD', 'GET']);
});
