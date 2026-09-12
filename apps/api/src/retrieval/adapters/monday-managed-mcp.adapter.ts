import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MeriManagedMcpService, type MeriV3ManagedMcpSchema } from '../../meri/meri-managed-mcp.service.js';
import { parseBridgedToolName } from '../../meri/meri-mcp.helpers.js';
import { withMeriToolExecutionControl } from '../../meri/meri-tool-request-control.js';
import { currentMeetingPrepExecution } from '../../engagement/meeting-prep-job-runtime.js';
import type { RetrievalSourceAdapter } from '../retrieval-source.adapter.js';
import type { RetrievalRecord, RetrievalRequest, RetrievalSourceResult, SemanticDatasetDescriptor } from '../retrieval-v2.types.js';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function mondayStructuredResult(raw: unknown): Record<string, unknown> {
  const result = record(record(raw).structuredResult ?? raw);
  if (result.isError === true) throw new Error('monday_provider_error');
  if (result.structuredContent) return record(result.structuredContent);
  if (Array.isArray(result.content)) {
    const text = result.content.map(item => record(item).text).filter(value => typeof value === 'string').join('\n');
    if (text.length > 2_000_000) throw new Error('monday_response_limit');
    return record(JSON.parse(text));
  }
  return result;
}

/** Only known schema fields are supplied; unknown required fields fail closed. */
export function mondayReadArguments(schema: MeriV3ManagedMcpSchema, selector: 'board' | 'item', id: string, cursor?: string, page?: number): Record<string, unknown> {
  const props = record(schema.input_schema.properties);
  const key = [selector + 'Id', selector + '_id'].find(name => props[name]);
  if (!key) throw new Error('monday_tool_schema_unsupported');
  const args: Record<string, unknown> = { [key]: record(props[key]).type === 'number' || record(props[key]).type === 'integer' ? Number(id) : id };
  if (typeof args[key] === 'number' && !Number.isSafeInteger(args[key])) throw new Error('monday_unsafe_numeric_identifier');
  if (props.limit) args.limit = 100;
  if (cursor) { if (!props.cursor) throw new Error('monday_cursor_schema_unsupported'); args.cursor = cursor; }
  if (page !== undefined && props.page) args.page = page;
  if (Array.isArray(schema.input_schema.required) && schema.input_schema.required.some(name => typeof name !== 'string' || args[name] === undefined)) throw new Error('monday_tool_schema_unsupported');
  return args;
}

