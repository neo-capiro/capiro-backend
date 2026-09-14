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
import { renderEditorialOutput } from './editorial-output.js';
@Controller('internal/legiwatch/editorial')
@UseGuards(PreparationSourceGuard)
export class EditorialDraftSourceController {
  constructor(
    readonly drafts: DraftsService,
    readonly prisma: PrismaService,
  ) {}
  @Post('lookup') async lookup(@Body() body: unknown) {
    const b = body as Record<string, unknown>;
    if (
      !b ||
      typeof b.tenantId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(b.tenantId) ||
      typeof b.ownerId !== 'string' ||
      !b.ownerId ||
      b.ownerId.length > 200 ||
      !Array.isArray(b.selectionIds) ||
      b.selectionIds.length > 50 ||
      b.selectionIds.some((id) => typeof id !== 'string' || !id || id.length > 200)
    )
      throw new BadRequestException('BOUNDED_EDITORIAL_IDENTITIES_REQUIRED');
    const tenantId = b.tenantId,
      ownerId = b.ownerId;
    const rows = await this.prisma.$queryRaw<Array<{ source_key: string; draft_id: string }>>`
      SELECT source_key,draft_id::text FROM ws_source_action
      WHERE tenant_id=${tenantId}::uuid AND owner_id=${ownerId}
        AND source_type='legiwatch_editorial' AND source_key=ANY(${b.selectionIds as string[]}::text[])`;
    const drafts: Array<{ selectionId: string; draftId: string; title: string; updatedAt: Date }> =
      [];
    const accessBudget = AbortSignal.timeout(12_000);
    // Use the same current collaboration/source guard as opening the editor.
    // A known source receipt is never enough to disclose a private draft.
    for (let i = 0; i < rows.length; i += 5) {
      const batch = await Promise.all(
        rows.slice(i, i + 5).map(async (row) => {
          try {
            const draft = await this.drafts.byId(tenantId, row.draft_id, ownerId, accessBudget);
            return {
              selectionId: row.source_key,
              draftId: draft.id,
              title: draft.docTitle,
              updatedAt: draft.updatedAt,
            };
          } catch (e) {
            if (e instanceof NotFoundException) return null;
            throw e;
          }
        }),
      );
      for (const draft of batch) if (draft) drafts.push(draft);
    }
    return { drafts };
  }
  @Get(':id/output') async output(
    @Param('id') id: string,
    @Query('tenantId') tenantId: string,
    @Query('ownerId') ownerId: string,
  ) {
    const rows = await this.prisma.$queryRaw<
      Array<{ draft_id: string }>
    >`SELECT draft_id::text FROM ws_source_action WHERE tenant_id=${tenantId}::uuid AND owner_id=${ownerId} AND source_type='legiwatch_editorial' AND source_key=${id}`;
    if (!rows[0]) throw new NotFoundException('EDITORIAL_OUTPUT_NOT_FOUND');
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
      throw new BadRequestException('EDITORIAL_REPORT_OUTPUT_TOO_LARGE');
    let rendered: ReturnType<typeof renderEditorialOutput>;
    try {
      rendered = renderEditorialOutput(snapshot);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const text = rendered.text;
    if (!text || text.length > 200_000)
      throw new BadRequestException('EDITORIAL_REPORT_TEXT_UNAVAILABLE_OR_TOO_LARGE');
    return {
      selectionId: id,
      draftId: draft.id,
      outputHash: createHash('sha256').update(serialized).digest('hex'),
      snapshot,
      ...rendered,
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
      throw new BadRequestException('EDITORIAL_ACTION_IDENTITY_REQUIRED');
    const base = process.env.INTEL_API_BASE_URL,
      secret = process.env.INTERNAL_SERVICE_SECRET;
    if (!base || !secret)
      throw new ServiceUnavailableException('INTEL_SOURCE_OWNER_NOT_CONFIGURED');
    const query = new URLSearchParams({ tenantId: b.tenantId, ownerId: b.ownerId });
    const response = await fetch(
      `${base.replace(/\/+$/, '')}/intel-api/internal/legiwatch/editorial-source/${encodeURIComponent(b.actionId)}?${query}`,
      {
        headers: { 'x-internal-service-secret': secret },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    );
    if (!response.ok) throw new ServiceUnavailableException('EDITORIAL_SOURCE_HELD');
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
      throw new BadRequestException('INVALID_EDITORIAL_SOURCE');
    return this.drafts.createEditorial(b.tenantId, b.ownerId, b.actionId, source.prefill);
  }
}
