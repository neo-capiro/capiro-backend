import { createHash } from 'node:crypto';
import type { RetrievalRecord } from '../retrieval/retrieval-v2.types.js';
import type { ObjectiveTypedEvidence } from './objective-generation-typed-context.js';

export interface ObjectiveSourceEvidence extends ObjectiveTypedEvidence {
  kind: 'context_fact' | 'governed_memory' | 'reference_calendar';
  title: string; text: string; locator: string; version: string;
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const string = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function scoped(clientId: unknown, selected: string) {
  if (clientId === selected) return { scope: 'client' as const, clientId: selected };
  if (clientId === null) return { scope: 'tenant-shared' as const, clientId: null };
  return null;
}
function fact(record: RetrievalRecord, selected: string, now: number): ObjectiveSourceEvidence | null {
  const p = object(record.payload), doc = object(p.documentWitness);
  const scope = scoped(p.clientId, selected), asOfMs = Date.parse(p.updatedAt);
  if (p.kind !== 'context_fact' || !scope || !uuid(p.id) || !uuid(p.documentId) || !sha(doc.checksum) ||
      doc.clientId !== p.clientId || !(scope.scope === 'client' ? doc.scope === 'client' : doc.scope === 'firm') ||
      p.state !== 'active' || doc.state !== 'active' ||
      doc.validUntil && Date.parse(doc.validUntil) < Date.parse(new Date(now).toISOString().slice(0, 10)) ||
      !Number.isFinite(asOfMs) || asOfMs > now || !string(p.fact) || !string(p.sourceRef) || !string(p.documentTitle)) return null;
  const reviewState = ['firm_approved', 'client_approved'].includes(doc.authority) && doc.sourceOfTruth === true && p.authority === doc.authority
    ? 'accepted' as const : 'pending' as const;
  const version = digest({ id: p.id, documentId: p.documentId, documentTitle: p.documentTitle, checksum: doc.checksum, revision: doc.revision ?? null,
    documentUpdatedAt: doc.updatedAt, scope: doc.scope, clientId: doc.clientId, authority: doc.authority,
    sourceOfTruth: doc.sourceOfTruth, fact: p.fact, sourceRef: p.sourceRef, factAuthority: p.authority,
    asOf: p.asOf, citation: p.citation, updatedAt: p.updatedAt, reviewState });
  return { kind: 'context_fact', ref: `context-fact:${p.id}:${version}`, sourceId: p.id, asOfMs, ...scope,
    reviewState, title: p.documentTitle, text: p.fact, locator: p.sourceRef, version };
}
function memory(record: RetrievalRecord, selected: string, now: number): ObjectiveSourceEvidence | null {
  const p = object(record.payload), g = object(p.governance), provenance = object(record.provenance);
  const scope = scoped(p.clientId, selected), asOfMs = new Date(record.updatedAt ?? '').getTime();
  if (!scope || !(scope.scope === 'client' ? p.scope === 'client' : p.scope === 'firm') ||
      p.sourceKind !== 'governed_memory' || !uuid(p.memoryItemId) || p.contentStatus !== 'available' ||
      !string(p.value) || !string(p.title) || !Number.isFinite(asOfMs) || asOfMs > now ||
      !['active', 'stale'].includes(g.status) || g.conflictStatus && g.conflictStatus !== 'none') return null;
  const accepted = g.status === 'active' && g.stale === false && string(g.approvedByUserId) && string(g.approvedAt) &&
    ['institutional_authoritative', 'client_steering'].includes(g.memoryClass) &&
    ['firm_approved', 'client_approved'].includes(g.authority);
  const reviewState = accepted ? 'accepted' as const : 'pending' as const;
  const version = digest({ id: p.memoryItemId, scope: p.scope, clientId: p.clientId, title: p.title, value: p.value,
    governance: { memoryClass: g.memoryClass, authority: g.authority, status: g.status, conflictStatus: g.conflictStatus,
      approvedByUserId: g.approvedByUserId, approvedAt: g.approvedAt, asOf: g.asOf, effectiveFrom: g.effectiveFrom,
      validUntil: g.validUntil, expiresAt: g.expiresAt, lastConfirmedAt: g.lastConfirmedAt, reviewDueAt: g.reviewDueAt, stale: g.stale },
    source: { type: provenance.sourceType, id: provenance.sourceId, ref: provenance.sourceRef,
      contentHash: provenance.contentHash, version: provenance.sourceVersion }, asOfMs, reviewState });
  return { kind: 'governed_memory', ref: `governed-memory:${p.memoryItemId}:${version}`, sourceId: p.memoryItemId,
    asOfMs, ...scope, reviewState, title: p.title, text: p.value, locator: 'Approved memory body', version };
}
/** Called only on the existing actor-authorized resolver's records. This is not an authorization owner. */
export function projectObjectiveSourceEvidence(records: readonly RetrievalRecord[], clientId: string, asOf: string,
  calendars: readonly Record<string, any>[] = []): ObjectiveSourceEvidence[] {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) throw new Error('Objective evidence observation unavailable');
  const result: ObjectiveSourceEvidence[] = [];
  for (const record of records) {
    const item = record.domain === 'strategies_work' ? fact(record, clientId, now)
      : record.domain === 'institutional_knowledge' ? memory(record, clientId, now) : null;
    if (item) result.push(item);
  }
  for (const row of calendars) {
    if (!uuid(row.id) || !['baseline', 'override'].includes(row.source) || !string(row.label))
      throw new Error('Reference calendar witness unavailable');
    const version = digest({ id: row.id, kind: row.kind, source: row.source, label: row.label, fy: row.fy,
      startsOn: row.startsOn, endsOn: row.endsOn, tone: row.tone, position: row.position });
    result.push({ kind: 'reference_calendar', ref: `calendar-${row.source}:${row.id}:${version}`, sourceId: row.id,
      asOfMs: now, scope: 'tenant-shared', clientId: null, reviewState: 'accepted', title: row.label,
      text: `Fiscal year: ${row.fy ?? 'not specified'}; start: ${row.startsOn ?? 'not specified'}; end: ${row.endsOn ?? 'not specified'}.`,
      locator: `${row.source} / ${row.kind}`, version });
  }
  if (result.length > 256 || new Set(result.map(item => item.ref)).size !== result.length)
    throw new Error('Objective evidence exceeds its complete bounded projection');
  return result.sort((a, b) => a.ref.localeCompare(b.ref));
}
export function typedObjectiveSourceEvidence(items: readonly ObjectiveSourceEvidence[]): ObjectiveTypedEvidence[] {
  return items.map(({ ref, sourceId, asOfMs, scope, clientId, reviewState }) => ({ ref, sourceId, asOfMs, scope, clientId, reviewState }));
}
