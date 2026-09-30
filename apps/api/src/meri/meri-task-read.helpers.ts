import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { EngagementTaskStatus } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';

const CURSOR_PREFIX = 'meri-task:';
const SOURCE_CONTRACT = 'engagement_tasks:canonical:v1';
const MAX_LIMIT = 50;

interface TaskCursor {
  version: 1;
  sourceContract: typeof SOURCE_CONTRACT;
  tenantId: string;
  actorUserId: string;
  clientId: string;
  taskId: string | null;
  status: string | null;
  dueBefore: string | null;
  offset: number;
}

export interface MeriTaskReadSelection {
  clientId: string;
  taskId: string | null;
  status: EngagementTaskStatus | null;
  openOnly: boolean;
  dueBefore: Date | null;
  limit: number;
  offset: number;
  cursorApplied: boolean;
  scopeStatus: string | null;
}

export interface MeriTaskOwnerRow {
  id: string;
  clientId: string | null;
  meetingId: string | null;
  contactId: string | null;
  mailThreadId: string | null;
  title: string;
  description: string | null;
  ownerUserId: string | null;
  dueDate: Date | null;
  status: EngagementTaskStatus;
  sourceType: string | null;
  sourceId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  client: { id: string; name: string } | null;
  meeting: { id: string; subject: string } | null;
  linkedSourceProofs?: Array<{
    owner: 'meetings';
    sourceRecordId: string;
    currentClientId: string;
    sourceVersion: string;
    contentSha256: string;
  }>;
}

