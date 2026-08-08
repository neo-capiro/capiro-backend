import { Injectable } from '@nestjs/common';
import { EngagementService } from '../engagement/engagement.service.js';

/**
 * Governed client-document mutation boundary.
 *
 * The existing Engagement attachment implementation remains authoritative for
 * storage, lifecycle, scanning, indexing, supersession, and cleanup. Consumers
 * depend on this narrow port instead of importing broad Engagement behavior.
 */
@Injectable()
export class ClientDocumentWriterService {
  constructor(private readonly engagement: EngagementService) {}

  createAttachmentFromBuffer(
    ctx: Parameters<EngagementService['createAttachmentFromBuffer']>[0],
    input: Parameters<EngagementService['createAttachmentFromBuffer']>[1],
  ): ReturnType<EngagementService['createAttachmentFromBuffer']> {
    return this.engagement.createAttachmentFromBuffer(ctx, input);
  }

  supersedeAttachment(
    ctx: Parameters<EngagementService['supersedeAttachment']>[0],
    oldId: string,
    newId: string,
  ): ReturnType<EngagementService['supersedeAttachment']> {
    return this.engagement.supersedeAttachment(ctx, oldId, newId);
  }

  deleteAttachment(
    ctx: Parameters<EngagementService['deleteAttachment']>[0],
    id: string,
  ): ReturnType<EngagementService['deleteAttachment']> {
    return this.engagement.deleteAttachment(ctx, id);
  }
}
