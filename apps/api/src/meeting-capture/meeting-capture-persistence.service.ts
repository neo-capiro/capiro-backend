import { Injectable } from '@nestjs/common';
import { EngagementService } from '../engagement/engagement.service.js';

/**
 * Exact persistence/orchestration port required by Notetaker.
 *
 * The existing implementations remain authoritative for transcript attachment
 * lifecycle, encrypted meeting notes, and grounded debrief drafting. Notetaker
 * receives this four-method object rather than the broad EngagementService.
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

  generateMeetingDebriefDraft(
    ...args: Parameters<EngagementService['generateMeetingDebriefDraft']>
  ) {
    return this.engagement.generateMeetingDebriefDraft(...args);
  }

  createMeetingNote(...args: Parameters<EngagementService['createMeetingNote']>) {
    return this.engagement.createMeetingNote(...args);
  }
}
