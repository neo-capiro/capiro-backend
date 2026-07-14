import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import { TrackerSummaryService } from './notifications/tracker-summary.service.js';

/**
 * class-validator decorators are REQUIRED: the app's global ValidationPipe runs
 * `whitelist: true` + `forbidNonWhitelisted: true` (main.ts), so an undecorated
 * DTO makes EVERY body key "non-whitelisted" → the pipe 400s before the handler
 * ever runs. billTitle is optional (some bills carry a null title); the other
 * four are required strings (emptiness is re-checked, trimmed, in the handler).
 */
export class SummarizeAlertDto {
  @IsString()
  tenantId!: string;

  @IsString()
  displayNum!: string;

  @IsOptional()
  @IsString()
  billTitle?: string;

  @IsString()
  label!: string;

  @IsString()
  actionText!: string;
}

/**
 * Internal-only (InternalServiceGuard) bill-alert "what happened" summary, for
 * backend-service callers that hold a tenantId but no Clerk-authenticated
 * TenantContext — currently intel-api's LegiWatch alert-delivery path
 * (emit-bill-alerts), which owns the alert emails but has NO in-process LLM
 * (it delegates all generation to apps/api, the credential-store owner). Mirrors
 * the sibling InternalAiCredentialsController: same guard, same shared-secret
 * channel intel-api already calls for the live-hearing BYOK path.
 *
 * Deliberately reuses the SAME TrackerSummaryService the legacy apps/api alert
 * pipeline uses, so the "what happened" line is identical no matter which
 * pipeline sends the email — the property you want during the tracker cutover.
 * TrackerSummaryService is fail-safe by contract (disabled flag / no key /
 * provider error / timeout all return null), so a null summary just means the
 * caller omits the line and still sends. The TRACKER_ALERT_SUMMARY flag and the
 * per-tenant BYOK Anthropic key stay single-sourced here on the apps/api side.
 *
 * NOT reachable by an ordinary user JWT (InternalServiceGuard, not RolesGuard).
 */
@Controller('internal/tracker')
@UseGuards(InternalServiceGuard)
export class InternalTrackerController {
  constructor(private readonly summaries: TrackerSummaryService) {}

  @Post('summarize')
  @HttpCode(200)
  async summarize(@Body() dto: SummarizeAlertDto): Promise<{ summary: string | null }> {
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const tenantId = str(dto?.tenantId);
    const displayNum = str(dto?.displayNum);
    const label = str(dto?.label);
    const actionText = str(dto?.actionText);
    // billTitle may legitimately be empty (some bills carry a null title) — do
    // not require it; the prompt renders "Bill: <num> — <title>" either way.
    const billTitle = str(dto?.billTitle);
    if (!tenantId) throw new BadRequestException('tenantId is required');
    if (!displayNum || !label || !actionText) {
      throw new BadRequestException('displayNum, label, and actionText are required');
    }

    const summary = await this.summaries.summarize({
      tenantId,
      displayNum,
      billTitle,
      label,
      actionText,
    });
    return { summary };
  }
}
