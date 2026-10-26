import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { BrandAssetAttachmentClient } from './brand-asset-attachment.client.js';

/** Workspace library entries refer to existing confirmed General attachment bytes.
 * Core retains the upload/scan/read authority. Removing an entry never deletes those bytes. */
@Injectable()
export class BrandAssetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: BrandAssetAttachmentClient,
  ) {}

  listUploads(tenantId: string, authorization: string | undefined) {
    return this.attachments.list(tenantId, authorization);
  }

  async list(tenantId: string, authorization: string | undefined) {
    const rows = await this.prisma.wsBrandAsset.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    if (!rows.length) return [];
    const uploads = await this.attachments.list(tenantId, authorization);
    return rows.map((asset) => {
      const upload = uploads.find(
        (item) =>
          item.s3Key === asset.objectKey &&
          item.fileName === asset.filename &&
          item.contentType === asset.mimeType &&
          item.contentLength === asset.sizeBytes,
      );
      return {
        ...asset,
        url: upload?.downloadUrl ?? null,
        available: Boolean(upload),
        scanDisclosure: upload?.scanDisclosure ?? null,
      };
    });
  }

  async register(
    tenantId: string,
    clerkUserId: string,
    attachmentId: string,
    authorization: string | undefined,
  ) {
    const upload = (await this.attachments.list(tenantId, authorization)).find(
      (item) => item.id === attachmentId,
    );
    if (!upload) throw new NotFoundException('Confirmed, available firm image not found');
    // An existing exact library entry is a safe registration retry. Core still rechecks the source above.
    const asset = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${upload.s3Key}))`;
      const existing = await tx.wsBrandAsset.findFirst({
        where: { tenantId, objectKey: upload.s3Key },
      });
      if (
        existing &&
        (existing.filename !== upload.fileName ||
          existing.mimeType !== upload.contentType ||
          existing.sizeBytes !== upload.contentLength)
      )
        throw new ConflictException('Brand asset metadata differs from its confirmed upload');
      return (
        existing ??
        tx.wsBrandAsset.create({
          data: {
            tenantId,
            uploadedById: clerkUserId,
            objectKey: upload.s3Key,
            filename: upload.fileName,
            mimeType: upload.contentType,
            sizeBytes: upload.contentLength,
            url: upload.downloadUrl,
          },
        })
      );
    });
    return {
      ...asset,
      url: upload.downloadUrl,
      available: true,
      attachmentId: upload.id,
      scanDisclosure: upload.scanDisclosure,
    };
  }

  /** Refuse known persisted references, including retired versions. This only removes library metadata. */
  async remove(tenantId: string, assetId: string): Promise<{ deleted: true; assetId: string }> {
    const asset = await this.prisma.wsBrandAsset.findFirst({ where: { id: assetId, tenantId } });
    if (!asset) throw new NotFoundException('Brand asset not found');
    const [themes, blueprints, drafts, versions] = await Promise.all([
      this.prisma.wsThemeVersion.findMany({ where: { tenantId }, select: { settings: true } }),
      this.prisma.wsBlueprintVersion.findMany({
        where: { OR: [{ tenantId }, { tenantId: null }] },
        select: { definition: true },
      }),
      this.prisma.wsDraft.findMany({ where: { tenantId }, select: { config: true } }),
      this.prisma.wsDocVersion.findMany({ where: { tenantId }, select: { snapshot: true } }),
    ]);
    let urlPath = asset.url;
    try {
      const url = new URL(asset.url);
      urlPath = url.origin + url.pathname;
    } catch {
      /* Legacy metadata may have no valid URL. */
    }
    const needles = new Set([asset.id, asset.objectKey, urlPath].filter(Boolean));
    if (
      [
        ...themes.map((x) => x.settings),
        ...blueprints.map((x) => x.definition),
        ...drafts.map((x) => x.config),
        ...versions.map((x) => x.snapshot),
      ].some((value) => references(value, needles))
    )
      throw new ConflictException(
        'Brand asset is referenced by a saved theme, blueprint or document',
      );
    await this.prisma.wsBrandAsset.delete({ where: { id: assetId, tenantId } });
    return { deleted: true, assetId };
  }
}
function references(value: unknown, needles: Set<string>): boolean {
  // Saved HTML and signed URLs can embed a reference; query-string rotation does not unpin it.
  if (typeof value === 'string')
    return [...needles].some(
      (needle) =>
        value.includes(needle) ||
        (/^[a-f\d-]{36}$/i.test(needle) && value.toLowerCase().includes(needle.toLowerCase())),
    );
  if (Array.isArray(value)) return value.some((item) => references(item, needles));
  return Boolean(
    value &&
    typeof value === 'object' &&
    Object.values(value).some((item) => references(item, needles)),
  );
}
