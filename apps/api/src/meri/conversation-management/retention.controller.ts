import { Body, Controller, ForbiddenException, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { InternalServiceGuard, hasInternalServiceIdentity } from '../../auth/internal-service.guard.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { readConversationRetentionState, finalizeConversationRetention, verifyConversationRetention } from './retention.js';

/** Fixed backend-only retention operations. The existing service identity is
 * required; an interactive bearer cannot read facts or finalize metadata. */
@Controller('internal/conversation-retention')
@UseGuards(InternalServiceGuard)
export class ConversationRetentionController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('read') @HttpCode(200)
  read(@Body() body: { tenantId: string; conversationId: string }, @Req() req: Request) {
    if (!hasInternalServiceIdentity(req)) throw new ForbiddenException('Verified service identity required');
    return readConversationRetentionState(this.prisma, body);
  }

  @Post('finalize') @HttpCode(200)
  finalize(@Body() body: unknown, @Req() req: Request) {
    if (!hasInternalServiceIdentity(req)) throw new ForbiddenException('Verified service identity required');
    return finalizeConversationRetention(this.prisma, body);
  }

  @Post('verify') @HttpCode(200)
  verify(@Body() body: unknown, @Req() req: Request) {
    if (!hasInternalServiceIdentity(req)) throw new ForbiddenException('Verified service identity required');
    return verifyConversationRetention(this.prisma, body);
  }
}
