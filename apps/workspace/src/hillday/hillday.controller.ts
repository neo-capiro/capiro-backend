import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import {
  AddManualMeetingDto,
  CreateExportDto,
  CreateHillDayDocumentDto,
  PatchHillDayDocumentDto,
  PutMeetingContextDto,
  RefineSectionTextDto,
  ResolutionCorrectionDto,
  SetMeetingsDto,
} from './dto/hillday.dto.js';
import { HillDayContextService } from './hillday-context.service.js';
import { HillDayDocumentService } from './hillday-document.service.js';
import { HillDayExportService } from './hillday-export.service.js';
import { HillDayGenerationService } from './hillday-generation.service.js';
import { HillDayResolutionService } from './hillday-resolution.service.js';

const SSE_MAX_MS = 15 * 60_000;
const SSE_POLL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function intOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Hill Day workflow API (requirements §6). Mounted at
 * `/workspace-api/hillday/*` on the workspace service — the requirements'
 * `/api/v1/...` families map 1:1 onto these routes. Firm-scoped by the caller's
 * session (TenantGuard), client-scoped by the document's sponsor.
 */
@Controller('hillday')
@UseGuards(TenantGuard)
export class HillDayController {
  constructor(
    private readonly documents: HillDayDocumentService,
    private readonly resolution: HillDayResolutionService,
    private readonly context: HillDayContextService,
    private readonly generation: HillDayGenerationService,
    private readonly exports: HillDayExportService,
  ) {}

  // ── Blueprints + library ──────────────────────────────────────────────────

  @Get('blueprints')
  blueprints(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.documents.listBlueprints(ctx.tenantId);
  }

  @Get('documents')
  listDocuments(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query('clientId') clientId?: string,
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.documents.listDocuments(ctx.tenantId, ctx.clerkUserId, { clientId, status, kind, cursor, limit });
  }

  @Post('documents')
  createDocument(@CurrentTenant() ctx: WorkspaceTenantContext, @Body() dto: CreateHillDayDocumentDto) {
    return this.documents.create(ctx.tenantId, ctx.clerkUserId, dto);
  }

  // ── Sponsor + calendar ────────────────────────────────────────────────────

  @Get('clients')
  clients(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.documents.listClients(ctx.tenantId, ctx.clerkUserId, q, cursor, limit);
  }

  @Get('clients/:clientId/calendar')
  calendar(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('clientId') clientId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('timeZone') timeZone?: string,
  ) {
    return this.documents.calendar(ctx.tenantId, ctx.clerkUserId, clientId, from, to, timeZone);
  }

  @Put('documents/:id/meetings')
  setMeetings(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() dto: SetMeetingsDto,
  ) {
    return this.documents.setMeetings(ctx.tenantId, ctx.clerkUserId, id, dto);
  }

  // ── Resolution ────────────────────────────────────────────────────────────

  @Post('documents/:id/resolution')
  runResolution(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.resolution.resolveDocument(ctx.tenantId, ctx.clerkUserId, id);
  }

  @Get('documents/:id/resolution')
  getResolution(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.resolution.getResolution(ctx.tenantId, id);
  }

  @Patch('documents/:id/resolution/:meetingId')
  correct(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('meetingId') meetingId: string,
    @Body() dto: ResolutionCorrectionDto,
  ) {
    return this.resolution.correct(ctx.tenantId, ctx.clerkUserId, id, meetingId, dto);
  }

  /** Add a meeting by picking the member directly from the Directory (no
   *  calendar event backs it) — step 3's Directory tab. */
  @Post('documents/:id/meetings/manual')
  addManualMeeting(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() dto: AddManualMeetingDto,
  ) {
    return this.resolution.addManualMeeting(ctx.tenantId, ctx.clerkUserId, id, dto.memberId);
  }

  @Get('directory/members/:memberId')
  member(@Param('memberId') memberId: string) {
    return this.resolution.memberProfile(memberId);
  }

  @Get('directory/members')
  members(@Query('q') q?: string, @Query('chamber') chamber?: string) {
    return this.resolution.searchMembers(q ?? '', chamber);
  }

  @Get('directory/staffers')
  staffers(@Query('q') q?: string, @Query('address') address?: string) {
    return this.resolution.searchStaffers((q ?? address ?? '').trim());
  }

  /** Full A–Z Directory browse for step 3's Directory tab — same data/UX as
   *  Outreach's Directory tab. No minimum query length: empty `q` browses. */
  @Get('directory/browse')
  browseDirectory(
    @Query('q') q?: string,
    @Query('state') state?: string,
    @Query('chamber') chamber?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.resolution.browseDirectory({
      q,
      state,
      chamber,
      page: intOrNull(page) ?? undefined,
      pageSize: intOrNull(pageSize) ?? undefined,
    });
  }

