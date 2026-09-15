import { Injectable } from '@nestjs/common';
import { EngagementService } from '../engagement/engagement.service.js';

/**
 * Exact persistence/orchestration port required by Notetaker.
 *
 * The existing implementations remain authoritative for transcript attachment
 * lifecycle, encrypted meeting notes, and grounded debrief drafting. Notetaker
 * receives this six-method object rather than the broad EngagementService.
 */
@Injectable()
export class MeetingCapturePersistenceService {
  constructor(private readonly engagement: EngagementService) {}

  createAttachmentFromBuffer(
    ...args: Parameters<EngagementService['createAttachmentFromBuffer']>
  ) {
    return this.engagement.createAttachmentFromBuffer(...args);
  }

  deleteAttachment(...args: Parameters<EngagementService['deleteAttachment']>) {
    return this.engagement.deleteAttachment(...args);
  }

  eraseAttachmentAsSystem(
    ...args: Parameters<EngagementService['eraseAttachmentAsSystem']>
  ) {
    return this.engagement.eraseAttachmentAsSystem(...args);
  }

  generateMeetingDebriefDraft(
    ...args: Parameters<EngagementService['generateMeetingDebriefDraft']>
  ) {
    return this.engagement.generateMeetingDebriefDraft(...args);
  }

  createMeetingNote(...args: Parameters<EngagementService['createMeetingNote']>) {
    return this.engagement.createMeetingNote(...args);
  }

  createMeetingDebrief(...args: Parameters<EngagementService['createMeetingDebrief']>) {
    return this.engagement.createMeetingDebrief(...args);
  }

  // Notetaker's reconcileClientPreference needs the existing
  // tenant/client-scoped meeting-association predicate to count client
  // meetings before persisting a preference change. Forward the existing
  // scoped helper verbatim — no new access semantics, no broadening.
  clientMeetingAssociationWhere(
    ...args: Parameters<EngagementService['clientMeetingAssociationWhere']>
  ) {
    return this.engagement.clientMeetingAssociationWhere(...args);
  }
}
