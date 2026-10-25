import { ConflictException } from '@nestjs/common';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';

export interface FileDeleteObject {
  bucket: string;
  key: string;
  etag: string | null;
}

// Bound the entire SDK call, including credential resolution and SDK retries.
async function storageRequest<T>(send: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('File storage request timed out'), { name: 'TimeoutError' }));
      controller.abort();
    }, 10_000);
  });
  try {
    return await Promise.race([send(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function missingObject(error: unknown): boolean {
  const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    failure?.$metadata?.httpStatusCode === 404 &&
    (failure.name === 'NotFound' || failure.name === 'NoSuchKey')
  );
}

function exactEtag(etag: unknown): etag is string {
  return typeof etag === 'string' && etag.trim().length > 0 && etag.trim() !== '*';
}

async function listedTargetAbsent(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  const listed = await storageRequest((abortSignal) =>
    s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }), { abortSignal }),
  );
  const contents = listed.Contents ?? [];
  if (
    listed.$metadata.httpStatusCode !== 200 ||
    listed.Name !== bucket ||
    listed.Prefix !== key ||
    listed.MaxKeys !== 1 ||
    typeof listed.IsTruncated !== 'boolean' ||
    !Array.isArray(contents) ||
    contents.length > 1 ||
    listed.KeyCount !== contents.length ||
    (listed.CommonPrefixes?.length ?? 0) !== 0 ||
    (listed.IsTruncated && (contents.length === 0 || !listed.NextContinuationToken)) ||
    contents.some((object) => typeof object.Key !== 'string' || !object.Key.startsWith(key))
  )
    return false;
  // General-purpose S3 buckets sort keys lexicographically: the exact key precedes
  // every longer prefix neighbor. No delimiter, StartAfter or pagination can skip it.
  // Listing is absence evidence only; its ETag never authorizes deletion.
  return contents[0]?.Key !== key;
}

/** Capture the current object identity for the domain owner to retain before deletion. */
export async function inspectFileDeleteObject(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<FileDeleteObject> {
  let object;
  try {
    object = await storageRequest((abortSignal) =>
      s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal }),
    );
  } catch (error) {
    if (missingObject(error)) return { bucket, key, etag: null };
    const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
      ?.httpStatusCode;
    if (status === 403 && (await listedTargetAbsent(s3, bucket, key)))
      return { bucket, key, etag: null };
    throw error;
  }
  if (!exactEtag(object.ETag)) throw new Error('File storage did not return an exact object ETag');
  return { bucket, key, etag: object.ETag };
}

/** Success means current-object absence was observed, not permanent erasure of old versions.
 * An uncertain write remains an error; retry with the same retained snapshot. */
export async function removeFileDeleteObject(
  s3: S3Client,
  snapshot: FileDeleteObject,
): Promise<void> {
  // Copy the retained identity before awaiting: never let a later mutation redirect the delete.
  const { bucket, key, etag } = snapshot;
  if (etag !== null && !exactEtag(etag))
    throw new Error('An exact retained object ETag is required');
  const current = await inspectFileDeleteObject(s3, bucket, key);
  if (current.etag === null) return;
  if (etag === null || current.etag !== etag)
    throw new ConflictException('The file in storage has changed since deletion was recorded');

  try {
    await storageRequest((abortSignal) =>
      s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, IfMatch: etag }), {
        abortSignal,
      }),
    );
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
      ?.httpStatusCode;
    if (!missingObject(error) && status !== 409 && status !== 412) throw error;
    // A conditional conflict can mean a concurrent delete or replacement. Never retry a write here.
    if ((await inspectFileDeleteObject(s3, bucket, key)).etag === null) return;
    throw error;
  }
  if ((await inspectFileDeleteObject(s3, bucket, key)).etag !== null)
    throw new ConflictException('File storage still contains an object after deletion');
}
