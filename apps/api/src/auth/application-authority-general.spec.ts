import { ForbiddenException } from '@nestjs/common';
import {
  parseApplicationAuthorityCurrentBody, parseApplicationAuthorityContextBody,
  readApplicationAuthorityCurrent, readApplicationAuthorityContext,
  type ApplicationAuthorityConversation, type ApplicationAuthorityIdentityProof,
} from './application-authority.js';

// Synthetic authority fixtures; no database or live identity is contacted.
const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const conversationId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const identity = (): ApplicationAuthorityIdentityProof => ({
  principal: { tenantId, actorId }, identityRevision: '1'.repeat(64),
  expiresAtMs: Date.now() + 30_000, recheckCurrent: async () => identity(),
});
const row = (): ApplicationAuthorityConversation => ({
  id: conversationId, tenantId, userId: actorId, clientId: null, status: 'active', archivedAt: null,
  bootstrapReceipt: { tenantId, actorUserId: actorId, conversationId, scopeKind: 'general', clientId: null },
});
function fixture(conversation = row()) {
  const clientVisible = jest.fn(async (_id: string) => { throw new Error('General must not read a selected client'); });
  const clientAuthority = jest.fn(async (_id: string) => { throw new Error('General must not read a selected client'); });
  const ports = {
    identity: async () => identity(),
    membership: async () => ({ role: 'standard_user' as const, permissions: ['read'],
      clientIds: [clientId], membershipRevision: '2'.repeat(64) }),
    conversation: async () => conversation, conversationScope: async () => null,
    clientVisible, clientAuthority,
  };
  return { ports, clientVisible, clientAuthority, conversation };
}
const input = { conversationId, clientId: null };

test('both current/context admit only the explicit General binding without client reads', async () => {
  const f = fixture();
  expect(parseApplicationAuthorityCurrentBody(input)).toEqual(input);
  const current = await readApplicationAuthorityCurrent(input, f.ports);
  expect(current).toMatchObject({ conversationId, selectedClientId: null, clientIds: [clientId] });
  const contextInput = { ...input, identitySha256: '3'.repeat(64) };
  expect(parseApplicationAuthorityContextBody(contextInput)).toEqual(contextInput);
  expect(await readApplicationAuthorityContext(contextInput, f.ports)).toMatchObject({
    conversationId, selectedClientId: null, identitySha256: contextInput.identitySha256,
  });
  expect(f.clientVisible).not.toHaveBeenCalled();
  expect(f.clientAuthority).not.toHaveBeenCalled();
});

test.each(['legacy-null', 'client-binding', 'foreign-actor', 'foreign-tenant', 'wrong-conversation', 'deleted-client', 'archived'])
('General refuses %s without widening to owner or tenant scope', async (variant) => {
  const conversation = row();
  if (variant === 'legacy-null') delete conversation.bootstrapReceipt;
  if (variant === 'client-binding') conversation.bootstrapReceipt!.scopeKind = 'client';
  if (variant === 'foreign-actor') conversation.bootstrapReceipt!.actorUserId = clientId;
  if (variant === 'foreign-tenant') conversation.bootstrapReceipt!.tenantId = clientId;
  if (variant === 'wrong-conversation') conversation.bootstrapReceipt!.conversationId = clientId;
  if (variant === 'deleted-client') {
    conversation.bootstrapReceipt!.scopeKind = 'client'; conversation.bootstrapReceipt!.clientId = clientId;
  }
  if (variant === 'archived') conversation.archivedAt = new Date();
  const f = fixture(conversation);
  await expect(readApplicationAuthorityCurrent(input, f.ports)).rejects.toBeInstanceOf(ForbiddenException);
  await expect(readApplicationAuthorityContext({ ...input, identitySha256: '3'.repeat(64) }, f.ports))
    .rejects.toBeInstanceOf(ForbiddenException);
});

test('context rechecks the General binding after its identity await', async () => {
  const f = fixture(); let reads = 0;
  f.ports.identity = async () => {
    if (++reads === 2) f.conversation.bootstrapReceipt!.scopeKind = 'client';
    return identity();
  };
  await expect(readApplicationAuthorityContext({ ...input, identitySha256: '3'.repeat(64) }, f.ports))
    .rejects.toBeInstanceOf(ForbiddenException);
});
