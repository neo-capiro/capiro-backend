import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsIn } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';
import {
  MERIV3_REASONING_MODES,
  reasoningModeFromConversationMetadata,
  withMeriV3ReasoningMode,
  type MeriV3ReasoningMode,
} from './meriv3-conversation.helpers.js';

class SetMeriV3ReasoningModeDto {
  @IsIn([...MERIV3_REASONING_MODES])
  reasoningMode!: MeriV3ReasoningMode;
}

@Controller('clio/v3')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MeriV3SettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: MeriFeatureFlagsService,
  ) {}

  @Get('capabilities')
  async capabilities(@CurrentTenant() ctx: TenantContext) {
    await this.assertEnabled(ctx);
    return {
      runtime: 'meriv3' as const,
      defaultReasoningMode: 'standard' as const,
      reasoningModes: [
        { mode: 'fast', label: 'Fast', description: 'Quick answers and direct lookups.' },
        { mode: 'standard', label: 'Standard', description: 'Balanced everyday reasoning.' },
        { mode: 'deep', label: 'Deep', description: 'More investigation for strategic work.' },
        { mode: 'max', label: 'Max', description: 'Highest configured reasoning tier.' },
      ],
      rawReasoningVisible: false,
      providerStateStored: false,
      defaultPresentation: 'browser_window' as const,
    };
  }

  @Get('conversations/:conversationId/reasoning-mode')
  async getReasoningMode(
    @CurrentTenant() ctx: TenantContext,
    @Param('conversationId') conversationId: string,
  ) {
    await this.assertEnabled(ctx);
    const conversation = await this.findConversation(ctx, conversationId);
    return {
      conversationId,
      reasoningMode: reasoningModeFromConversationMetadata(conversation.metadata),
    };
  }

  @Patch('conversations/:conversationId/reasoning-mode')
  async setReasoningMode(
    @CurrentTenant() ctx: TenantContext,
    @Param('conversationId') conversationId: string,
    @Body() body: SetMeriV3ReasoningModeDto,
  ) {
    await this.assertEnabled(ctx);
    const conversation = await this.findConversation(ctx, conversationId);
    const metadata = withMeriV3ReasoningMode(conversation.metadata, body.reasoningMode);
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.update({
        where: { id: conversationId },
        data: { metadata: metadata as Prisma.InputJsonValue, updatedAt: new Date() },
      }),
    );
    return { conversationId, reasoningMode: body.reasoningMode };
  }

  private async assertEnabled(ctx: TenantContext): Promise<void> {
    if (!(await this.flags.isMeriV3ChatEnabled(ctx.tenantId, ctx.tenantSlug))) {
      throw new NotFoundException('Chat runtime not found');
    }
  }

  private async findConversation(ctx: TenantContext, conversationId: string) {
    const conversation = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.findFirst({
        where: {
          id: conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          archivedAt: null,
        },
        select: { id: true, metadata: true },
      }),
    );
    if (!conversation) throw new NotFoundException('Meri conversation not found');
    return conversation;
  }
}
