import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { RolesGuard } from '../../auth/roles.guard.js';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { ConversationManagementController } from './controller.js';
import { MANAGEMENT_VERSION } from './contract.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(2), role: 'standard_user' } as TenantContext;
const query = { version: MANAGEMENT_VERSION, status: 'active', title: '', before: null };
function fixture(environment = 'production', supplied?: string) {
  const tx = { tenantMembership: { findFirst: jest.fn(async () => ({ id: id(9) })) }, clioConversation: { findMany: jest.fn(async () => []) } };
  const prisma = { withTenant: jest.fn(async (_tenant: string, work: (t: typeof tx) => unknown) => work(tx)) };
  const controller = new ConversationManagementController(prisma as never);
  const req = { tenantContext: ctx, headers: supplied ? { 'x-internal-service-secret': supplied } : {}, method: 'POST', path: '/api/clio/conversations/management/summaries' } as unknown as Request;
  const context = { getClass: () => ConversationManagementController, getHandler: () => controller.summaries,
    switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  const values: Record<string, unknown> = { NODE_ENV: environment, INTERNAL_SERVICE_SECRET: 'synthetic-service-only', MERI_TOOLS_REQUIRE_SERVICE_SECRET: false };
  const guard = new ToolServiceSecretGuard({ get: (k: string) => values[k] } as never);
  return { controller, prisma, req, context, guard };
}

test('both current user context and actual backend identity are required', async () => {
  const f = fixture('production', 'synthetic-service-only');
  expect(new RolesGuard(new Reflector()).canActivate(f.context)).toBe(true);
  expect(f.guard.canActivate(f.context)).toBe(true);
  await expect(f.controller.summaries(ctx, query, f.req)).resolves.toEqual({ version: MANAGEMENT_VERSION, conversations: [], nextBefore: null });
  delete (f.req as Request & { tenantContext?: TenantContext }).tenantContext;
  expect(() => new RolesGuard(new Reflector()).canActivate(f.context)).toThrow('No tenant context');
});
test.each([undefined, 'wrong-service'])('missing/wrong service refuses before metadata read: %s', supplied => {
  const f = fixture('production', supplied);
  expect(() => f.guard.canActivate(f.context)).toThrow('valid internal service identity');
  expect(() => f.controller.summaries(ctx, query, f.req)).toThrow('Verified service identity required');
  expect(() => f.controller.deletions(ctx, {}, f.req)).toThrow('Verified service identity required');
  expect(() => f.controller.deletion(ctx, {}, f.req)).toThrow('Verified service identity required');
  expect(f.prisma.withTenant).not.toHaveBeenCalled();
});
test('observe-mode guard does not become management authority', () => {
  const f = fixture('test'); expect(f.guard.canActivate(f.context)).toBe(true);
  expect(() => f.controller.apply(ctx, {}, f.req)).toThrow('Verified service identity required');
  expect(f.prisma.withTenant).not.toHaveBeenCalled();
});
test('metadata and command endpoints reject caller principal/scope injection', async () => {
  const f = fixture('production', 'synthetic-service-only'); f.guard.canActivate(f.context);
  expect(() => f.controller.metadata(ctx, { version: MANAGEMENT_VERSION, conversationId: id(3), actorId: id(8) }, f.req)).toThrow('Invalid chat metadata request');
  const command = { version: MANAGEMENT_VERSION, conversationId: id(3), requestId: id(4), expectedRevision: '0', operation: 'archive', tenantId: id(8) };
  await expect(f.controller.apply(ctx, command, f.req)).rejects.toThrow('Invalid chat change');
  await expect(f.controller.read(ctx, command, f.req)).rejects.toThrow('Invalid chat change');
  await expect(f.controller.deletions(ctx, { version: MANAGEMENT_VERSION, before: null, actorId: id(8) }, f.req)).rejects.toThrow('Invalid deletion read');
  await expect(f.controller.deletion(ctx, { version: MANAGEMENT_VERSION, requestId: id(4), actorId: id(8) }, f.req)).rejects.toThrow('Invalid deletion read');
  expect(f.prisma.withTenant).not.toHaveBeenCalled();
});
