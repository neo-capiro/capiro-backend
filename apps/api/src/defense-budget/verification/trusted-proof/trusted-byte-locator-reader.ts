/**
 * TrustedByteLocatorReader — production-capable byte reader contract.
 *
 * Routes `file://` and approved local paths to the filesystem reader,
 * `s3://bucket/key?versionId=...` to the S3 reader.
 * No silent fallback between filesystem and S3.
 * Unsupported locator schemes fail closed.
 */
import type { JsonValue } from '../../contracts/canonical-json.js';

export interface TrustedLocatedBytes {
  locator: string;
  bytes: Buffer;
  kind: 'filesystem' | 's3';
  bucket?: string;
  key?: string;
  versionId?: string;
  contentLength?: number;
  checksumSha256?: string;
  objectLockMode?: string;
  retainUntil?: string;
  kmsKeyArn?: string;
}

export interface TrustedByteLocatorReader {
  /** Read raw bytes from a locator. Throws on unsupported scheme, missing file, or access error. */
  read(locator: string): Promise<TrustedLocatedBytes>;
}

/* ------------------------------------------------------------------ */
/* Filesystem reader                                                   */
/* ------------------------------------------------------------------ */

import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

export class FilesystemByteLocatorReader implements TrustedByteLocatorReader {
  constructor(
    /** Optional approved prefix list. If empty, all filesystem paths are accepted. */
    private readonly approvedPrefixes: readonly string[] = [],
  ) {}

  async read(locator: string): Promise<TrustedLocatedBytes> {
    // Strip file:// prefix if present
    const path = locator.startsWith('file://') ? locator.slice(7) : locator;

    // Check approved prefixes
    if (this.approvedPrefixes.length > 0) {
      const allowed = this.approvedPrefixes.some((prefix) => path.startsWith(prefix));
      if (!allowed) {
        throw new Error(`filesystem path "${path}" is not in approved prefix list`);
      }
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(path);
    } catch (err) {
      throw new Error(`failed to read filesystem locator "${path}": ${(err as Error).message}`);
    }

    const checksumSha256 = createHash('sha256').update(bytes).digest('hex');

    return {
      locator,
      bytes,
      kind: 'filesystem',
      contentLength: bytes.length,
      checksumSha256,
    };
  }
}

/* ------------------------------------------------------------------ */
/* S3 reader                                                           */
/* ------------------------------------------------------------------ */

export interface S3ReaderDeps {
  getObjectBytes(bucket: string, key: string, versionId?: string): Promise<Buffer | null>;
  headObject(bucket: string, key: string, versionId?: string): Promise<S3HeadResult | null>;
}

export interface S3HeadResult {
  contentLength?: number;
  checksumSha256?: string;
  objectLockMode?: string;
  retainUntil?: string;
  kmsKeyArn?: string;
}

/**
 * Parse an S3 locator of the form:
 *   s3://bucket/key?versionId=...&other=ignored
 */
function parseS3Locator(locator: string): { bucket: string; key: string; versionId?: string } | null {
  try {
    const url = new URL(locator);
    if (url.protocol !== 's3:') return null;
    const bucket = url.hostname;
    const key = decodeURIComponent(url.pathname.slice(1)); // remove leading /
    const versionId = url.searchParams.get('versionId') ?? undefined;
    if (!bucket || !key) return null;
    return { bucket, key, versionId };
  } catch {
    return null;
  }
}

export class S3ByteLocatorReader implements TrustedByteLocatorReader {
  constructor(private readonly deps: S3ReaderDeps) {}

  async read(locator: string): Promise<TrustedLocatedBytes> {
    const parsed = parseS3Locator(locator);
    if (!parsed) {
      throw new Error(`invalid S3 locator: "${locator}"`);
    }

    const { bucket, key, versionId } = parsed;

    // Head first for metadata
    const head = await this.deps.headObject(bucket, key, versionId);

    // Read exact bytes
    const bytes = await this.deps.getObjectBytes(bucket, key, versionId);
    if (!bytes) {
      throw new Error(
        `S3 object not found: ${bucket}/${key}${versionId ? `@${versionId}` : ''}`,
      );
    }

    const checksumSha256 =
      head?.checksumSha256 ??
      createHash('sha256').update(bytes).digest('hex');

    return {
      locator,
      bytes,
      kind: 's3',
      bucket,
      key,
      versionId,
      contentLength: head?.contentLength ?? bytes.length,
      checksumSha256,
      objectLockMode: head?.objectLockMode,
      retainUntil: head?.retainUntil,
      kmsKeyArn: head?.kmsKeyArn,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Composite reader — routes by scheme                                 */
/* ------------------------------------------------------------------ */

export class CompositeByteLocatorReader implements TrustedByteLocatorReader {
  constructor(
    private readonly filesystemReader?: FilesystemByteLocatorReader,
    private readonly s3Reader?: S3ByteLocatorReader,
  ) {}

  async read(locator: string): Promise<TrustedLocatedBytes> {
    // Determine scheme
    if (locator.startsWith('s3://')) {
      if (!this.s3Reader) {
        throw new Error('S3 locator requested but no S3 reader configured');
      }
      return this.s3Reader.read(locator);
    }

    // Filesystem: file:// prefix or bare path
    if (locator.startsWith('file://') || locator.startsWith('/') || /^[A-Za-z]:/.test(locator)) {
      if (!this.filesystemReader) {
        throw new Error('filesystem locator requested but no filesystem reader configured');
      }
      return this.filesystemReader.read(locator);
    }

    throw new Error(`unsupported locator scheme: "${locator}"`);
  }
}

/* ------------------------------------------------------------------ */
/* sha256Bytes helper                                                  */
/* ------------------------------------------------------------------ */

export function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}