import {
  Body,
  Controller,
  Post,
  UseGuards,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DraftsService } from './drafts.service.js';
import { PreparationSourceGuard } from './preparation-source.guard.js';
@Controller('internal/legiwatch/preparations')
@UseGuards(PreparationSourceGuard)
export class PreparationSourceController {
  constructor(readonly drafts: DraftsService) {}
  @Post() async create(@Body() body: unknown) {
    const b = body as Record<string, unknown>;
    if (
      !b ||
      typeof b.tenantId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(b.tenantId) ||
      typeof b.ownerId !== 'string' ||
      typeof b.actionId !== 'string' ||
      b.actionId.length > 200
    )
      throw new BadRequestException('SOURCE_ACTION_IDENTITY_REQUIRED');
    const base = process.env.INTEL_API_BASE_URL,
      secret = process.env.INTERNAL_SERVICE_SECRET;
    if (!base || !secret)
      throw new ServiceUnavailableException('INTEL_SOURCE_OWNER_NOT_CONFIGURED');
    const q = new URLSearchParams({ tenantId: b.tenantId, ownerId: b.ownerId });
    const response = await fetch(
      `${base.replace(/\/+$/, '')}/intel-api/internal/legiwatch/workflow-actions/${encodeURIComponent(b.actionId)}?${q}`,
      {
        headers: { 'x-internal-service-secret': secret },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new ServiceUnavailableException('PREPARATION_SOURCE_HELD');
    const source = (await response.json()) as {
      actionId: string;
      prefill: {
        draft: { docTitle: string };
        context: Record<string, unknown>;
        sources: unknown[];
      };
    };
    if (
      source.actionId !== b.actionId ||
      !source.prefill?.context?.snapshotId ||
      JSON.stringify(source).length > 1000000
    )
      throw new BadRequestException('INVALID_PREPARATION_SOURCE_CONTRACT');
    return this.drafts.createPreparation(b.tenantId, b.ownerId, b.actionId, source.prefill);
  }
}
