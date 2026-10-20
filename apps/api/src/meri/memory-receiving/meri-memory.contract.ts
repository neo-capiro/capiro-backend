import { types as nodeTypes } from 'node:util';
import { BadRequestException } from '@nestjs/common';

/**
 * Closed parsers for Meri's memory receiving contract at meri-greenfield
 * 497479c7: `apps/control/memory/candidate.mjs` (meri.memory-candidate.v1),
 * `core-review.mjs` (submit/status) and `core-memory.mjs` (read_target,
 * find_by_key). Every object is closed and every key required.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SOURCE_KINDS = ['conversation_message', 'artifact_version', 'document', 'web_page', 'memory'] as const;
export const MERI_MEMORY_SCOPES = ['personal', 'client', 'firm'] as const;
export type MeriMemoryScope = (typeof MERI_MEMORY_SCOPES)[number];

export interface MeriMemoryCandidate {
  schema: 'meri.memory-candidate.v1';
  candidateId: string;
  tenantId: string;
  proposerActorId: string;
  kind: 'addition' | 'correction';
  scope: MeriMemoryScope;
  clientId: string | null;
  content: string;
  key: string | null;
  ttlDays: number | null;
  corrects: { memoryId: string; memorySha256: string } | null;
  reason: string | null;
  sources: Array<{ kind: string; reference: string; sha256: string | null; title: string | null }>;
  origin: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: string;
}

const invalid = (field: string) => new BadRequestException(`Invalid memory receiving input: ${field}`);

function closed(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) throw invalid(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid(field);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) throw invalid(field);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw invalid(field);
  return value;
}

function nullableText(value: unknown, field: string, min: number, max: number): string | null {
  return value === null ? null : text(value, field, min, max);
}

function trimmedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > max) throw invalid(field);
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(field);
  return value;
}

function parseOrigin(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'surface') {
    closed(value, ['kind'], 'origin');
    return { kind: 'surface' };
  }
  const v = closed(value, ['kind', 'conversationId', 'runId', 'commandId', 'commandSha256'], 'origin');
  if (v.kind !== 'conversation') throw invalid('origin.kind');
  if (typeof v.commandSha256 !== 'string' || !HEX64.test(v.commandSha256)) throw invalid('origin.commandSha256');
  return {
    kind: 'conversation', conversationId: uuid(v.conversationId, 'origin.conversationId'),
    runId: uuid(v.runId, 'origin.runId'), commandId: uuid(v.commandId, 'origin.commandId'), commandSha256: v.commandSha256,
  };
}

export function parseMeriMemoryCandidate(value: unknown): MeriMemoryCandidate {
  const v = closed(value, ['schema', 'candidateId', 'tenantId', 'proposerActorId', 'kind', 'scope', 'clientId', 'content',
    'key', 'ttlDays', 'corrects', 'reason', 'sources', 'origin', 'idempotencyKey', 'createdAt'], 'candidate');
  if (v.schema !== 'meri.memory-candidate.v1') throw invalid('candidate.schema');
  if (v.kind !== 'addition' && v.kind !== 'correction') throw invalid('candidate.kind');
  if (!MERI_MEMORY_SCOPES.includes(v.scope as MeriMemoryScope)) throw invalid('candidate.scope');
  const clientId = v.scope === 'client' ? uuid(v.clientId, 'candidate.clientId') : v.clientId === null ? null : (() => { throw invalid('candidate.clientId'); })();
  const content = text(v.content, 'candidate.content', 1, 4000);
  if (content.trim() !== content) throw invalid('candidate.content');
  if (v.ttlDays !== null && (!Number.isSafeInteger(v.ttlDays) || (v.ttlDays as number) < 1 || (v.ttlDays as number) > 365)) {
    throw invalid('candidate.ttlDays');
  }
  let corrects: MeriMemoryCandidate['corrects'] = null;
  if (v.kind === 'correction') {
    const c = closed(v.corrects, ['memoryId', 'memorySha256'], 'candidate.corrects');
    if (typeof c.memorySha256 !== 'string' || !HEX64.test(c.memorySha256)) throw invalid('candidate.corrects.memorySha256');
    corrects = { memoryId: text(c.memoryId, 'candidate.corrects.memoryId', 1, 128), memorySha256: c.memorySha256 };
  } else if (v.corrects !== null) {
    throw invalid('candidate.corrects');
  }
  const reason = nullableText(v.reason, 'candidate.reason', 1, 1000);
  if (v.kind === 'addition' && reason !== null) throw invalid('candidate.reason');
  if (!Array.isArray(v.sources) || v.sources.length > 16) throw invalid('candidate.sources');
  const sources = v.sources.map((item, index) => {
    const s = closed(item, ['kind', 'reference', 'sha256', 'title'], `candidate.sources[${index}]`);
    if (!SOURCE_KINDS.includes(s.kind as (typeof SOURCE_KINDS)[number])) throw invalid(`candidate.sources[${index}].kind`);
    if (s.sha256 !== null && (typeof s.sha256 !== 'string' || !HEX64.test(s.sha256))) throw invalid(`candidate.sources[${index}].sha256`);
    // Meri `wire.mjs` sourceRef: trimmed reference <= 512 (https for web_page), trimmed title <= 200.
    const reference = trimmedText(s.reference, `candidate.sources[${index}].reference`, 512);
    if (s.kind === 'web_page') {
      let url: URL;
      try { url = new URL(reference); } catch { throw invalid(`candidate.sources[${index}].reference`); }
      if (url.protocol !== 'https:' || url.username || url.password) throw invalid(`candidate.sources[${index}].reference`);
    }
    const title = s.title === null ? null : trimmedText(s.title, `candidate.sources[${index}].title`, 200);
    return { kind: s.kind as string, reference, sha256: s.sha256 as string | null, title };
  });
  if (typeof v.createdAt !== 'string' || !ISO_MS.test(v.createdAt) || new Date(v.createdAt).toISOString() !== v.createdAt) {
    throw invalid('candidate.createdAt');
  }
  return {
    schema: 'meri.memory-candidate.v1', candidateId: uuid(v.candidateId, 'candidate.candidateId'),
    tenantId: text(v.tenantId, 'candidate.tenantId', 1, 128), proposerActorId: text(v.proposerActorId, 'candidate.proposerActorId', 1, 128),
    kind: v.kind, scope: v.scope as MeriMemoryScope, clientId, content,
    key: nullableText(v.key, 'candidate.key', 1, 120), ttlDays: v.ttlDays as number | null, corrects, reason, sources,
    origin: parseOrigin(v.origin), idempotencyKey: text(v.idempotencyKey, 'candidate.idempotencyKey', 1, 128), createdAt: v.createdAt,
  };
}

export function parseSubmitRequest(value: unknown): { candidate: unknown; candidateSha256: string } {
  const v = closed(value, ['candidate', 'candidateSha256'], 'body');
  if (typeof v.candidateSha256 !== 'string' || !HEX64.test(v.candidateSha256)) throw invalid('candidateSha256');
  return { candidate: v.candidate, candidateSha256: v.candidateSha256 };
}

export function parseStatusRequest(value: unknown): Array<{ candidateId: string; candidateSha256: string }> {
  const v = closed(value, ['candidates'], 'body');
  if (!Array.isArray(v.candidates) || v.candidates.length < 1 || v.candidates.length > 50) throw invalid('candidates');
  const pairs = v.candidates.map((item, index) => {
    const pair = closed(item, ['candidateId', 'candidateSha256'], `candidates[${index}]`);
    if (typeof pair.candidateSha256 !== 'string' || !HEX64.test(pair.candidateSha256)) throw invalid(`candidates[${index}].candidateSha256`);
    return { candidateId: uuid(pair.candidateId, `candidates[${index}].candidateId`), candidateSha256: pair.candidateSha256 };
  });
  if (new Set(pairs.map((pair) => pair.candidateId)).size !== pairs.length) throw invalid('candidates');
  return pairs;
}

export function parseReadTargetRequest(value: unknown): { memoryId: string } {
  const v = closed(value, ['memoryId'], 'body');
  return { memoryId: text(v.memoryId, 'memoryId', 1, 128) };
}

export function parseFindByKeyRequest(value: unknown): { scope: MeriMemoryScope; clientId: string | null; key: string } {
  const v = closed(value, ['scope', 'clientId', 'key'], 'body');
  if (!MERI_MEMORY_SCOPES.includes(v.scope as MeriMemoryScope)) throw invalid('scope');
  const clientId = v.scope === 'client' ? uuid(v.clientId, 'clientId') : v.clientId === null ? null : (() => { throw invalid('clientId'); })();
  return { scope: v.scope as MeriMemoryScope, clientId, key: text(v.key, 'key', 1, 120) };
}
