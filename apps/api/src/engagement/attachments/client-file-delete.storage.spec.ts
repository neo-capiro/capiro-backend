import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
type Request = { method: string; path: string; headers: Record<string, string> };
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

test.each(['NotFound', 'NoSuchKey'])('only strict 404 %s records absence', async (name) => {
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
  const h = storage(failure(status, name));
  await expect(h.remove()).rejects.toMatchObject({ name, $metadata: { httpStatusCode: status } });
  expect(h.handle).toHaveBeenCalledTimes(1);
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
    const h = storage(present(), deletion, failure(403, 'AccessDenied'));
    await expect(h.remove()).rejects.toMatchObject({ name: 'AccessDenied' });
    expect(h.handle).toHaveBeenCalledTimes(3);
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

test.each(['HEAD', 'DELETE', 'verification'])(
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
