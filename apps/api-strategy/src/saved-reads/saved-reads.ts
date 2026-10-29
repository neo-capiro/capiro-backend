import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const SAVED_READ_PAGE_SIZE = 100;
export const SAVED_READ_MAX_BYTES = 262144;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KINDS = [
  'planner_projects',
  'planner_tasks',
  'planner_task',
  'planner_events',
  'strategy_versions',
  'strategy_activity',
  'objective_versions',
] as const;
export type SavedReadKind = (typeof KINDS)[number];
export interface SavedReadRequest {
  kind: SavedReadKind;
  clientId: string;
  id?: string;
  projectId?: string;
  strategyId?: string;
  objectiveId?: string;
  target?: 'task' | 'project';
  archived?: boolean;
  cursor?: string;
}
export interface SavedOwnerPage {
  items: object[];
  nextCursor: string | null;
}

function invalid(): never {
  throw new BadRequestException('Invalid saved-record read');
}
export function parseSavedRead(raw: unknown): SavedReadRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const value = raw as Record<string, unknown>;
  if (!KINDS.includes(value.kind as SavedReadKind)) return invalid();
  const kind = value.kind as SavedReadKind;
  const fields: Record<SavedReadKind, string[]> = {
    planner_projects: ['archived'],
    planner_tasks: ['archived', 'projectId'],
    planner_task: ['id'],
    planner_events: ['id', 'target'],
    strategy_versions: ['strategyId'],
    strategy_activity: ['strategyId'],
    objective_versions: ['objectiveId'],
  };
  const allowed = new Set([
    'kind',
    'clientId',
    ...(kind === 'planner_task' ? [] : ['cursor']),
    ...fields[kind],
  ]);
  if (Object.keys(value).some((k) => !allowed.has(k))) return invalid();
  const result = { ...value } as unknown as SavedReadRequest;
  for (const key of ['clientId', 'id', 'projectId', 'strategyId', 'objectiveId'] as const) {
    if (key === 'clientId' || key in value) {
      if (typeof value[key] !== 'string' || !UUID.test(value[key])) return invalid();
      result[key] = value[key].toLowerCase();
    }
  }
  if ((kind === 'planner_task' || kind === 'planner_events') && !result.id) return invalid();
  if (kind.startsWith('strategy_') && !result.strategyId) return invalid();
  if (kind === 'objective_versions' && !result.objectiveId) return invalid();
  if (kind === 'planner_events' && !['task', 'project'].includes(String(value.target)))
    return invalid();
  if ('archived' in value && typeof value.archived !== 'boolean') return invalid();
  if (
    'cursor' in value &&
    (typeof value.cursor !== 'string' || value.cursor.length > 2048 || !value.cursor)
  )
    return invalid();
  return result;
}
function binding(request: SavedReadRequest) {
  return [
    request.kind,
    request.clientId,
    request.id ?? null,
    request.projectId ?? null,
    request.strategyId ?? null,
    request.objectiveId ?? null,
    request.target ?? null,
    request.archived ?? false,
  ];
}
export function savedCursor(request: SavedReadRequest, after: string): string {
  return Buffer.from(JSON.stringify({ binding: binding(request), after })).toString('base64url');
}
export function savedAfter(request: SavedReadRequest): string | undefined {
  if (!request.cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'));
    if (
      JSON.stringify(decoded.binding) !== JSON.stringify(binding(request)) ||
      typeof decoded.after !== 'string' ||
      !UUID.test(decoded.after) ||
      savedCursor(request, decoded.after) !== request.cursor
    )
      return invalid();
    return decoded.after;
  } catch {
    return invalid();
  }
}

const RELATIONS: Record<SavedReadKind, string> = {
  planner_projects: 'sp_planner_projects',
  planner_tasks: 'sp_planner_tasks',
  planner_task: 'sp_planner_tasks',
  planner_events: 'sp_planner_events',
  strategy_versions: 'sp_version',
  strategy_activity: 'sp_activity_log',
  objective_versions: 'client_objective_revisions',
};
/** Whole records only. A single oversized record is an explicit refusal, never a skipped record. */
export function savedReadPage(request: SavedReadRequest, page: SavedOwnerPage) {
  const items: Array<{
    source: { relation: string; id: string; contentSha256: string };
    record: Record<string, unknown>;
  }> = [];
  const result = {
    version: '0.1.0' as const,
    kind: request.kind,
    clientId: request.clientId,
    observedAt: new Date().toISOString(),
    items,
    nextCursor: page.nextCursor ? savedCursor(request, page.nextCursor) : null,
    coverage: {
      scope: 'selected_client' as const,
      sourceUniverseComplete: false,
      representation: request.kind === 'strategy_activity' ? 'activity_summaries' : 'owner_records',
      rowLimit: SAVED_READ_PAGE_SIZE,
      maxOutputBytes: SAVED_READ_MAX_BYTES,
      byteTruncated: false,
      limitations: [
        'Pages are current reads, not a frozen cross-page snapshot.',
        ...(request.kind === 'strategy_activity'
          ? [
              'Only Strategy-level activity metadata; node history and before/after content are excluded.',
            ]
          : []),
        ...(request.kind === 'strategy_versions'
          ? ['Coalescible versions may change; source identity includes the returned content hash.']
          : []),
      ],
    },
  };
  let bytes = 0;
  for (let index = 0; index < page.items.length; index++) {
    const record = JSON.parse(JSON.stringify(page.items[index])) as Record<string, unknown>;
    if (typeof record.id !== 'string' || !UUID.test(record.id))
      throw new Error('Invalid owner record identity');
    const item = {
      source: {
        relation: RELATIONS[request.kind],
        id: record.id,
        contentSha256: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
      },
      record,
    };
    const next =
      index + 1 < page.items.length || page.nextCursor ? savedCursor(request, record.id) : null;
    const overhead = Buffer.byteLength(
      JSON.stringify({
        ...result,
        items: [],
        nextCursor: next,
        coverage: { ...result.coverage, byteTruncated: false },
      }),
      'utf8',
    );
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + (items.length ? 1 : 0);
    if (overhead + bytes + itemBytes > SAVED_READ_MAX_BYTES) {
      if (!items.length)
        throw new PayloadTooLargeException('Saved record exceeds the read byte limit');
      result.nextCursor = savedCursor(request, items.at(-1)!.source.id);
      result.coverage.byteTruncated = true;
      return result;
    }
    items.push(item);
    bytes += itemBytes;
  }
  return result;
}
