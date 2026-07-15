/**
 * PE Watch defense-budget raw archive — content-addressed, immutable S3 upload.
 *
 * NON-NEGOTIABLE INVARIANT (defense-budget-document-ingestion.md §"S3 raw archive
 * contract"): original bytes are archived to the Object-Lock raw bucket BEFORE any
 * parsing, and a SourceDocument row is only trustworthy once it carries the returned
 * S3 VersionId. This module owns that upload and NOTHING else (no DB writes here).
 *
 * Idempotency: keys are content-addressed by sha256. Re-archiving identical bytes is a
 * HEAD + reuse (no duplicate object, no wasted PUT). Distinct retrieval aliases (e.g.
 * "AF_OM_Vol1.pdf" and "AF_OM_Vol1 (1).pdf" that hash the same) are preserved in
 * retrieval.json without creating a second raw object.
 *
 * The S3 client is injected via a narrow interface so specs drive it with an in-memory
 * fake — no AWS calls in unit tests.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

/** Narrow slice of @aws-sdk/client-s3 we actually use — keeps specs trivial to fake. */
export interface S3Like {
  send(command: unknown): Promise<Record<string, unknown>>;
}

/** Command factories injected so the real AWS SDK stays out of the unit tests. */
export interface S3CommandFactory {
  head(input: { Bucket: string; Key: string }): unknown;
  put(input: {
    Bucket: string;
    Key: string;
    Body: Buffer | string;
    ContentType: string;
    ChecksumSHA256?: string;
    IfNoneMatch?: string;
    ServerSideEncryption: string;
    SSEKMSKeyId?: string;
    ObjectLockMode?: string;
    ObjectLockRetainUntilDate?: Date;
  }): unknown;
}

export interface RawArchiveConfig {
  bucket: string;
  kmsKeyArn?: string;
  retentionYears: number;
}

export interface ArchiveDescriptor {
  /** Stable document id used in the key path (SourceDocument.id or a deterministic slug). */
  documentId: string;
  fiscalYear: number | null;
  /** dod-comptroller | hasc | sasc | hac_d | sac_d | ndaa_conference | public_law | ... */
  sourceAuthority: string;
  /** rdte | procurement | om | milcon | committee | ... */
  family: string;
  /** Absolute path to the local original PDF. */
  localPath: string;
  contentType?: string;
  /** Every URL/local alias that resolves to these exact bytes (dedup-preserving). */
  retrievalAliases?: string[];
  /** Free-form manifest extras (classification, stage, exhibits, page/byte counts). */
  manifest?: Record<string, unknown>;
}

export interface ArchiveResult {
  bucket: string;
  key: string;
  versionId: string | null;
  sha256: string;
  byteSize: number;
  kmsKeyArn?: string;
  retainUntil: Date;
  /** True when a brand-new object was PUT; false when identical bytes already existed. */
  created: boolean;
  retrievalKey: string;
  manifestKey: string;
}

