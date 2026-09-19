import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { defer, lastValueFrom, of } from 'rxjs';
import {
  generationReleaseHoldEnforced,
  generationReleaseModeForTenant,
} from './execution-assurance.js';
import { ExecutionAssuranceTenantInterceptor } from './execution-assurance-tenant.interceptor.js';

class AgentsController {}
class OtherController {}

function executionContext(tenantId: string | null, controller: Function): ExecutionContext {
  return {
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => ({
        tenantContext: tenantId
          ? { tenantId, clerkUserId: 'user_test', role: 'org:member' }
          : undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('ExecutionAssuranceTenantInterceptor', () => {
  const interceptor = new ExecutionAssuranceTenantInterceptor();

  it('carries the authenticated tenant through asynchronous handler work', async () => {
    // generationReleaseHoldEnforced is now advisory-only (always false), but the
    // tenant-aware mode resolver still flows through the request context.
    const next: CallHandler = {
      handle: () =>
        defer(async () => {
          await Promise.resolve();
          return {
            mode: generationReleaseModeForTenant(
              'tenant-a',
              'strategy',
              'enforce',
              'tenant-a',
              'strategy',
            ),
            held: generationReleaseHoldEnforced('enforce', 'tenant-a', 'strategy'),
          };
        }),
    };

    await expect(
      lastValueFrom(interceptor.intercept(executionContext('tenant-a', AgentsController), next)),
    ).resolves.toEqual({ mode: 'enforce', held: false });

    // A direct non-request caller still resolves mode off for an unselected tenant.
    expect(generationReleaseModeForTenant('tenant-b', 'strategy', 'enforce', 'tenant-a', 'strategy'))
      .toBe('off');
  });

  it('does not let another tenant inherit the selected canary', async () => {
    const next: CallHandler = {
      handle: () =>
        defer(async () => {
          await Promise.resolve();
          return {
            mode: generationReleaseModeForTenant(
              'tenant-b',
              'strategy',
              'enforce',
              'tenant-a',
              'strategy',
            ),
            held: generationReleaseHoldEnforced('enforce', 'tenant-a', 'strategy'),
          };
        }),
    };

    await expect(
      lastValueFrom(interceptor.intercept(executionContext('tenant-b', AgentsController), next)),
    ).resolves.toEqual({ mode: 'off', held: false });
  });

  it('is inert outside AgentsController or without authenticated tenant context', async () => {
    const next: CallHandler = { handle: () => of('unchanged') };
    await expect(
      lastValueFrom(interceptor.intercept(executionContext('tenant-a', OtherController), next)),
    ).resolves.toBe('unchanged');
    await expect(
      lastValueFrom(interceptor.intercept(executionContext(null, AgentsController), next)),
    ).resolves.toBe('unchanged');
  });
});
