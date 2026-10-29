import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyFlagsService } from '../flags/strategy-flags.service.js';
import { PlannerLinksService } from '../planner/planner-links.service.js';
import { PlannerService } from '../planner/planner.service.js';
import { SavedHistoryService } from './saved-history.service.js';
import {
  parseSavedRead,
  savedAfter,
  savedReadPage,
  type SavedOwnerPage,
  type SavedReadRequest,
} from './saved-reads.js';

@Injectable()
export class SavedReadsService {
  constructor(
    private readonly planner: PlannerService,
    private readonly links: PlannerLinksService,
    private readonly history: SavedHistoryService,
    private readonly flags: StrategyFlagsService,
  ) {}

  async read(ctx: AuthTenantContext, raw: unknown, authorization?: string) {
    const request = parseSavedRead(raw),
      after = savedAfter(request);
    await this.authorize(ctx, request, authorization);
    const page = await this.readOwner(ctx, request, after);
    // Refuse stale client/feature authority before any saved content is released.
    await this.authorize(ctx, request, authorization);
    return savedReadPage(request, page);
  }

  private async authorize(
    ctx: AuthTenantContext,
    request: SavedReadRequest,
    authorization?: string,
  ) {
    await this.links.validate({ clientId: request.clientId }, authorization);
    if (request.kind.startsWith('strategy_') && !(await this.flags.isEnabled(ctx.tenantId)))
      throw new ForbiddenException('Strategy Planner is not enabled for this tenant');
  }

  private async target(ctx: AuthTenantContext, request: SavedReadRequest) {
    const record =
      request.target === 'project'
        ? await this.planner.savedProject(ctx, request.id!)
        : await this.planner.task(ctx, request.id!);
    if (record.clientId?.toLowerCase() !== request.clientId)
      throw new NotFoundException('Saved record not found');
    return record;
  }

  private async readOwner(
    ctx: AuthTenantContext,
    request: SavedReadRequest,
    after?: string,
  ): Promise<SavedOwnerPage> {
    const query = {
      clientId: request.clientId,
      cursor: after,
      archived: String(request.archived ?? false),
    };
    if (request.kind === 'planner_projects') return this.planner.savedProjects(ctx, query);
    if (request.kind === 'planner_tasks') {
      const project = { ...request, target: 'project' as const, id: request.projectId };
      if (request.projectId) await this.target(ctx, project);
      const page = await this.planner.tasks(ctx, { ...query, projectId: request.projectId });
      if (request.projectId) await this.target(ctx, project);
      return page;
    }
    if (request.kind === 'planner_task')
      return { items: [await this.target(ctx, request)], nextCursor: null };
    if (request.kind === 'planner_events') {
      await this.target(ctx, request);
      const page = await this.planner.events(
        ctx,
        request.target === 'project' ? { projectId: request.id } : { taskId: request.id },
        { paged: 'true', cursor: after },
      );
      await this.target(ctx, request);
      if (Array.isArray(page)) throw new Error('Expected paged Planner activity');
      return { items: page.items, nextCursor: page.nextCursor };
    }
    return this.history.read(ctx, request, after);
  }
}
