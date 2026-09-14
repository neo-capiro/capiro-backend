import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ResearchService } from './research.service.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { object } from '../reports/report-domain.js';
import { requestKey } from '../keywords/keyword-rule.service.js';
import { hash } from '../folders/folder-tracker.service.js';
@Injectable()
export class ResearchDeadlineService {
  constructor(readonly research: ResearchService) {}
  async save(ctx: WorkspaceTenantContext, input: unknown) {
    const selection = await this.research.run(ctx, input, async (tx, b, scope) => {
      if (
        !scope.folderId ||
        typeof b.deadlineId !== 'string' ||
        typeof b.noticeRevision !== 'string' ||
        typeof b.analysis !== 'string' ||
        b.analysis.length > 30000
      )
        throw new BadRequestException('EXACT_DEADLINE_FOLDER_AND_ANALYSIS_REQUIRED');
      const key = requestKey(b.requestKey),
        inputHash = hash(b);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + ctx.clerkUserId + ':research:' + key},0))`;
      const previous = await tx.$queryRaw<
        Array<{ id: string; input_hash: string }>
      >`SELECT id,input_hash FROM intel_legiwatch_research_selection WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND request_key=${key}`;
      if (previous[0]) {
        if (previous[0].input_hash !== inputHash)
          throw new ConflictException('RESEARCH_REQUEST_CHANGED');
        return previous[0].id;
      }
      const dates = await tx.$queryRaw<
        Array<{
          id: string;
          notice_revision_id: string;
          notice_id: string;
          content_hash: string;
          kind: string;
          raw_wording: string;
          source_locator: string;
          source_url: string;
          date_only: Date | null;
          precision: string;
          basis: string;
        }>
      >`SELECT d.*,n.notice_id,n.content_hash,n.source_url FROM legal_published_date d JOIN rule_notice_revision n ON n.id=d.notice_revision_id JOIN state_rule s ON s.id=n.notice_id WHERE d.id=${b.deadlineId} AND n.id=${b.noticeRevision} AND s.state=${scope.jurisdiction} AND s.source_revision=n.content_hash AND NOT d.canceled AND s.rule_type<>'withdrawal'`;
      const deadline = dates[0];
      if (!deadline) throw new NotFoundException('CURRENT_PUBLISHED_DATE_NOT_FOUND');
      const contextVersion = await this.research.contextVersion(tx, ctx, scope),
        id = randomUUID();
      const payload = {
        scope,
        contextVersion,
        title: 'Published date follow-up: ' + deadline.kind.replaceAll('_', ' '),
        analysis: b.analysis,
        authorId: ctx.clerkUserId,
        generatedAt: new Date().toISOString(),
        authority: 'Capiro analysis for review',
        deadline,
        citations: [
          {
            documentId: deadline.notice_id,
            revision: deadline.content_hash,
            locator: deadline.source_locator,
            quote: deadline.raw_wording,
            sourceUrl: deadline.source_url,
          },
        ],
        documents: [],
        sourceCutoff: [{ noticeId: deadline.notice_id, revision: deadline.content_hash }],
        captureAllowed: false,
      };
      await tx.$executeRaw`INSERT INTO intel_legiwatch_research_selection(id,tenant_id,owner_clerk_id,folder_id,client_id,request_key,input_hash,payload) VALUES(${id},${ctx.tenantId},${ctx.clerkUserId},${scope.folderId},${scope.clientId},${key},${inputHash},${JSON.stringify(payload)}::jsonb)`;
      return id;
    });
    return this.research.createWorkspace(ctx, selection);
  }
}
