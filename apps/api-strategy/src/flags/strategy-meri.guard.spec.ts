import { describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { StrategyMeriGuard } from './strategy-meri.guard.js';
import type { StrategyFlagsService } from './strategy-flags.service.js';

function ctxWith(tenantId?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        tenantContext: tenantId ? { tenantId } : undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

function stubFlags(enabled: boolean) {
  const isMeriEnabled = jest.fn(async () => enabled);
  return { flags: { isMeriEnabled } as unknown as StrategyFlagsService, isMeriEnabled };
}

describe('StrategyMeriGuard', () => {
  it('rejects with 403 when there is no tenant context (never reaches the flag read)', async () => {
    const { flags, isMeriEnabled } = stubFlags(true);
    const guard = new StrategyMeriGuard(flags);
    await expect(guard.canActivate(ctxWith(undefined))).rejects.toThrow(ForbiddenException);
    expect(isMeriEnabled).not.toHaveBeenCalled();
  });

  it('rejects with 403 when isMeriEnabled resolves false (fail-closed)', async () => {
    const { flags, isMeriEnabled } = stubFlags(false);
    const guard = new StrategyMeriGuard(flags);
    await expect(guard.canActivate(ctxWith('tenant-1'))).rejects.toThrow(ForbiddenException);
    expect(isMeriEnabled).toHaveBeenCalledWith('tenant-1');
  });

  it('allows when isMeriEnabled resolves true', async () => {
    const { flags } = stubFlags(true);
    const guard = new StrategyMeriGuard(flags);
    await expect(guard.canActivate(ctxWith('tenant-1'))).resolves.toBe(true);
  });

  it('propagates (does not swallow) a rejection from the flag service', async () => {
    const isMeriEnabled = jest.fn(async () => {
      throw new Error('boom');
    });
    const guard = new StrategyMeriGuard({ isMeriEnabled } as unknown as StrategyFlagsService);
    // The service itself is documented fail-closed; the guard must not mask an
    // unexpected throw as an open gate — it should propagate, not resolve true.
    await expect(guard.canActivate(ctxWith('tenant-1'))).rejects.toThrow('boom');
  });
});
