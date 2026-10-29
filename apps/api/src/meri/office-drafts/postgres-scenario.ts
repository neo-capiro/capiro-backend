import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { openDraft, lockDraft } from './store.js';
import { admitOfficeEditor } from './editor.js';
import { digest } from './input.js';
import type { OfficeAuthority } from './authority.js';

export async function officeDraftFixture(db: PrismaClient, scoped: PrismaService, existingTenantId?: string,
  artifactId: string = randomUUID(), existingClientId?: string) {
  const tenantId = existingTenantId ?? randomUUID(), userId = randomUUID(), clientId = existingClientId ?? randomUUID(), conversationId = randomUUID();
  if (!existingTenantId) await db.tenant.create({ data: { id: tenantId, slug: 'office-' + tenantId, name: 'Office test', status: 'active' } });
  await db.user.create({ data: { id: userId, clerkUserId: 'office-' + userId, email: userId + '@example.invalid' } });
  const member = await db.tenantMembership.create({ data: { tenantId, userId, role: 'standard_user', status: 'active' } });
  if (!existingClientId) await db.client.create({ data: { id: clientId, tenantId, name: 'Office test', memoryWall: true } });
  await db.clientMemoryAccess.create({ data: { tenantId, userId, clientId } });
  await db.clioConversation.create({ data: { id: conversationId, tenantId, userId, clientId, title: 'Office test' } });
  await db.clioConversationBootstrapReceipt.create({ data: { tenantId, actorUserId: userId, requestId: randomUUID(),
    conversationId, scopeKind: 'client', clientId } });
  const ctx = { tenantId, tenantSlug: 'office-' + tenantId, userId, clerkUserId: 'office-' + userId, role: 'standard_user' } as TenantContext;
  const authority = { readCurrent: jest.fn(async () => ({ principal: { tenantId, actorId: userId }, expiresAtMs: Date.now() + 600000 })) } as unknown as OfficeAuthority;
  const ports = { prisma: scoped, ctx, authority }, key = { conversationId, draftId: randomUUID() };
  const source = { ...key, artifactId, baseVersionId: randomUUID(), baseSha256: 'a'.repeat(64), format: 'docx', filename: 'draft.docx' };
  const opened = await openDraft(ports, source);
  const editor = { editorId: randomUUID(), editorEpoch: 1 };
  await admitOfficeEditor(ports, { ...key, operation: 'acquire', editorId: editor.editorId, expectedEpoch: 0 });
  const lock = (operation = 'lock', token = 'writer-1') => lockDraft(ports, { ...key, ...editor, operation, ...(operation === 'get' ? {} : { lock: token }) });
  const save = (text: string, expectedSequence = 0) => {
    const bytes = Buffer.from(text); return { ...key, ...editor, lock: 'writer-1', expectedSequence,
      sha256: digest(bytes), bytesBase64: bytes.toString('base64'), kind: 'explicit' };
  };
  return { ports, key, source, opened, member, clientId, editor, lock, save };
}
