import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HillDayExportService } from './hillday-export.service.js';

/**
 * Signed-URL file route for Hill Day PDF exports. No session guard on purpose:
 * the HMAC signature (bound to document + export + expiry) is the grant, so
 * the PDF can be opened in a new tab or fetched by a print pipeline without a
 * bearer token. Kept in its own file (no DTO imports) so it can be exercised
 * end-to-end under jest.
 */
@Controller('hillday/files')
export class HillDayFileController {
  constructor(private readonly exports: HillDayExportService) {}

  @Get(':documentId/:exportId')
  async file(
    @Param('documentId') documentId: string,
    @Param('exportId') exportId: string,
    @Query('exp') exp: string | undefined,
    @Query('sig') sig: string | undefined,
    @Query('download') download: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.exports.file(documentId, exportId, exp ?? '', sig ?? '');
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="${filename.replace(/"/g, '')}"`,
    );
    res.end(buffer);
  }
}