export function sha256OfBuffer(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256OfFile(filePath: string): string {
  return sha256OfBuffer(fs.readFileSync(filePath));
}

/** base64 of the raw sha256 digest — the form S3 ChecksumSHA256 expects. */
export function sha256Base64OfBuffer(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('base64');
}

/**
 * Content-addressed key prefix. Mirrors the documented layout exactly:
 *   raw/public/dod-budget/fiscal_year={FY}/source_authority={auth}/family={fam}/document_id={id}/sha256={sha}/
 */
export function buildKeyPrefix(d: ArchiveDescriptor, sha256: string): string {
  const fy = d.fiscalYear == null ? 'unknown' : String(d.fiscalYear);
  return [
    'raw/public/dod-budget',
    `fiscal_year=${fy}`,
    `source_authority=${d.sourceAuthority}`,
    `family=${d.family}`,
    `document_id=${d.documentId}`,
    `sha256=${sha256}`,
  ].join('/');
}

function retainUntilFrom(now: Date, years: number): Date {
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
}

export class RawArchiveService {
  constructor(
    private readonly s3: S3Like,
    private readonly commands: S3CommandFactory,
    private readonly config: RawArchiveConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Archive the original PDF. Recomputes sha256 immediately before upload (bytes could
   * change between an earlier inventory pass and now), HEADs the content-addressed key,
   * and only PUTs when absent. Sidecars (retrieval.json, manifest.json) are written AFTER
   * the original so an extraction artifact can never be the sole retained copy.
   */
  async archiveOriginal(d: ArchiveDescriptor): Promise<ArchiveResult> {
    const bytes = fs.readFileSync(d.localPath);
    const sha256 = sha256OfBuffer(bytes);
    const prefix = buildKeyPrefix(d, sha256);
    const ext = d.localPath.toLowerCase().endsWith('.pdf') ? 'pdf' : d.localPath.split('.').pop() || 'bin';
    const key = `${prefix}/original.${ext}`;
    const retrievalKey = `${prefix}/retrieval.json`;
    const manifestKey = `${prefix}/manifest.json`;
    const contentType = d.contentType ?? 'application/pdf';
    const now = this.clock();
    const retainUntil = retainUntilFrom(now, this.config.retentionYears);

    // 1. HEAD the content-addressed original. Present => reuse (idempotent, no re-PUT).
    let created = false;
    let versionId: string | null = null;
    const existing = await this.headSafe(key);
    if (existing.exists) {
      versionId = (existing.versionId as string | undefined) ?? null;
    } else {
      // 2. PUT original FIRST — If-None-Match:* guards against a race double-write,
      //    SSE-KMS + Object-Lock retention satisfy the bucket policy + immutability.
      const putRes = await this.s3.send(
        this.commands.put({
          Bucket: this.config.bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          ChecksumSHA256: sha256Base64OfBuffer(bytes),
          IfNoneMatch: '*',
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: this.config.kmsKeyArn,
          ObjectLockMode: 'GOVERNANCE',
          ObjectLockRetainUntilDate: retainUntil,
        }),
      );
      versionId = (putRes?.VersionId as string | undefined) ?? null;
      created = true;
    }

    // 3. Sidecars AFTER the original.
    const retrieval = {
      documentId: d.documentId,
      sha256,
      byteSize: bytes.byteLength,
      aliases: dedupeAliases(d.retrievalAliases, d.localPath),
      archivedAt: now.toISOString(),
    };
    await this.s3.send(
      this.commands.put({
        Bucket: this.config.bucket,
        Key: retrievalKey,
        Body: JSON.stringify(retrieval, null, 2),
        ContentType: 'application/json',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.config.kmsKeyArn,
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: retainUntil,
      }),
    );

    const manifest = {
      documentId: d.documentId,
      fiscalYear: d.fiscalYear,
      sourceAuthority: d.sourceAuthority,
      family: d.family,
      sha256,
      byteSize: bytes.byteLength,
      s3: { bucket: this.config.bucket, key, versionId },
      kmsKeyArn: this.config.kmsKeyArn,
      retainUntil: retainUntil.toISOString(),
      ...d.manifest,
    };
    await this.s3.send(
      this.commands.put({
        Bucket: this.config.bucket,
        Key: manifestKey,
        Body: JSON.stringify(manifest, null, 2),
        ContentType: 'application/json',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.config.kmsKeyArn,
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: retainUntil,
      }),
    );

    return {
      bucket: this.config.bucket,
      key,
      versionId,
      sha256,
      byteSize: bytes.byteLength,
      kmsKeyArn: this.config.kmsKeyArn,
      retainUntil,
      created,
      retrievalKey,
      manifestKey,
    };
  }

  /** Archive a derived parse output (markdown/json) under the derived/ prefix (not Object-Lock-sensitive, but same bucket+KMS). */
  async archiveDerived(
    d: ArchiveDescriptor,
    sha256: string,
    filename: string,
    body: string,
    contentType: string,
  ): Promise<{ bucket: string; key: string; versionId: string | null }> {
    const prefix = buildKeyPrefix(d, sha256).replace('raw/public/dod-budget', 'derived/public/dod-budget');
    const key = `${prefix}/${filename}`;
    const now = this.clock();
    const res = await this.s3.send(
      this.commands.put({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: this.config.kmsKeyArn,
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: retainUntilFrom(now, this.config.retentionYears),
      }),
    );
    return { bucket: this.config.bucket, key, versionId: (res?.VersionId as string | undefined) ?? null };
  }

  private async headSafe(key: string): Promise<{ exists: boolean; versionId?: string }> {
    try {
      const res = await this.s3.send(this.commands.head({ Bucket: this.config.bucket, Key: key }));
      return { exists: true, versionId: res?.VersionId as string | undefined };
    } catch (err) {
      const name = (err as { name?: string; $metadata?: { httpStatusCode?: number } })?.name;
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) return { exists: false };
      throw err;
    }
  }
}

function dedupeAliases(aliases: string[] | undefined, localPath: string): string[] {
  const set = new Set<string>(aliases ?? []);
  set.add(localPath);
  return Array.from(set);
}
