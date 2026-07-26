import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { TrackerV2Guard } from './tracker-v2.guard.js';
import { ActionItemService } from './action-item.service.js';
import { AlertPacketService } from './alert-packet.service.js';

class MemoLinkDto {
  @IsOptional() @IsString() documentAttachmentId?: string;
  @IsOptional() @IsString() @MaxLength(300) title?: string;
}
class TalkingPointDto {
  @IsString() @MinLength(1) @MaxLength(2000) text!: string;
}
class ReportDto {
  @IsBoolean() on!: boolean;
}

/**
 * Alert action-item state (intel_action_item), same guards/paths as the Feed.
 * intel-api owns this state; apps/api generates the memo itself and the frontend
 * records the resulting Document link here so the Feed can show "memo drafted".
 */
@Controller('clients')
@UseGuards(TenantGuard, TrackerV2Guard)
export class ActionItemController {
  constructor(
    private readonly svc: ActionItemService,
    private readonly packet: AlertPacketService,
  ) {}

  /**
   * §4.1 / P1-13: the server-built Government Affairs Alert Packet for one alert, so
   * every generator reads the same complete context instead of a frontend-authored
   * projection. Read-only, DB reads only — no LLM call and no new timeout.
   *
   * Guards: this route inherits TenantGuard + TrackerV2Guard from the controller, the
   * same posture as its memo-link/talking-point/report siblings. It deliberately does NOT
   * add TrackerOwnerGuard, which the plan's f-2 suggested: that guard is applied at
   * controller scope here, so adding it would silently change the guard posture of three
   * already-shipped routes and 404 them for any tenant without tracker_owner_intel. The
   * ownership proof that actually matters is in the service — assertClientInTenant for
   * the client, plus a (tenantId, clientId) predicate on the alert itself.
   */
  @Get(':clientId/alerts/:alertId/packet')
  getPacket(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Param('alertId') alertId: string,
  ) {
    return this.packet.build(ctx.tenantId, clientId, alertId);
  }

  @Post(':clientId/alerts/:alertId/memo-link')
  recordMemo(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Param('alertId') alertId: string,
    @Body() body: MemoLinkDto,
  ) {
    return this.svc.recordMemo(ctx.tenantId, clientId, alertId, ctx.clerkUserId, body);
  }

  @Get(':clientId/alerts/:alertId/memo-link')
  getMemo(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') _clientId: string,
    @Param('alertId') alertId: string,
  ) {
    return this.svc.getMemo(ctx.tenantId, alertId);
  }

  @Post(':clientId/alerts/:alertId/talking-point')
  addTalkingPoint(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Param('alertId') alertId: string,
    @Body() body: TalkingPointDto,
  ) {
    return this.svc.addTalkingPoint(ctx.tenantId, clientId, alertId, ctx.clerkUserId, body.text);
  }

  @Post(':clientId/alerts/:alertId/report')
  setReport(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Param('alertId') alertId: string,
    @Body() body: ReportDto,
  ) {
    return this.svc.setReport(ctx.tenantId, clientId, alertId, ctx.clerkUserId, body.on);
  }

  @Get(':clientId/action-items')
  list(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Query('kind') kind?: string,
  ) {
    return this.svc.listForClient(ctx.tenantId, clientId, kind);
  }
}
