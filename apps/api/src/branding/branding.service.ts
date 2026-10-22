import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']);
const MAX_BYTES = 2 * 1024 * 1024;
const UPLOAD_TTL_MS = 300_000;

function extension(contentType: string): string | null {
  return ALLOWED_MIME.has(contentType)
    ? contentType === 'image/svg+xml' ? 'svg' : contentType.split('/')[1] ?? null
    : null;
}

function ownedLogoKey(tenantId: string, key: string, contentType: string, allowLegacy = false) {
  const prefix = `tenants/${tenantId}/branding/`;
  const ext = extension(contentType);
  if (!ext || !key.startsWith(prefix)) return false;
  const filename = key.slice(prefix.length);
  return (allowLegacy && filename === `logo.${ext}`) ||
    new RegExp(`^logo-\\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${ext}$`).test(filename);
}

@Injectable()
export class BrandingService {
  private readonly logger = new Logger(BrandingService.name);
  private readonly s3: S3Client;
  private readonly bucket: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<AppConfig, true>,
  ) {
    const region = config.get('AWS_REGION_DEFAULT', { infer: true });
    this.bucket = config.get('ASSETS_BUCKET', { infer: true });
    this.s3 = new S3Client({ region });
  }

  async getBranding(ctx: TenantContext) {
    const tenant = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: {
          id: true,
          slug: true,
          name: true,
          logoS3Key: true,
          logoContentType: true,
          logoUploadedAt: true,
        },
      }),
    );
    if (!tenant) return null;
    // Treat persisted metadata as untrusted too: old generic writes could
    // store arbitrary bucket keys. Never return or sign those keys.
    if (tenant.logoS3Key && !ownedLogoKey(ctx.tenantId, tenant.logoS3Key, tenant.logoContentType ?? '', true)) {
      return { ...tenant, logoS3Key: null, logoContentType: null, logoUploadedAt: null, logoUrl: null };
    }
    const logoUrl = tenant.logoS3Key ? await this.signedGetUrl(tenant.logoS3Key) : null;
    return { ...tenant, logoUrl };
  }

  /**
   * Issue a presigned POST policy that lets the browser upload directly to
   * S3. Limits: content type whitelist + 2 MB. Key is fully tenant-scoped:
   *   tenants/{tenantId}/branding/logo-{issuedAt}-{uploadId}.{ext}
   * Different upload requests cannot reuse a shared canonical object key.
   */
  async createLogoUploadUrl(ctx: TenantContext, contentType: string, contentLength: number) {
    if (!this.bucket) {
      throw new BadRequestException(
        'Asset uploads are not configured (ASSETS_BUCKET unset)',
      );
    }
    if (!ALLOWED_MIME.has(contentType)) {
      throw new BadRequestException(`Unsupported content type: ${contentType}`);
    }
    if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > MAX_BYTES) {
      throw new BadRequestException(`Logo must be <= ${MAX_BYTES} bytes`);
    }
    const issuedAt = String(Date.now());
    const s3Key = `tenants/${ctx.tenantId}/branding/logo-${issuedAt}-${randomUUID()}.${extension(contentType)}`;
    const presigned = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: s3Key,
      Conditions: [
        ['content-length-range', 1, MAX_BYTES],
        ['eq', '$Content-Type', contentType],
        ['eq', '$key', s3Key],
        ['eq', '$x-amz-meta-tenant-id', ctx.tenantId],
        ['eq', '$x-amz-meta-upload-issued-at', issuedAt],
      ],
      Fields: {
        'Content-Type': contentType,
        'x-amz-meta-tenant-id': ctx.tenantId,
        'x-amz-meta-upload-issued-at': issuedAt,
      },
      Expires: 300, // 5 min
    });
    return { ...presigned, s3Key };
  }

  /**
   * Confirm the upload happened. We HEAD the object to verify it exists +
   * matches the declared content type, then update the tenant row.
   */
  async confirmLogoUpload(ctx: TenantContext, s3Key: string, contentType: string) {
    if (!this.bucket) throw new BadRequestException('Assets bucket not configured');
    if (!ownedLogoKey(ctx.tenantId, s3Key, contentType)) {
      throw new BadRequestException('Invalid logo upload');
    }
    const issuedAt = s3Key.slice(`tenants/${ctx.tenantId}/branding/logo-`.length).split('-')[0];
    const age = Date.now() - Number(issuedAt);
    if (age < 0 || age > UPLOAD_TTL_MS) throw new BadRequestException('Logo upload expired');
    const head = await this.s3
      .send(new HeadObjectCommand({ Bucket: this.bucket, Key: s3Key }))
      .catch(() => null);
    if (!head) throw new BadRequestException('Object not found at the given key');
    if (head.ContentType !== contentType ||
        !Number.isSafeInteger(head.ContentLength) || !head.ContentLength ||
        head.ContentLength < 1 || head.ContentLength > MAX_BYTES ||
        head.Metadata?.['tenant-id'] !== ctx.tenantId ||
        head.Metadata?.['upload-issued-at'] !== issuedAt) {
      throw new BadRequestException('Invalid logo upload');
    }
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Refuse an older upload after another logo was confirmed. Keep the
      // comparison and update serialized on the existing tenant row.
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${ctx.tenantId}::uuid FOR UPDATE`;
      const current = await tx.tenant.findUnique({ where: { id: ctx.tenantId } });
      if (!current) throw new BadRequestException('Branding unavailable');
      if (current.logoS3Key === s3Key && current.logoContentType === contentType) return current;
      if (current.logoUploadedAt && current.logoUploadedAt.getTime() >= Number(issuedAt)) {
        throw new BadRequestException('Logo upload has been superseded');
      }
      return tx.tenant.update({
        where: { id: ctx.tenantId },
        data: {
          logoS3Key: s3Key,
          logoContentType: contentType,
          logoUploadedAt: new Date(),
        },
      });
    });
  }

  private async signedGetUrl(s3Key: string, ttlSeconds = 300): Promise<string | null> {
    if (!this.bucket) return null;
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }),
      { expiresIn: ttlSeconds },
    );
  }
}
