import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { OutreachReasoningExceptionFilter } from './outreach-reasoning-exception.filter.js';
import { OutreachReasoningHistoryService } from './outreach-reasoning-history.service.js';
import { OutreachReasoningService } from './outreach-reasoning.service.js';
import { OutreachV3ReasoningGuard } from './outreach-v3-reasoning.guard.js';

@Controller('engagement/outreach-v3')
@UseGuards(OutreachV3ReasoningGuard, RolesGuard)
@UseFilters(OutreachReasoningExceptionFilter)
@Roles('standard_user')
export class OutreachV3ReasoningController {
  constructor(
    private readonly reasoning: OutreachReasoningService,
    private readonly history: OutreachReasoningHistoryService,
  ) {}

  @Post('sessions/:sessionId/reasoning/conversations')
  createConversation(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.reasoning.createConversation(ctx, sessionId);
  }

  @Get('reasoning/conversations/:conversationId')
  getConversation(
    @CurrentTenant() ctx: TenantContext,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return this.reasoning.getConversation(ctx, conversationId);
  }

  @Get('reasoning/conversations/:conversationId/turns')
  listTurns(
    @CurrentTenant() ctx: TenantContext,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query('limit') limit?: string,
  ) {
    return this.history.listTurns(ctx, conversationId, Number(limit));
  }

  @Post('reasoning/conversations/:conversationId/turns')
  respond(
    @CurrentTenant() ctx: TenantContext,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() body: unknown,
  ) {
    return this.reasoning.respond(ctx, conversationId, body);
  }

  @Post('reasoning/conversations/:conversationId/archive')
  archiveConversation(
    @CurrentTenant() ctx: TenantContext,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return this.reasoning.archiveConversation(ctx, conversationId);
  }
}