  /** A third attendee source alongside typing a name and Directory search:
   *  the sponsor's own Portfolio relationship history for this document's client. */
  @Get('documents/:id/relationships')
  clientRelationships(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.resolution.clientRelationships(ctx.tenantId, id);
  }

  // ── Context ───────────────────────────────────────────────────────────────

  @Get('documents/:id/meetings/:meetingId/context')
  getContext(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('meetingId') meetingId: string,
    @Query('lookbackDays') lookbackDays?: string,
  ) {
    return this.context.candidates(ctx.tenantId, ctx.clerkUserId, id, meetingId, intOrNull(lookbackDays));
  }

  @Put('documents/:id/meetings/:meetingId/context')
  putContext(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('meetingId') meetingId: string,
    @Body() dto: PutMeetingContextDto,
  ) {
    return this.context.write(ctx.tenantId, ctx.clerkUserId, id, meetingId, dto);
  }

  @Get('engagement/threads')
  threads(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Query('documentId') documentId?: string,
    @Query('meetingId') meetingId?: string,
    @Query('lookbackDays') lookbackDays?: string,
  ) {
    return this.context.threads(
      ctx.tenantId,
      ctx.clerkUserId,
      documentId ?? '',
      meetingId ?? null,
      intOrNull(lookbackDays),
    );
  }

  // ── Generation ────────────────────────────────────────────────────────────

  @Post('documents/:id/generate')
  generate(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.generation.start(ctx.tenantId, ctx.clerkUserId, id);
  }

  @Get('documents/:id/generate/:jobId')
  job(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ) {
    return this.generation.jobStatus(ctx.tenantId, id, jobId);
  }

  /**
   * SSE progress stream. Events replay from the job's persisted log, so a
   * reconnect with `Last-Event-ID` (or `?after=`) resumes without loss. The
   * poll fallback is the sibling route without `/events`.
   */
  @Get('documents/:id/generate/:jobId/events')
  async events(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Query('after') after: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const lastHeader = req.headers['last-event-id'];
    let lastSeq =
      intOrNull(after) ?? intOrNull(typeof lastHeader === 'string' ? lastHeader : undefined) ?? 0;
    // Validate access before committing to the stream (404s as JSON).
    await this.generation.jobStatus(ctx.tenantId, id, jobId);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    req.on('close', () => {
      closed = true;
    });
    const deadline = Date.now() + SSE_MAX_MS;
    let ticks = 0;
    while (!closed && Date.now() < deadline) {
      const { status, events } = await this.generation.jobEvents(ctx.tenantId, id, jobId, lastSeq);
      for (const ev of events) {
        res.write(`id: ${ev.seq}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
        lastSeq = ev.seq;
      }
      if (status === 'complete' || status === 'failed') break;
      ticks += 1;
      if (ticks % 15 === 0) res.write(': keep-alive\n\n');
      await sleep(SSE_POLL_MS);
    }
    res.end();
  }

  @Post('documents/:id/sections/:sectionId/regenerate')
  regenerate(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('sectionId') sectionId: string,
  ) {
    return this.generation.regenerateSection(ctx.tenantId, ctx.clerkUserId, id, sectionId);
  }

  @Post('documents/:id/sections/:sectionId/refine')
  refine(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('sectionId') sectionId: string,
    @Body() dto: RefineSectionTextDto,
  ) {
    return this.generation.refineText(ctx.tenantId, ctx.clerkUserId, id, sectionId, dto.field, dto.text);
  }

  // ── Document ──────────────────────────────────────────────────────────────

  @Get('documents/:id')
  getDocument(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.documents.get(ctx.tenantId, id);
  }

  @Patch('documents/:id')
  patchDocument(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() dto: PatchHillDayDocumentDto,
  ) {
    return this.documents.patch(ctx.tenantId, ctx.clerkUserId, id, dto);
  }

  @Get('documents/:id/quality')
  quality(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('id') id: string) {
    return this.documents.quality(ctx.tenantId, id);
  }

  // ── Exports ───────────────────────────────────────────────────────────────

  @Post('documents/:id/exports')
  createExport(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() dto: CreateExportDto,
  ) {
    return this.exports.create(ctx.tenantId, ctx.clerkUserId, id, dto.pageSize ?? 'letter');
  }

  @Get('documents/:id/exports/:exportId')
  getExport(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('exportId') exportId: string,
  ) {
    return this.exports.get(ctx.tenantId, id, exportId);
  }
}
