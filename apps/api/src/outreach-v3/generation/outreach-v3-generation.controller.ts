import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { EngagementRuntimeAction } from '../../engagement/runtime/engagement-runtime-action.decorator.js';
import { OutreachV3ExceptionFilter } from '../api/outreach-v3-exception.filter.js';
import { OutreachV3StateGuard } from '../api/outreach-v3-state.guard.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { OutreachV3ApproachApprovalService } from './outreach-v3-approach-approval.service.js';
import { OutreachV3FullGenerationGuard } from './outreach-v3-full-generation.guard.js';
import { OutreachV3FullGenerationService } from './outreach-v3-full-generation.service.js';
import { OutreachV3GenerationGuard } from './outreach-v3-generation.guard.js';
import { OutreachV3GenerationService } from './outreach-v3-generation.service.js';
import { OutreachV3SampleGenerationService } from './outreach-v3-sample-generation.service.js';

@Controller('engagement/outreach-v3/sessions/:sessionId/generation')
@UseGuards(OutreachV3StateGuard, OutreachV3GenerationGuard, RolesGuard)
@UseFilters(OutreachV3ExceptionFilter)
@Roles('standard_user')
export class OutreachV3GenerationController {
  constructor(
    private readonly generation: OutreachV3GenerationService,
    private readonly samples: OutreachV3SampleGenerationService,
    private readonly approach: OutreachV3ApproachApprovalService,
    private readonly full: OutreachV3FullGenerationService,
  ) {}

  @Get('plan')
  plan(@CurrentTenant() ctx: TenantContext, @Param('sessionId', ParseUUIDPipe) sessionId: string) {
    return this.generation.plan(ctx, sessionId);
  }

  @Post('samples')
  @EngagementRuntimeAction('outreach_v3_generate')
  generateSamples(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Headers('authorization') authHeader?: string,
  ) {
    return this.samples.generateSamples(ctx, sessionId, authHeader);
  }

  /**
   * Read the current exact-version approach approval. A stale approval is
   * returned as null rather than being cosmetically carried forward.
   */
  @Get('approach-approval')
  getApproachApproval(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return this.approach.getCurrent(ctx, sessionId);
  }

  @Post('approach-approval')
  approveApproach(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: unknown,
  ) {
    return this.approach.approve(ctx, sessionId, approvalVersionIds(body));
  }

  /**
   * Guided-flow human gate. This accepts only an empty body because the exact
   * review packet is already represented by the canonical Campaign Spec and
   * generation-plan hash loaded server-side.
   */
  @Post('review-packet-approval')
  approveReviewPacket(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: unknown,
  ) {
    assertEmptyReviewPacketBody(body);
    return this.approach.approveReviewPacket(ctx, sessionId);
  }

  @Post('full')
  @EngagementRuntimeAction('outreach_v3_generate')
  @UseGuards(OutreachV3FullGenerationGuard)
  startFullGeneration(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: unknown,
  ) {
    return this.full.submit(ctx, sessionId, requestKey(body));
  }

  /**
   * Server-truth recovery (Workstream H). Returns the most recent full
   * generation job for this session, or `{ job: null }` when none has ever
   * been created. Registered before `jobs/:jobId` so "latest" is never
   * captured by the ParseUUIDPipe'd :jobId param.
   */
  @Get('jobs/latest')
  @UseGuards(OutreachV3FullGenerationGuard)
  async getLatestFullGenerationJob(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    return { job: await this.full.getLatestJob(ctx, sessionId) };
  }

  @Get('jobs/:jobId')
  @UseGuards(OutreachV3FullGenerationGuard)
  getFullGenerationJob(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    return this.full.getJob(ctx, sessionId, jobId);
  }

  @Post('jobs/:jobId/cancel')
  @UseGuards(OutreachV3FullGenerationGuard)
  cancelFullGenerationJob(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ) {
    return this.full.cancel(ctx, sessionId, jobId);
  }

  @Post('jobs/:jobId/items/:itemId/retry')
  @EngagementRuntimeAction('outreach_v3_generate')
  @UseGuards(OutreachV3FullGenerationGuard)
  retryFullGenerationItem(
    @CurrentTenant() ctx: TenantContext,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.full.retryItem(ctx, sessionId, jobId, itemId);
  }
}

function approvalVersionIds(body: unknown): string[] {
  const record = strictObject(body, ['versionIds'], invalidApprovalBody);
  const value = record.versionIds;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 3 ||
    value.some((entry) => typeof entry !== 'string' || !entry.trim())
  ) {
    throw invalidApprovalBody();
  }
  return value.map((entry) => String(entry).trim());
}

function assertEmptyReviewPacketBody(body: unknown): void {
  if (body === undefined || body === null) return;
  strictObject(body, [], invalidReviewPacketBody);
}

function requestKey(body: unknown): string {
  const record = strictObject(body, ['requestKey'], invalidRequestKey);
  const value = record.requestKey;
  if (typeof value !== 'string' || value.trim().length < 8 || value.trim().length > 128) {
    throw invalidRequestKey();
  }
  return value.trim();
}

function strictObject(
  value: unknown,
  allowedKeys: readonly string[],
  errorFactory: () => OutreachCommandError,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw errorFactory();
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw errorFactory();
  return record;
}

function invalidApprovalBody(): OutreachCommandError {
  return new OutreachCommandError(
    'OUTREACH_COMMAND_INVALID',
    'Approach approval requires one to three immutable sample version ids and no other fields.',
    400,
  );
}

function invalidReviewPacketBody(): OutreachCommandError {
  return new OutreachCommandError(
    'OUTREACH_COMMAND_INVALID',
    'Review-packet approval accepts no client-supplied fields.',
    400,
  );
}

function invalidRequestKey(): OutreachCommandError {
  return new OutreachCommandError(
    'OUTREACH_COMMAND_INVALID',
    'Full generation accepts only a requestKey between 8 and 128 characters.',
    400,
  );
}
