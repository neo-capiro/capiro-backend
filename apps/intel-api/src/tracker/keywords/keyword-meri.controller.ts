import {
  Body,
  Controller,
  Post,
  UseGuards,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { object } from '../reports/report-domain.js';
import { WorkflowSourceGuard } from './internal-workflow.controller.js';
import { KeywordRuleService } from './keyword-rule.service.js';
import { KeywordDiscoveryService } from './keyword-discovery.service.js';
import { InternalWorkflowService } from './internal-workflow.service.js';
import { SemanticSuggestionService } from './semantic-suggestion.service.js';
import { Phase8EvidenceService } from '../editorial/evidence.service.js';
import { EditorialService } from '../editorial/editorial.service.js';
import { ResearchService } from '../research/research.service.js';
@Controller('internal/legiwatch/meri')
@UseGuards(WorkflowSourceGuard)
export class KeywordMeriController {
  constructor(
    readonly rules: KeywordRuleService,
    readonly discovery: KeywordDiscoveryService,
    readonly workflows: InternalWorkflowService,
    readonly semantic: SemanticSuggestionService,
    readonly research: ResearchService,
    readonly phase8: Phase8EvidenceService,
    readonly editorial: EditorialService,
  ) {}
  @Post('read') read(@Body() body: unknown) {
    return this.route(body, false);
  }
  @Post('apply') apply(@Body() body: unknown) {
    return this.route(body, true);
  }
  async route(body: unknown, write: boolean) {
    const b = object(body),
      input = object(b.input);
    if (
      typeof b.tenantId !== 'string' ||
      typeof b.actor !== 'string' ||
      !b.actor ||
      b.actor.length > 200 ||
      !/^[0-9a-f-]{36}$/i.test(b.tenantId)
    )
      throw new BadRequestException('CANONICAL_ACTOR_SCOPE_REQUIRED');
    const ctx = { tenantId: b.tenantId, clerkUserId: b.actor, role: null };
    if (
      [
        'search_legiwatch_news',
        'get_florida_budget_project',
        'compare_florida_budget_amounts',
        'prepare_legiwatch_briefing',
      ].includes(String(b.tool))
    ) {
      if (write !== (b.tool === 'prepare_legiwatch_briefing'))
        throw new ForbiddenException('TOOL_SURFACE_MISMATCH');
      if (b.tool === 'prepare_legiwatch_briefing') return this.editorial.save(ctx, input);
      if (b.tool === 'get_florida_budget_project') return this.phase8.budget(ctx, input);
      if (b.tool === 'compare_florida_budget_amounts') return this.phase8.compare(ctx, input);
      if (input.view === 'source')
        return this.phase8.run(ctx, input, input.kind === 'budget' ? 'budget' : 'news', (tx) =>
          this.phase8.exact(tx, String(input.kind), String(input.id)),
        );
      if (input.view === 'personnel') return this.phase8.personnel(ctx, input);
      if (input.view === 'monitors') return this.phase8.monitors(ctx);
      return this.phase8.news(ctx, input);
    }
    if (
      [
        'search_legislative_research',
        'get_legal_reference',
        'compare_legislative_versions',
        'save_legislative_research',
      ].includes(String(b.tool))
    ) {
      if (write !== (b.tool === 'save_legislative_research'))
        throw new ForbiddenException('TOOL_SURFACE_MISMATCH');
      if (b.tool === 'search_legislative_research') return this.research.search(ctx, input);
      if (b.tool === 'get_legal_reference')
        return input.view === 'rules'
          ? this.research.rules(ctx, input)
          : input.view === 'versions'
            ? this.research.versions(ctx, input)
            : this.research.references(ctx, input);
      if (b.tool === 'compare_legislative_versions') return this.research.compare(ctx, input);
      return this.research.saveResearch(ctx, input);
    }
    await this.rules.authorize(ctx);
    const writes = ['apply_legiwatch_suggestion', 'save_legiwatch_relevance'];
    if (write !== writes.includes(String(b.tool)))
      throw new ForbiddenException('TOOL_SURFACE_MISMATCH');
    if (b.tool === 'get_legiwatch_review' && input.view === 'folders') {
      const folders = await this.rules.reports.folders.list(ctx),
        allowed = [];
      for (const f of folders.filter((f) => !f.archived && f.clientId === (input.clientId ?? null)))
        try {
          await this.rules.reports.folders.withActor(ctx, (tx) => this.rules.folder(tx, ctx, f.id));
          allowed.push(f);
        } catch {}
      return { folders: allowed, scope: { clientId: input.clientId ?? null }, effects: [] };
    }
    if (typeof input.folderId !== 'string' || !input.folderId)
      throw new BadRequestException('EXACT_FOLDER_REQUIRED');
    const folder = await this.rules.reports.folders.withActor(ctx, (tx) =>
      this.rules.folder(tx, ctx, input.folderId as string),
    );
    if (folder.clientId !== (input.clientId ?? null))
      throw new ForbiddenException('CURRENT_CLIENT_FOLDER_SCOPE_REQUIRED');
    if (b.tool === 'get_legiwatch_review') {
      if (input.view === 'workflows') return this.workflows.history(ctx, folder.id);
      if (input.view === 'rules')
        return (await this.rules.list(ctx)).filter((r) => r.config.folderIds.includes(folder.id));
      return this.discovery.suggestions(ctx, folder.id, {
        jurisdiction: input.jurisdiction,
        sessionKey: input.sessionKey,
        cursor: input.cursor,
      });
    }
    const semanticInput = {
      scope: {
        jurisdiction: input.jurisdiction,
        sessionKey: input.sessionKey,
        fields: input.fields ?? ['title'],
      },
      folderId: folder.id,
      billId: input.billId,
      explanation: input.explanation,
      documentId: input.documentId,
      start: input.start,
      end: input.end,
      quote: input.quote,
    };
    if (b.tool === 'preview_legiwatch_relevance') {
      const { source, ...preview } = await this.semantic.preview(ctx, semanticInput);
      return preview;
    }
    if (b.tool === 'save_legiwatch_relevance')
      return this.semantic.save(ctx, {
        input: semanticInput,
        previewHash: input.previewHash,
        requestKey: input.requestKey,
      });
    if (b.tool === 'apply_legiwatch_suggestion') {
      const found = await this.rules.reports.folders.withActor(
        ctx,
        (tx) =>
          tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM intel_legiwatch_suggestion WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND folder_id=${folder.id} AND id=${String(input.suggestionId)}
            AND payload->'sourceScope'->>'jurisdiction'=${String(input.jurisdiction)} AND payload->'sourceScope'->>'sessionKey'=${String(input.sessionKey)}`,
      );
      if (!found.length) throw new ForbiddenException('EXACT_SUGGESTION_FOLDER_REQUIRED');
      return this.discovery.decide(ctx, String(input.suggestionId), {
        action: input.action,
        expectedVersion: input.expectedVersion,
        requestKey: input.requestKey,
      });
    }
    throw new BadRequestException('UNKNOWN_LEGIWATCH_TOOL');
  }
}
