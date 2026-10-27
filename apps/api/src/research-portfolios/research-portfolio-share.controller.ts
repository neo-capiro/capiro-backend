import {
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type {
  TenantContext,
  ChangeResearchPortfolioSharePinDto,
  EnableResearchPortfolioSharingDto,
  PublishResearchPortfolioShareLinkDto,
  PreviewResearchPortfolioShareDto,
  ResearchPortfolioSharePreviewDto,
  ResearchPortfolioDashboardDesignDto,
  ResearchPortfolioShareAvailabilityDto,
  ResearchPortfolioShareDashboardDto,
  ResearchPortfolioShareLinkDto,
  ResearchPortfolioShareLinkPublishedDto,
  ResearchPortfolioShareLogoDto,
  ResearchPortfolioSharePinDto,
  ResearchPortfolioShareSettingsDto,
  ResearchPortfolioShareViewDto,
  ResearchPortfolioShareViewSessionDto,
  ResearchPortfolioTenantSharingDto,
  SaveResearchPortfolioDashboardDesignDto,
  SetResearchPortfolioTenantSharingDto,
} from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ResearchPortfolioShareService } from './research-portfolio-share.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function ensureUuid(value: string, what: string): void {
  if (!UUID.test(value)) throw new NotFoundException(`${what} not found`);
}

/** Sharing settings, dashboard designs and links of one portfolio (Owner/Editor/Viewer rules in the service). */
@Controller('research-portfolios')
@UseGuards(RolesGuard)
@Roles('standard_user', 'user_admin', 'capiro_admin')
export class ResearchPortfolioShareController {
  constructor(private readonly share: ResearchPortfolioShareService) {}

