import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyPlannerGuard } from '../flags/strategy-planner.guard.js';
import { StrategyMeriGuard } from '../flags/strategy-meri.guard.js';
import { MeriService } from './meri.service.js';
import { StrategyConversationService } from './strategy-conversation.service.js';
import { DraftStrategyDto, AssistantDto, ReferenceAssistDto } from './dto/meri.dto.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bearer token TenantGuard verified but did not stash — needed to forward to the orchestrator. */
function bearerFrom(req: Request): string | undefined {
  const h = req.headers?.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m?.[1];
}

/**
 * Meri endpoints (G5) — draft-from-goal, panel assistant, reference assist, and
 * (Phase 2) the durable conversation reads. All behind TenantGuard →
 * StrategyPlannerGuard → StrategyMeriGuard (module on AND Meri opt-in AND env
 * kill-switch). No global prefix here; main.ts adds /strategy-api, so these are
 * /strategy-api/strategies/draft etc.
 */
@Controller()
@UseGuards(TenantGuard, StrategyPlannerGuard, StrategyMeriGuard)
export class MeriController {
  constructor(
    private readonly meri: MeriService,
    private readonly conversations: StrategyConversationService,
  ) {}

  /**
   * Phase 2: one context's persisted conversation, oldest first. `nodeId`
   * omitted = the strategy thread; a node id = that step's thread. Never "all
   * threads" — the two contexts are separate conversations.
   */
  @Get('strategies/:id/conversations')
  conversation(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('nodeId') nodeId?: string,
  ) {
    const node = nodeId?.trim() || null;
    if (node && !UUID_RE.test(node)) {
      throw new BadRequestException('nodeId must be a UUID');
    }
    return this.conversations.list(ctx.tenantId, id, node);
  }

  /** Phase 2: dismiss a persistent context-gap note. Only that message changes. */
  @Post('strategies/:id/conversations/context-gaps/:messageId/dismiss')
  dismissContextGap(
    @CurrentTenant() ctx: AuthTenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
  ) {
    return this.conversations.dismissContextGap(ctx.tenantId, id, messageId);
  }

  @Post('strategies/draft')
  draft(@CurrentTenant() ctx: AuthTenantContext, @Req() req: Request, @Body() dto: DraftStrategyDto) {
    return this.meri.draft(ctx.tenantId, ctx.clerkUserId, bearerFrom(req), dto);
  }

  @Post('strategies/:id/assistant')
  assistant(
    @CurrentTenant() ctx: AuthTenantContext,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: AssistantDto,
  ) {
    return this.meri.assistant(ctx.tenantId, ctx.clerkUserId, bearerFrom(req), id, dto);
  }

  @Post('reference-calendars/:kind/assist')
  refAssist(
    @CurrentTenant() ctx: AuthTenantContext,
    @Req() req: Request,
    @Param('kind') kind: string,
    @Body() dto: ReferenceAssistDto,
  ) {
    if (kind !== 'congress' && kind !== 'ppbe') {
      throw new BadRequestException(`Unknown reference kind "${kind}"`);
    }
    return this.meri.referenceAssist(ctx.tenantId, bearerFrom(req), kind, dto);
  }
}
