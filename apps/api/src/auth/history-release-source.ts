import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';

/** Unmounted Core/Meri saved-history wire. Parsing and hashing do not authorize a read. */
export const HISTORY_RELEASE_MAX_SUBJECTS = 100;
export const HISTORY_RELEASE_MAX_SCOPES = 100;
export const HISTORY_RELEASE_RECEIPT_TTL_MS = 5_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SCOPE_KINDS = new Set([
  'tenant', 'client', 'mailbox', 'memory', 'document', 'private-user', 'public',
] as const);

export type HistoryReleaseRoute = 'list' | 'transcript';
export type HistoryReleaseScopeKind = 'tenant' | 'client' | 'mailbox' | 'memory' | 'document' | 'private-user' | 'public';
export interface HistoryReleaseScope {
  readonly tenantId: string;
  readonly kind: HistoryReleaseScopeKind;
  readonly resourceId: string;
  readonly policyRevision: string;
}
export interface HistoryReleaseSubject {
  readonly conversationId: string;
  readonly clientId: string | null;
  readonly scopes: readonly HistoryReleaseScope[];
}
export interface HistoryReleaseRequest {
  readonly schemaVersion: 1;
  readonly observationId: string;
  readonly route: HistoryReleaseRoute;
  readonly responseSha256: string;
  readonly subjects: readonly HistoryReleaseSubject[];
}
export interface HistoryReleasePrincipal { readonly tenantId: string; readonly actorId: string }

/** The future owner must return one decision for the whole ordered vector. */
export interface HistoryReleaseBatchDecision {
  authorized: true;
  observationId: string;
  route: HistoryReleaseRoute;
  principal: HistoryReleasePrincipal;
  subjectsSha256: string;
  responseSha256: string;
  checkedAtMs: number;
  expiresAtMs: number;
}
export interface HistoryReleaseReceipt {
  schemaVersion: 1;
  observationId: string;
  route: HistoryReleaseRoute;
  principal: HistoryReleasePrincipal;
  subjectsSha256: string;
  responseSha256: string;
  checkedAtMs: number;
  expiresAtMs: number;
}
export interface HistoryReleaseBatchPort {
  /** Must validate every subject within one owner transaction and do a last online session read under its locks. */
  decideAll(request: HistoryReleaseRequest, principal: HistoryReleasePrincipal, subjectsSha256: string): Promise<unknown>;
}

export class HistoryReleaseSourceError extends Error {
  readonly code: 'INVALID_REQUEST' | 'UNAVAILABLE';
  constructor(code: 'INVALID_REQUEST' | 'UNAVAILABLE') {
    super('History release unavailable');
    this.name = 'HistoryReleaseSourceError';
    this.code = code;
  }
}
function invalid(): never { throw new HistoryReleaseSourceError('INVALID_REQUEST'); }
function unavailable(): never { throw new HistoryReleaseSourceError('UNAVAILABLE'); }

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !property.enumerable || !('value' in property)) invalid();
    result[key] = property.value;
  }
  return result;
}

function boundedArray(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !property.enumerable || !('value' in property)) invalid();
    result.push(property.value);
  }
  return result;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) invalid();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid();
  return value;
}
function principal(value: unknown): HistoryReleasePrincipal {
  const p = closed(value, ['tenantId', 'actorId']);
  return Object.freeze({ tenantId: uuid(p.tenantId), actorId: uuid(p.actorId) });
}

