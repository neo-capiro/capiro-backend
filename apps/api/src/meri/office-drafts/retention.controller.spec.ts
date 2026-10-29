import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { InternalServiceGuard } from '../../auth/internal-service.guard.js';
import { OfficeDraftRetentionController } from './retention.controller.js';

const input = { tenantId: randomUUID(), subject: { kind: 'artifact', id: randomUUID() } };
function fixture(secret?: string, configured = true) {
  const tx = { $queryRaw: jest.fn() };
  const prisma = { withSystem: jest.fn(async (work: (value: typeof tx) => unknown) => work(tx)) };
  const controller = new OfficeDraftRetentionController(prisma as never);
  const request = { headers: { authorization: 'Bearer synthetic-user',
    ...(secret ? { 'x-internal-service-secret': secret } : {}) } } as Request;
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext;
  const guard = new InternalServiceGuard({ get: () => configured ? 'synthetic-service-only' : undefined } as never);
  return { tx, prisma, controller, request, context, guard };
}
test.each([undefined, 'wrong-secret'])('interactive bearer cannot inspect or retire drafts: %s', secret => {
  const f = fixture(secret);
  expect(() => f.guard.canActivate(f.context)).toThrow();
  for (const operation of ['read', 'retire'] as const)
    expect(() => f.controller[operation](input, f.request)).toThrow('Verified service identity required');
  expect(f.prisma.withSystem).not.toHaveBeenCalled();
});
test('actual service identity admits counts-only read and retirement, not widened subjects', async () => {
  const f = fixture('synthetic-service-only');
  expect(f.guard.canActivate(f.context)).toBe(true);
  f.tx.$queryRaw.mockResolvedValueOnce([{ drafts: 1n, active: 1n, bytes: 9n }]);
  await expect(f.controller.read(input, f.request)).resolves.toEqual({ version: 'meri.office-draft-retention.v1',
    ...input, drafts: 1, active: 1, bytes: 9 });
  f.tx.$queryRaw.mockResolvedValueOnce([{ draft_id: randomUUID() }]).mockResolvedValueOnce([{ remaining: false }]);
  await expect(f.controller.retire(input, f.request)).resolves.toEqual({ version: 'meri.office-draft-retention.v1',
    ...input, retired: 1, remaining: false });
  await expect(f.controller.retire({ ...input, force: true }, f.request)).rejects.toThrow('INPUT');
  expect(f.prisma.withSystem).toHaveBeenCalledTimes(2);
  expect(() => f.controller.retire(input, { ...f.request } as Request)).toThrow('Verified service identity required');
});
test('missing service configuration keeps retirement disabled', () => {
  const f = fixture('synthetic-service-only', false);
  expect(() => f.guard.canActivate(f.context)).toThrow('disabled');
  expect(f.prisma.withSystem).not.toHaveBeenCalled();
});
