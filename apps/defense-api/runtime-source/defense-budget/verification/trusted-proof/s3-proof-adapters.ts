/**
 * R8.2 Workstream B — AWS SDK adapters for production proof resolution.
 *
 * Bridges the existing `@aws-sdk/client-s3` dependency (the same SDK the
 * repository already uses in `defense-budget/s3-aws-commands.ts`) into the
 * narrow reader contracts owned by the verifier:
 *
 *   - `S3ObjectReader` (archive-proof-resolver.ts) — head + bytes for
 *     immutable archive proof;
 *   - `S3ReaderDeps` (trusted-byte-locator-reader.ts) — head + bytes for the
 *     S3 byte locator reader.
 *
 * Rules honored here:
 *   - No second AWS configuration system. Region/credentials come from the
 *     standard AWS SDK environment conventions. The only verifier-scoped
 *     setting is `BUDGET_VERIFICATION_S3_ENDPOINT`, which points at a local
 *     S3-compatible container (LocalStack/MinIO) for testing. When that
 *     endpoint is a non-AWS URL the client uses path-style addressing. It is
 *     never set in production.
 *   - Missing objects (NoSuchKey / NotFound / 404) resolve to `null` so the
 *     proof resolvers can classify them as `missing`. Every other failure is
 *     rethrown — proof resolution fails closed, it never downgrades.
 *   - SHA comparison uses the verifier's own recomputed bytes hash by
 *     default. A response checksum is only surfaced when it is an explicit
 *     full-object SHA-256 (ChecksumAlgorithm SHA256), converted from the
 *     SDK's base64 form to hex. Multipart-uploaded objects carry a
 *     composite `etag-md5` checksum which is never treated as SHA-256.
 */
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { S3ObjectReader, S3ObjectMetadata } from './archive-proof-resolver.js';
import type { S3ReaderDeps, S3HeadResult } from './trusted-byte-locator-reader.js';

/** Environment key for the verifier-scoped test-only S3 endpoint. */
export const BUDGET_VERIFICATION_S3_ENDPOINT_ENV = 'BUDGET_VERIFICATION_S3_ENDPOINT';

/** AWS SDK error names / status codes that mean "object does not exist". */
function isObjectMissing(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.name === 'NoSuchBucket') {
    return true;
  }
  return e?.$metadata?.httpStatusCode === 404;
}

/** Convert the SDK's base64 full-object SHA-256 checksum to hex. */
function base64ChecksumToHex(base64: string): string | null {
  try {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length !== 32) return null;
    return bytes.toString('hex');
  } catch {
    return null;
  }
}

export interface SdkS3ProofClientOptions {
  /** Pre-built client (dependency injection for tests). */
  client?: S3Client;
}

/**
 * S3 proof client over the AWS SDK. One instance owns one S3Client; call
 * `destroy()` when verification finishes (the CLI does this in `finally`).
 */
export class SdkS3ProofClient implements S3ObjectReader, S3ReaderDeps {
  private readonly client: S3Client;
  private readonly ownsClient: boolean;

  constructor(options: SdkS3ProofClientOptions = {}) {
    if (options.client) {
      this.client = options.client;
      this.ownsClient = false;
    } else {
      this.client = createBudgetVerificationS3Client(process.env);
      this.ownsClient = true;
    }
  }

  async getObjectBytes(bucket: string, key: string, versionId?: string): Promise<Buffer | null> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
      );
      const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      if (!body?.transformToByteArray) {
        throw new Error(`empty body for s3://${bucket}/${key}`);
      }
      const bytes = await body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err) {
      if (isObjectMissing(err)) return null;
      throw err;
    }
  }

  async headObject(
    bucket: string,
    key: string,
    versionId?: string,
  ): Promise<(S3ObjectMetadata & S3HeadResult) | null> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
      );

      // Only an explicit full-object SHA-256 checksum is usable as proof.
      // The SDK's HeadObjectOutput exposes ChecksumSHA256 (base64 of the raw
      // 32-byte digest) when the object carries a SHA256 checksum; composite
      // multipart checksums (etag-md5) are never surfaced as SHA-256 because
      // base64ChecksumToHex rejects non-32-byte digests.
      let checksumSha256: string | undefined;
      if (typeof out.ChecksumSHA256 === 'string') {
        checksumSha256 = base64ChecksumToHex(out.ChecksumSHA256) ?? undefined;
      }

      return {
        contentLength: out.ContentLength,
        checksumSha256,
        sha256Checksum: checksumSha256,
        objectLockMode: out.ObjectLockMode,
        retainUntil: out.ObjectLockRetainUntilDate?.toISOString(),
        retainUntilDate: out.ObjectLockRetainUntilDate?.toISOString(),
        kmsKeyArn:
          out.ServerSideEncryption === 'aws:kms' && out.SSEKMSKeyId ? out.SSEKMSKeyId : undefined,
      };
    } catch (err) {
      if (isObjectMissing(err)) return null;
      throw err;
    }
  }

  /** Release the underlying SDK client. Safe to call more than once. */
  async destroy(): Promise<void> {
    if (this.ownsClient) {
      this.client.destroy();
    }
  }
}

/**
 * Create the verifier-scoped S3 client using the existing AWS SDK
 * conventions (region/credentials from the environment or instance
 * metadata). The optional `BUDGET_VERIFICATION_S3_ENDPOINT` setting points at
 * a local S3-compatible container for tests; it is never used by default in
 * production.
 */
export function createBudgetVerificationS3Client(env: NodeJS.ProcessEnv = process.env): S3Client {
  const endpoint = env[BUDGET_VERIFICATION_S3_ENDPOINT_ENV];
  const config: S3ClientConfig = {};
  if (endpoint) {
    config.endpoint = endpoint;
    // LocalStack/MinIO require path-style addressing for non-AWS hosts.
    const hostIsAws = /(^|\.)amazonaws\.com$/.test(new URL(endpoint).hostname);
    config.forcePathStyle = !hostIsAws;
  }
  return new S3Client(config);
}
