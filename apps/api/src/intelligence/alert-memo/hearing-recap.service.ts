import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from '../../engagement/engagement.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  DOCX_MIME,
  markdownToMemoDocInput,
  renderMemoDocx,
} from './alert-memo-docx.js';

export interface SaveHearingRecapInput {
  sessionId: string;
  title: string;
  markdown: string;
  clientName: string;
  replaceAttachmentId?: string;
}

/**
 * Files a post-hearing recap without pretending it is an alert memo.
 *
 * Public hearings/markups are firm-visible. Private meetings, webinars and
 * agency sessions are creator-private, matching intel-api's read boundary. The
 * former web path called alert-memo/save without its required alertId, so the
 * global ValidationPipe rejected every save; this service owns the correct
 * session-shaped contract instead.
 */
@Injectable()
export class HearingRecapService {
  private readonly logger = new Logger(HearingRecapService.name);

  constructor(
    private readonly engagement: EngagementService,
    private readonly prisma: PrismaService,
  ) {}

  async save(ctx: TenantContext, clientId: string, input: SaveHearingRecapInput) {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM intel_live_hearing_session
        WHERE id = ${input.sessionId}
          AND tenant_id = ${ctx.tenantId}
          AND (
            source_type::text IN ('hearing', 'markup')
            OR created_by = ${ctx.clerkUserId}
          )
        LIMIT 1
      `,
    );
    if (!rows[0]) throw new NotFoundException('Live hearing session not found');

    const buffer = await renderMemoDocx(
      markdownToMemoDocInput(input.markdown, input.clientName, input.title),
    );
    const fileName = `${input.title}.docx`.replace(/[\/:*?"<>|]+/g, '-');
    const saved = await this.engagement.createAttachmentFromBuffer(ctx, {
      clientId,
      fileName,
      contentType: DOCX_MIME,
      buffer,
      source: 'hearing_recap',
    });

    // The new document is already durable. A failure to link the prior version
    // as superseded must not turn a successful save into an apparent failure and
    // encourage the user to create duplicates; preserve both and surface it in
    // logs for reconciliation, matching the alert-memo lifecycle posture.
    if (input.replaceAttachmentId) {
      await this.engagement
        .supersedeAttachment(ctx, input.replaceAttachmentId, saved.id)
        .catch((err) =>
          this.logger.warn(`superseding prior hearing recap failed: ${(err as Error).message}`),
        );
    }

    return {
      title: input.title,
      sessionId: input.sessionId,
      document: { attachmentId: saved.id, fileName: saved.fileName },
    };
  }
}
