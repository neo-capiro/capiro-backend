import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  MeriManagedMcpService,
  type MeriV3ManagedMcpSchema,
} from '../../meri/meri-managed-mcp.service.js';
import { parseBridgedToolName } from '../../meri/meri-mcp.helpers.js';
import { withMeriToolExecutionControl } from '../../meri/meri-tool-request-control.js';
import { currentMeetingPrepExecution } from '../../engagement/meeting-prep-job-runtime.js';
import { MEETING_PREP_POLICY } from '../../engagement/meeting-prep-policy.js';
import type { RetrievalSourceAdapter } from '../retrieval-source.adapter.js';
import type {
  RetrievalRecord,
  RetrievalRequest,
  RetrievalSourceResult,
  SemanticDatasetDescriptor,
} from '../retrieval-v2.types.js';
import { mondayBoardScopeFromQuery } from './monday-board-scope.js';

const MAX_BOARDS = 20;
const MAX_ITEMS = 3_000;
const MAX_ITEM_PAGES = 30;
const MAX_UPDATE_PAGES = 10;
const GENERAL_RETRIEVAL_BUDGET_MS = 45_000;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function mondayStructuredResult(
  raw: unknown,
  emptyItemId?: string,
): Record<string, unknown> {
  const result = record(record(raw).structuredResult ?? raw);
  if (result.isError === true) throw new Error('monday_provider_error');
  if (result.structuredContent) return record(result.structuredContent);
  if (Array.isArray(result.content) || typeof result.content === 'string') {
    const text =
      typeof result.content === 'string'
        ? result.content
        : result.content
            .map((item) => record(item).text)
            .filter((value) => typeof value === 'string')
            .join('\n');
    if (text.length > 2_000_000) throw new Error('monday_response_limit');
    if (emptyItemId && text === `No updates found for item with id ${emptyItemId}`)
      return { item_id: emptyItemId, updates: [], has_more: false };
    return record(JSON.parse(text));
  }
  if (result.content && typeof result.content === 'object') return record(result.content);
  return result;
}

/** Only known schema fields are supplied; unknown required fields fail closed. */
export function mondayReadArguments(
  schema: MeriV3ManagedMcpSchema,
  selector: 'board' | 'item',
  id: string,
  cursor?: string,
  page?: number,
): Record<string, unknown> {
  const props = record(schema.input_schema.properties);
  const key = [
    selector + 'Id',
    selector + '_id',
    ...(selector === 'item' ? ['objectId'] : []),
  ].find((name) => props[name]);
  if (!key) throw new Error('monday_tool_schema_unsupported');
  const args: Record<string, unknown> = {
    [key]:
      record(props[key]).type === 'number' || record(props[key]).type === 'integer'
        ? Number(id)
        : id,
  };
  if (typeof args[key] === 'number' && !Number.isSafeInteger(args[key]))
    throw new Error('monday_unsafe_numeric_identifier');
  if (key === 'objectId') {
    const values = record(props.objectType).enum;
    if (!Array.isArray(values) || !values.includes('Item'))
      throw new Error('monday_tool_schema_unsupported');
    args.objectType = 'Item';
  }
  const boundedLimit = (name: string) => {
    const spec = record(props[name]);
    const maximum = typeof spec.maximum === 'number' ? Math.min(100, spec.maximum) : 100;
    if (maximum < 1 || (typeof spec.minimum === 'number' && spec.minimum > maximum))
      throw new Error('monday_tool_schema_unsupported');
    return maximum;
  };
  if (props.limit) args.limit = boundedLimit('limit');
  if (parseBridgedToolName(schema.name)?.tool === 'get_board_items_page') {
    for (const name of ['includeColumns', 'includeSubItems', 'includeItemDescription']) {
      if (record(props[name]).type === 'boolean') args[name] = true;
    }
    if (props.subItemLimit) args.subItemLimit = boundedLimit('subItemLimit');
  }
  if (cursor) {
    if (!props.cursor) throw new Error('monday_cursor_schema_unsupported');
    args.cursor = cursor;
  }
  if (page !== undefined && props.page) args.page = page;
  if (
    Array.isArray(schema.input_schema.required) &&
    schema.input_schema.required.some(
      (name) => typeof name !== 'string' || args[name] === undefined,
    )
  )
    throw new Error('monday_tool_schema_unsupported');
  return args;
}

