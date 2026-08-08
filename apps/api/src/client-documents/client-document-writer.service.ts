import { Injectable } from '@nestjs/common';
import { EngagementService } from '../engagement/engagement.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';

/**
 * Governed client-document mutation boundary.
 *
 * The existing Engagement attachment implementation remains authoritative for
 * storage, lifecycle, scanning, indexing, supersession, and cleanup. Consumers
 * depend on this narrow port instead of importing broad Engagement behavior.
 *
 * This port owns an independent runtime-policy check so a future shadow consumer
 * cannot reach S3 or mutate document state merely by bypassing a controller.
 * EngagementService retains the same checks as defense in depth for direct callers.
 */
@Injectable()
export class ClientDocumentWriterService {
  constructor(
    private readonly engagement: EngagementService,
    private readonly runtime: EngagementRuntimePolicyService,
  ) {}

  createAttachmentFromBuffer(
    ctx: Parameters<EngagementService['createAttachmentFromBuffer']>[0],
    input: Parameters<EngagementService['createAttachmentFromBuffer']>[1],
  ): ReturnType<EngagementService['createAttachmentFromBuffer']> {
    this.runtime.assertExternalAction('attachment_external_write');
    return this.engagement.createAttachmentFromBuffer(ctx, input);
  }

  supersedeAttachment(
    ctx: Parameters<EngagementService['supersedeAttachment']>[0],
    oldId: string,
    newId: string,
  ): ReturnType<EngagementService['supersedeAttachment']> {
    this.runtime.assertExternalAction('attachment_external_write');
    return this.engagement.supersedeAttachment(ctx, oldId, newId);
  }

  deleteAttachment(
    ctx: Parameters<EngagementService['deleteAttachment']>[0],
    id: string,
  ): ReturnType<EngagementService['deleteAttachment']> {
    this.runtime.assertExternalAction('attachment_external_write');
    return this.engagement.deleteAttachment(ctx, id);
  }
}
