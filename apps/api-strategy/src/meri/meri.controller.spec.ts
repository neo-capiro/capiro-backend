import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { MeriController } from './meri.controller.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import type { DraftStrategyDto } from './dto/meri.dto.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const CTX = { tenantId: 'tenant-1', clerkUserId: 'user-1' } as AuthTenantContext;

function req(authorization?: string): Request {
  return { headers: authorization ? { authorization } : {} } as unknown as Request;
}

function controller(overrides: { submit?: jest.Mock; get?: jest.Mock } = {}) {
  const submit = overrides.submit ?? jest.fn();
  const get = overrides.get ?? jest.fn();
  const c = new MeriController({} as never, { submit, get } as never, {} as never);
  return { c, submit, get };
}

describe('MeriController draft-from-goal (strategy generation timeout fix)', () => {
  it('POST strategies/draft enqueues a job instead of calling the orchestrator inline', async () => {
    const submit = jest.fn<() => Promise<{ jobId: string; status: string }>>();
    submit.mockResolvedValue({ jobId: 'job-1', status: 'queued' });
    const { c } = controller({ submit });
    const dto = { clientId: CLIENT, type: 'appropriations' } as DraftStrategyDto;

    const result = await c.draftAsync(CTX, req('Bearer abc.def.ghi'), dto);

    expect(result).toEqual({ jobId: 'job-1', status: 'queued' });
    expect(submit).toHaveBeenCalledWith(CTX, 'abc.def.ghi', dto);
  });

  it('POST strategies/draft is declared 202 Accepted, not the default 201/200', () => {
    // @HttpCode stores its status on Nest's own metadata key — asserting THIS
    // (rather than re-deriving the value another way) is what actually pins
    // "the endpoint returns 202", since draftAsync's return value alone
    // doesn't carry a status code.
    const HTTP_CODE_KEY = '__httpCode__';
    const status = Reflect.getMetadata(HTTP_CODE_KEY, MeriController.prototype.draftAsync);
    expect(status).toBe(202);
  });

  it('submits without a bearer when the request carries no Authorization header', async () => {
    const submit = jest.fn<() => Promise<{ jobId: string; status: string }>>();
    submit.mockResolvedValue({ jobId: 'job-1', status: 'queued' });
    const { c } = controller({ submit });
    const dto = { clientId: CLIENT, type: 'appropriations' } as DraftStrategyDto;

    await c.draftAsync(CTX, req(), dto);

    expect(submit).toHaveBeenCalledWith(CTX, undefined, dto);
  });

  it('GET strategies/draft-jobs/:jobId delegates to DraftJobService.get with the tenant context', async () => {
    const get = jest.fn<() => Promise<Record<string, unknown>>>();
    get.mockResolvedValue({ jobId: 'job-1', status: 'completed', strategyId: 'strategy-1' });
    const { c } = controller({ get });

    const result = await c.draftJob(CTX, 'job-1');

    expect(result).toEqual({ jobId: 'job-1', status: 'completed', strategyId: 'strategy-1' });
    expect(get).toHaveBeenCalledWith(CTX, 'job-1');
  });

  it('GET strategies/draft-jobs/:jobId 404s a job from another tenant (never distinguished from unknown)', async () => {
    // DraftJobService.get() tenant-scopes its lookup and throws NotFoundException
    // for a cross-tenant id (see draft-job.service.spec.ts for that isolation
    // proof) — this asserts the controller is a plain pass-through: it neither
    // catches nor reinterprets that failure, so the same 404 reaches the client.
    const get = jest.fn<() => Promise<Record<string, unknown>>>();
    get.mockRejectedValue(new NotFoundException('Draft job not found'));
    const { c } = controller({ get });

    await expect(c.draftJob(CTX, 'someone-elses-job')).rejects.toBeInstanceOf(NotFoundException);
  });
});
