import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { EventEmitter } from 'node:events';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { MeriMemoryHelperController } from './meri-memory-helper.controller.js';
import * as source from './meri-passive-memory-source.js';

const secret = 'synthetic-memory-route-secret';
const ctx = { tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222' } as TenantContext;
const prisma = { withTenantUser: jest.fn() };
const controller = new MeriMemoryHelperController(prisma as never);
function request(authorization = 'Bearer synthetic-user-session', deadline = Date.now() + 10_000) {
  return Object.assign(new EventEmitter(), { method: 'POST', url: '/api/clio/tools/search_memory_eligibility',
    headers: { authorization, 'x-internal-service-secret': secret, 'x-meri-deadline-at': String(deadline) },
  }) as unknown as Request;
}
function authenticateService(req: Request) {
  const guard = new ToolServiceSecretGuard(new ConfigService({ NODE_ENV: 'staging',
    MERI_TOOLS_REQUIRE_SERVICE_SECRET: true, INTERNAL_SERVICE_SECRET: secret }) as never);
  return guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as ExecutionContext);
}
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

describe('ordinary passive memory helper composition', () => {
  it('passes the original authenticated actor and body directly to canonical eligibility', async () => {
    const req = request(); authenticateService(req);
    const body = { syntheticContext: 'exact original request' };
    const result = { records: [], checkedAtMs: 1, expiresAtMs: 2 };
    const check = jest.spyOn(source, 'checkPassiveMemoryEligibility').mockResolvedValue(result as never);
    expect(await controller.eligibility(ctx, body, req)).toBe(result);
    expect(check).toHaveBeenCalledWith(prisma, ctx, body);
    expect(req.listenerCount('aborted')).toBe(0);
  });

  it('refuses missing service proof and removed signed-token credentials before eligibility', () => {
    const check = jest.spyOn(source, 'checkPassiveMemoryEligibility');
    expect(() => controller.eligibility(ctx, {}, request())).toThrow(ForbiddenException);
    for (const credential of ['', 'CapiroMeriRead old.token', 'Bearer with spaces']) {
      const req = request(credential); authenticateService(req);
      expect(() => controller.eligibility(ctx, {}, req)).toThrow(ForbiddenException);
    }
    expect(check).not.toHaveBeenCalled();
  });

  it('does not start an expired request and withholds content after caller cancellation', async () => {
    const expired = request(undefined, Date.now() - 1); authenticateService(expired);
    const check = jest.spyOn(source, 'checkPassiveMemoryEligibility').mockResolvedValue({ records: [] } as never);
    await expect(controller.eligibility(ctx, {}, expired)).rejects.toThrow();
    expect(check).not.toHaveBeenCalled();
    const req = request(); authenticateService(req);
    check.mockImplementationOnce(async () => { req.emit('aborted'); return { records: [] } as never; });
    await expect(controller.eligibility(ctx, {}, req)).rejects.toThrow();
    expect(check).toHaveBeenCalledTimes(1);
    expect(req.listenerCount('aborted')).toBe(0);
  });

  it('preserves canonical owner refusals without minting a callback token', async () => {
    const req = request(); authenticateService(req);
    const failure = new ForbiddenException('Current memory access revoked');
    jest.spyOn(source, 'checkPassiveMemoryEligibility').mockRejectedValue(failure);
    await expect(controller.eligibility(ctx, {}, req)).rejects.toBe(failure);
    expect(prisma.withTenantUser).not.toHaveBeenCalled();
  });
});