export function parseHistoryReleaseRequest(value: unknown): HistoryReleaseRequest {
  const request = closed(value, ['schemaVersion', 'observationId', 'route', 'responseSha256', 'subjects']);
  if (request.schemaVersion !== 1 || (request.route !== 'list' && request.route !== 'transcript')) invalid();
  const rows = boundedArray(request.subjects, request.route === 'transcript' ? 1 : 0,
    request.route === 'transcript' ? 1 : HISTORY_RELEASE_MAX_SUBJECTS);
  const seenConversations = new Set<string>();
  let totalScopes = 0;
  const subjects: HistoryReleaseSubject[] = rows.map((value) => {
    const row = closed(value, ['conversationId', 'clientId', 'scopes']);
    const conversationId = uuid(row.conversationId);
    if (seenConversations.has(conversationId)) invalid();
    seenConversations.add(conversationId);
    const scopes = Object.freeze(boundedArray(row.scopes, 1, HISTORY_RELEASE_MAX_SCOPES).map((value) => {
      const scope = closed(value, ['tenantId', 'kind', 'resourceId', 'policyRevision']);
      if (typeof scope.kind !== 'string' || !SCOPE_KINDS.has(scope.kind as HistoryReleaseScopeKind)) invalid();
      return Object.freeze({ tenantId: text(scope.tenantId, 128), kind: scope.kind as HistoryReleaseScopeKind,
        resourceId: text(scope.resourceId, 256), policyRevision: text(scope.policyRevision, 128) });
    }));
    totalScopes += scopes.length;
    if (totalScopes > HISTORY_RELEASE_MAX_SCOPES) invalid();
    const seenScopes = new Set<string>();
    for (const scope of scopes) {
      let canonical: string;
      try { canonical = canonicalizeCoreRetainedJson(scope); } catch { return invalid(); }
      if (seenScopes.has(canonical)) invalid();
      seenScopes.add(canonical);
    }
    return Object.freeze({ conversationId, clientId: row.clientId === null ? null : uuid(row.clientId), scopes });
  });
  return Object.freeze({ schemaVersion: 1, observationId: uuid(request.observationId), route: request.route,
    responseSha256: digest(request.responseSha256), subjects: Object.freeze(subjects) });
}

/** RFC 8785 of the ordered subject vector; order of subjects and scopes is retained. */
export function historyReleaseSubjectsSha256(subjects: readonly HistoryReleaseSubject[]): string {
  try {
    return createHash('sha256').update(canonicalizeCoreRetainedJson(subjects), 'utf8').digest('hex');
  } catch { return unavailable(); }
}

function validTime(checkedAtMs: unknown, expiresAtMs: unknown, nowMs: number): boolean {
  return Number.isSafeInteger(nowMs) && nowMs >= 0 &&
    Number.isSafeInteger(checkedAtMs) && (checkedAtMs as number) <= nowMs &&
    nowMs - (checkedAtMs as number) <= HISTORY_RELEASE_RECEIPT_TTL_MS &&
    Number.isSafeInteger(expiresAtMs) && (expiresAtMs as number) > nowMs &&
    (expiresAtMs as number) <= (checkedAtMs as number) + HISTORY_RELEASE_RECEIPT_TTL_MS;
}

/** Exact echo check only. The batch port is responsible for the actual authority decision. */
export function buildHistoryReleaseReceipt(
  request: HistoryReleaseRequest, expectedPrincipal: HistoryReleasePrincipal,
  subjectsSha256: string, value: unknown, nowMs: number,
): HistoryReleaseReceipt {
  const decision = closed(value, ['authorized', 'observationId', 'route', 'principal', 'subjectsSha256',
    'responseSha256', 'checkedAtMs', 'expiresAtMs']);
  const decidedPrincipal = principal(decision.principal);
  if (decision.authorized !== true || decision.observationId !== request.observationId ||
      decision.route !== request.route || decision.subjectsSha256 !== subjectsSha256 ||
      decision.responseSha256 !== request.responseSha256 ||
      decidedPrincipal.tenantId !== expectedPrincipal.tenantId ||
      decidedPrincipal.actorId !== expectedPrincipal.actorId ||
      !validTime(decision.checkedAtMs, decision.expiresAtMs, nowMs)) unavailable();
  return { schemaVersion: 1, observationId: request.observationId, route: request.route,
    principal: decidedPrincipal, subjectsSha256, responseSha256: request.responseSha256,
    checkedAtMs: decision.checkedAtMs as number, expiresAtMs: decision.expiresAtMs as number };
}

/** Pure ingress seam. A future native-only HTTP route must supply the authenticated principal and qualified port. */
export async function readHistoryReleaseSource(
  body: unknown, authenticatedPrincipal: unknown, port: HistoryReleaseBatchPort,
  now: () => number = Date.now,
): Promise<HistoryReleaseReceipt> {
  const request = parseHistoryReleaseRequest(body);
  let expectedPrincipal: HistoryReleasePrincipal;
  try { expectedPrincipal = principal(authenticatedPrincipal); } catch { return unavailable(); }
  const subjectsSha256 = historyReleaseSubjectsSha256(request.subjects);
  let decision: unknown;
  try { decision = await port.decideAll(request, expectedPrincipal, subjectsSha256); }
  catch { return unavailable(); }
  try { return buildHistoryReleaseReceipt(request, expectedPrincipal, subjectsSha256, decision, now()); }
  catch { return unavailable(); }
}
