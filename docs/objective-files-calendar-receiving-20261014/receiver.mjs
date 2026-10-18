/** Runnable receiving example. Call through the frontend's existing API client.
 * This module owns no login, tenant authority, persistence, fetch or cache. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const record = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_RECEIPT');
  return value;
};
const uuid = (value) => {
  if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_SELECTION');
  return value.toLowerCase();
};
const version = (value) => {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) fail('INVALID_SELECTION');
  return value;
};
function binding(input) {
  return { clientId: uuid(input.clientId), objectiveId: uuid(input.objectiveId),
    objectiveVersion: version(input.objectiveVersion) };
}
function bound(destination, expected, kind, resourceId) {
  const d = record(destination);
  if (d.kind !== kind || d.resourceId !== resourceId || d.clientId !== expected.clientId ||
      d.objectiveId !== expected.objectiveId || d.objectiveVersion !== expected.objectiveVersion ||
      typeof d.objectiveRevisionId !== 'string' || !UUID.test(d.objectiveRevisionId))
    fail('INVALID_RECEIPT');
  return d;
}
function active(options) {
  return !options.signal?.aborted && options.isCurrent();
}
function query(b) { return new URLSearchParams(b).toString(); }
async function observe(run) {
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  }
}

/** request({owner,path,signal}) must use normal existing API login/tenant handling.
 * hashSnapshot must use the public canonicalWorkspaceSnapshot producer and SHA256.
 * isCurrent is the caller's existing session/client/Objective/request admission. */
export async function openSavedRevision(selection, objective, options) {
  options = { request: options.request, isCurrent: options.isCurrent,
    hashSnapshot: options.hashSnapshot, signal: options.signal };
  const b = binding(objective);
  const draftId = uuid(selection.draftId), versionId = uuid(selection.versionId);
  const selectedHash = selection.snapshotHash;
  if (selectedHash !== undefined && (typeof selectedHash !== 'string' || !HASH.test(selectedHash)))
    fail('INVALID_SELECTION');
  if (!active(options)) return null;
  const observed = await observe(() => options.request({ owner: 'workspace',
    path: `drafts/${draftId}/versions/${versionId}/objective-destination?${query(b)}`,
    signal: options.signal }));
  if (!active(options)) return null;
  if (Object.hasOwn(observed, 'error')) throw observed.error;
  const response = record(observed.value);
  const destination = bound(response.destination, b, 'workspace_saved_revision', versionId);
  if (destination.draftId !== draftId || response.draftId !== draftId ||
      response.versionId !== versionId || response.clientId !== b.clientId ||
      response.hashFormat !== 'workspace-snapshot-canonical-json-v1' ||
      typeof response.snapshotHash !== 'string' || !HASH.test(response.snapshotHash))
    fail('INVALID_RECEIPT');
  const verified = await observe(() => options.hashSnapshot(response.snapshot));
  if (!active(options)) return null;
  if (Object.hasOwn(verified, 'error')) throw verified.error;
  if (verified.value !== response.snapshotHash ||
      (selectedHash !== undefined && selectedHash !== response.snapshotHash))
    fail('SAVED_REVISION_CHANGED');
  if (!active(options)) return null;
  return { destination, snapshot: response.snapshot, snapshotHash: response.snapshotHash,
    hashFormat: response.hashFormat, savedAt: response.savedAt,
    authorId: response.authorId, authorKind: response.authorKind };
}

const day = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('INVALID_RECEIPT');
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    fail('INVALID_RECEIPT');
  return value;
};
function zone(value) {
  if (typeof value !== 'string' || !value || value.length > 100) fail('INVALID_RECEIPT');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); }
  catch { fail('INVALID_RECEIPT'); }
  return value;
}

/** Occurrences are presentation selectors on the returned task, not resources.
 * The source civil date and optional HH:mm/IANA pair stay unconverted here. */
export async function openPlannerOccurrence(selection, objective, options) {
  options = { request: options.request, isCurrent: options.isCurrent, signal: options.signal };
  const b = binding(objective), taskId = uuid(selection.taskId);
  const expectedVersion = version(selection.destinationVersion);
  const occurrence = selection.occurrence;
  if (!['start', 'due'].includes(occurrence)) fail('INVALID_SELECTION');
  if (!active(options)) return null;
  const observed = await observe(() => options.request({ owner: 'strategy',
    path: `planner/tasks/${taskId}/objective-destination?${query(b)}`,
    signal: options.signal }));
  if (!active(options)) return null;
  if (Object.hasOwn(observed, 'error')) throw observed.error;
  const response = record(observed.value);
  const destination = bound(response.destination, b, 'planner_task', taskId);
  const task = record(response.task);
  if (task.id !== taskId || typeof task.clientId !== 'string' ||
      task.clientId.toLowerCase() !== b.clientId || task.archived !== false ||
      !Number.isInteger(destination.destinationVersion) || destination.destinationVersion < 1 ||
      task.version !== destination.destinationVersion) fail('INVALID_RECEIPT');
  if (destination.destinationVersion !== expectedVersion) fail('DESTINATION_CHANGED');
  // Preserve the selected plan's coincident-date collapse to the due occurrence.
  if (occurrence === 'start' && task.startOn !== null && task.startOn === task.dueOn)
    fail('OCCURRENCE_UNAVAILABLE');
  const date = task[`${occurrence}On`];
  if (date === null || date === undefined) fail('OCCURRENCE_UNAVAILABLE');
  const civilDate = day(date), time = task[`${occurrence}Time`] ?? null;
  const timeZone = task.timeZone ?? null;
  if (time !== null) {
    if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail('INVALID_RECEIPT');
    zone(timeZone);
  } else if (timeZone !== null) zone(timeZone);
  if (!active(options)) return null;
  return { destination, task, occurrence: { id: `planner:${taskId}:${occurrence}`,
    taskId, dateKind: occurrence === 'start' ? 'planner_start' : 'planner_due',
    civilDate, time, timeZone, provenance: 'planner_task', destinationVersion: task.version } };
}
