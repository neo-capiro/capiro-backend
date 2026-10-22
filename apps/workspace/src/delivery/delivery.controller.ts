// Delivery Controller — authenticated routes for share links.
// Public share routes are in a separate controller without TenantGuard.

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { ShareLinkService } from './share-link.service.js';
import {
  CreateShareLinkDto,
  GuestCommentDto,
} from './dto/delivery.dto.js';

@Controller('drafts/:draftId/delivery')
@UseGuards(TenantGuard)
export class DeliveryController {
  constructor(
    private readonly shareLink: ShareLinkService,
  ) {}

  @Post('share-links')
  createShareLink(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: CreateShareLinkDto,
  ) {
    return this.shareLink.createShareLink(ctx.tenantId, draftId, ctx.clerkUserId, dto);
  }

  @Delete('share-links/:shareLinkId')
  revokeShareLink(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Param('shareLinkId') shareLinkId: string,
  ) {
    return this.shareLink.revoke(ctx.tenantId, draftId, shareLinkId, ctx.clerkUserId);
  }

  /**
   * GET /workspace-api/drafts/:draftId/delivery/guest-comments — internal-facing
   * visibility into feedback guests left on this draft's public share links.
   */
  @Get('guest-comments')
  listGuestComments(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
  ) {
    return this.shareLink.listGuestComments(ctx.tenantId, draftId, ctx.clerkUserId);
  }
}

/**
 * Shares index controller — tenant-wide share-link listing for the
 * /workspace/shares page. Mounted at /workspace-api/shares (no draftId prefix).
 */
@Controller('shares')
@UseGuards(TenantGuard)
export class SharesController {
  constructor(private readonly shareLink: ShareLinkService) {}

  @Get()
  listShares(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.shareLink.listShares(ctx.tenantId, ctx.clerkUserId);
  }
}

/**
 * Public share controller — NO TenantGuard. Accessible by anyone with the token.
 */
@Controller('public/workspace-share')
export class PublicShareController {
  constructor(private readonly shareLink: ShareLinkService) {}

  @Get(':token')
  getSharedDocument(@Param('token') token: string) {
    return this.shareLink.getByToken(token);
  }

  @Post(':token/comments')
  addGuestComment(
    @Param('token') token: string,
    @Body() dto: GuestCommentDto,
  ) {
    return this.shareLink.addGuestComment(token, dto.text, dto.name);
  }
}
