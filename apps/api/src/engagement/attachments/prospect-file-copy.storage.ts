import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { MAX_COPY_BYTES } from './prospect-file-copy.input.js';
import type { AttachmentContentService } from '../attachment-content.service.js';

export interface CopySourceObject {
  bucket: string;
  key: string;
  fileName: string;
  contentType: string;
  checksumSha256: string;
  contentLength: number;
}
export interface CopyDestinationObject {
  bucket: string;
  key: string;
  payloadDigest: string;
}
const mismatch = () =>
  new ConflictException('The retained copy does not match the reviewed source');

/** Only an existing Engagement storage owner calls this with recorded identities.
 * No database transaction is held during reads, conditional writes or scanning. */
export async function putProspectFileCopy(
  s3: S3Client,
  content: Pick<AttachmentContentService, 'detectContentType' | 'contentTypeConflicts'>,
  source: CopySourceObject,
  target: CopyDestinationObject,
) {
  if (
    !Number.isSafeInteger(source.contentLength) ||
    source.contentLength < 1 ||
    source.contentLength > MAX_COPY_BYTES
  )
    throw mismatch();
  const signal = AbortSignal.timeout(30_000);
  const object = await s3.send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key }), {
    abortSignal: signal,
  });
  const body = object.Body;
  let bytes: Buffer;
  try {
    if (!body || object.ContentLength !== source.contentLength) throw mismatch();
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const piece of body as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted();
      const chunk = Buffer.from(piece);
      size += chunk.byteLength;
      if (size > source.contentLength || size > MAX_COPY_BYTES) throw mismatch();
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  } finally {
    (body as { destroy?: () => void } | undefined)?.destroy?.();
  }
  if (
    bytes.length !== source.contentLength ||
    createHash('sha256').update(bytes).digest('hex') !== source.checksumSha256
  )
    throw mismatch();
  const verifiedContentType = content.detectContentType(bytes);
  if (verifiedContentType && content.contentTypeConflicts(source.contentType, verifiedContentType))
    throw mismatch();
  const checksum = Buffer.from(source.checksumSha256, 'hex').toString('base64');
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: target.bucket,
        Key: target.key,
        Body: bytes,
        ContentType: source.contentType,
        IfNoneMatch: '*',
        ChecksumSHA256: checksum,
        Metadata: { 'prospect-copy-digest': target.payloadDigest },
      }),
      { abortSignal: signal },
    );
  } catch (error) {
    const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (failure?.name !== 'PreconditionFailed' && failure?.$metadata?.httpStatusCode !== 412)
      throw error;
    const existing = await s3.send(
      new HeadObjectCommand({
        Bucket: target.bucket,
        Key: target.key,
        ChecksumMode: 'ENABLED',
      }),
      { abortSignal: signal },
    );
    if (
      existing.ContentLength !== source.contentLength ||
      existing.ChecksumSHA256 !== checksum ||
      existing.ContentType !== source.contentType ||
      existing.Metadata?.['prospect-copy-digest'] !== target.payloadDigest
    )
      throw mismatch();
  }
  return { verifiedContentType };
}
