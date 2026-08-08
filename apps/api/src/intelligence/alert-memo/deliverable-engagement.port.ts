import { Injectable } from '@nestjs/common';
import { ClientDocumentWriterService } from '../../client-documents/client-document-writer.service.js';
import { OutreachTruthService } from '../../engagement/generation/outreach-truth.service.js';

/**
 * Exact narrow compatibility port for legacy deliverable constructors.
 * It intentionally exposes only canonical bill truth and governed document
 * mutation; no other Engagement behavior is reachable through this object.
 */
@Injectable()
export class DeliverableEngagementPort {
  constructor(
    private readonly truth: OutreachTruthService,
    private readonly documents: ClientDocumentWriterService,
  ) {}

  billTruthBlock(billId: string) {
    return this.truth.billTruthBlock(billId);
  }

  createAttachmentFromBuffer(
    ...args: Parameters<ClientDocumentWriterService['createAttachmentFromBuffer']>
  ) {
    return this.documents.createAttachmentFromBuffer(...args);
  }

  supersedeAttachment(...args: Parameters<ClientDocumentWriterService['supersedeAttachment']>) {
    return this.documents.supersedeAttachment(...args);
  }
}
