import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { QuickDraftService } from './quick-draft.service.js';
import { TwoStepDraftFlagsService } from './two-step-draft-flags.service.js';
import { GenerateFromIntakeDto } from './dto/quick-draft.dto.js';

/**
 * Legacy generate-from-intake endpoint (PR #964).
 *
 * Kept temporarily behind the feature flag for backward compatibility.
 * The new UI does NOT call this endpoint — it uses the aggregate
 * POST /document-agent/intakes endpoint instead.
 *
 * This endpoint will be removed before broad rollout or made to delegate
 * to the aggregate operation without running synchronous generation.
 */
@Controller('drafts/:draftId/agent')
@UseGuards(TenantGuard)
export class QuickDraftController {
  constructor(
    private readonly quickDraft: QuickDraftService,
    private readonly flags: TwoStepDraftFlagsService,
  ) {}

  @Post('generate-from-intake')
  async generateFromIntake(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: GenerateFromIntakeDto,
  ) {
    // Enforce the flag server-side — this endpoint is only available
    // when the two-step draft flow is enabled.
    const enabled = await this.flags.isTwoStepDraftEnabled(ctx.tenantId);
    if (!enabled) {
      throw new BadRequestException(
        'The quick draft flow is not enabled for this tenant.',
      );
    }
    return this.quickDraft.generateFromIntake(
      ctx.tenantId,
      draftId,
      ctx.clerkUserId,
      dto,
    );
  }
}
