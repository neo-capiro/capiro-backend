import { effectiveClientSlots } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { CLIENT_PROFILE_PREFLIGHT_KEY } from './client-record-action.contract.js';
import {
  clientProfilePreflightVerdict,
  readClientProfilePreflight,
  readCreateClientPreflight,
} from './client-profile-proposal.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

/** The two read-only queries the precheck is allowed to make, and nothing else. */
function prismaStub(
  opts: {
    existing?: boolean;
    tenant?: { billingStatus: string; clientSlots: number } | null;
    used?: number;
    throws?: Error;
  } = {},
) {
  const findFirst = jest.fn().mockResolvedValue(opts.existing ? { id: 'client-existing' } : null);
  const findUnique = jest
    .fn()
    .mockResolvedValue(
      opts.tenant === undefined ? { billingStatus: 'active', clientSlots: 10 } : opts.tenant,
    );
  const count = jest.fn().mockResolvedValue(opts.used ?? 0);
  const withTenant = jest.fn(
    async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => {
      if (opts.throws) throw opts.throws;
      return fn({ client: { findFirst, count }, tenant: { findUnique } });
    },
  );
  return {
    prisma: { withTenant } as unknown as PrismaService,
    withTenant,
    findFirst,
    findUnique,
    count,
  };
}

const createInput = (extra: Record<string, unknown> = {}) => ({
  name: 'New client',
  skipLdaCheck: true,
  ...extra,
});

describe('client profile preflight', () => {
  it('maps read-only facts to a bounded verdict that carries no identity', () => {
    expect(
      clientProfilePreflightVerdict({
        existingClientNamed: false,
        capacity: { state: 'limited', limit: 10, used: 3 },
      }),
    ).toEqual({ duplicate: 'clear', capacity: 'allowed' });
    expect(
      clientProfilePreflightVerdict({
        existingClientNamed: true,
        capacity: { state: 'limited', limit: 10, used: 10 },
      }),
    ).toEqual({ duplicate: 'possible', capacity: 'denied' });
    expect(
      clientProfilePreflightVerdict({
        existingClientNamed: null,
        capacity: { state: 'unavailable' },
      }),
    ).toEqual({ duplicate: 'unknown', capacity: 'unknown' });
    // Two enums: there is no field a hidden client's id or name could travel in.
    expect(
      JSON.stringify(
        clientProfilePreflightVerdict({
          existingClientNamed: true,
          capacity: { state: 'limited', limit: 10, used: 10 },
        }),
      ),
    ).toBe('{"duplicate":"possible","capacity":"denied"}');
  });

  it('reads a stored verdict and refuses to invent one for an absent or malformed record', () => {
    expect(
      readClientProfilePreflight({
        [CLIENT_PROFILE_PREFLIGHT_KEY]: { duplicate: 'clear', capacity: 'denied' },
      }),
    ).toEqual({ duplicate: 'clear', capacity: 'denied' });
    for (const preview of [
      undefined,
      {},
      { [CLIENT_PROFILE_PREFLIGHT_KEY]: { duplicate: 'maybe' } },
      { [CLIENT_PROFILE_PREFLIGHT_KEY]: 'clear' },
      { [CLIENT_PROFILE_PREFLIGHT_KEY]: { duplicate: 'clear', capacity: 'allowed', extra: 1 } },
    ])
      expect(readClientProfilePreflight(preview)).toBeNull();
  });

  it('reads the create precheck in a read-only transaction', async () => {
    const stub = prismaStub({ used: 3 });
    await expect(
      readCreateClientPreflight(stub.prisma, TENANT, 'create_client', createInput(), true),
    ).resolves.toEqual({ duplicate: 'clear', capacity: 'allowed' });
    expect(stub.withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function), { readOnly: true });
    expect(stub.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: TENANT,
          name: { equals: 'New client', mode: 'insensitive' },
          status: { not: 'archived' },
        },
      }),
    );
    expect(stub.count).toHaveBeenCalledWith({
      where: { tenantId: TENANT, status: { not: 'archived' } },
    });
  });

  it('applies the canonical slot allowance and the dormant/comped exemption', async () => {
    // The trialing floor is the canonical allowance, so 5 used against 2 purchased is allowed.
    expect(effectiveClientSlots('trialing', 2)).toBeGreaterThan(2);
    const trialing = prismaStub({ tenant: { billingStatus: 'trialing', clientSlots: 2 }, used: 5 });
    await expect(
      readCreateClientPreflight(trialing.prisma, TENANT, 'create_client', createInput(), true),
    ).resolves.toEqual({ duplicate: 'clear', capacity: 'allowed' });

    const comped = prismaStub({ tenant: { billingStatus: 'comped', clientSlots: 0 }, used: 99 });
    await expect(
      readCreateClientPreflight(comped.prisma, TENANT, 'create_client', createInput(), true),
    ).resolves.toEqual({ duplicate: 'clear', capacity: 'allowed' });
    expect(comped.count).not.toHaveBeenCalled();

    const dormant = prismaStub({ used: 99 });
    await expect(
      readCreateClientPreflight(dormant.prisma, TENANT, 'create_client', createInput(), false),
    ).resolves.toEqual({ duplicate: 'clear', capacity: 'allowed' });
    expect(dormant.count).not.toHaveBeenCalled();

    const full = prismaStub({ used: 10 });
    await expect(
      readCreateClientPreflight(full.prisma, TENANT, 'create_client', createInput(), true),
    ).resolves.toEqual({ duplicate: 'clear', capacity: 'denied' });
  });

  it('reports a possible duplicate and an unreadable state without turning either into a clear preflight', async () => {
    const existing = prismaStub({ existing: true });
    await expect(
      readCreateClientPreflight(existing.prisma, TENANT, 'create_client', createInput(), true),
    ).resolves.toEqual({ duplicate: 'possible', capacity: 'allowed' });

    const noTenant = prismaStub({ tenant: null });
    await expect(
      readCreateClientPreflight(noTenant.prisma, TENANT, 'create_client', createInput(), true),
    ).resolves.toEqual({ duplicate: 'clear', capacity: 'unknown' });

    const broken = prismaStub({ throws: new Error('billing read unavailable') });
    await expect(
      readCreateClientPreflight(broken.prisma, TENANT, 'create_client', createInput(), true),
    ).resolves.toEqual({ duplicate: 'unknown', capacity: 'unknown' });
  });

  it('answers only for create_client and only for an input the canonical schema accepts', async () => {
    const stub = prismaStub();
    await expect(
      readCreateClientPreflight(stub.prisma, TENANT, 'update_client_profile', createInput(), true),
    ).resolves.toBeNull();
    await expect(
      readCreateClientPreflight(stub.prisma, TENANT, 'create_client', { name: '' }, true),
    ).resolves.toBeNull();
    await expect(
      readCreateClientPreflight(
        stub.prisma,
        TENANT,
        'create_client',
        { name: 'New client', nope: 1 },
        true,
      ),
    ).resolves.toBeNull();
    expect(stub.withTenant).not.toHaveBeenCalled();
  });
});