function mondayColumns(
  value: unknown,
  metadata: unknown[] = [],
): {
  columns: unknown[];
  status: string | null;
  owners: unknown[];
  deadline: string | null;
} {
  const columns = Array.isArray(value)
    ? value
    : Object.entries(record(value)).map(([id, raw]) => ({
        ...record(metadata.find((entry) => record(entry).id === id)),
        id,
        text: typeof raw === 'string' ? raw : null,
        value: raw,
      }));
  // monday also represents Type and Priority as status columns. A known title
  // takes precedence over the storage type; a blank workflow status stays blank.
  const statusCandidates = columns
    .map((raw) => {
      const column = record(raw);
      const title = String(column.title ?? '')
        .trim()
        .toLowerCase();
      const id = String(column.id ?? '').toLowerCase();
      const rank = title
        ? /^(?:(?:task|item|workflow)\s+)?status$|^workflow$/.test(title)
          ? 3
          : /\bstatus\b/.test(title)
            ? 2
            : 0
        : id.includes('status')
          ? 2
          : column.type === 'status'
            ? 1
            : 0;
      return { column, rank };
    })
    .filter(({ rank }) => rank > 0);
  const highestRank = Math.max(0, ...statusCandidates.map(({ rank }) => rank));
  const workflowColumns = statusCandidates.filter(({ rank }) => rank === highestRank);
  const statusText = workflowColumns.length === 1 ? workflowColumns[0]?.column.text : null;
  const status = typeof statusText === 'string' && statusText.trim() ? statusText.trim() : null;
  let deadline: string | null = null;
  const owners: unknown[] = [];
  for (const raw of columns) {
    const column = record(raw);
    const id = String(column.id ?? '').toLowerCase();
    const type = String(column.type ?? '').toLowerCase();
    const text = typeof column.text === 'string' && column.text.trim() ? column.text.trim() : null;
    const parsed = (() => {
      if (typeof column.value !== 'string' || !column.value.trim()) return record(column.value);
      try {
        return record(JSON.parse(column.value));
      } catch {
        return {};
      }
    })();
    if (!deadline && (type === 'date' || /(?:date|due|deadline)/.test(id))) {
      deadline =
        (typeof parsed.date === 'string' && parsed.date) ||
        (typeof parsed.to === 'string' && parsed.to) ||
        text;
    }
    if (type === 'people' || /(?:person|people|owner|assignee)/.test(id)) {
      const people = Array.isArray(parsed.personsAndTeams) ? parsed.personsAndTeams : [];
      owners.push(...(people.length ? people : text ? [text] : []));
    }
  }
  return { columns, status, owners, deadline };
}

function mondayItemsPage(raw: Record<string, unknown>, boardId: string): Record<string, unknown> {
  const data = record(raw.data ?? raw);
  const board = Array.isArray(data.boards) ? record(data.boards[0]) : record(data.board ?? data);
  if (board.id !== undefined && String(board.id) !== boardId)
    throw new Error('monday_board_scope_mismatch');
  const itemsPage = record(board.items_page ?? (data.board ? data : board));
  if (!Array.isArray(itemsPage.items)) throw new Error('monday_items_response_unsupported');
  const pagination = record(itemsPage.pagination);
  return Object.keys(pagination).length
    ? { ...itemsPage, cursor: pagination.nextCursor, has_more: pagination.has_more }
    : itemsPage;
}

function mondayChildren(item: Record<string, unknown>): Record<string, unknown>[] {
  const raw = item.subitems ?? item.sub_items ?? item.children;
  return Array.isArray(raw) ? raw.map(record) : [];
}

@Injectable()
export class MondayManagedMcpAdapter implements RetrievalSourceAdapter {
  readonly key = 'monday-managed-mcp';
  readonly domains = ['monday'] as const;
  constructor(
    private readonly prisma: PrismaService,
    private readonly managed: MeriManagedMcpService,
  ) {}

