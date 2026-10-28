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
   *
   * The durable intake run's drafting is served by the approved greenfield
   * native conversation owner, which verifies the CURRENT authenticated session
   * credential itself. That credential exists only on this attended request, so
   * the run is dispatched from here with it — it is forwarded verbatim to the
   * owner, never persisted, and never widened into a new approval of its own. A
   * replayed request (same Idempotency-Key) returns the same receipt and cannot
   * start a second paid run: the run's own exact request identity is what the
   * owner replays.
   */
  @Post('intakes')
  @HttpCode(HttpStatus.ACCEPTED)
  async createIntake(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: IntakeRequestDto,
    @Headers('authorization') authorization?: string,
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
    const receipt = await this.intakeService.createIntake(
      ctx.tenantId,
      ctx.clerkUserId,
      idempotencyKey.trim(),
      dto,
    );
    // The receipt is already durable. Admitting the native turn is bounded (one
    // observation window) and its outcome is recorded on the run itself, so a
    // refusal or a lost answer never invalidates the receipt the caller holds.
    await this.runWorker.claim(receipt.runId, {
      credential: nativeCredential(authorization),
    });
    return receipt;
  }

  /**
   * GET /workspace-api/document-agent/runs/:runId/status
   * Poll the durable run status. The editor hydrates real stages and
   * per-section state from this endpoint. The reading caller's own current
   * credential lets a run whose native request is retained unresolved be
   * reconciled against that SAME stored request.
   */
  @Get('runs/:runId/status')
  async getRunStatus(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('runId') runId: string,
    @Headers('authorization') authorization?: string,
  ): Promise<RunStatusResponse> {
    return this.runWorker.getRunStatus(ctx.tenantId, runId, {
      actorId: ctx.clerkUserId,
      credential: nativeCredential(authorization),
    });
  }

  /**
   * POST /workspace-api/document-agent/runs/:runId/retry-failed
   * Retry only failed or stale sections. The worker preserves successful
   * sections on retry.
   *
   * A durable intake run's retry is a continuation of its RETAINED native
   * request, which the owner verifies against the caller's own current session
   * credential — so this attended request's credential is forwarded exactly as
   * the intake and status routes forward it (verbatim, never persisted, never
   * widened). The response keeps its shape; `status` is the run's real status
   * after the continuation ('queued' as before for a run that is not a durable
   * intake).
   */
  @Post('runs/:runId/retry-failed')
  @HttpCode(HttpStatus.ACCEPTED)
  async retryFailed(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('runId') runId: string,
    @Headers('authorization') authorization?: string,
  ): Promise<{ runId: string; status: string }> {
    const status = await this.runWorker.retryFailedSections(ctx.tenantId, runId, ctx.clerkUserId, {
      credential: nativeCredential(authorization),
    });
    return { runId, status };
  }
}

/** The current authenticated session credential, forwarded to the native owner verbatim. */
const nativeCredential = (authorization?: string): string | undefined =>
  authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
