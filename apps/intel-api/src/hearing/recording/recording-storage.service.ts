import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';

/** Uses the existing private assets bucket and IAM credential chain. No public ACL. */
@Injectable()
export class RecordingStorageService {
  readonly enabled: boolean;
  private readonly bucket: string;
  private readonly kmsKey?: string;
  private readonly s3: S3Client;

  constructor(config: ConfigService) {
    this.bucket = config.get<string>('ASSETS_BUCKET')?.trim() ?? '';
    this.kmsKey = config.get<string>('HEARING_AUDIO_KMS_KEY_ID')?.trim() || undefined;
    this.enabled =
      config.get<string>('HEARING_AUDIO_STORAGE_ENABLED') === 'true' && Boolean(this.bucket);
    this.s3 = new S3Client({
      region: config.get<string>('AWS_REGION_DEFAULT') ?? 'us-east-1',
      maxAttempts: 2,
    });
  }

  assertReady() {
    if (!this.enabled)
      throw new ServiceUnavailableException('Retained hearing audio is not enabled');
  }

  private object(key: string) {
    if (!this.bucket) throw new ServiceUnavailableException('Recording storage is not configured');
    if (
      !/^hearing-audio\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\//.test(key) ||
      key.includes('..')
    ) {
      throw new Error('Invalid private recording object');
    }
    return { Bucket: this.bucket, Key: key };
  }

  async put(
    key: string,
    bytes: Buffer | Readable,
    size: number,
    sha256: string,
    contentType = 'application/octet-stream',
    cancellation?: AbortSignal,
  ) {
    this.assertReady();
    const object = this.object(key);
    const deadline = AbortSignal.timeout(Buffer.isBuffer(bytes) ? 8_000 : 120_000);
    const signal = cancellation ? AbortSignal.any([deadline, cancellation]) : deadline;
    try {
      await this.s3.send(
        new PutObjectCommand({
          ...object,
          Body: bytes,
          ContentLength: size,
          ContentType: contentType,
          IfNoneMatch: '*',
          ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
          Metadata: { sha256 },
          ServerSideEncryption: this.kmsKey ? 'aws:kms' : 'AES256',
          ...(this.kmsKey ? { SSEKMSKeyId: this.kmsKey } : {}),
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412)
        throw error;
      // Retry after S3 success / DB failure: only identical immutable bytes qualify.
      const headDeadline = AbortSignal.timeout(8_000);
      const existing = await this.s3.send(new HeadObjectCommand(object), {
        abortSignal: cancellation ? AbortSignal.any([headDeadline, cancellation]) : headDeadline,
      });
      if (existing.ContentLength !== size || existing.Metadata?.sha256 !== sha256) {
        throw new Error('Conflicting immutable recording object');
      }
    }
  }

  async read(key: string): Promise<Readable> {
    const result = await this.s3.send(new GetObjectCommand(this.object(key)), {
      abortSignal: AbortSignal.timeout(30_000),
    });
    if (!result.Body) throw new Error('Recording object is unavailable');
    return result.Body as Readable;
  }

  async playbackUrl(
    key: string,
    expiresIn: number,
    contentType: 'audio/webm' | 'audio/wav' = 'audio/webm',
  ) {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        ...this.object(key),
        ResponseContentType: contentType,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: Math.min(60, Math.max(1, expiresIn)) },
    );
  }

  async remove(key: string) {
    await this.s3.send(new DeleteObjectCommand(this.object(key)), {
      abortSignal: AbortSignal.timeout(15_000),
    });
  }

  /** Includes orphaned uploads and assembled artifacts, not just known DB parts. */
  async purgeRecording(tenantId: string, recordingId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(tenantId) || !/^[a-zA-Z0-9_-]+$/.test(recordingId) || !this.bucket)
      throw new Error('Invalid recording purge scope');
    const Prefix = `hearing-audio/${tenantId}/${recordingId}/`;
    return this.purgePrefix(Prefix);
  }

  async purgeEpoch(tenantId: string, recordingId: string, epochId: string) {
    if (
      ![tenantId, recordingId, epochId].every((value) => /^[a-zA-Z0-9_-]+$/.test(value)) ||
      !this.bucket
    )
      throw Error('Invalid epoch purge scope');
    return this.purgePrefix(`hearing-audio/${tenantId}/${recordingId}/${epochId}/`);
  }

  private async purgePrefix(Prefix: string) {
    let KeyMarker: string | undefined, VersionIdMarker: string | undefined;
    do {
      // Version enumeration also works for an unversioned bucket (version=null).
      // Deleting only current keys would retain audio in noncurrent versions.
      const listed = await this.s3.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix,
          KeyMarker,
          VersionIdMarker,
          MaxKeys: 500,
        }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      const Objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].flatMap(
        (object) =>
          object.Key?.startsWith(Prefix) ? [{ Key: object.Key, VersionId: object.VersionId }] : [],
      );
      if (Objects.length) {
        const deleted = await this.s3.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects, Quiet: true } }),
          { abortSignal: AbortSignal.timeout(15_000) },
        );
        if (deleted.Errors?.length)
          throw new Error('Some expired recording objects could not be deleted');
      }
      KeyMarker = listed.IsTruncated ? listed.NextKeyMarker : undefined;
      VersionIdMarker = listed.IsTruncated ? listed.NextVersionIdMarker : undefined;
    } while (KeyMarker);
  }
}
