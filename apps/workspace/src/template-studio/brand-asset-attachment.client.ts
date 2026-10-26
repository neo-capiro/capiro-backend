import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import type { WorkspaceBrandUpload } from '@capiro/shared/workspace-template-studio';
const images = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** Core owns membership, attachment visibility, confirmation, scan and signed read URLs.
 * Reuse its existing actor-authorized unlinked library; never fetch a caller's URL. */
@Injectable()
export class BrandAssetAttachmentClient {
  async list(tenantId: string, authorization: string | undefined): Promise<WorkspaceBrandUpload[]> {
    const base = process.env.API_BASE_URL;
    if (!base) throw new ServiceUnavailableException('Attachment owner is not configured');
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization))
      throw new UnauthorizedException('Attachment access requires the current session');
    let response: Response;
    try {
      response = await fetch(
        `${base.replace(/\/+$/, '')}/api/engagement/attachments?unlinked=true`,
        {
          headers: { authorization, accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      throw new ServiceUnavailableException('Attachment owner is unavailable');
    }
    if (!response.ok)
      throw new ServiceUnavailableException('Attachment owner could not confirm access');
    let values: unknown;
    try {
      values = await response.json();
    } catch {
      throw new BadGatewayException('Attachment owner returned an invalid response');
    }
    if (!Array.isArray(values))
      throw new BadGatewayException('Attachment owner returned an invalid response');
    const uploads: WorkspaceBrandUpload[] = [];
    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      const r = value as Record<string, unknown>;
      // Require confirmed bytes and Core readiness, not a presign response or an unverified row.
      if (
        r.tenantId !== tenantId ||
        r.usable !== true ||
        typeof r.calculatedSha256 !== 'string' ||
        !/^[a-f\d]{64}$/i.test(r.calculatedSha256) ||
        r.clientId !== null ||
        r.meetingId !== null ||
        r.mailMessageId !== null ||
        r.prospectId !== null ||
        r.viewerMode !== 'all' ||
        typeof r.id !== 'string' ||
        typeof r.s3Key !== 'string' ||
        !r.s3Key.startsWith(`tenants/${tenantId}/engagement/`) ||
        typeof r.fileName !== 'string' ||
        typeof r.contentType !== 'string' ||
        !images.has(r.contentType) ||
        typeof r.byteSize !== 'number' ||
        !Number.isSafeInteger(r.byteSize) ||
        r.byteSize <= 0 ||
        typeof r.downloadUrl !== 'string'
      )
        continue;
      try {
        const url = new URL(r.downloadUrl);
        if (url.protocol !== 'https:' || url.username || url.password) continue;
      } catch {
        continue;
      }
      uploads.push({
        id: r.id,
        tenantId,
        s3Key: r.s3Key,
        fileName: r.fileName,
        contentType: r.contentType,
        contentLength: r.byteSize,
        downloadUrl: r.downloadUrl,
        scanDisclosure: typeof r.scanDisclosure === 'string' ? r.scanDisclosure : null,
      });
    }
    return uploads;
  }
}
