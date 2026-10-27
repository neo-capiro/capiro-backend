import { Body, Controller, Header, HttpCode, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { DocumentsService } from '../documents/documents.service.js';
import { VersionsService } from '../versions/versions.service.js';
import { CommentsService } from '../comments/comments.service.js';
import { HillDayDocumentService } from '../hillday/hillday-document.service.js';
import { NewsletterService } from '../newsletters/newsletter.service.js';
import { readWorkspaceSavedRecord, type WorkspaceSavedRead } from './workspace-saved-reads.js';

/** Ordinary authenticated Workspace read. A service header or body identity
 * never substitutes for TenantGuard's verified current session/member. */
@Controller('saved-records')
@UseGuards(TenantGuard)
export class WorkspaceSavedReadsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly versions: VersionsService,
    private readonly comments: CommentsService,
    private readonly hillDay: HillDayDocumentService,
    private readonly newsletter: NewsletterService,
  ) {}

  @Post('read')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  read(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() input: WorkspaceSavedRead) {
    return readWorkspaceSavedRecord(
      {
        documents: this.documents,
        versions: this.versions,
        comments: this.comments,
        hillDay: this.hillDay,
        newsletter: this.newsletter,
      },
      ctx,
      input,
    );
  }
}
