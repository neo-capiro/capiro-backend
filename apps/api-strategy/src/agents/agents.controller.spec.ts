import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AgentsController } from './agents.controller.js';
import { ApproveChangeSetDto, ReviewRunDto, UpdateMissionDto } from './dto/agents.dto.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';

const tenant = { tenantId: 'tenant-1', clerkUserId: 'user-1' } as AuthTenantContext;

describe('AgentsController runtime boundary', () => {
  it('rejects null for optional fields that cannot be cleared', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    for (const body of [{ name: null }, { state: null }]) {
      await expect(pipe.transform(body, { type: 'body', metatype: UpdateMissionDto }))
        .rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(pipe.transform({ opIndexes: null }, { type: 'body', metatype: ApproveChangeSetDto }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ cadence: null, nextRunAt: null }, { type: 'body', metatype: UpdateMissionDto }))
      .resolves.toEqual({ cadence: null, nextRunAt: null });
  });

  it('rejects caller-authored findings and internal lifecycle states at HTTP validation', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    for (const body of [
      { to: 'approved' },
      { to: 'executing' },
      { to: 'completed', findings: { approval: null, tasks: [] } },
    ]) {
      await expect(pipe.transform(body, { type: 'body', metatype: ReviewRunDto }))
        .rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(pipe.transform({ to: 'completed' }, { type: 'body', metatype: ReviewRunDto }))
      .resolves.toEqual({ to: 'completed' });
  });

  it('uses the firm-review policy for public acknowledgments and plans execution retries', async () => {
    const transition = jest.fn();
    const retry = jest.fn();
    const controller = new AgentsController(
      {} as never, { transition } as never, {} as never, {} as never,
      {} as never, { retry } as never, {} as never,
    );
    controller.transitionRun(tenant, 'run-1', { to: 'completed' });
    expect(transition).toHaveBeenCalledWith('tenant-1', 'user-1', 'run-1', { to: 'completed' }, { reviewOnly: true });
    controller.retryRun(tenant, 'run-1');
    expect(retry).toHaveBeenCalledWith('tenant-1', 'user-1', 'run-1');
  });
});
