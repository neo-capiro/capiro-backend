// Delivery Controller — authenticated routes for approval + share links.
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
import { ApprovalService } from './approval.service.js';
import { ShareLinkService } from './share-link.service.js';
import {
  CreateApprovalRequestDto,
  ApprovalDecisionDto,
  CreateShareLinkDto,
  GuestCommentDto,
} from './dto/delivery.dto.js';

@Controller('drafts/:draftId/delivery')
@UseGuards(TenantGuard)
export class DeliveryController {
  constructor(
    private readonly approval: ApprovalService,
    private readonly shareLink: ShareLinkService,
  ) {}

  @Post('preflight')
  preflight(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
  ) {
    return this.approval.preflight(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  @Post('approval-requests')
  createApprovalRequest(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: CreateApprovalRequestDto,
  ) {
    return this.approval.createRequest(ctx.tenantId, draftId, ctx.clerkUserId, dto);
  }

  @Post('approval-requests/:requestId/decision')
  decide(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Param('requestId') requestId: string,
    @Body() dto: ApprovalDecisionDto,
  ) {
    return this.approval.decide(
      ctx.tenantId,
      draftId,
      requestId,
      ctx.clerkUserId,
      dto.decision,
      dto.note,
    );
  }

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
    return this.shareLink.revoke(ctx.tenantId, draftId, shareLinkId);
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

// Need to import Get at the top — it's used in PublicShareController.
