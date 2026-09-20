/**
 * Phase 10B-1 repair — reads the exact archived bytes for an already-
 * registered SourceDocument back out of the immutable S3 raw-archive bucket.
 *
 * Uses the same AWS SDK conventions as `s3-aws-commands.ts` / the trusted
 * proof S3 adapters: no second AWS configuration system, region/credentials
 * come from the standard SDK environment. `GetObjectCommand` is version-
 * pinned by `versionId` when the archive result carried one, so a replay
 * reads the exact object version DocumentRegistrar wrote — never "whatever
 * is live at that key now".
 */
import { createHash } from 'node:crypto';
import { GetObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type {
  ArchivedSourceBytes,
  SourceDocumentArchiveLocator,
  SourceDocumentArchiveReadPort,
} from './observation-ingestion-bridge.ports.js';

export interface S3SourceDocumentArchiveReadAdapterOptions {
  /** Pre-built client (dependency injection for tests). */
  readonly client?: S3Client;
}

export class S3SourceDocumentArchiveReadAdapter implements SourceDocumentArchiveReadPort {
  private readonly client: S3Client;
  private readonly ownsClient: boolean;

  constructor(options: S3SourceDocumentArchiveReadAdapterOptions = {}) {
    if (options.client) {
      this.client = options.client;
      this.ownsClient = false;
    } else {
      const endpoint = process.env.BUDGET_VERIFICATION_S3_ENDPOINT?.trim();
      const config: S3ClientConfig = {};
      if (endpoint) {
        config.endpoint = endpoint;
        const hostIsAws = /(^|\.)amazonaws\.com$/.test(new URL(endpoint).hostname);
        config.forcePathStyle = !hostIsAws;
      }
      this.client = new S3Client(config);
      this.ownsClient = true;
    }
  }

  async readMaterializedBytes(
    locator: SourceDocumentArchiveLocator,
    options: { readonly abortSignal?: AbortSignal } = {},
  ): Promise<ArchivedSourceBytes> {
    options.abortSignal?.throwIfAborted();
    const out = await this.client.send(
      new GetObjectCommand({
        Bucket: locator.bucket,
        Key: locator.key,
        ...(locator.versionId ? { VersionId: locator.versionId } : {}),
      }),
      options.abortSignal ? { abortSignal: options.abortSignal } : undefined,
    );
    options.abortSignal?.throwIfAborted();
    const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body?.transformToByteArray) {
      throw new Error(
        `empty body for archived SourceDocument object s3://${locator.bucket}/${locator.key}` +
          `${locator.versionId ? `@${locator.versionId}` : ''}`,
      );
    }
    const bytes = Buffer.from(await body.transformToByteArray());
    options.abortSignal?.throwIfAborted();
    return { bytes, contentSha256: createHash('sha256').update(bytes).digest('hex') };
  }

  /** Release the underlying SDK client. Safe to call more than once. */
  async destroy(): Promise<void> {
    if (this.ownsClient) this.client.destroy();
  }
}
