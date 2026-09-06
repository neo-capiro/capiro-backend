import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { FundingOpportunityClientAccessGuard } from './funding-opportunity-client-access.guard.js';

function setup(
  granted = false,
  flags = ['funding_opportunities', 'funding_opportunities_forecasts'],
) {
  const tx = {
    client: {
      findMany: jest.fn(async () => [
        { id: 'walled', memoryWall: true },
        { id: 'public', memoryWall: false },
      ]),
    },
    clientMemoryAccess: {
      findMany: jest.fn(async () => (granted ? [{ clientId: 'walled' }] : [])),
    },
    $queryRaw: jest.fn(async (_q: TemplateStringsArray, flag: string) =>
      flags.includes(flag) ? [{ ok: 1 }] : [],
    ),
  };
  const prisma: any = {
    withTenant: jest.fn(async (_tenant, run) => run(tx)),
    withSystem: jest.fn(async (run) => run(tx)),
  };
  const request = (input: object) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          tenantContext: { tenantId: 'tenant', userId: 'actor' },
          params: {},
          query: {},
          body: {},
          ...input,
        }),
      }),
    }) as ExecutionContext;
  return {
    guard: new FundingOpportunityClientAccessGuard(prisma),
    request,
    tx,
  };
}

describe('Funding Opportunities route client wall', () => {
  test.each([
    { params: { clientId: 'walled', source: 'grants_gov' } },
    { query: { clientId: 'walled' } },
    { body: { clientId: 'walled' } },
  ])('denies a walled client in every route input: %p', async (input) => {
    const { guard, request } = setup();
    await expect(guard.canActivate(request(input))).rejects.toThrow(NotFoundException);
  });
  test('an explicit grant allows the client-scoped route', async () => {
    const { guard, request } = setup(true);
    await expect(
      guard.canActivate(request({ params: { clientId: 'walled', source: 'sam_gov' } })),
    ).resolves.toBe(true);
  });
  test('unscoped Browse needs no client', async () => {
    const { guard, request, tx } = setup();
    await expect(
      guard.canActivate(request({ params: { source: 'agency_forecast' } })),
    ).resolves.toBe(true);
    expect(tx.client.findMany).not.toHaveBeenCalled();
  });
  test('the action-plan route cannot bypass a disabled source', async () => {
    const { guard, request } = setup(false, ['funding_opportunities']);
    await expect(
      guard.canActivate(
        request({
          params: { source: 'agency_forecast' },
          query: { clientId: 'public' },
        }),
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
