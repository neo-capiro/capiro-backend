import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { WsBrandAsset } from '../../generated/prisma-client/index.js';

/**
 * Brand Asset Service — manages firm logo / mark uploads for theme
 * letterheads (GAPS §16). The client uploads the file to S3 via a presigned
 * URL (obtained from the existing /api/engagement/attachments/upload-url
 * pipeline) and then registers the asset here with the S3 object key + URL.
 */
@Injectable()
export class BrandAssetService {
  constructor(private readonly prisma: PrismaService) {}

  /** List all brand assets for this tenant. */
  async list(tenantId: string): Promise<WsBrandAsset[]> {
    return this.prisma.wsBrandAsset.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    }) as Promise<WsBrandAsset[]>;
  }

  /** Register a brand asset after the client has uploaded to S3. */
  async register(
    tenantId: string,
    clerkUserId: string,
    params: {
      objectKey: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      url: string;
    },
  ): Promise<WsBrandAsset> {
    return this.prisma.wsBrandAsset.create({
      data: {
        tenantId,
        uploadedById: clerkUserId,
        objectKey: params.objectKey,
        filename: params.filename,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
        url: params.url,
      },
    }) as Promise<WsBrandAsset>;
  }

  /** Delete a brand asset. */
  async remove(tenantId: string, assetId: string): Promise<{ deleted: boolean }> {
    const asset = await this.prisma.wsBrandAsset.findFirst({
      where: { id: assetId, tenantId },
    });
    if (!asset) throw new NotFoundException('Brand asset not found');
    await this.prisma.wsBrandAsset.delete({ where: { id: assetId } });
    return { deleted: true };
  }
}
