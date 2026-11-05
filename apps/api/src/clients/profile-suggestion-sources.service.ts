import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { readBodyWithSizeLimit, withGuardedWebResponse } from '../meri/hardenedWebTransport.js';
import { stripHtmlToText } from './client-profile-fill.helpers.js';
import { assertSharedProfileEvidence } from './profile-shared-evidence.js';
import { requireProfileSubject, type ProfileSubject } from './profile-subject.js';
import type { PortfolioAgentSource } from './portfolio-agent.service.js';

export interface ProfileSuggestionSource extends PortfolioAgentSource {
  label: string;
  observedAt: string;
  source: 'website' | 'document' | 'person_context' | 'reference_catalog';
  /** Present only when a read is on the same origin as the person's explicitly provided company URL. */
  companyWebsite?: string;
}

/** Read-only source collection shared by bounded profile previews, never a hidden profile/run. */
@Injectable()
export class ProfileSuggestionSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: EngagementService,
  ) {}

  async website(rawUrl: string, signal?: AbortSignal): Promise<ProfileSuggestionSource> {
    return withGuardedWebResponse(
      rawUrl,
      async (response, finalUrl, scope) => {
        if (!response.ok) throw new Error('Website unavailable');
        const type = response.headers.get('content-type')?.toLowerCase() ?? '';
        if (!type.includes('text/html') && !type.includes('application/xhtml+xml'))
          throw new Error('Website text unavailable');
        const bytes = await readBodyWithSizeLimit(response, 500_000, scope);
        const text = stripHtmlToText(new TextDecoder().decode(bytes), 35_000);
        if (!text.trim()) throw new Error('Website text unavailable');
        return {
          id: 'company_website',
          url: finalUrl,
          text,
          label: 'Provided company website',
          observedAt: new Date().toISOString(),
          source: 'website',
        };
      },
      {
        signal,
        deadlineMs: 12_000,
        maxRedirects: 3,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Capiro profile source reader',
        },
      },
    );
  }

  async document(
    ctx: TenantContext,
    subject: ProfileSubject,
    id: string,
    signal?: AbortSignal,
  ): Promise<ProfileSuggestionSource> {
    const row = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireProfileSubject(tx, ctx, subject);
      await assertSharedProfileEvidence(tx, ctx.tenantId, subject, [{ attachmentId: id }], ctx);
      return tx.engagementAttachment.findFirstOrThrow({
        where: { id, tenantId: ctx.tenantId },
        select: { prospectId: true, fileName: true },
      });
    });
    const result = await this.attachments.extractAttachmentText(ctx, id, {
      ...(row.prospectId ? { prospectId: row.prospectId } : { clientId: subject.id }),
      readOnly: true,
      allowPaidExtraction: false,
      signal,
    });
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await requireProfileSubject(tx, ctx, subject);
      await assertSharedProfileEvidence(tx, ctx.tenantId, subject, [{ attachmentId: id }], ctx);
    });
    return {
      id: `document_${id}`,
      attachmentId: id,
      text: result.text.slice(0, 50_000),
      label: row.fileName,
      source: 'document',
      observedAt: new Date().toISOString(),
    };
  }

  async identityDocument(
    ctx: TenantContext,
    id: string,
    signal?: AbortSignal,
  ): Promise<ProfileSuggestionSource> {
    const result = await this.attachments.extractIdentityUploadText(ctx, id, signal);
    if (!result.text.trim()) throw new Error('Identity document contains no readable text');
    return {
      id: `identity_document_${id}`,
      attachmentId: id,
      text: result.text.slice(0, 50_000),
      label: result.fileName,
      source: 'document',
      observedAt: new Date().toISOString(),
    };
  }
}
