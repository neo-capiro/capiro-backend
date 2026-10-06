import {
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MeriJobDeliverablesService } from './meri-job-deliverables.service.js';

/** Stage 2 deliverable jobs: download the Word document, or file it (one confirmation). */
@Controller('clio/research')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MeriJobDeliverablesController {
  constructor(private readonly deliverables: MeriJobDeliverablesService) {}

  @Get(':id/deliverables/:index/docx')
  @Header('Cache-Control', 'private, no-store')
  async download(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Res() res: Response,
  ) {
    const document = await this.deliverables.docx(ctx, id, index);
    res.setHeader('Content-Type', document.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(document.fileName)}`,
    );
    res.send(document.buffer);
  }

  @Post(':id/deliverables/:index/file')
  @Header('Cache-Control', 'private, no-store')
  file(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.deliverables.file(ctx, id, index);
  }
}
