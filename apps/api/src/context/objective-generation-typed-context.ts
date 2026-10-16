import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

export interface ObjectiveTypedSource {
  clientId: string; objectiveId: string; objectiveVersion: number; objectiveRevisionId: string;
}
export interface ObjectiveTypedIntent {
  outcome: string; governmentProblem: string; askType: string; minimumWin: string; limits: string;
}
export interface ObjectiveTypedEvidence {
  ref: string; sourceId: string; asOfMs: number; scope: 'client'; clientId: string;
  /** Review status of this historical artifact, not current canonical truth.
   * An accepted recommendation remains a recommendation in the full prompt. */
  reviewState: 'accepted' | 'pending';
}
export interface ObjectiveTypedContext {
  schemaVersion: 1; tenantId: string; clerkUserId: string; requestId: string;
  source: ObjectiveTypedSource; intent: ObjectiveTypedIntent;
  snapshotSha256: string; sourceDigest: string; packetId: string; compiledAt: string;
  coverageDigest: string; promptSha256: string; evidence: ObjectiveTypedEvidence[];
}
export class ObjectiveTypedContextError extends Error {
  constructor() { super('Objective typed context is unavailable'); }
}
const fail = (): never => { throw new ObjectiveTypedContextError(); };
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === 'string' && pattern.exec(value)?.[0] === value;
function uuid(value: unknown): string {
  return exact(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, value) ? value : fail();
}
function sha(value: unknown): string { return exact(/^[a-f0-9]{64}$/, value) ? value : fail(); }
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return fail();
  return raw as Record<string, unknown>;
}
function read(raw: unknown, keys: string[], closed = true): Record<string, unknown> {
  const r = object(raw);
  if (closed) {
    const own = Reflect.ownKeys(r);
    if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) return fail();
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(r, key);
    if (!d || !d.enumerable || !('value' in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
function text(value: unknown, maximum: number, blank = false): string {
  return typeof value === 'string' && value.length <= maximum && (blank || /\S/.test(value)) ? value : fail();
}
function milliseconds(raw: unknown): number {
  if (typeof raw !== 'string') return fail();
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.exec(raw);
  if (!m || m[0] !== raw) return fail();
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const value = Date.parse(raw);
  if (month! < 1 || month! > 12 || day! < 1 || day! > days[month! - 1]! || hour! > 23 || minute! > 59 || second! > 59 ||
      !Number.isSafeInteger(value) || value < 0) return fail();
  return value;
}
function finiteJson(raw: unknown): string {
  if (raw === null || typeof raw === 'string' || typeof raw === 'boolean') return JSON.stringify(raw);
  if (typeof raw === 'number' && Number.isFinite(raw)) return JSON.stringify(raw);
  const r = object(raw), own = Reflect.ownKeys(r);
  if (own.some(k => typeof k !== 'string')) return fail();
  const keys = (own as string[]).sort();
  return '{' + keys.map(key => {
    const d = Object.getOwnPropertyDescriptor(r, key);
    if (!d || !d.enumerable || !('value' in d)) return fail();
    return JSON.stringify(key) + ':' + finiteJson(d.value);
  }).join(',') + '}';
}
const digest = (value: unknown) => createHash('sha256').update(finiteJson(value), 'utf8').digest('hex');
function findingRows(raw: unknown): unknown[] {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || !Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Array.prototype || Reflect.ownKeys(raw).length !== raw.length + 1) return fail();
  const rows: unknown[] = [];
  for (let index = 0; index < raw.length; index++) {
    const d = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!d || !d.enumerable || !('value' in d)) return fail();
    rows.push(d.value);
  }
  return rows;
}
/** Private owner projection, not a public coverage manifest or another corpus.
 * Caller supplies the existing bound, lossless prompt and the actual retained
 * background projection. No retrieval/steering authority or completeness flag
 * is converted into an evidence review status. Full prompt content stays in
 * governedContext.prompt; this hash is its raw UTF-8 SHA, not JSON-string SHA.
 * The full saved revision hash must be captured by the actual snapshot owner;
 * it is deliberately distinct from the hash of {source,intent} below. */
export function projectObjectiveTypedContext(raw: unknown): ObjectiveTypedContext {
  const r = read(raw, ['tenantId', 'clerkUserId', 'requestId', 'source', 'intent', 'snapshotSha256',
    'sourceDigest', 'packetId', 'compiledAt', 'coverageDigest', 'prompt', 'findings',
    'packetPersisted', 'packetDegraded', 'coverageComplete', 'paginationComplete', 'truncated']);
  if (r.packetPersisted !== true || r.packetDegraded !== false || r.coverageComplete !== true ||
      r.paginationComplete !== true || r.truncated !== false) return fail();
  const tenantId = uuid(r.tenantId), requestId = uuid(r.requestId), packetId = uuid(r.packetId);
  // Identity was resolved by the actual Core owner. Preserve the opaque
  // subject domain shared by the generation admission; do not infer lineage
  // from a newly invented Clerk identifier regex.
  const clerkUserId = text(r.clerkUserId, 128);
  const s = read(r.source, ['clientId', 'objectiveId', 'objectiveVersion', 'objectiveRevisionId']);
  const source: ObjectiveTypedSource = { clientId: uuid(s.clientId), objectiveId: uuid(s.objectiveId),
    objectiveVersion: typeof s.objectiveVersion === 'number' && Number.isInteger(s.objectiveVersion) &&
      s.objectiveVersion >= 1 && s.objectiveVersion <= 2147483647 ? s.objectiveVersion : fail(),
    objectiveRevisionId: uuid(s.objectiveRevisionId) };
  const i = read(r.intent, ['outcome', 'governmentProblem', 'askType', 'minimumWin', 'limits']);
  const intent: ObjectiveTypedIntent = { outcome: text(i.outcome, 2000), governmentProblem: text(i.governmentProblem, 4000),
    askType: typeof i.askType === 'string' && ['funding', 'policy_authority', 'both', 'protect_funding', 'meri_propose'].includes(i.askType)
      ? i.askType : fail(), minimumWin: text(i.minimumWin, 2000), limits: text(i.limits, 4000, true) };
  const sourceDigest = sha(r.sourceDigest), snapshotSha256 = sha(r.snapshotSha256), coverageDigest = sha(r.coverageDigest);
  if (sourceDigest !== digest({ source, intent })) return fail();
  const compiledAtMs = milliseconds(r.compiledAt);
  if (typeof r.prompt !== 'string' || !r.prompt.trim()) return fail();
  const ids = new Set<string>(), evidence: ObjectiveTypedEvidence[] = [];
  for (const row of findingRows(r.findings)) {
    // Deliberately read only owner-projected metadata. Proposed values, source
    // material and even accessor-bearing extra fields are never inspected.
    const f = read(row, ['id', 'status', 'factKind', 'disposition', 'contentHash', 'updatedAt'], false);
    const sourceId = uuid(f.id), contentHash = sha(f.contentHash), asOfMs = milliseconds(f.updatedAt);
    if (ids.has(sourceId) || asOfMs > compiledAtMs || typeof f.factKind !== 'string' ||
        !['fact', 'recommendation'].includes(f.factKind)) return fail();
    ids.add(sourceId);
    if (f.status === 'rejected' || f.status === 'informational') {
      if (f.disposition !== 'withheld_not_supporting') return fail();
      continue;
    }
    if (f.status !== 'accepted' && f.status !== 'pending' ||
        f.disposition !== (f.status === 'accepted' ? 'historical_reviewed_applied' : 'candidate_unverified')) return fail();
    evidence.push({ ref: `profile-fill:${sourceId}:${contentHash}`, sourceId, asOfMs,
      scope: 'client', clientId: source.clientId, reviewState: f.status });
    if (evidence.length > 256) return fail();
  }
  evidence.sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  const result: ObjectiveTypedContext = { schemaVersion: 1, tenantId, clerkUserId, requestId,
    source, intent, snapshotSha256, sourceDigest, packetId, compiledAt: r.compiledAt as string, coverageDigest,
    promptSha256: createHash('sha256').update(r.prompt, 'utf8').digest('hex'), evidence };
  Object.freeze(source); Object.freeze(intent);
  for (const item of evidence) Object.freeze(item);
  Object.freeze(evidence);
  return Object.freeze(result);
}
