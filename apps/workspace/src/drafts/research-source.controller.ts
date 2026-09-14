import {
  Body,
  Controller,
  Post,
  UseGuards,
  BadRequestException,
  ServiceUnavailableException,
  Get,
  Param,
  Query,
  NotFoundException,
} from '@nestjs/common';
import { DraftsService } from './drafts.service.js';
import { PreparationSourceGuard } from './preparation-source.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { createHash } from 'node:crypto';
import { meriImportText } from '../documents/meri-import-text.js';
@Controller('internal/legiwatch/research')
@UseGuards(PreparationSourceGuard)
export class ResearchDraftSourceController {
  constructor(
    readonly drafts: DraftsService,
    readonly prisma: PrismaService,
  ) {}
  @Get(':id/output') async output(
    @Param('id') id: string,
    @Query('tenantId') tenantId: string,
    @Query('ownerId') ownerId: string,
  ) {
    const rows = await this.prisma.$queryRaw<
      Array<{ draft_id: string }>
    >`SELECT draft_id::text FROM ws_source_action WHERE tenant_id=${tenantId}::uuid AND owner_id=${ownerId} AND source_type='legiwatch_research' AND source_key=${id}`;
    if (!rows[0]) throw new NotFoundException('RESEARCH_OUTPUT_NOT_FOUND');
    const draft = await this.drafts.byId(tenantId, rows[0].draft_id, ownerId);
    const snapshot = {
      title: draft.docTitle,
      config: draft.config,
      documents: draft.documents.map((d) => ({
        id: d.id,
        name: d.name,
        body: d.body,
        ordinal: d.ordinal,
      })),
    };
    const serialized = JSON.stringify(snapshot);
    if (serialized.length > 1_000_000)
      throw new BadRequestException('RESEARCH_REPORT_OUTPUT_TOO_LARGE');
    const text = draft.documents
      .map((d, i) => meriImportText(d.body, i === 0 ? draft.config : {}))
      .filter(Boolean)
      .join('\n\n');
    if (!text || text.length > 200_000)
      throw new BadRequestException('RESEARCH_REPORT_TEXT_UNAVAILABLE_OR_TOO_LARGE');
    return {
      selectionId: id,
      draftId: draft.id,
      outputHash: createHash('sha256').update(serialized).digest('hex'),
      snapshot,
      text,
    };
  }
  @Post() async create(@Body() body: unknown) {
    const b = body as Record<string, unknown>;
    if (
      !b ||
      typeof b.tenantId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(b.tenantId) ||
      typeof b.ownerId !== 'string' ||
      !b.ownerId ||
      b.ownerId.length > 200 ||
      typeof b.actionId !== 'string' ||
      b.actionId.length > 200
    )
      throw new BadRequestException('RESEARCH_ACTION_IDENTITY_REQUIRED');
    const base = process.env.INTEL_API_BASE_URL,
      secret = process.env.INTERNAL_SERVICE_SECRET;
    if (!base || !secret)
      throw new ServiceUnavailableException('INTEL_SOURCE_OWNER_NOT_CONFIGURED');
    const query = new URLSearchParams({ tenantId: b.tenantId, ownerId: b.ownerId });
    const response = await fetch(
      `${base.replace(/\/+$/, '')}/intel-api/internal/legiwatch/research-source/${encodeURIComponent(b.actionId)}?${query}`,
      {
        headers: { 'x-internal-service-secret': secret },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    );
    if (!response.ok) throw new ServiceUnavailableException('RESEARCH_SOURCE_HELD');
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
      source.prefill?.context.snapshotId !== b.actionId ||
      !Array.isArray(source.prefill.sources) ||
      JSON.stringify(source).length > 1_000_000
    )
      throw new BadRequestException('INVALID_RESEARCH_SOURCE');
    return this.drafts.createResearch(b.tenantId, b.ownerId, b.actionId, source.prefill);
  }
}
