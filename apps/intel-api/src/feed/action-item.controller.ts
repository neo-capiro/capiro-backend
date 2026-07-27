import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { TrackerV2Guard } from './tracker-v2.guard.js';
import { ActionItemService } from './action-item.service.js';
import { AlertPacketService } from './alert-packet.service.js';
import {
  AlertWorkStateService,
  BULK_MAX,
  WORK_STATES,
  type WorkStatePatch,
  type WorkStateValue,
} from './alert-work-state.service.js';

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
 * P2-04 (Gate D e-3). Real DTO classes with @IsIn allowlists — the global
 * ValidationPipe runs whitelist + forbidNonWhitelisted, so an undecorated field
 * is rejected outright and an unlisted state can never reach the column.
 */
export class SetWorkStateDto {
  @IsOptional() @IsIn(WORK_STATES as unknown as string[]) state?: WorkStateValue;
  @IsOptional() @IsString() @MaxLength(200) assignedTo?: string | null;
  @IsOptional() @IsDateString() snoozedUntil?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) note?: string | null;
}

export class BulkWorkStateDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_MAX)
  @IsString({ each: true })
  alertIds!: string[];

  @IsOptional() @IsIn(WORK_STATES as unknown as string[]) state?: WorkStateValue;
  @IsOptional() @IsString() @MaxLength(200) assignedTo?: string | null;
  @IsOptional() @IsDateString() snoozedUntil?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) note?: string | null;
}

/** Shared DTO → service patch mapping, so the two routes cannot drift. */
function toPatch(dto: SetWorkStateDto | BulkWorkStateDto): WorkStatePatch {
  return {
    ...(dto.state !== undefined ? { state: dto.state } : {}),
    ...(dto.assignedTo !== undefined ? { assignedTo: dto.assignedTo ?? null } : {}),
    ...(dto.snoozedUntil !== undefined
      ? { snoozedUntil: dto.snoozedUntil ? new Date(dto.snoozedUntil) : null }
      : {}),
    ...(dto.note !== undefined ? { note: dto.note ?? null } : {}),
  };
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
    private readonly workState: AlertWorkStateService,
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

  /**
   * P2-04: this user's triage state for one alert. Idempotent — a repeated
   * "mark reviewed" upserts on (alertId, userId) rather than inserting again.
   * Deliberately writes NO `intel_alert.status`: the event stays global.
   */
  @Post(':clientId/alerts/:alertId/work-state')
  async setWorkState(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Param('alertId') alertId: string,
    @Body() body: SetWorkStateDto,
  ) {
    await this.workState.setState(
      ctx.tenantId,
      clientId,
      alertId,
      ctx.clerkUserId,
      toPatch(body),
    );
    return { ok: true };
  }

  /** P2-04: bulk triage. Capped at BULK_MAX by the DTO; the web chunks above it. */
  @Post(':clientId/alerts/work-state/bulk')
  bulkSetWorkState(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Body() body: BulkWorkStateDto,
  ) {
    return this.workState.bulkSetState(
      ctx.tenantId,
      clientId,
      body.alertIds,
      ctx.clerkUserId,
      toPatch(body),
    );
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