@Injectable()
export class MondayManagedMcpAdapter implements RetrievalSourceAdapter {
  readonly key = 'monday-managed-mcp';
  readonly domains = ['monday'] as const;
  constructor(private readonly prisma: PrismaService, private readonly managed: MeriManagedMcpService) {}
  async retrieve(_dataset: SemanticDatasetDescriptor, request: RetrievalRequest): Promise<RetrievalSourceResult> {
    const result: RetrievalSourceResult = { domain: 'monday', records: [], returned: 0, hasMore: false, truncated: false, sourceStatus: 'unavailable', recordsEvaluated: 0, requestedEntityCount: request.caller.clientIds?.length ?? 0, searchedEntityCount: 0, pagesRead: 0, paginationComplete: false, coverageComplete: false, stopReason: 'monday_mapping_required' };
    const clientId = request.caller.clientIds?.length === 1 ? request.caller.clientIds[0] : undefined;
    if (!request.meetingBriefing || !clientId) return result;
    const scope = await this.prisma.withTenantUser(request.caller.tenantId, request.caller.userId, async tx => {
      const membership = await tx.tenantMembership.findFirst({ where: { tenantId: request.caller.tenantId, userId: request.caller.userId, status: 'active' }, include: { user: true, tenant: true } });
      const client = await tx.client.findFirst({ where: { tenantId: request.caller.tenantId, id: clientId, status: { not: 'archived' }, OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { userId: request.caller.userId } } }] }, select: { id: true } });
      const mapping = await tx.meetingPrepMondayMapping.findFirst({ where: { tenantId: request.caller.tenantId, userId: request.caller.userId, clientId } });
      if (!membership || !client) return null;
      return { ctx: { tenantId: membership.tenantId, userId: membership.userId, role: membership.role, tenantSlug: membership.tenant.slug, clerkUserId: membership.user.clerkUserId } satisfies TenantContext, boardIds: mapping?.boardIds ?? [] };
    });
    if (!scope) return { ...result, sourceStatus: 'unauthorized', stopReason: 'monday_client_scope_unauthorized' };
    try {
      const app = (await this.managed.listApps(scope.ctx)).find(app => app.id === 'monday');
      if (!app?.available) return { ...result, stopReason: 'monday_disabled' };
      if (!app.connected) return { ...result, stopReason: app.needsReauth ? 'monday_needs_reauth' : 'monday_not_connected' };
      if (!scope.boardIds.length) return result;
      const schemas = (await this.managed.schemasForMeriV3(scope.ctx)).filter(schema => schema.appId === 'monday' && schema.readOnly);
      const tool = (name: string) => schemas.find(schema => parseBridgedToolName(schema.name)?.tool === name);
      const itemsTool = tool('get_board_items_page'); const updatesTool = tool('get_updates');
      if (!itemsTool || !updatesTool) return { ...result, stopReason: 'monday_required_read_tools_unavailable' };
      const gaps: string[] = [];
      const call = async (schema: MeriV3ManagedMcpSchema, args: Record<string, unknown>) => {
        const execution = currentMeetingPrepExecution();
        execution?.signal.throwIfAborted();
        const deadlineAt = Math.min(request.deadlineAt ?? Date.now() + 45_000, Date.now() + 45_000);
        if (deadlineAt <= Date.now()) throw new Error('monday_retrieval_deadline');
        const signal = execution ? AbortSignal.any([execution.signal, AbortSignal.timeout(deadlineAt - Date.now())]) : AbortSignal.timeout(deadlineAt - Date.now());
        const value = await withMeriToolExecutionControl({ signal, deadlineAt }, () => new Promise<unknown>((resolve, reject) => {
          const abort = () => reject(new Error('monday_read_timeout'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) { abort(); return; }
          void this.managed.executeRead(scope.ctx, schema.name, args, { structuredRead: true }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        }));
        result.pagesRead++; return mondayStructuredResult(value);
      };
      for (const boardId of scope.boardIds.slice(0, 20)) {
        let cursor: string | undefined; const seen = new Set<string>();
        for (let page = 0; page < 30; page++) {
          const raw = await call(itemsTool, mondayReadArguments(itemsTool, 'board', boardId, cursor));
          const data = record(raw.data ?? raw);
          const board = Array.isArray(data.boards) ? record(data.boards[0]) : data;
          if (board.id !== undefined && String(board.id) !== boardId) throw new Error('monday_board_scope_mismatch');
          const itemsPage = record(board.items_page ?? board);
          if (!Array.isArray(itemsPage.items)) throw new Error('monday_items_response_unsupported');
          for (const itemRaw of itemsPage.items) {
            const item = record(itemRaw); const itemId = String(item.id ?? '');
            if (!/^\d+$/.test(itemId)) throw new Error('monday_item_identifier_missing');
            if (result.records.length >= 3_000) { gaps.push('monday_item_cap'); break; }
            const updates: unknown[] = []; let updateCursor: string | undefined; const seenUpdates = new Set<string>();
            for (let updatePage = 1; updatePage <= 10; updatePage++) {
              const rawUpdates = await call(updatesTool, mondayReadArguments(updatesTool, 'item', itemId, updateCursor, updatePage));
              const updateData = record(rawUpdates.data ?? rawUpdates);
              const updateItem = Array.isArray(updateData.items) ? record(updateData.items[0]) : updateData;
              if (updateItem.id !== undefined && String(updateItem.id) !== itemId) throw new Error('monday_update_scope_mismatch');
              if (!Array.isArray(updateItem.updates)) { gaps.push('monday_updates_response_unsupported'); break; }
              updates.push(...updateItem.updates.map(value => { const update = record(value); return { id: update.id, body: update.text_body ?? update.body, createdAt: update.created_at, creator: update.creator }; }));
              if (updateItem.updates.length === 0) break;
              updateCursor = typeof updateItem.cursor === 'string' && updateItem.cursor ? updateItem.cursor : undefined;
              if (updateCursor) { if (seenUpdates.has(updateCursor)) { gaps.push('monday_updates_cursor_cycle'); break; } seenUpdates.add(updateCursor); }
              else if (record(updatesTool.input_schema.properties).page === undefined) { if (updateItem.has_more !== false) gaps.push('monday_updates_pagination_unproven'); break; }
              if (updatePage === 10) gaps.push('monday_updates_page_cap');
            }
            result.records.push({ domain: 'monday', recordId: `${boardId}:${itemId}`, payload: JSON.parse(JSON.stringify({ clientId, title: item.name, status: item.state, updatedAt: item.updated_at, description: item.description, origin: { provider: 'monday', boardId, itemId }, updates, columns: item.column_values, url: typeof item.url === 'string' && /^https:\/\/[a-z0-9-]+\.monday\.com\//i.test(item.url) ? item.url : null })), provenance: { source: 'managed_monday_mcp', boardId, itemId } } satisfies RetrievalRecord);
          }
          cursor = typeof itemsPage.cursor === 'string' && itemsPage.cursor ? itemsPage.cursor : undefined;
          if (!cursor) { if (itemsPage.has_more === true) gaps.push('monday_items_cursor_missing'); break; }
          if (seen.has(cursor)) { gaps.push('monday_items_cursor_cycle'); break; } seen.add(cursor);
          if (page === 29) gaps.push('monday_items_page_cap');
          if (result.records.length >= 3_000) break;
        }
      }
      result.sourceStatus = gaps.length ? 'degraded' : 'healthy'; result.stopReason = gaps.length ? [...new Set(gaps)].join(',') : 'monday_mapped_boards_complete';
      result.coverageComplete = result.paginationComplete = !gaps.length; result.truncated = !!gaps.length; result.lastSyncAt = new Date(); result.searchedEntityCount = 1;
    } catch (error) {
      result.sourceStatus = result.records.length ? 'degraded' : 'error';
      result.stopReason = error instanceof Error && /^monday_[a-z_]+$/.test(error.message) ? error.message : 'monday_read_failed';
      result.truncated = true;
    }
    result.returned = result.records.length; result.recordsEvaluated = result.records.length;
    return result;
  }
}
