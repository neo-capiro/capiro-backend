import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { putProspectFileCopy } from './prospect-file-copy.storage.js';
import { parseProspectFileCopy, prospectFileCopyDigest } from './prospect-file-copy.input.js';

const bytes = Buffer.from('Reviewed synthetic file');
const source = {
  bucket: 'synthetic-bucket',
  key: 'synthetic-source',
  fileName: 'reviewed.txt',
  contentType: 'text/plain',
  checksumSha256: createHash('sha256').update(bytes).digest('hex'),
  contentLength: bytes.length,
};
const target = {
  bucket: source.bucket,
  key: 'synthetic-destination',
  payloadDigest: 'a'.repeat(64),
};
const content = {
  detectContentType: () => 'text/plain',
  contentTypeConflicts: (a: string, b: string) => a !== b,
};
function storage() {
  const body = Readable.from([bytes]);
  const head = {
    ContentLength: source.contentLength,
    ContentType: source.contentType,
    ChecksumSHA256: Buffer.from(source.checksumSha256, 'hex').toString('base64'),
    Metadata: { 'prospect-copy-digest': target.payloadDigest },
  };
  const controls = {
    existing: false,
    putError: null as Error | null,
    body,
    length: source.contentLength,
    head,
  };
  const send = jest.fn(async (command: any, options: any) => {
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    if (command instanceof GetObjectCommand)
      return { Body: controls.body, ContentLength: controls.length };
    if (command instanceof PutObjectCommand) {
      if (controls.putError) throw controls.putError;
      if (controls.existing)
        throw Object.assign(Error('exists'), { $metadata: { httpStatusCode: 412 } });
      return {};
    }
    if (command instanceof HeadObjectCommand) return controls.head;
    throw Error('Unexpected storage command');
  });
  return {
    controls,
    send,
    run: () => putProspectFileCopy({ send } as never, content, source, target),
  };
}
test('reads verified bytes and conditionally writes only the recorded independent key', async () => {
  const h = storage();
  await expect(h.run()).resolves.toEqual({ verifiedContentType: 'text/plain' });
  expect(h.send.mock.calls.map(([c]) => c.input)).toEqual([
    { Bucket: source.bucket, Key: source.key },
    {
      Bucket: target.bucket,
      Key: target.key,
      Body: bytes,
      ContentType: 'text/plain',
      IfNoneMatch: '*',
      ChecksumSHA256: h.controls.head.ChecksumSHA256,
      Metadata: h.controls.head.Metadata,
    },
  ]);
  expect(h.controls.body.destroyed).toBe(true);
});
test.each(['length', 'checksum', 'oversize'])(
  'rejects %s mismatch without a destination write and closes stream',
  async (mode) => {
    const h = storage();
    if (mode === 'length') h.controls.length++;
    else
      h.controls.body = Readable.from([
        mode === 'oversize' ? Buffer.concat([bytes, bytes]) : Buffer.alloc(bytes.length),
      ]);
    await expect(h.run()).rejects.toMatchObject({ status: 409 });
    expect(h.send.mock.calls.every(([c]) => c instanceof GetObjectCommand)).toBe(true);
    expect(h.controls.body.destroyed).toBe(true);
  },
);
test('a conditional collision is accepted only after exact checksum, type, length and command readback', async () => {
  const h = storage();
  h.controls.existing = true;
  await h.run();
  expect(h.send.mock.calls[2]![0]).toBeInstanceOf(HeadObjectCommand);
  expect(h.send.mock.calls[2]![0].input).toMatchObject({
    Key: target.key,
    ChecksumMode: 'ENABLED',
  });
});
test.each(['ContentLength', 'ChecksumSHA256', 'ContentType', 'Metadata'])(
  'refuses an existing object with changed %s without overwrite',
  async (field) => {
    const h = storage();
    h.controls.existing = true;
    (h.controls.head as any)[field] = null;
    await expect(h.run()).rejects.toMatchObject({ status: 409 });
    expect(h.send.mock.calls.filter(([c]) => c instanceof PutObjectCommand)).toHaveLength(1);
  },
);
test('an unknown storage write outcome stays an error without fallback overwrite', async () => {
  const h = storage();
  h.controls.putError = Error('Lost acknowledgement');
  await expect(h.run()).rejects.toThrow('Lost acknowledgement');
  expect(h.send.mock.calls).toHaveLength(2);
});
test('actual byte type conflict refuses before writing', async () => {
  const h = storage();
  await expect(
    putProspectFileCopy(
      { send: h.send } as never,
      { ...content, detectContentType: () => 'application/pdf' },
      source,
      target,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(h.send.mock.calls).toHaveLength(1);
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const command = () => ({
  schemaVersion: 1,
  requestId: id(1),
  prospectId: id(2),
  clientId: id(3),
  sourceId: id(4),
  expectedProspectUpdatedAt: '2026-10-25T00:00:00.000Z',
  expectedRevision: 0,
  checksumSha256: source.checksumSha256,
  contentLength: bytes.length,
  folder: 'Reviewed',
});
test.each([
  { schemaVersion: 2 },
  { extra: true },
  { requestId: 'bad' },
  { sourceId: 'bad' },
  { clientId: 'bad' },
  { expectedProspectUpdatedAt: '2026-10-25' },
  { expectedRevision: -1 },
  { expectedRevision: 0.5 },
  { checksumSha256: 'x'.repeat(64) },
  { contentLength: 0 },
  { contentLength: 26 * 1024 * 1024 },
  { folder: 'x'.repeat(121) },
  { sourceKey: 'untrusted/key' },
])('rejects malformed review %j', (fields) => {
  expect(() => parseProspectFileCopy({ ...command(), ...fields })).toThrow();
});
test('canonical folder and manifest digest bind the actor and selected bytes', () => {
  const a = parseProspectFileCopy({ ...command(), folder: '  Reviewed  ' }),
    b = parseProspectFileCopy(command());
  expect(a).toEqual(b);
  const actor = { tenantId: id(5), userId: id(6) } as never;
  expect(prospectFileCopyDigest(actor, a)).toBe(prospectFileCopyDigest(actor, b));
  expect(prospectFileCopyDigest({ tenantId: id(5), userId: id(7) } as never, b)).not.toBe(
    prospectFileCopyDigest(actor, b),
  );
});