  async retrieve(
    _dataset: SemanticDatasetDescriptor,
    request: RetrievalRequest,
  ): Promise<RetrievalSourceResult> {
    const result: RetrievalSourceResult = {
      domain: 'monday',
      records: [],
      returned: 0,
      hasMore: false,
      truncated: false,
      sourceStatus: 'unavailable',
      recordsEvaluated: 0,
      requestedEntityCount: request.caller.clientIds?.length ?? 0,
      searchedEntityCount: 0,
      pagesRead: 0,
      paginationComplete: false,
      coverageComplete: false,
      stopReason: 'monday_mapping_required',
    };
    const clientId =
      request.caller.clientIds?.length === 1 ? request.caller.clientIds[0] : undefined;
    if (!clientId) return result;
    if (
      request.caller.authorizedClientIds &&
      !request.caller.authorizedClientIds.includes(clientId)
    )
      return {
        ...result,
        sourceStatus: 'unauthorized',
        stopReason: 'monday_client_scope_unauthorized',
      };

    const queryScope = mondayBoardScopeFromQuery(request.mondayBoardContext ?? request.query);
    if (queryScope.invalid || queryScope.boardIds.length > MAX_BOARDS) {
      return { ...result, sourceStatus: 'error', stopReason: 'monday_board_scope_invalid' };
    }

    const scope = await this.prisma.withTenantUser(
      request.caller.tenantId,
      request.caller.userId,
      async (tx) => {
        const membership = await tx.tenantMembership.findFirst({
          where: {
            tenantId: request.caller.tenantId,
            userId: request.caller.userId,
            status: 'active',
          },
          include: { user: true, tenant: true },
        });
        const client = await tx.client.findFirst({
          where: {
            tenantId: request.caller.tenantId,
            id: clientId,
            status: { not: 'archived' },
            OR: [
              { memoryWall: false },
              { memoryAccessGrants: { some: { userId: request.caller.userId } } },
            ],
          },
          select: { id: true },
        });
        const mapping = await tx.meetingPrepMondayMapping.findFirst({
          where: { tenantId: request.caller.tenantId, userId: request.caller.userId, clientId },
          select: { boardIds: true },
        });
        if (!membership || !client) return null;
        return {
          ctx: {
            tenantId: membership.tenantId,
            userId: membership.userId,
            role: membership.role,
            tenantSlug: membership.tenant.slug,
            clerkUserId: membership.user.clerkUserId,
          } satisfies TenantContext,
          boardIds: queryScope.explicit ? queryScope.boardIds : (mapping?.boardIds ?? []),
          explicitBoardScope: queryScope.explicit,
        };
      },
    );
    if (!scope)
      return {
        ...result,
        sourceStatus: 'unauthorized',
        stopReason: 'monday_client_scope_unauthorized',
      };

    const execution = currentMeetingPrepExecution();
    const retrievalDeadline = Math.min(
      request.deadlineAt ?? Date.now() + GENERAL_RETRIEVAL_BUDGET_MS,
      execution
        ? execution.deadlineAt - MEETING_PREP_POLICY.synthesisReserveMs
        : Date.now() + GENERAL_RETRIEVAL_BUDGET_MS,
    );
    const gaps: string[] = [];
    try {
      const app = (await this.managed.listApps(scope.ctx)).find((app) => app.id === 'monday');
      if (!app?.available) return { ...result, stopReason: 'monday_disabled' };
      if (!app.connected)
        return {
          ...result,
          stopReason: app.needsReauth ? 'monday_needs_reauth' : 'monday_not_connected',
        };
      if (!scope.boardIds.length) return result;
      if (scope.boardIds.length > MAX_BOARDS) gaps.push('monday_board_cap');
      const schemas = (await this.managed.schemasForMeriV3(scope.ctx)).filter(
        (schema) => schema.appId === 'monday' && schema.readOnly,
      );
      const tool = (name: string) =>
        schemas.find((schema) => parseBridgedToolName(schema.name)?.tool === name);
      const itemsTool = tool('get_board_items_page');
      const infoTool = tool('get_board_info');
      const updatesTool = tool('get_updates');
      if (!itemsTool || !infoTool)
        return { ...result, stopReason: 'monday_required_read_tools_unavailable' };
      if (!updatesTool) gaps.push('monday_updates_unavailable');
      const itemProperties = record(itemsTool.input_schema.properties);
      if (record(itemProperties.includeColumns).type !== 'boolean')
        gaps.push('monday_columns_unavailable');
      if (record(itemProperties.includeSubItems).type !== 'boolean')
        gaps.push('monday_subitems_unavailable');

      const call = async (schema: MeriV3ManagedMcpSchema, args: Record<string, unknown>) => {
        execution?.signal.throwIfAborted();
        if (retrievalDeadline <= Date.now()) throw new Error('monday_retrieval_deadline');
        const timeout = AbortSignal.timeout(Math.max(1, retrievalDeadline - Date.now()));
        const signal = execution ? AbortSignal.any([execution.signal, timeout]) : timeout;
        const value = await withMeriToolExecutionControl(
          { signal, deadlineAt: retrievalDeadline },
          () =>
            new Promise<unknown>((resolve, reject) => {
              const abort = () => reject(new Error('monday_read_timeout'));
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) return abort();
              void this.managed
                .executeRead(scope.ctx, schema.name, args, { structuredRead: true })
                .then(resolve, reject)
                .finally(() => signal.removeEventListener('abort', abort));
            }),
        );
        result.pagesRead++;
        return mondayStructuredResult(
          value,
          parseBridgedToolName(schema.name)?.tool === 'get_updates'
            ? String(args.objectId ?? args.itemId ?? args.item_id ?? '')
            : undefined,
        );
      };

      const readUpdates = async (itemId: string): Promise<unknown[]> => {
        if (!updatesTool) return [];
        const updates: unknown[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let page = 1; page <= MAX_UPDATE_PAGES; page++) {
          const raw = await call(
            updatesTool,
            mondayReadArguments(updatesTool, 'item', itemId, cursor, page),
          );
          const data = record(raw.data ?? raw);
          const item = Array.isArray(data.items) ? record(data.items[0]) : data;
          if (
            (item.id !== undefined && String(item.id) !== itemId) ||
            (item.item_id !== undefined && String(item.item_id) !== itemId)
          )
            throw new Error('monday_update_scope_mismatch');
          if (!Array.isArray(item.updates)) {
            gaps.push('monday_updates_response_unsupported');
            break;
          }
          updates.push(
            ...item.updates.map((value) => {
              const update = record(value);
              return {
                id: update.id,
                body: update.text_body ?? update.body,
                createdAt: update.created_at,
                creator: update.creator,
              };
            }),
          );
          if (!item.updates.length) break;
          const pagination = record(item.pagination);
          if (pagination.page !== undefined && pagination.page !== page)
            throw new Error('monday_updates_pagination_mismatch');
          if (
            typeof pagination.limit === 'number' &&
            pagination.count === item.updates.length &&
            pagination.limit > item.updates.length
          )
            break;
          cursor = typeof item.cursor === 'string' && item.cursor ? item.cursor : undefined;
          if (cursor) {
            if (seen.has(cursor)) {
              gaps.push('monday_updates_cursor_cycle');
              break;
            }
            seen.add(cursor);
          } else if (record(updatesTool.input_schema.properties).page === undefined) {
            if (item.has_more !== false) gaps.push('monday_updates_pagination_unproven');
            break;
          }
          if (page === MAX_UPDATE_PAGES) gaps.push('monday_updates_page_cap');
        }
        return updates;
      };

      const boardMetadata = new Map<string, { columns: unknown[]; subItemColumns: unknown[] }>();
      const seenItems = new Set<string>();
      const updateTargets: Array<{ itemId: string; row: RetrievalRecord }> = [];
      const addItem = (
        boardId: string,
        item: Record<string, unknown>,
        parentItemId?: string,
      ): void => {
        if (result.records.length >= MAX_ITEMS) {
          gaps.push('monday_item_cap');
          return;
        }
        const itemId = String(item.id ?? '');
        if (!/^\d+$/.test(itemId)) throw new Error('monday_item_identifier_missing');
        const identity = `${boardId}:${itemId}`;
        if (seenItems.has(identity)) return;
        seenItems.add(identity);
        parentItemId ??= typeof item.parent_item_id === 'string' ? item.parent_item_id : undefined;
        const metadata = boardMetadata.get(boardId);
        const normalized = mondayColumns(
          item.column_values,
          parentItemId ? metadata?.subItemColumns : metadata?.columns,
        );
        const row = {
          domain: 'monday',
          recordId: `${boardId}:${itemId}`,
          payload: JSON.parse(
            JSON.stringify({
              clientId,
              sourceActorUserId: request.caller.userId,
              title: item.name,
              status: normalized.status,
              owners: normalized.owners,
              dueDate: normalized.deadline,
              updatedAt: item.updated_at,
              description: item.item_description ?? item.description,
              origin: {
                provider: 'monday',
                boardId,
                itemId,
                ...(parentItemId ? { parentItemId, itemType: 'subitem' } : { itemType: 'item' }),
                scope: scope.explicitBoardScope ? 'request' : 'saved_mapping',
              },
              updates: [],
              columns: normalized.columns,
              url:
                typeof item.url === 'string' &&
                /^https:\/\/[a-z0-9-]+\.monday\.com\//i.test(item.url)
                  ? item.url
                  : null,
            }),
          ),
          provenance: {
            source: 'managed_monday_mcp',
            boardId,
            itemId,
            ...(parentItemId ? { parentItemId } : {}),
          },
        } satisfies RetrievalRecord;
        result.records.push(row);
        updateTargets.push({ itemId, row });
      };

      for (const boardId of scope.boardIds.slice(0, MAX_BOARDS)) {
        const info = await call(infoTool, mondayReadArguments(infoTool, 'board', boardId));
        const board = record(info.board ?? record(info.data).board ?? info);
        if (String(board.id ?? '') !== boardId) throw new Error('monday_board_scope_mismatch');
        const columns = Array.isArray(board.columns) ? board.columns : [];
        boardMetadata.set(boardId, {
          columns,
          subItemColumns: Array.isArray(board.subItemColumns) ? board.subItemColumns : columns,
        });
        let cursor: string | undefined;
        const seen = new Set<string>();
        for (let page = 0; page < MAX_ITEM_PAGES; page++) {
          const itemArgs = mondayReadArguments(itemsTool, 'board', boardId, cursor);
          const itemsPage = mondayItemsPage(await call(itemsTool, itemArgs), boardId);
          for (const raw of itemsPage.items as unknown[]) {
            const item = record(raw);
            const walk = (entry: Record<string, unknown>, parent?: string, depth = 0) => {
              addItem(boardId, entry, parent);
              const children = mondayChildren(entry);
              if (depth >= 5 || result.records.length >= MAX_ITEMS) {
                if (children.length) gaps.push('monday_subitems_cap');
                return;
              }
              if (
                typeof itemArgs.subItemLimit === 'number' &&
                children.length >= itemArgs.subItemLimit
              )
                gaps.push('monday_subitems_cap');
              for (const child of children) walk(child, String(entry.id), depth + 1);
            };
            walk(item);
            if (result.records.length >= MAX_ITEMS) break;
          }
          cursor =
            typeof itemsPage.cursor === 'string' && itemsPage.cursor ? itemsPage.cursor : undefined;
          if (cursor && itemsPage.has_more === false)
            throw new Error('monday_items_pagination_mismatch');
          if (!cursor) {
            if (itemsPage.has_more === true) gaps.push('monday_items_cursor_missing');
            if (!('cursor' in itemsPage) && typeof itemsPage.has_more !== 'boolean')
              gaps.push('monday_items_pagination_unproven');
            break;
          }
          if (seen.has(cursor)) {
            gaps.push('monday_items_cursor_cycle');
            break;
          }
          seen.add(cursor);
          if (page === MAX_ITEM_PAGES - 1) gaps.push('monday_items_page_cap');
          if (result.records.length >= MAX_ITEMS) break;
        }
      }
      // Fetch task facts first so a slow comments page cannot hide later tasks.
      for (const target of updateTargets) {
        if (Date.now() >= retrievalDeadline) {
          gaps.push('monday_retrieval_deadline');
          break;
        }
        try {
          target.row.payload.updates = JSON.parse(JSON.stringify(await readUpdates(target.itemId)));
        } catch (error) {
          gaps.push(
            error instanceof Error && /^monday_[a-z_]+$/.test(error.message)
              ? error.message
              : 'monday_updates_unavailable',
          );
        }
      }
      if (result.records.length >= MAX_ITEMS) gaps.push('monday_item_cap');
      result.sourceStatus = gaps.length ? 'degraded' : 'healthy';
      result.stopReason = gaps.length
        ? [...new Set(gaps)].join(',')
        : scope.explicitBoardScope
          ? 'monday_requested_boards_complete'
          : 'monday_mapped_boards_complete';
      result.coverageComplete = result.paginationComplete = !gaps.length;
      result.truncated = !!gaps.length;
      result.lastSyncAt = new Date();
      result.searchedEntityCount = 1;
    } catch (error) {
      result.sourceStatus = result.records.length ? 'degraded' : 'error';
      result.stopReason =
        error instanceof Error && /^monday_[a-z_]+$/.test(error.message)
          ? error.message
          : 'monday_read_failed';
      result.truncated = true;
      result.paginationComplete = false;
      result.coverageComplete = false;
    }
    result.returned = result.records.length;
    result.recordsEvaluated = result.records.length;
    return result;
  }
}