  @Get(':id/sharing')
  settings(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<ResearchPortfolioShareSettingsDto> {
    ensureUuid(id, 'Research portfolio');
    return this.share.getSettings(ctx, id);
  }

  @Post(':id/sharing/enable')
  enable(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: EnableResearchPortfolioSharingDto,
  ): Promise<ResearchPortfolioShareSettingsDto> {
    ensureUuid(id, 'Research portfolio');
    return this.share.enableSharing(ctx, id, dto);
  }

  @Post(':id/sharing/pin')
  changePin(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: ChangeResearchPortfolioSharePinDto,
  ): Promise<ResearchPortfolioShareSettingsDto> {
    ensureUuid(id, 'Research portfolio');
    return this.share.changePin(ctx, id, dto);
  }

  @Post(':id/sharing/disable')
  disable(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<ResearchPortfolioShareSettingsDto> {
    ensureUuid(id, 'Research portfolio');
    return this.share.disableSharing(ctx, id);
  }

  @Get(':id/dashboard-designs')
  designs(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<readonly ResearchPortfolioDashboardDesignDto[]> {
    ensureUuid(id, 'Research portfolio');
    return this.share.listDesigns(ctx, id);
  }

  @Post(':id/dashboard-designs')
  createDesign(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: SaveResearchPortfolioDashboardDesignDto,
  ): Promise<ResearchPortfolioDashboardDesignDto> {
    ensureUuid(id, 'Research portfolio');
    return this.share.saveDesign(ctx, id, null, dto);
  }

  @Put(':id/dashboard-designs/:designId')
  updateDesign(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('designId') designId: string,
    @Body() dto: SaveResearchPortfolioDashboardDesignDto,
  ): Promise<ResearchPortfolioDashboardDesignDto> {
    ensureUuid(id, 'Research portfolio');
    ensureUuid(designId, 'Dashboard design');
    return this.share.saveDesign(ctx, id, designId, dto);
  }

  @Get(':id/share-links')
  links(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ): Promise<readonly ResearchPortfolioShareLinkDto[]> {
    ensureUuid(id, 'Research portfolio');
    return this.share.listLinks(ctx, id);
  }

  @Post(':id/share-preview')
  @Header('Cache-Control', 'no-store')
  preview(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: PreviewResearchPortfolioShareDto,
  ): Promise<ResearchPortfolioSharePreviewDto> {
    ensureUuid(id, 'Research portfolio');
    return this.share.previewLink(ctx, id, dto);
  }

  @Get(':id/share-links/operations/:operationKey')
  @Header('Cache-Control', 'no-store')
  operation(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('operationKey') operationKey: string,
  ): Promise<{ link: ResearchPortfolioShareLinkDto | null }> {
    ensureUuid(id, 'Research portfolio');
    return this.share.lookupPublishOperation(ctx, id, operationKey);
  }

  @Post(':id/share-links')
  publish(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: PublishResearchPortfolioShareLinkDto,
  ): Promise<ResearchPortfolioShareLinkPublishedDto> {
    ensureUuid(id, 'Research portfolio');
    return this.share.publishLink(ctx, id, dto);
  }

  @Post(':id/share-links/:linkId/revoke')
  revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('linkId') linkId: string,
  ): Promise<ResearchPortfolioShareLinkDto> {
    ensureUuid(id, 'Research portfolio');
    ensureUuid(linkId, 'Share link');
    return this.share.revokeLink(ctx, id, linkId);
  }
}

/** Tenant administrators see and can revoke every live link. */
@Controller('research-share-links')
@UseGuards(RolesGuard)
@Roles('user_admin', 'capiro_admin')
export class ResearchPortfolioShareAdminController {
  constructor(private readonly share: ResearchPortfolioShareService) {}

  @Get()
  list(@CurrentTenant() ctx: TenantContext): Promise<readonly ResearchPortfolioShareLinkDto[]> {
    return this.share.listTenantActiveLinks(ctx);
  }

  /** Workspace-wide switch (FR-16.42). */
  @Get('settings')
  tenantSharing(@CurrentTenant() ctx: TenantContext): Promise<ResearchPortfolioTenantSharingDto> {
    return this.share.getTenantSharing(ctx);
  }

  @Post('settings')
  setTenantSharing(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: SetResearchPortfolioTenantSharingDto,
  ): Promise<ResearchPortfolioTenantSharingDto> {
    return this.share.setTenantSharing(ctx, dto);
  }

  @Post(':linkId/revoke')
  revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('linkId') linkId: string,
  ): Promise<ResearchPortfolioShareLinkDto> {
    ensureUuid(linkId, 'Share link');
    return this.share.revokeTenantLink(ctx, linkId);
  }
}

/**
 * Recipient routes: no Clerk session and no tenant context (bypassed in app.module.ts and
 * TenantContextMiddleware). Authority is the link token plus the portfolio PIN; every
 * failure is the same "not available" answer.
 */
@Controller('public/research-share')
export class ResearchPortfolioSharePublicController {
  constructor(private readonly share: ResearchPortfolioShareService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  availability(@Param('token') token: string): Promise<ResearchPortfolioShareAvailabilityDto> {
    return this.share.availability(token);
  }

  @Post(':token/pin')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  verifyPin(
    @Param('token') token: string,
    @Body() dto: ResearchPortfolioSharePinDto,
    @Req() req: Request,
  ): Promise<ResearchPortfolioShareViewSessionDto> {
    // Express owns proxy trust. Do not accept a caller's raw forwarded prefix.
    // The durable per-link lock is primary; a gateway may share this address.
    const address = req.ip || 'unknown';
    return this.share.verifyPin(token, dto?.pin, address);
  }

  /** POST so the short-lived view token travels in the body, never in the address or a log line. */
  @Post(':token/dashboard')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  dashboard(
    @Param('token') token: string,
    @Body() dto: ResearchPortfolioShareViewDto,
  ): Promise<ResearchPortfolioShareDashboardDto> {
    return this.share.dashboard(token, dto?.viewToken ?? '');
  }

  /** Firm logo for a branded link; the same view token as the dashboard. */
  @Post(':token/logo')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  logo(
    @Param('token') token: string,
    @Body() dto: ResearchPortfolioShareViewDto,
  ): Promise<ResearchPortfolioShareLogoDto> {
    return this.share.logo(token, dto?.viewToken ?? '');
  }
}

/** A single public entry point dispatches the existing Workspace share-link kinds. */
@Controller('public/share')
export class ResearchPortfolioShareDispatchController {
  constructor(private readonly share: ResearchPortfolioShareService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  kind(@Param('token') token: string) {
    return this.share.publicKind(token);
  }
}
