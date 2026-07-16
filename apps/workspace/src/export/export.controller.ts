import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { ExportService } from './export.service.js';

/** Document export endpoints (Phase 7). Both .docx and .pdf are server-rendered
 *  (deterministic — the PDF no longer depends on the browser print pipeline). */
@Controller('drafts/:draftId/export')
@UseGuards(TenantGuard)
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  /**
   * GET /workspace-api/drafts/:draftId/export/docx?part=<all|main|documentId>
   * Streams a .docx of the draft (anonymized when the draft flag is set).
   * `part` (optional, default 'all'): 'all' combines every packet document
   * (e.g. a cover letter) with the draft's own sections into one file; 'main'
   * exports only the draft's own sections; any other value must be a packet
   * document id, exporting that document standalone (404 if it doesn't
   * belong to this draft).
   */
  @Get('docx')
  async docx(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Query('part') part: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { filename, buffer } = await this.exportService.buildDocx(
      ctx.tenantId,
      draftId,
      part,
      ctx.clerkUserId,
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  /**
   * GET /workspace-api/drafts/:draftId/export/pdf?part=<all|main|documentId>
   * Streams a server-rendered .pdf of the draft (anonymized when the flag is
   * set). Same `part` semantics as the .docx route above.
   */
  @Get('pdf')
  async pdf(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Query('part') part: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { filename, buffer } = await this.exportService.buildPdf(
      ctx.tenantId,
      draftId,
      part,
      ctx.clerkUserId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}
