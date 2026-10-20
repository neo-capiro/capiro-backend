import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  parseCoreRetainedAuthorityProbeSelector,
  type CoreRetainedAuthorityProbeSelector,
} from './core-retained-authority-probe.js';
import type { CoreRetainedReadOperation } from './core-retained-principal.js';

export type RetainedReadOperation = CoreRetainedReadOperation;
export type RetainedFloridaSelector = CoreRetainedAuthorityProbeSelector;
export interface RetainedPortfolioSelector { readonly schemaVersion: 1; readonly portfolioId: string }
export type CoreRetainedReadCanonicalizer = (value: unknown) => string;
export class CoreRetainedReadRequestInvalidError extends Error {
  readonly status = 400;
  readonly code = 'CORE_RETAINED_READ_REQUEST_INVALID';
  constructor() { super('Invalid retained read request'); this.name = 'CoreRetainedReadRequestInvalidError'; }
}
export class CoreRetainedReadRequestUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'CORE_RETAINED_READ_REQUEST_UNAVAILABLE';
  constructor(message = 'Retained resource selector unavailable') {
    super(message); this.name = 'CoreRetainedReadRequestUnavailableError';
  }
}

type Data = Record<string, unknown>;
type Args = Readonly<Record<string, string | number | null>>;
export interface ParsedRetainedReadBody {
  readonly request: Readonly<Data>;
  readonly context: Readonly<Data>;
  readonly normalizedArgs: Args;
  readonly digests: Readonly<{
    rawRequestSha256: string;
    normalizedArgsSha256: string;
    normalizationContextSha256: string;
  }>;
  readonly selector: Readonly<RetainedPortfolioSelector | RetainedFloridaSelector>;
  readonly originalExpiresAtMs?: number;
}

const MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => new CoreRetainedReadRequestInvalidError();
const unsupported = () => new CoreRetainedReadRequestUnavailableError();
const invalidProvider = () => new CoreRetainedReadRequestUnavailableError('Retained canonicalizer unavailable');
function requireData(condition: unknown): asserts condition { if (!condition) throw invalid(); }

/** Bounded inert JSON copy before any caller property read or serialization.
 * Limits cover the entire body, including keys, explicit nulls and escaping. */
