import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { InternalServiceGuard } from '../../auth/internal-service.guard.js';
import { ConversationRetentionController } from './retention.controller.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const subject = { tenantId: id(1), conversationId: id(3) };
function fixture(supplied?: string, configured = true) {
  const tx = { $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async () => [{ now: new Date('2026-10-24T00:00:00Z') }]),
    clioConversation: { findFirst: jest.fn(async () => ({ id: id(3), tenantId: id(1), userId: id(2),
      clientId: null, status: 'active', metadataRevision: 0n, archivedAt: null, trashedAt: null, restoreUntil: null,
      bootstrapReceipt: { tenantId: id(1), actorUserId: id(2), requestId: id(4), conversationId: id(3), clientId: null, scopeKind: 'general' } })) } };
  const prisma = { withTenant: jest.fn(async (_tenant: string, work: (value: typeof tx) => unknown) => work(tx)) };
  const controller = new ConversationRetentionController(prisma as never);
  const request = { headers: { ...(supplied ? { 'x-internal-service-secret': supplied } : {}), authorization: 'Bearer synthetic-user' } } as unknown as Request;
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext;
  const guard = new InternalServiceGuard({ get: () => configured ? 'synthetic-service-only' : undefined } as never);
  return { controller, request, context, guard, prisma, tx };
}

test.each([undefined, 'wrong-secret'])('an interactive bearer or wrong service secret cannot read retention: %s', supplied => {
  const f = fixture(supplied);
  expect(() => f.guard.canActivate(f.context)).toThrow();
  expect(() => f.controller.read(subject, f.request)).toThrow('Verified service identity required');
  expect(() => f.controller.finalize(subject, f.request)).toThrow('Verified service identity required');
  expect(f.prisma.withTenant).not.toHaveBeenCalled();
});

test('actual internal guard admits the closed content-free reader, without an interactive member', async () => {
  const f = fixture('synthetic-service-only');
  expect(f.guard.canActivate(f.context)).toBe(true);
  await expect(f.controller.read(subject, f.request)).resolves.toMatchObject({ status: 'active',
    identity: { ownerActorId: id(2), scope: { kind: 'general', clientId: null } }, trashRequestId: null });
  await expect(f.controller.read({ ...subject, ownerActorId: id(9) } as never, f.request)).rejects.toThrow('Invalid retention subject');
  expect(f.prisma.withTenant).toHaveBeenCalledTimes(1);
});

test('missing configured service secret cannot enable the route', () => {
  const f = fixture('synthetic-service-only', false);
  expect(() => f.guard.canActivate(f.context)).toThrow('disabled');
  expect(f.prisma.withTenant).not.toHaveBeenCalled();
});
