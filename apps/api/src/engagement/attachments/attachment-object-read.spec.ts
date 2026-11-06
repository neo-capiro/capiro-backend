import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { assertAttachmentByteIntegrity, readAttachmentObject } from './attachment-object-read.js';

const bytes = Buffer.from('Synthetic verified attachment');
const identity = {
  source: 'upload', scanStatus: 'clean',
  calculatedSha256: createHash('sha256').update(bytes).digest('hex'),
};
const client = (send: jest.Mock) => ({ send }) as unknown as S3Client;

describe('attachment object integrity and bounded storage reads', () => {
  test('uses computed bytes, refusing changed content regardless of S3 checksum metadata', async () => {
    const body = Readable.from([Buffer.from('replacement')]);
    const s3 = client(jest.fn().mockResolvedValue({ Body: body, VersionId: 'v2',
      ChecksumSHA256: identity.calculatedSha256 }));
    const object = await readAttachmentObject(s3, 'synthetic', 'key');
    expect(() => assertAttachmentByteIntegrity(identity, object.bytes)).toThrow(/no longer matches/);
    expect(body.destroyed).toBe(true);
  });

  test.each([null, '', 'x'.repeat(64), 'a'.repeat(63)])('refuses invalid clean digest %s', (digest) => {
    expect(() => assertAttachmentByteIntegrity({ ...identity, calculatedSha256: digest }, bytes))
      .toThrow(/no longer matches/);
  });

  test('requires identity-upload integrity even when scanning was optional', () => {
    expect(() => assertAttachmentByteIntegrity({ ...identity, source: 'profile_identity',
      scanStatus: 'scanner_not_required' }, Buffer.from('replacement'))).toThrow();
    expect(() => assertAttachmentByteIntegrity({ source: 'upload', scanStatus: null,
      calculatedSha256: null }, bytes)).not.toThrow();
  });

  test('returns exact response version and accepts identical bytes in a newer version', async () => {
    const body = Readable.from([bytes]);
    const s3 = client(jest.fn().mockResolvedValue({ Body: body, ContentLength: bytes.length, VersionId: 'v-new' }));
    const object = await readAttachmentObject(s3, 'synthetic', 'key');
    expect(object).toEqual({ bytes, versionId: 'v-new' });
    expect(() => assertAttachmentByteIntegrity(identity, object.bytes)).not.toThrow();
    expect(body.destroyed).toBe(true);
  });

  test.each([-1, 1.5, 25 * 1024 * 1024 + 1, bytes.length + 1])(
    'rejects invalid or mismatching declared length %s and releases body', async (ContentLength) => {
      const body = Readable.from([bytes]);
      await expect(readAttachmentObject(client(jest.fn().mockResolvedValue({ Body: body, ContentLength })),
        'synthetic', 'key')).rejects.toThrow();
      expect(body.destroyed).toBe(true);
    });

  test('caps actual streaming bytes when S3 omits length', async () => {
    const body = Readable.from([Buffer.alloc(25 * 1024 * 1024), Buffer.from('x')]);
    await expect(readAttachmentObject(client(jest.fn().mockResolvedValue({ Body: body })),
      'synthetic', 'key')).rejects.toThrow();
    expect(body.destroyed).toBe(true);
  });

  test('releases a failed stream', async () => {
    const body = Readable.from((async function* () { yield bytes; throw new Error('broken stream'); })());
    await expect(readAttachmentObject(client(jest.fn().mockResolvedValue({ Body: body })),
      'synthetic', 'key')).rejects.toThrow('broken stream');
    expect(body.destroyed).toBe(true);
  });

  test('deadline aborts a stalled stream and clears its timer', async () => {
    jest.useFakeTimers();
    try {
      const body = new Readable({ read() {} });
      const send = jest.fn().mockResolvedValue({ Body: body });
      const pending = readAttachmentObject(client(send), 'synthetic', 'key');
      const refused = expect(pending).rejects.toThrow();
      await jest.advanceTimersByTimeAsync(30_000);
      await refused;
      expect(body.destroyed).toBe(true);
      expect(send.mock.calls[0]![1].abortSignal.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  test('caller cancellation also disposes a late S3 response', async () => {
    let complete!: (value: unknown) => void;
    const send = jest.fn(() => new Promise((resolve) => { complete = resolve; }));
    const controller = new AbortController();
    const pending = readAttachmentObject(client(send), 'synthetic', 'key', controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    const body = Readable.from([bytes]);
    complete({ Body: body });
    await Promise.resolve();
    expect(body.destroyed).toBe(true);
  });
});
