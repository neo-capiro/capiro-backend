import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { HearingRecordWorkflowService } from './hearing-record-workflow.service.js';
import { object, text } from '../tracker/reports/report-domain.js';

/** Owner service read seam for the existing governed API retrieval adapter.
 * The API derives the actor from its authenticated user; this route is not a
 * replacement for the Clerk tenant guard on any user-facing route. */
@Controller('internal/hearing-record-retrieval')
export class HearingRecordRetrievalController {
  constructor(readonly records: HearingRecordWorkflowService) {}
  @Post()
  async retrieve(
    @Headers('x-internal-service-secret') supplied: string | undefined,
    @Body() input: unknown,
  ) {
    const secret = process.env.INTERNAL_SERVICE_SECRET,
      a = Buffer.from(supplied ?? ''),
      b = Buffer.from(secret ?? '');
    if (!secret || !a.length || a.length !== b.length || !timingSafeEqual(a, b))
      throw new UnauthorizedException();
    const body = object(input),
      ctx = { tenantId: text(body.tenantId, 100), clerkUserId: text(body.actor, 200), role: null },
      eventId = text(body.eventId, 200);
    await this.records.authorize(ctx);
    if (body.view === 'briefs' || body.view === 'document-access') {
      const id = text(body.id, 100),
        brief = await this.records.brief(ctx, eventId, id);
      if (!body.clientId || brief.payload.clientId !== body.clientId)
        throw new BadRequestException('EXACT_AUTHORIZED_CLIENT_REQUIRED');
      if (body.view === 'document-access') {
        if (body.asOf || !brief.current || !brief.approvedAt || brief.contentHash !== body.contentHash)
          throw new BadRequestException('CURRENT_REVIEWED_BRIEF_REQUIRED');
        if (body.purpose === 'distribute')
          await this.records.approvedDocument(ctx, eventId, id, brief.contentHash);
        else if (body.purpose !== 'read') throw new BadRequestException('DOCUMENT_PURPOSE_REQUIRED');
        return { kind: 'capiro_record_document_access', tenantId: ctx.tenantId, eventId, id,
          clientId: brief.payload.clientId, contentHash: brief.contentHash, sourceHash: brief.payload.sourceHash };
      }
      if (body.asOf) {
        if (!Number.isFinite(Date.parse(String(body.asOf))))
          throw new BadRequestException('VALID_AS_OF_REQUIRED');
        const cutoff = new Date(String(body.asOf));
        const rows = await this.records.actor(
          ctx,
          (tx) => tx.$queryRaw<
            Array<{ created_at: Date }>
          >`SELECT created_at FROM intel_hearing_record_brief_review
          WHERE tenant_id=${ctx.tenantId} AND brief_id=${id} AND content_hash=${brief.contentHash} AND source_hash=${brief.payload.sourceHash}
            AND created_at<=${cutoff} ORDER BY created_at DESC,id DESC LIMIT 1`,
        );
        if (brief.createdAt > cutoff || !rows[0])
          throw new BadRequestException('REVIEWED_BRIEF_NOT_AVAILABLE_AS_OF');
        brief.approvedAt = rows[0].created_at;
      } else if (!brief.current || !brief.approvedAt)
        throw new BadRequestException('CURRENT_REVIEWED_BRIEF_REQUIRED');
      return {
        kind: 'capiro_published_record_brief',
        ...brief,
        historical: Boolean(body.asOf),
        authority: 'Capiro assessment; source citations retain separate publisher authority',
      };
    }
    if (body.view === 'reconciliation') {
      const run = await this.records.run(ctx, eventId, text(body.id, 100));
      const clientId = run.payload.observation?.clientId;
      if (clientId && clientId !== body.clientId)
        throw new BadRequestException('EXACT_AUTHORIZED_CLIENT_REQUIRED');
      if (body.asOf) {
        const cutoff = Date.parse(String(body.asOf));
        if (!Number.isFinite(cutoff) || run.createdAt.getTime() > cutoff)
          throw new BadRequestException('RECONCILIATION_NOT_AVAILABLE_AS_OF');
        run.assessments = run.assessments.map((a) => ({
          ...a,
          reviews: a.reviews.filter((r) => r.createdAt.getTime() <= cutoff),
        }));
      } else if (!run.current) throw new BadRequestException('CURRENT_RECONCILIATION_REQUIRED');
      // Private observation context is an exact owner-only read, never a broad
      // client search result whose existence is inferred from public facts.
      return {
        kind: 'capiro_record_reconciliation',
        ...run,
        historical: Boolean(body.asOf),
        authority: 'Capiro assessment of the preserved captured account',
      };
    }
    throw new BadRequestException('RECORD_RETRIEVAL_VIEW_REQUIRED');
  }
}
