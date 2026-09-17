import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
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
import { DraftJobService } from './draft-job.service.js';
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
    private readonly draftJobs: DraftJobService,
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

  /**
   * Strategy generation timeout fix: this used to run the ENTIRE orchestrator
   * draft synchronously on the request (context compile, grounding fan-out,
   * the model's own repair/retry loop, verify, persist) — a shape with no
   * fixed timeout that is both safe and a good client experience (the
   * orchestrator's loop can legitimately take many minutes). It now only
   * validates and enqueues an SpDraftJob; DraftJobWorkerService's claim-sweep
   * runs the actual generation off the request path. Poll
   * GET strategies/draft-jobs/:jobId for status.
   */
  @Post('strategies/draft')
  @HttpCode(202)
  draftAsync(@CurrentTenant() ctx: AuthTenantContext, @Req() req: Request, @Body() dto: DraftStrategyDto) {
    return this.draftJobs.submit(ctx, bearerFrom(req), dto);
  }

  @Get('strategies/draft-jobs/:jobId')
  draftJob(@CurrentTenant() ctx: AuthTenantContext, @Param('jobId', new ParseUUIDPipe()) jobId: string) {
    return this.draftJobs.get(ctx, jobId);
  }

  @Post('strategies/:id/assistant')
  assistant(
    @CurrentTenant() ctx: AuthTenantContext,
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
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
