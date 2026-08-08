import { Controller, Get, NotFoundException, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MeriV3VisualAnalysisService } from './meri-v3-visual-analysis.service.js';

/**
 * User-scoped analysis artifact reader shared by MeriV3 and the legacy
 * image-only chart card. Keeping reads outside the V3 canary gate preserves
 * existing analysis-chart history during rollback while fixing the old
 * tenant-only image lookup: both metadata and PNG now require the artifact's
 * owning user as well as its tenant.
 */
@Controller('clio/analysis-artifacts')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MeriAnalysisArtifactController {
  constructor(private readonly visualAnalysis: MeriV3VisualAnalysisService) {}

  @Get(':artifactId')
  async getArtifact(@CurrentTenant() ctx: TenantContext, @Param('artifactId') artifactId: string) {
    const artifact = await this.visualAnalysis.getArtifact(ctx, artifactId);
    if (!artifact) throw new NotFoundException('Analysis artifact not found');
    return artifact;
  }

  @Get(':artifactId/image')
  async getArtifactImage(
    @CurrentTenant() ctx: TenantContext,
    @Param('artifactId') artifactId: string,
    @Res() res: Response,
  ) {
    const image = await this.visualAnalysis.getArtifactImage(ctx, artifactId);
    if (!image) throw new NotFoundException('Analysis image not found');
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(image.buffer);
  }
}
