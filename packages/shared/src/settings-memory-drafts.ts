/** Browser-safe private draft and submission contract. Core owns all authority. */
export type MemoryDraftScope = 'user' | 'client' | 'firm';
export interface MemoryDraftTarget {
  type: string;
  slug: string;
  scope: MemoryDraftScope;
  clientId: string | null;
}
export interface MemoryDraftEdit {
  key: string;
  body: string;
}
export interface MemoryDraftSection extends MemoryDraftEdit {
  heading: string;
  owner: 'human' | 'engine';
}
export interface MemoryDraftSave {
  requestId: string;
  expectedRevision: number;
  action: 'save' | 'discard';
  baseItemId: string | null;
  baseVersion: string | null;
  sections: MemoryDraftEdit[];
}
export interface MemoryDraftSubmit {
  requestId: string;
  expectedRevision: number;
}
export interface MemoryDraftFile {
  schema: 'memory-settings-file/1';
  type: string;
  slug: string;
  scope: MemoryDraftScope;
  baseItemId: string | null;
  baseVersion: string | null;
  sections: MemoryDraftSection[];
  drafts: Array<{ id: string; revision: number; expiresAt: string; updatedAt: string }>;
  hasMoreDrafts: boolean;
  retention: { policyVersion: 1; draftDays: 30 };
  publicationAvailable: false;
}
export interface MemoryDraftRead {
  schema: 'memory-settings-draft/1';
  id: string;
  type: string;
  slug: string;
  revision: number;
  state: 'draft' | 'discarded' | 'expired' | 'submitted';
  baseItemId: string | null;
  baseVersion: string | null;
  sections: MemoryDraftEdit[] | null;
  expiresAt: string;
  updatedAt: string;
  legalHold: boolean;
  baseChanged: boolean;
}
export interface MemoryDraftReceipt {
  schema: 'memory-settings-draft-receipt/1';
  requestId: string;
  draftId: string;
  requestHash: string;
  revision: number;
  state: 'draft' | 'discarded';
  recordedAt: string;
}
export interface MemoryDraftSubmissionReceipt {
  schema: 'memory-settings-submit-receipt/1';
  requestId: string;
  requestHash: string;
  draftId: string;
  draftRevision: number;
  candidateId: string;
  submittedAt: string;
  status: 'pending_review';
  activeItemUnchanged: true;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function fail(): never {
  throw Error('INVALID_MEMORY_DRAFT_CONTRACT');
}
function object(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    fail();
  return value as Record<string, unknown>;
}
const text = (v: unknown, max = 128): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;
const id = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && HASH.test(v);
const revision = (v: unknown, min = 1): v is number =>
  Number.isSafeInteger(v) && Number(v) >= min && Number(v) < 2147483647;
const date = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
function source(row: Record<string, unknown>) {
  if (!(
    (row.baseItemId === null && row.baseVersion === null) ||
    (id(row.baseItemId) && hash(row.baseVersion))
  ))
    fail();
}
function edits(raw: unknown, full = false): MemoryDraftEdit[] {
  if (!Array.isArray(raw) || raw.length > (full ? 256 : 64)) fail();
  const seen = new Set<string>();
  for (const value of raw) {
    const row = object(value, full ? ['key', 'body', 'heading', 'owner'] : ['key', 'body']);
    if (
      !text(row.key) ||
      seen.has(row.key) ||
      typeof row.body !== 'string' ||
      row.body.length > 512 * 1024
    )
      fail();
    if (full && (!text(row.heading, 256) || !['human', 'engine'].includes(String(row.owner))))
      fail();
    seen.add(row.key);
  }
  return raw as MemoryDraftEdit[];
}
export function parseMemoryDraftSave(raw: unknown): MemoryDraftSave {
  const row = object(raw, [
    'requestId',
    'expectedRevision',
    'action',
    'baseItemId',
    'baseVersion',
    'sections',
  ]);
  source(row);
  if (
    !id(row.requestId) ||
    !revision(row.expectedRevision, 0) ||
    !['save', 'discard'].includes(String(row.action))
  )
    fail();
  const sections = edits(row.sections)
    .map((s) => ({ key: s.key, body: s.body }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (
    (row.action === 'discard' && sections.length) ||
    new TextEncoder().encode(JSON.stringify(row)).byteLength > 128 * 1024
  )
    fail();
  return {
    requestId: row.requestId,
    expectedRevision: row.expectedRevision,
    action: row.action as MemoryDraftSave['action'],
    baseItemId: row.baseItemId as string | null,
    baseVersion: row.baseVersion as string | null,
    sections,
  };
}
export function parseMemoryDraftSubmit(raw: unknown): MemoryDraftSubmit {
  const row = object(raw, ['requestId', 'expectedRevision']);
  if (!id(row.requestId) || !revision(row.expectedRevision)) fail();
  return { requestId: row.requestId, expectedRevision: row.expectedRevision };
}
/** Hash these exact UTF-8 bytes with SHA-256 in the server/browser crypto owner. */
export function memoryDraftRequestBytes(
  target: MemoryDraftTarget,
  id: string,
  raw: MemoryDraftSave,
) {
  return JSON.stringify({
    schema: 1,
    target: {
      type: target.type,
      slug: target.slug,
      scope: target.scope,
      clientId: target.clientId,
    },
    id,
    ...parseMemoryDraftSave(raw),
  });
}
export function memoryDraftSubmissionBytes(
  target: MemoryDraftTarget,
  id: string,
  raw: MemoryDraftSubmit,
) {
  return JSON.stringify({
    schema: 1,
    target: {
      type: target.type,
      slug: target.slug,
      scope: target.scope,
      clientId: target.clientId,
    },
    id,
    ...parseMemoryDraftSubmit(raw),
  });
}
export function parseMemoryDraftFile(raw: unknown): MemoryDraftFile {
  const row = object(raw, [
    'schema',
    'type',
    'slug',
    'scope',
    'baseItemId',
    'baseVersion',
    'sections',
    'drafts',
    'hasMoreDrafts',
    'retention',
    'publicationAvailable',
  ]);
  source(row);
  edits(row.sections, true);
  if (
    row.schema !== 'memory-settings-file/1' ||
    !text(row.type, 64) ||
    !text(row.slug, 128) ||
    !['user', 'client', 'firm'].includes(String(row.scope)) ||
    typeof row.hasMoreDrafts !== 'boolean' ||
    row.publicationAvailable !== false ||
    !Array.isArray(row.drafts) ||
    row.drafts.length > 100
  )
    fail();
  for (const draft of row.drafts) {
    const d = object(draft, ['id', 'revision', 'expiresAt', 'updatedAt']);
    if (!id(d.id) || !revision(d.revision) || !date(d.expiresAt) || !date(d.updatedAt)) fail();
  }
  const policy = object(row.retention, ['policyVersion', 'draftDays']);
  if (policy.policyVersion !== 1 || policy.draftDays !== 30) fail();
  return raw as MemoryDraftFile;
}
export function parseMemoryDraftRead(raw: unknown): MemoryDraftRead {
  const row = object(raw, [
    'schema',
    'id',
    'type',
    'slug',
    'revision',
    'state',
    'baseItemId',
    'baseVersion',
    'sections',
    'expiresAt',
    'updatedAt',
    'legalHold',
    'baseChanged',
  ]);
  source(row);
  if (row.sections !== null) edits(row.sections);
  if (
    row.schema !== 'memory-settings-draft/1' ||
    !id(row.id) ||
    !text(row.type, 64) ||
    !text(row.slug, 128) ||
    !revision(row.revision) ||
    !['draft', 'discarded', 'expired', 'submitted'].includes(String(row.state)) ||
    !date(row.expiresAt) ||
    !date(row.updatedAt) ||
    typeof row.legalHold !== 'boolean' ||
    typeof row.baseChanged !== 'boolean' ||
    (row.state === 'draft') !== (row.sections !== null)
  )
    fail();
  return raw as MemoryDraftRead;
}
export function parseMemoryDraftReceipt(raw: unknown): MemoryDraftReceipt {
  const row = object(raw, [
    'schema',
    'requestId',
    'draftId',
    'requestHash',
    'revision',
    'state',
    'recordedAt',
  ]);
  if (
    row.schema !== 'memory-settings-draft-receipt/1' ||
    !id(row.requestId) ||
    !id(row.draftId) ||
    !hash(row.requestHash) ||
    !revision(row.revision) ||
    !['draft', 'discarded'].includes(String(row.state)) ||
    !date(row.recordedAt)
  )
    fail();
  return raw as MemoryDraftReceipt;
}
export function parseMemoryDraftSubmissionReceipt(raw: unknown): MemoryDraftSubmissionReceipt {
  const row = object(raw, [
    'schema',
    'requestId',
    'requestHash',
    'draftId',
    'draftRevision',
    'candidateId',
    'submittedAt',
    'status',
    'activeItemUnchanged',
  ]);
  if (
    row.schema !== 'memory-settings-submit-receipt/1' ||
    !id(row.requestId) ||
    !hash(row.requestHash) ||
    !id(row.draftId) ||
    !id(row.candidateId) ||
    !revision(row.draftRevision) ||
    !date(row.submittedAt) ||
    row.status !== 'pending_review' ||
    row.activeItemUnchanged !== true
  )
    fail();
  return raw as MemoryDraftSubmissionReceipt;
}
