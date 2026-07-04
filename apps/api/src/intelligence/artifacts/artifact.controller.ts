import { Body, Controller, Get, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { IsIn, IsString, MinLength } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { ArtifactGeneratorService } from './artifact-generator.service.js';
import type { ArtifactType } from './artifact-types.js';

// The global ValidationPipe runs whitelist + forbidNonWhitelisted, so every DTO field
// MUST carry a class-validator decorator (mirrors ActionRecommendationController).

const ARTIFACT_TYPES: ArtifactType[] = [
  'internal_brief',
  'client_email',
  'member_one_pager',
  'committee_staff_memo',
  'talking_points',
  'procurement_watch_note',
];

class GenerateArtifactDto {
  @IsIn(ARTIFACT_TYPES)
  type!: ArtifactType;
}

class UpdateArtifactDto {
  @IsString()
  @MinLength(1)
  bodyText!: string;
}

/**
 * Step 3.3 — source-backed artifact generation API (plan §18).
 *
 * Mounted under `/intelligence` (same module, own controller — mirrors
 * ActionRecommendationController). Tenant-scoped via RolesGuard + @Roles(standard_user);
 * the generator service enforces RLS through withTenant. Generation is verifier-gated
 * (unsourced numerals dropped) and user edits are preserved as new versions.
 */
@Controller('intelligence')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ArtifactController {
  constructor(private readonly generator: ArtifactGeneratorService) {}

  /** Generate a source-backed artifact of `type` from an action card. */
  @Post('actions/:id/artifacts')
  generate(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: GenerateArtifactDto,
  ) {
    return this.generator.generate(ctx, id, body.type);
  }

  /** List the artifacts generated for an action, newest first. */
  @Get('actions/:id/artifacts')
  list(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.generator.listForAction(ctx, id);
  }

  /** Persist a user edit as a new version (never regenerates). */
  @Patch('artifacts/:id')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdateArtifactDto,
  ) {
    return this.generator.updateContent(ctx, id, body.bodyText);
  }

  /** Download the (already-verified) artifact as a client-ready .docx. */
  @Get('artifacts/:id/export/docx')
  async exportDocx(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { filename, buffer } = await this.generator.renderDocx(ctx, id);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}
