import { types as nodeTypes } from 'node:util';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { isUuid } from '../auth/read-delegation/read-delegation.contract.js';

const refused = () => new ForbiddenException('Retained read context refused');

export interface RetainedReadContext {
  binding: {
    tenantId: string; actorId: string; conversationId: string; runId: string;
    attemptId: string; workerId: string; writerFence: number;
  };
  subject: {
    kind: 'client' | 'personal'; entityType: 'client' | 'user'; entityIds: string[];
    tenantId: string; actorId: string; policyRevision: string;
    scopes: Array<{ tenantId: string; kind: string; resourceId: string; policyRevision: string }>;
    rosterVersionId: null;
  };
  policyRevision: string;
  normalizationContext: Record<string, unknown> | null;
}

export function retainedReadObject(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || nodeTypes.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw refused();
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key) ||
      !Object.getOwnPropertyDescriptor(raw, key)?.enumerable ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key)!, 'value'))) throw refused();
  return raw as Record<string, unknown>;
}

export function retainedReadSnapshot<T>(raw: T, maxBytes: number): T {
  try {
    const json = canonicalizeCoreRetainedJson(raw);
    if (Buffer.byteLength(json, 'utf8') > maxBytes) throw refused();
    return JSON.parse(json) as T;
  } catch { throw refused(); }
}

/** Correlation is bounded request data. Only the ordinary authenticated user
 * and verified service identity admit this path; no run field grants access. */
export function readRetainedReadHeader(req: Pick<Request, 'headers'>): unknown {
  const authorization = req.headers.authorization;
  const header = req.headers['x-meri-read-correlation'];
  if (typeof authorization !== 'string' || !/^Bearer \S+$/i.test(authorization) ||
      typeof header !== 'string' || header.length > 10_923 || !/^[A-Za-z0-9_-]+$/.test(header)) throw refused();
  const bytes = Buffer.from(header, 'base64url');
  const json = bytes.toString('utf8');
  if (bytes.length > 8192 || bytes.toString('base64url') !== header ||
      !Buffer.from(json, 'utf8').equals(bytes)) throw refused();
  try {
    const value: unknown = JSON.parse(json);
    if (canonicalizeCoreRetainedJson(value) !== json) throw refused();
    return value;
  } catch { throw refused(); }
}

export function readRetainedReadDeadline(req: Pick<Request, 'headers'>, nowMs = Date.now()): number {
  const raw = req.headers['x-meri-deadline-at'];
  const deadline = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(deadline) || deadline <= nowMs) throw refused();
  return deadline;
}

export function parseRetainedReadContext(ctx: Pick<TenantContext, 'tenantId' | 'userId'>,
  raw: unknown, verifiedServiceIdentity: boolean): RetainedReadContext {
  if (verifiedServiceIdentity !== true || !isUuid(ctx.tenantId) || !isUuid(ctx.userId)) throw refused();
  const value = retainedReadSnapshot(raw, 8192);
  const context = retainedReadObject(value, ['binding', 'subject', 'policyRevision', 'normalizationContext']);
  const binding = retainedReadObject(context.binding,
    ['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence']);
  const subject = retainedReadObject(context.subject,
    ['kind', 'entityType', 'entityIds', 'tenantId', 'actorId', 'policyRevision', 'scopes', 'rosterVersionId']);
  if (binding.tenantId !== ctx.tenantId || binding.actorId !== ctx.userId ||
      ![binding.conversationId, binding.runId, binding.attemptId, binding.workerId].every(isUuid) ||
      !Number.isSafeInteger(binding.writerFence) || Number(binding.writerFence) < 1 ||
      subject.tenantId !== ctx.tenantId || subject.actorId !== ctx.userId ||
      typeof context.policyRevision !== 'string' || !context.policyRevision.length || context.policyRevision.length > 128 ||
      subject.policyRevision !== context.policyRevision || subject.rosterVersionId !== null ||
      !Array.isArray(subject.entityIds) || subject.entityIds.length !== 1 || !isUuid(subject.entityIds[0]) ||
      !Array.isArray(subject.scopes) || !subject.scopes.length || subject.scopes.length > 4096) throw refused();
  const client = subject.kind === 'client';
  if (client ? subject.entityType !== 'client' : subject.kind !== 'personal' ||
      subject.entityType !== 'user' || subject.entityIds[0] !== ctx.userId) throw refused();
  let selected = false;
  for (const item of subject.scopes) {
    const scope = retainedReadObject(item, ['tenantId', 'kind', 'resourceId', 'policyRevision']);
    if (scope.tenantId !== ctx.tenantId || scope.policyRevision !== context.policyRevision ||
        typeof scope.kind !== 'string' || !scope.kind.length || scope.kind.length > 128 ||
        typeof scope.resourceId !== 'string' || !scope.resourceId.length || scope.resourceId.length > 256 ||
        scope.kind === 'client' && (!client || scope.resourceId !== subject.entityIds[0]) ||
        scope.kind === 'private-user' && scope.resourceId !== ctx.userId) throw refused();
    if (scope.kind === (client ? 'client' : 'private-user') && scope.resourceId === subject.entityIds[0]) selected = true;
  }
  if (!selected || context.normalizationContext !== null &&
      (!context.normalizationContext || typeof context.normalizationContext !== 'object' ||
      Array.isArray(context.normalizationContext))) throw refused();
  return value as RetainedReadContext;
}

/** Selectors constrain the request; the domain reader still checks current
 * client walls, mailbox ownership and every returned resource. */
export function assertRetainedReadSelectors(input: unknown, context: RetainedReadContext,
  explicitClientId?: string): void {
  const clients = new Set(['clientId', 'client_id', 'clientIds', 'client_ids', 'clientRef', 'client', 'selectedClientId']);
  const conversations = new Set(['conversationId', 'conversation_id']);
  const selectedClientId = context.subject.kind === 'client' ? context.subject.entityIds[0] : null;
  if (explicitClientId !== undefined && (!isUuid(explicitClientId) ||
      selectedClientId !== null && selectedClientId !== explicitClientId)) throw refused();
  const clientId = explicitClientId ?? selectedClientId;
  let count = 0;
  const walk = (value: unknown, depth: number): void => {
    if (++count > 4096 || depth > 12) throw refused();
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
    for (const [key, part] of Object.entries(value)) {
      if (clients.has(key)) {
        if (Array.isArray(part)) {
          if (!part.length || part.some(item => item !== clientId)) throw refused();
        } else if (part !== clientId) throw refused();
      } else if (conversations.has(key)) {
        if (part !== context.binding.conversationId) throw refused();
      } else walk(part, depth + 1);
    }
  };
  walk(input, 0);
}