export interface MeriTaskOwnerPage {
  rows: MeriTaskOwnerRow[];
  total: number;
  sourceStatus: 'healthy' | 'degraded';
  sourceReason: string | null;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function optionalText(input: Record<string, unknown>, key: string, max = 100): string | null {
  const value = input[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new BadRequestException(`${key} is invalid`);
  return value.trim();
}

function limit(input: Record<string, unknown>): number {
  const value = input.limit ?? 25;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_LIMIT)
    throw new BadRequestException(`limit must be between 1 and ${MAX_LIMIT}`);
  return Number(value);
}

function decodeCursor(value: string): TaskCursor {
  try {
    if (!value.startsWith(CURSOR_PREFIX)) throw new Error('format');
    const cursor = JSON.parse(
      Buffer.from(value.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    ) as TaskCursor;
    if (
      cursor.version !== 1 ||
      cursor.sourceContract !== SOURCE_CONTRACT ||
      typeof cursor.tenantId !== 'string' ||
      typeof cursor.actorUserId !== 'string' ||
      typeof cursor.clientId !== 'string' ||
      !(cursor.taskId === null || typeof cursor.taskId === 'string') ||
      !(cursor.status === null || typeof cursor.status === 'string') ||
      !(
        cursor.dueBefore === null ||
        (typeof cursor.dueBefore === 'string' && Number.isFinite(Date.parse(cursor.dueBefore)))
      ) ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0
    )
      throw new Error('contract');
    return cursor;
  } catch {
    throw new BadRequestException('Task cursor is invalid or no longer matches this read');
  }
}

function encodeCursor(cursor: TaskCursor): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')}`;
}

export function parseMeriTaskReadInput(
  ctx: TenantContext,
  input: Record<string, unknown>,
  clientId: string,
  statuses: readonly string[],
): MeriTaskReadSelection {
  const taskId = optionalText(input, 'taskId', 80);
  const statusInput = optionalText(input, 'status', 30)?.toLowerCase() ?? null;
  let status: EngagementTaskStatus | null = null;
  let openOnly = false;
  if (statusInput === 'open' || statusInput === 'overdue') openOnly = true;
  else if (statusInput && statuses.includes(statusInput))
    status = statusInput as EngagementTaskStatus;
  else if (statusInput)
    throw new BadRequestException(`status must be one of: open, overdue, ${statuses.join(', ')}`);

  const dueBeforeInput = optionalText(input, 'dueBefore', 80);
  let dueBefore = dueBeforeInput ? new Date(dueBeforeInput) : null;
  if (dueBefore && !Number.isFinite(dueBefore.getTime()))
    throw new BadRequestException('dueBefore must be an ISO date');
  if (statusInput === 'overdue' && !dueBefore) dueBefore = new Date();

  const cursorInput = optionalText(input, 'cursor', 4096);
  let offset = 0;
  let cursorApplied = false;
  if (cursorInput) {
    const cursor = decodeCursor(cursorInput);
    const dueBeforeIso = dueBefore?.toISOString() ?? null;
    if (
      cursor.tenantId !== ctx.tenantId ||
      cursor.actorUserId !== ctx.userId ||
      cursor.clientId !== clientId ||
      cursor.taskId !== taskId ||
      cursor.status !== statusInput ||
      cursor.dueBefore !== dueBeforeIso
    )
      throw new BadRequestException(
        'Task cursor does not match the tenant, actor, client, identity, or filters',
      );
    offset = cursor.offset;
    cursorApplied = true;
  }
  return {
    clientId,
    taskId,
    status,
    openOnly,
    dueBefore,
    limit: limit(input),
    offset,
    cursorApplied,
    scopeStatus: statusInput,
  };
}

function canonicalTask(row: MeriTaskOwnerRow) {
  const sourceVersion = row.updatedAt.toISOString();
  const task = {
    id: row.id,
    title: row.title,
    body: row.description,
    status: row.status,
    ownerUserId: row.ownerUserId,
    dueDate: row.dueDate?.toISOString() ?? null,
    clientId: row.clientId,
    clientName: row.client?.name ?? null,
    meetingId: row.meetingId,
    meetingTitle: row.meeting?.subject ?? null,
    contactId: row.contactId,
    mailThreadId: row.mailThreadId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: sourceVersion,
  };
  return {
    ...task,
    recordKind: 'native_task' as const,
    recommendation: false,
    nativeCompletion: {
      completed: row.status === 'done',
      evidence: row.status === 'done' ? 'native_task_status' : null,
      establishesDeliveryOrAcceptance: false,
      note:
        row.status === 'done'
          ? 'The native task is marked done, but this status alone does not prove delivery or client acceptance.'
          : 'The native task does not claim completion.',
    },
    sourceProof: {
      version: 1,
      owner: 'engagement_tasks',
      sourceRecordId: row.id,
      currentClientId: row.clientId,
      sourceVersion,
      contentSha256: sha256(JSON.stringify(task)),
      linkedSources: row.linkedSourceProofs ?? [],
    },
  };
}

export function buildMeriTaskReadResult(
  ctx: TenantContext,
  selection: MeriTaskReadSelection,
  page: MeriTaskOwnerPage,
) {
  const seen = new Set<string>();
  const tasks = page.rows.map(canonicalTask).filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  if (tasks.length !== page.rows.length || tasks.some((row) => row.clientId !== selection.clientId))
    throw new BadRequestException('Canonical task owner returned ambiguous or cross-client rows');
  const nextOffset = selection.offset + tasks.length;
  const hasMore = nextOffset < page.total;
  const nextCursor = hasMore
    ? encodeCursor({
        version: 1,
        sourceContract: SOURCE_CONTRACT,
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        clientId: selection.clientId,
        taskId: selection.taskId,
        status: selection.scopeStatus,
        dueBefore: selection.dueBefore?.toISOString() ?? null,
        offset: nextOffset,
      })
    : null;
  const complete =
    page.sourceStatus === 'healthy' &&
    !selection.cursorApplied &&
    !hasMore &&
    tasks.length === page.total;
  return {
    tool: 'query_tasks',
    generatedAt: new Date().toISOString(),
    clientId: selection.clientId,
    total: page.total,
    returned: tasks.length,
    tasks,
    scope: {
      taskId: selection.taskId,
      status: selection.scopeStatus,
      dueBefore: selection.dueBefore?.toISOString() ?? null,
      offset: selection.offset,
      limit: selection.limit,
      cursorApplied: selection.cursorApplied,
    },
    coverage: {
      sourceStatus: page.sourceStatus,
      sourceReason: page.sourceReason,
      complete,
      partial: !complete,
      paginationComplete: !hasMore,
      hasMore,
      nextCursor,
      totalIsExactForScope: true,
      absenceSupported: complete && tasks.length === 0,
      note: complete
        ? 'All currently authorized native tasks in the declared client scope were returned.'
        : 'This is an exact bounded page. Follow nextCursor before inferring that a tracked task is absent.',
    },
  };
}
