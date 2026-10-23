import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const MANAGEMENT_VERSION = 'meri.conversation-management.v1' as const;
export const TRASH_MS = 30 * 24 * 60 * 60 * 1000;
export type ManagementRequest = {
  version: typeof MANAGEMENT_VERSION; requestId: string; conversationId: string;
  expectedRevision: string;
} & ({ operation: 'rename'; title: string } | { operation: 'archive' | 'restore' | 'trash' });
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export function parseManagementRequest(raw: unknown): ManagementRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Invalid chat change');
  const r = raw as Record<string, unknown>;
  const keys = ['version', 'requestId', 'conversationId', 'expectedRevision', 'operation', ...(r.operation === 'rename' ? ['title'] : [])];
  if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k)) ||
      r.version !== MANAGEMENT_VERSION || typeof r.requestId !== 'string' || !uuid.test(r.requestId) ||
      typeof r.conversationId !== 'string' || !uuid.test(r.conversationId) ||
      typeof r.expectedRevision !== 'string' || !/^(0|[1-9][0-9]{0,17})$/.test(r.expectedRevision) ||
      !['rename', 'archive', 'restore', 'trash'].includes(String(r.operation)) ||
      (r.operation === 'rename' && (typeof r.title !== 'string' || r.title !== r.title.trim() || !r.title || r.title.length > 200)))
    throw new BadRequestException('Invalid chat change');
  return r as ManagementRequest;
}
export function managementDigest(r: ManagementRequest) {
  return createHash('sha256').update(JSON.stringify([r.version, r.requestId, r.conversationId,
    r.expectedRevision, r.operation, r.operation === 'rename' ? r.title : null])).digest('hex');
}
export type ConversationMetadata = {
  conversationId: string; title: string; status: 'active' | 'archived' | 'trashed'; revision: string;
  scopeKind: 'client' | 'general'; clientId: string | null;
  updatedAt: string; archivedAt: string | null; trashedAt: string | null; restoreUntil: string | null;
};
export type ManagementReceipt = { version: typeof MANAGEMENT_VERSION; requestId: string; conversation: ConversationMetadata };
export type ListRequest = { version: typeof MANAGEMENT_VERSION; status: ConversationMetadata['status']; title: string;
  before: { updatedAt: string; conversationId: string } | null };
export function parseListRequest(raw: unknown): ListRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Invalid chat list');
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).sort().join() !== 'before,status,title,version' || r.version !== MANAGEMENT_VERSION ||
      !['active', 'archived', 'trashed'].includes(String(r.status)) || typeof r.title !== 'string' || r.title.length > 200 || r.title !== r.title.trim())
    throw new BadRequestException('Invalid chat list');
  if (r.before !== null) {
    const b = r.before as Record<string, unknown>;
    if (!b || Object.keys(b).sort().join() !== 'conversationId,updatedAt' || typeof b.conversationId !== 'string' ||
        !uuid.test(b.conversationId) || typeof b.updatedAt !== 'string' || !Number.isFinite(Date.parse(b.updatedAt)) ||
        new Date(b.updatedAt).toISOString() !== b.updatedAt) throw new BadRequestException('Invalid chat cursor');
  }
  return r as ListRequest;
}
