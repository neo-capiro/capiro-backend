import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { IntakeService } from './intake.service.js';
import { GenerationRunWorkerService } from './generation-run-worker.service.js';
import { TwoStepDraftFlagsService } from './two-step-draft-flags.service.js';
import type {
  IntakeRequestDto,
  IntakeResponse,
  RunStatusResponse,
  TwoStepDraftCapabilityResponse,
} from './dto/intake.dto.js';

/**
 * Two-step Max draft flow — aggregate, idempotent intake endpoint and
 * durable run status polling.
 *
 * The browser sends only identifiers — never server-backed source bodies.
 * The backend re-fetches and authorizes every selected ID in one transaction
 * and returns 202 only after the draft, sources, run, and durable job are
 * persisted.
 */
@Controller('document-agent')
@UseGuards(TenantGuard)
export class TwoStepDraftController {
  constructor(
    private readonly intakeService: IntakeService,
    private readonly runWorker: GenerationRunWorkerService,
    private readonly flags: TwoStepDraftFlagsService,
  ) {}

  /**
   * GET /workspace-api/document-agent/two-step-draft-capability
   * Returns whether the two-step Max draft flow is enabled for this tenant.
   */
  @Get('two-step-draft-capability')
  async getCapability(
    @CurrentTenant() ctx: WorkspaceTenantContext,
  ): Promise<TwoStepDraftCapabilityResponse> {
    const enabled = await this.flags.isTwoStepDraftEnabled(ctx.tenantId);
    return { enabled };
  }

  /**
   * POST /workspace-api/document-agent/intakes
   * Aggregate, idempotent intake. Returns 202 after persisting the draft,
   * source selections, run, and durable job record.
   */
  @Post('intakes')
  @HttpCode(HttpStatus.ACCEPTED)
  async createIntake(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: IntakeRequestDto,
  ): Promise<IntakeResponse> {
    // Enforce the flag server-side — frontend gating alone is insufficient.
    const enabled = await this.flags.isTwoStepDraftEnabled(ctx.tenantId);
    if (!enabled) {
      throw new ConflictException(
        'The two-step Max draft flow is not enabled for this tenant.',
      );
    }
    if (!idempotencyKey || idempotencyKey.trim().length < 8) {
      throw new BadRequestException('A valid Idempotency-Key header is required.');
    }
    return this.intakeService.createIntake(
      ctx.tenantId,
      ctx.clerkUserId,
      idempotencyKey.trim(),
      dto,
    );
  }

  /**
   * GET /workspace-api/document-agent/runs/:runId/status
   * Poll the durable run status. The editor hydrates real stages and
   * per-section state from this endpoint.
   */
  @Get('runs/:runId/status')
  async getRunStatus(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('runId') runId: string,
  ): Promise<RunStatusResponse> {
    return this.runWorker.getRunStatus(ctx.tenantId, runId);
  }

  /**
   * POST /workspace-api/document-agent/runs/:runId/retry-failed
   * Retry only failed or stale sections. The worker preserves successful
   * sections on retry.
   */
  @Post('runs/:runId/retry-failed')
  @HttpCode(HttpStatus.ACCEPTED)
  async retryFailed(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('runId') runId: string,
  ): Promise<{ runId: string; status: string }> {
    await this.runWorker.retryFailedSections(ctx.tenantId, runId, ctx.clerkUserId);
    return { runId, status: 'queued' };
  }
}
