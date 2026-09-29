import { createHash } from 'node:crypto';
import { researchJsonSha256 } from './meri-research-durable-result.js';

type UnknownRecord = Record<string, unknown>;
const SHA256_RE = /^[a-f0-9]{64}$/;
const record = (value: unknown): UnknownRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const finiteDate = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const linkedSourceProofs = (value: unknown, clientId: string): UnknownRecord[] | null => {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const sources: UnknownRecord[] = [];
  for (const candidate of value) {
    const source = record(candidate);
    if (
      !source ||
      source.owner !== 'meetings' ||
      typeof source.sourceRecordId !== 'string' ||
      ids.has(source.sourceRecordId) ||
      source.currentClientId !== clientId ||
      !finiteDate(source.sourceVersion) ||
      !SHA256_RE.test(String(source.contentSha256))
    )
      return null;
    ids.add(source.sourceRecordId);
    sources.push(source);
  }
  return sources;
};

function taskProof(value: unknown): string[] | null {
  const root = record(value);
  const scope = record(root?.scope);
  const coverage = record(root?.coverage);
  if (
    root?.tool !== 'query_tasks' ||
    typeof root.clientId !== 'string' ||
    !scope ||
    !coverage ||
    coverage.sourceStatus !== 'healthy' ||
    coverage.complete !== true ||
    coverage.partial !== false ||
    coverage.paginationComplete !== true ||
    coverage.hasMore !== false ||
    coverage.nextCursor !== null ||
    coverage.totalIsExactForScope !== true ||
    scope.offset !== 0 ||
    scope.cursorApplied !== false ||
    !Number.isSafeInteger(root.total) ||
    !Number.isSafeInteger(root.returned) ||
    root.total !== root.returned ||
    !Array.isArray(root.tasks) ||
    root.returned !== root.tasks.length
  )
    return null;

  const ids = new Set<string>();
  const projected = [];
  for (const candidate of root.tasks) {
    const row = record(candidate);
    const completion = record(row?.nativeCompletion);
    const source = record(row?.sourceProof);
    const linkedSources = linkedSourceProofs(source?.linkedSources, root.clientId as string);
    if (
      !row ||
      typeof row.id !== 'string' ||
      ids.has(row.id) ||
      row.clientId !== root.clientId ||
      typeof row.title !== 'string' ||
      !nullableString(row.body) ||
      typeof row.status !== 'string' ||
      !nullableString(row.ownerUserId) ||
      !(row.dueDate === null || finiteDate(row.dueDate)) ||
      !nullableString(row.clientName) ||
      !nullableString(row.meetingId) ||
      !nullableString(row.meetingTitle) ||
      !nullableString(row.contactId) ||
      !nullableString(row.mailThreadId) ||
      !nullableString(row.sourceType) ||
      !nullableString(row.sourceId) ||
      !nullableString(row.createdByUserId) ||
      !finiteDate(row.createdAt) ||
      !finiteDate(row.updatedAt) ||
      row.recordKind !== 'native_task' ||
      row.recommendation !== false ||
      !completion ||
      typeof completion.completed !== 'boolean' ||
      completion.establishesDeliveryOrAcceptance !== false ||
      source?.version !== 1 ||
      source.owner !== 'engagement_tasks' ||
      source.sourceRecordId !== row.id ||
      source.currentClientId !== root.clientId ||
      source.sourceVersion !== row.updatedAt ||
      !SHA256_RE.test(String(source.contentSha256)) ||
      !linkedSources
    )
      return null;
    const canonical = {
      id: row.id,
      title: row.title,
      body: row.body,
      status: row.status,
      ownerUserId: row.ownerUserId,
      dueDate: row.dueDate,
      clientId: row.clientId,
      clientName: row.clientName,
      meetingId: row.meetingId,
      meetingTitle: row.meetingTitle,
      contactId: row.contactId,
      mailThreadId: row.mailThreadId,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (source.contentSha256 !== sha256(JSON.stringify(canonical))) return null;
    ids.add(row.id);
    projected.push({
      ...canonical,
      sourceProof: { ...source, linkedSources },
      nativeCompletion: completion,
    });
  }
  return [
    researchJsonSha256({
      owner: 'engagement_tasks',
      clientId: root.clientId,
      scope,
      rows: projected,
    }),
  ];
}

export function canonicalTaskOwnerProof(value: unknown): string[] | null {
  return taskProof(value);
}

export function canonicalTaskReauthorizationInput(
  input: Record<string, unknown>,
  savedResult: unknown,
): Record<string, unknown> | null {
  if (!taskProof(savedResult)) return null;
  const root = record(savedResult)!;
  const scope = record(root.scope)!;
  const requestedClientId = typeof input.clientId === 'string' ? input.clientId.trim() : null;
  const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : null;
  const status = typeof input.status === 'string' ? input.status.trim().toLowerCase() : null;
  const dueBefore =
    typeof input.dueBefore === 'string' ? new Date(input.dueBefore).toISOString() : null;
  if (
    requestedClientId !== root.clientId ||
    taskId !== scope.taskId ||
    status !== scope.status ||
    (dueBefore !== null && dueBefore !== scope.dueBefore) ||
    scope.cursorApplied !== false
  )
    return null;
  return status === 'overdue' && dueBefore === null
    ? { ...input, dueBefore: scope.dueBefore }
    : input;
}
