import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Injectable, Logger } from "@nestjs/common";
import { sanitizeRasterAsset } from "./report-image.js";
import type { ClientLogoAsset } from "./report.types.js";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export const CLIENT_LOGO_READER = Symbol("CLIENT_LOGO_READER");

export interface ClientLogoReader {
  read(input: {
    tenantId: string;
    clientId: string;
    objectKey: string;
  }): Promise<ClientLogoAsset | null>;
}

/** Read-only private-assets adapter. It never accepts a caller-provided key. */
@Injectable()
export class S3ClientLogoReader implements ClientLogoReader {
  private readonly logger = new Logger(S3ClientLogoReader.name);
  private readonly bucket = process.env.ASSETS_BUCKET?.trim();
  private readonly s3 = new S3Client({
    region:
      process.env.AWS_REGION_DEFAULT ?? process.env.AWS_REGION ?? "us-east-1",
  });

  async read(input: {
    tenantId: string;
    clientId: string;
    objectKey: string;
  }): Promise<ClientLogoAsset | null> {
    if (!this.bucket) return null;

    // Defense in depth: ReportSnapshotService already derives this key from the
    // authenticated strategy/client row. The storage adapter independently
    // rejects a foreign or nested prefix before touching S3.
    const prefix = `tenants/${input.tenantId}/clients/${input.clientId}/`;
    const tail = input.objectKey.startsWith(prefix)
      ? input.objectKey.slice(prefix.length)
      : "";
    if (
      !/^logos\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpe?g)$/i.test(
        tail,
      )
    ) {
      return null;
    }

    try {
      const result = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: input.objectKey }),
      );
      if (!result.Body || (result.ContentLength ?? 0) > MAX_LOGO_BYTES)
        return null;

      const bytes = Buffer.from(await result.Body.transformToByteArray());
      if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return null;
      const contentType = sniffRasterContentType(bytes);
      if (!contentType) return null;
      return sanitizeRasterAsset({ bytes, contentType });
    } catch (error) {
      this.logger.warn(
        `Client logo unavailable during report export: ${
          error instanceof Error ? error.name : "unknown error"
        }`,
      );
      return null;
    }
  }
}

function sniffRasterContentType(
  bytes: Buffer,
): ClientLogoAsset["contentType"] | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  return null;
}