function snapshot(raw: unknown): unknown {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  function consume(count: number) { bytes += count; requireData(bytes <= MAX_BYTES); }
  function text(value: string) {
    requireData(value.length <= MAX_BYTES);
    consume(2);
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 34 || code === 92) consume(2);
      else if (code < 32) consume([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
      else if (code < 128) consume(1);
      else if (code < 2048) consume(2);
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
          value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
        consume(4); index++;
      } else {
        requireData(code < 0xd800 || code > 0xdfff);
        consume(3);
      }
    }
  }
  function copy(value: unknown, depth: number): unknown {
    requireData(++nodes <= 32768 && depth <= 8);
    if (value === null) { consume(4); return null; }
    if (typeof value === 'string') { text(value); return value; }
    if (typeof value === 'boolean') { consume(value ? 4 : 5); return value; }
    if (typeof value === 'number') {
      requireData(Number.isFinite(value)); consume(String(value).length); return value;
    }
    requireData(typeof value === 'object' && value !== null && !types.isProxy(value));
    requireData(!ancestors.has(value));
    ancestors.add(value);
    try {
      const prototype = Object.getPrototypeOf(value);
      if (Array.isArray(value)) {
        requireData(prototype === Array.prototype || prototype === null);
        const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
        requireData(Number.isSafeInteger(length) && length >= 0 && length <= 4096);
        const keys = Reflect.ownKeys(value);
        requireData(keys.length === length + 1 && keys.every(key =>
          typeof key === 'string' && (key === 'length' || /^(0|[1-9][0-9]*)$/.test(key))));
        consume(2 + Math.max(0, length - 1));
        const result: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          requireData(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
          result.push(copy(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }
      requireData(prototype === Object.prototype || prototype === null);
      const keys = Reflect.ownKeys(value);
      requireData(keys.length <= 16 && keys.every(key => typeof key === 'string' && key !== 'toJSON'));
      consume(2 + Math.max(0, keys.length - 1));
      const result: Data = Object.create(null);
      for (const key of keys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        requireData(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
        text(key); consume(1);
        result[key] = copy(descriptor.value, depth + 1);
      }
      return Object.freeze(result);
    } finally { ancestors.delete(value); }
  }
  return copy(raw, 0);
}

function object(value: unknown): Data {
  requireData(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Data;
}
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): Data {
  const row = object(value);
  const keys = Object.keys(row);
  requireData(required.every(key => Object.hasOwn(row, key)) &&
    keys.every(key => required.includes(key) || optional.includes(key)));
  return row;
}
function string(value: unknown, minimum: number, maximum: number): asserts value is string {
  requireData(typeof value === 'string' && value.length <= maximum * 2);
  const length = Array.from(value).length;
  requireData(length >= minimum && length <= maximum);
}
function uuid(value: unknown): asserts value is string {
  requireData(typeof value === 'string' && UUID.test(value));
}
function integer(value: unknown, minimum: number, maximum: number): asserts value is number {
  requireData(Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum);
}

function portfolioContext(value: unknown): { context: Data; conversationId: string; portfolioId: string } {
  const context = shape(value, ['binding', 'subject']);
  const binding = shape(context.binding, ['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence']);
  string(binding.tenantId, 1, 128); string(binding.actorId, 1, 128);
  for (const key of ['conversationId', 'runId', 'attemptId', 'workerId']) uuid(binding[key]);
  integer(binding.writerFence, 1, Number.MAX_SAFE_INTEGER);
  const subject = shape(context.subject, ['kind', 'entityType', 'entityIds', 'tenantId', 'actorId',
    'authorizationDecisionId', 'policyRevision', 'scopes', 'rosterVersionId']);
  requireData(subject.kind === 'entity' && subject.entityType === 'research-portfolio');
  string(subject.tenantId, 1, 128); string(subject.actorId, 1, 128);
  uuid(subject.authorizationDecisionId); string(subject.policyRevision, 1, 128);
  requireData(subject.tenantId === binding.tenantId && subject.actorId === binding.actorId);
  requireData(Array.isArray(subject.entityIds) && subject.entityIds.length === 1 && subject.rosterVersionId === null);
  string(subject.entityIds[0], 1, 256);
  requireData(Array.isArray(subject.scopes) && subject.scopes.length >= 1 && subject.scopes.length <= 4096);
  const unique = new Set<string>();
  for (const value of subject.scopes) {
    const scope = shape(value, ['tenantId', 'kind', 'resourceId', 'policyRevision']);
    string(scope.tenantId, 1, 128); string(scope.resourceId, 1, 256); string(scope.policyRevision, 1, 128);
    requireData(['tenant', 'client', 'mailbox', 'memory', 'document', 'private-user', 'public'].includes(scope.kind as string));
    requireData(scope.tenantId === subject.tenantId && scope.policyRevision === subject.policyRevision);
    // Fixed required scalar fields: structural schema uniqueness, not a digest.
    const key = JSON.stringify([scope.tenantId, scope.kind, scope.resourceId, scope.policyRevision]);
    requireData(!unique.has(key)); unique.add(key);
  }
  return { context, conversationId: binding.conversationId as string, portfolioId: subject.entityIds[0] };
}

function portfolio(operation: RetainedReadOperation, request: Data, value: unknown) {
  const { context, conversationId, portfolioId } = portfolioContext(value);
  const changes = operation === 'get_research_portfolio_changes';
  shape(request, [], changes ? ['conversationId', 'cursor', 'limit'] : ['conversationId']);
  if (Object.hasOwn(request, 'conversationId')) {
    uuid(request.conversationId); requireData(request.conversationId === conversationId);
  }
  const normalizedArgs: Record<string, string | number | null> = { conversationId, portfolioId };
  if (changes) {
    if (Object.hasOwn(request, 'cursor') && request.cursor !== null) string(request.cursor, 0, 2048);
    if (Object.hasOwn(request, 'limit')) integer(request.limit, 1, 100);
    normalizedArgs.cursor = typeof request.cursor === 'string' ? request.cursor.trim() || null : null;
    normalizedArgs.limit = request.limit === undefined ? 25 : request.limit as number;
  }
  if (!CORE_UUID.test(portfolioId)) throw unsupported();
  const selector: RetainedPortfolioSelector = { schemaVersion: 1, portfolioId };
  return { context, normalizedArgs: Object.freeze(normalizedArgs), selector: Object.freeze(selector) };
}

function florida(request: Data, value: unknown) {
  shape(request, [], ['q', 'fiscalYear', 'projectId', 'sessionKey', 'folderId', 'clientId', 'offset']);
  for (const key of ['q', 'fiscalYear', 'projectId', 'sessionKey', 'folderId', 'clientId']) {
    if (Object.hasOwn(request, key)) requireData(request[key] === null || typeof request[key] === 'string');
  }
  if (Object.hasOwn(request, 'offset')) requireData(request.offset === null || typeof request.offset === 'string' || typeof request.offset === 'number');
  const context = shape(value, ['asOf', 'effectiveScope', 'clientResolution']);
  requireData(typeof context.asOf === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(context.asOf));
  const instant = Date.parse(context.asOf);
  requireData(Number.isFinite(instant) && new Date(instant).toISOString() === context.asOf);
  const scope = shape(context.effectiveScope, ['jurisdiction', 'sessionKey', 'folderId', 'clientId']);
  requireData(scope.jurisdiction === 'FL' && typeof scope.sessionKey === 'string' && scope.sessionKey.length <= 256);
  requireData(scope.folderId === null || typeof scope.folderId === 'string');
  requireData(scope.clientId === null || typeof scope.clientId === 'string');
  requireData(request.folderId === null || request.folderId === undefined || (request.folderId as string).length <= 100);
  const input = {
    q: ((request.q ?? '') as string).slice(0, 200),
    fiscalYear: (request.fiscalYear ?? '2026-27') as string,
    projectId: (request.projectId ?? '') as string,
    offset: Math.max(0, Number(request.offset) || 0),
    sessionKey: (request.sessionKey ?? '') as string,
    folderId: (request.folderId || null) as string | null,
    clientId: (typeof request.clientId === 'string' ? request.clientId.trim().slice(0, 80) : '') || null,
  };
  requireData(/^20[0-9]{2}-[0-9]{2}$/.test(input.fiscalYear));
  integer(input.offset, 0, 10000);
  requireData(input.sessionKey.length <= 256);
  const clientSelector = input.clientId;
  if (clientSelector === null) requireData(context.clientResolution === null);
  else {
    const resolution = shape(context.clientResolution, ['selector', 'clientId']);
    requireData(resolution.selector === clientSelector); uuid(resolution.clientId);
    requireData(!UUID.test(clientSelector.trim()) || clientSelector.trim().toLowerCase() === resolution.clientId.toLowerCase());
    input.clientId = resolution.clientId;
  }
  requireData(scope.sessionKey === input.sessionKey && scope.folderId === input.folderId &&
    (input.clientId === null || scope.clientId === input.clientId) &&
    (input.folderId !== null || scope.clientId === input.clientId));
  // Native schema-valid names/IDs do not become canonical Core resource IDs.
  if (scope.clientId !== null && !CORE_UUID.test(scope.clientId as string)) throw unsupported();
  let selector: RetainedFloridaSelector;
  try { selector = parseCoreRetainedAuthorityProbeSelector({ schemaVersion: 1, sessionKey: input.sessionKey,
    folderId: input.folderId, clientSelector }); }
  catch { throw unsupported(); }
  return { context, normalizedArgs: Object.freeze(input), selector: Object.freeze(selector) };
}

/** Validates claimed fixed data only. No principal, grant, fence or source is
 * corroborated here. JCS is a trusted injected owner, never a local substitute. */
export function parseRetainedReadBody(
  operation: RetainedReadOperation,
  raw: unknown,
  options: { issuer: boolean },
  canonicalize: CoreRetainedReadCanonicalizer,
): ParsedRetainedReadBody {
  requireData(operation === 'get_research_portfolio' || operation === 'get_research_portfolio_changes' || operation === 'get_florida_budget_project');
  requireData(typeof options.issuer === 'boolean' && typeof canonicalize === 'function');
  const body = shape(snapshot(raw), options.issuer
    ? ['schemaVersion', 'request', 'context', 'originalExpiresAtMs'] : ['schemaVersion', 'request', 'context']);
  requireData(body.schemaVersion === 1);
  if (options.issuer) integer(body.originalExpiresAtMs, 1, Number.MAX_SAFE_INTEGER);
  const request = object(body.request);
  const selected = operation === 'get_florida_budget_project'
    ? florida(request, body.context) : portfolio(operation, request, body.context);
  function digest(value: unknown): string {
    let canonical: string;
    try {
      canonical = canonicalize(value);
      if (typeof canonical !== 'string' || !canonical || canonical.length > MAX_BYTES ||
          Buffer.byteLength(canonical, 'utf8') > MAX_BYTES || !validUnicode(canonical) ||
          !uniqueJsonKeys(canonical) || !jsonEquivalent(JSON.parse(canonical), value)) throw invalidProvider();
    } catch { throw invalidProvider(); }
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }
  const digests = Object.freeze({
    rawRequestSha256: digest(request),
    normalizedArgsSha256: digest(selected.normalizedArgs),
    normalizationContextSha256: digest(selected.context),
  });
  return Object.freeze({ request, context: selected.context, normalizedArgs: selected.normalizedArgs,
    digests, selector: selected.selector,
    ...(options.issuer ? { originalExpiresAtMs: body.originalExpiresAtMs as number } : {}),
  });
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Duplicate-key screen only; JSON.parse owns grammar. No ordering, numeric
 * canonicalization or replacement serialization is used for digest bytes. */
function uniqueJsonKeys(text: string): boolean {
  const stack: Array<{ keys: Set<string>; key: boolean } | null> = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      const start = index++;
      for (; index < text.length; index++) {
        if (text[index] === '\\') index++;
        else if (text[index] === '"') break;
      }
      const current = stack.at(-1);
      if (current?.key) {
        const name = JSON.parse(text.slice(start, index + 1));
        if (current.keys.has(name)) return false;
        current.keys.add(name); current.key = false;
        if (current.keys.size > 16) return false;
      }
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? { keys: new Set(), key: true } : null);
      if (stack.length > 8) return false;
    } else if (char === '}' || char === ']') {
      if (stack.length === 0) return false;
      stack.pop();
    } else if (char === ',') {
      const current = stack.at(-1);
      if (current) current.key = true;
    }
  }
  return stack.length === 0;
}

/** Inert JSON value equality ignores key order and prototype. It does not prove
 * RFC8785; the trusted provider still owns that required encoding. */
function jsonEquivalent(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => jsonEquivalent(value, right[index]));
  }
  const leftObject = left as Data, rightObject = right as Data;
  const keys = Object.keys(leftObject);
  return keys.length === Object.keys(rightObject).length && keys.every(key =>
    Object.hasOwn(rightObject, key) && jsonEquivalent(leftObject[key], rightObject[key]));
}
