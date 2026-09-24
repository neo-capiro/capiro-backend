/**
 * R5 District Brief — HTTP controller.
 *
 * Routes under the existing District Nexus prefix `/intelligence/...`.
 * Guarded by RolesGuard → DistrictNexusFlagGuard → R5FlagGuard and
 * @RequireR5Feature('district_nexus_r5_brief').
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../../auth/roles.guard.js';
import { Roles } from '../../auth/roles.decorator.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { DistrictNexusFlagGuard } from '../district-nexus-flag.guard.js';
import { R5FlagGuard, RequireR5Feature, DISTRCT_NEXUS_R5_BRIEF } from './r5-flag.guard.js';
import { R5DistrictBriefService } from './r5-district-brief.service.js';
import type { R5Brief, R5BriefSaveResult } from './r5-types.js';

@Controller('intelligence')
@UseGuards(RolesGuard, DistrictNexusFlagGuard, R5FlagGuard)
@RequireR5Feature(DISTRCT_NEXUS_R5_BRIEF)
@Roles('standard_user')
export class R5DistrictBriefController {
  private readonly logger = new Logger(R5DistrictBriefController.name);

  constructor(private readonly briefService: R5DistrictBriefService) {}

  /**
   * Get the deterministic district brief as a structured JSON draft.
   *
   * Query params: clientId, state (2-letter), district (2-digit, e.g. '08')
   */
  @Get('district-nexus/r5/brief')
  async getBrief(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('state') state?: string,
    @Query('district') district?: string,
  ): Promise<R5Brief> {
    if (!clientId?.trim()) throw new BadRequestException('clientId is required');
    if (!state?.trim()) throw new BadRequestException('state is required');
    if (!district?.trim()) throw new BadRequestException('district is required');

    return this.briefService.buildDraft(
      ctx.tenantId,
      clientId.trim(),
      state.trim().toUpperCase(),
      district.trim(),
    );
  }

  /**
   * Export the brief as a DOCX file for download.
   * The server re-builds context and validates factIds.
   */
  @Post('district-nexus/r5/brief/export')
  async exportDocx(
    @CurrentTenant() ctx: TenantContext,
    @Body()
    body: {
      clientId: string;
      state: string;
      district: string;
      sections: Array<{ key: string; title: string; paragraphs: string[] }>;
      factIds: string[];
    },
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    if (!body.clientId?.trim()) throw new BadRequestException('clientId is required');
    if (!body.state?.trim()) throw new BadRequestException('state is required');
    if (!body.district?.trim()) throw new BadRequestException('district is required');
    if (!body.sections?.length) throw new BadRequestException('sections is required');
    if (!body.factIds?.length) throw new BadRequestException('factIds is required');

    const { buffer, fileName } = await this.briefService.exportDocx(
      ctx.tenantId,
      body.clientId.trim(),
      body.state.trim().toUpperCase(),
      body.district.trim(),
      body.sections,
      body.factIds,
    );

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length.toString());
    res.send(buffer);
  }

  /**
   * Generate the brief DOCX and save it to the client's Documents.
   * Idempotent: double-click safe via client+district+content hash.
   */
  @Post('district-nexus/r5/brief/save')
  async saveToClient(
    @CurrentTenant() ctx: TenantContext,
    @Body()
    body: {
      clientId: string;
      state: string;
      district: string;
      sections: Array<{ key: string; title: string; paragraphs: string[] }>;
      factIds: string[];
    },
  ): Promise<R5BriefSaveResult> {
    if (!body.clientId?.trim()) throw new BadRequestException('clientId is required');
    if (!body.state?.trim()) throw new BadRequestException('state is required');
    if (!body.district?.trim()) throw new BadRequestException('district is required');
    if (!body.sections?.length) throw new BadRequestException('sections is required');
    if (!body.factIds?.length) throw new BadRequestException('factIds is required');

    return this.briefService.saveToClient(ctx, {
      clientId: body.clientId.trim(),
      state: body.state.trim().toUpperCase(),
      district: body.district.trim(),
      sections: body.sections,
      factIds: body.factIds,
    });
  }
}