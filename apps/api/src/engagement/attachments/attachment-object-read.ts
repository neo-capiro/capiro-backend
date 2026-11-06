import { BadRequestException, ConflictException } from '@nestjs/common';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

/** Persisted owner identity, never a client-supplied checksum or S3 metadata. */
export interface AttachmentByteIdentity {
  calculatedSha256: string | null;
  scanStatus: string | null;
  source: string;
}

export function requiresAttachmentIntegrity(row: AttachmentByteIdentity): boolean {
  return row.scanStatus === 'clean' || row.source === 'profile_identity';
}

const changed = () => new ConflictException({
  code: 'ATTACHMENT_CONTENT_CHANGED',
  message: 'The stored file no longer matches its verified content. Re-upload the file.',
});

export function assertAttachmentByteIntegrity(row: AttachmentByteIdentity, bytes: Buffer): void {
  if (!requiresAttachmentIntegrity(row)) return;
  if (!row.calculatedSha256 || !/^[a-f0-9]{64}$/i.test(row.calculatedSha256) ||
      createHash('sha256').update(bytes).digest('hex') !== row.calculatedSha256.toLowerCase())
    throw changed();
}

/** Read one bounded object with its SAME-response version, releasing the borrowed
 * client's body on every exit. No authorization, caching or durable state here. */
export async function readAttachmentObject(
  s3: S3Client,
  bucket: string,
  key: string,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; versionId: string | undefined }> {
  signal?.throwIfAborted();
  const abort = new AbortController();
  let body: Readable | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const failure = () => new BadRequestException('Could not read verified attachment from S3');
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      abort.abort();
      body?.destroy();
      reject(signal?.reason ?? failure());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(onAbort, 30_000);
  });
  const read = async () => {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: abort.signal,
    });
    body = object.Body instanceof Readable ? object.Body : undefined;
    // An SDK response can arrive after cancellation. Dispose that late body too.
    if (abort.signal.aborted) {
      body?.destroy();
      throw failure();
    }
    if (!body) throw failure();
    const declared = object.ContentLength;
    const maxBytes = 25 * 1024 * 1024;
    if (declared !== undefined &&
        (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes)) throw failure();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of body) {
      abort.signal.throwIfAborted();
      if (!Buffer.isBuffer(part) && !(part instanceof Uint8Array)) throw failure();
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.byteLength;
      if (size > maxBytes) throw failure();
      chunks.push(chunk);
    }
    abort.signal.throwIfAborted();
    if (declared !== undefined && size !== declared) throw failure();
    return { bytes: Buffer.concat(chunks, size), versionId: object.VersionId };
  };
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    abort.abort();
    body?.destroy();
  }
}
