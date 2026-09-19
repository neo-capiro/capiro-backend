/**
 * S3-backed byte storage for Hermes-published `ClioArtifact` rows (Phase 1
 * backlog #11: artifact storage parity). Replaces the Phase 0 prototype that
 * inlined artifact bytes as base64 inside `ClioArtifact.metadata.inlineBase64`
 * (2 MiB cap, `storage: 'inline_prototype'`).
 *
 * There is no shared `ObjectStorage`/`S3Client` wrapper elsewhere in this
 * codebase to reuse (every feature area — `EngagementService`,
 * `ClientsService`, `BrandingService`, etc. — builds its own `S3Client` field
 * from `ASSETS_BUCKET` / `AWS_REGION_DEFAULT`); this follows that same
 * per-feature convention rather than inventing a new generic abstraction.
 *
 * `ClioArtifact.s3Key` already exists as a column (unused by this path until
 * now — see `apps/api/prisma/schema.prisma`), so no migration is needed.
 */
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/config.schema.js';

@Injectable()
export class MeriHermesArtifactStorageService {
  private readonly logger = new Logger(MeriHermesArtifactStorageService.name);
  private readonly s3: S3Client;
  private readonly bucket: string | undefined;

  constructor(config: ConfigService<AppConfig, true>) {
    this.bucket = config.get('ASSETS_BUCKET', { infer: true });
    this.s3 = new S3Client({ region: config.get('AWS_REGION_DEFAULT', { infer: true }) });
  }

  get configured(): boolean {
    return Boolean(this.bucket);
  }

  /** `tenants/<tenantId>/hermes-artifacts/<runId>/<uuid>/<safe-filename>` — mirrors EngagementService's attachment key shape. */
  buildKey(input: { tenantId: string; runId: string; filename: string | null }): string {
    const safeName =
      (input.filename ?? 'artifact').replace(/[^\w.\- ]+/g, '_').slice(0, 200).trim() || 'artifact';
    return `tenants/${input.tenantId}/hermes-artifacts/${input.runId}/${randomUUID()}/${safeName}`;
  }

  async putBytes(key: string, bytes: Buffer, contentType: string | null): Promise<void> {
    if (!this.bucket) throw new ServiceUnavailableException('ASSETS_BUCKET is not configured');
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType ?? 'application/octet-stream',
      }),
    );
  }

  async getBytes(key: string): Promise<Buffer> {
    if (!this.bucket) throw new ServiceUnavailableException('ASSETS_BUCKET is not configured');
    const object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = object.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body?.transformToByteArray) {
      this.logger.error(`S3 object ${key} returned no readable body`);
      throw new Error(`Artifact object ${key} has no body`);
    }
    return Buffer.from(await body.transformToByteArray());
  }
}
