import { CapabilityAuthorizationService } from './capability-authorization.service.js';
import type { AuthorizedCapabilityContext } from './capability-context.js';
import { CapabilityError } from './capability-errors.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const actorUserId = '00000000-0000-4000-8000-000000000002';
const clientId = '00000000-0000-4000-8000-000000000003';
const otherClientId = '00000000-0000-4000-8000-000000000004';

function context(overrides: Partial<AuthorizedCapabilityContext> = {}): AuthorizedCapabilityContext {
  return {
    actorUserId,
    tenantId,
    role: 'standard_user',
    requestId: 'request-1',
    surface: 'outreach',
    clientScope: null,
    ...overrides,
  };
}

function prismaFor(tx: Record<string, unknown>) {
  return {
    withTenantUser: jest.fn(
      async (
        _tenantId: string,
        _userId: string,
        run: (transaction: Record<string, unknown>) => Promise<unknown>,
      ) => run(tx),
    ),
  };
}

describe('CapabilityAuthorizationService', () => {
  it('rejects a requested client that differs from the server-established scope before DB access', async () => {
    const prisma = prismaFor({});
    const service = new CapabilityAuthorizationService(prisma as never);

    await expect(
      service.authorizeClient(
        context({ clientScope: { clientId, reason: 'campaign' } }),
        otherClientId,
      ),
    ).rejects.toMatchObject<Partial<CapabilityError>>({
      code: 'CAPABILITY_INVALID_SCOPE',
      scopeChanged: true,
    });
    expect(prisma.withTenantUser).not.toHaveBeenCalled();
  });

  it('returns not found for an inaccessible or absent tenant client', async () => {
    const tx = {
      client: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRawUnsafe: jest.fn(),
    };
    const service = new CapabilityAuthorizationService(prismaFor(tx) as never);

    await expect(service.authorizeClient(context(), clientId)).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_FOUND',
    });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('fails closed when the client ethical wall does not grant the actor', async () => {
    const tx = {
      client: {
        findFirst: jest.fn().mockResolvedValue({
          id: clientId,
          name: 'Walled client',
          website: null,
          description: null,
          sectorTag: null,
          status: 'active',
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: false }]),
    };
    const service = new CapabilityAuthorizationService(prismaFor(tx) as never);

    await expect(service.authorizeClient(context(), clientId)).rejects.toMatchObject({
      code: 'CAPABILITY_ETHICAL_WALL',
    });
  });

  it('returns the bounded client summary when tenant and wall checks pass', async () => {
    const client = {
      id: clientId,
      name: 'Allowed client',
      website: 'https://example.test',
      description: 'Description',
      sectorTag: 'defense',
      status: 'active',
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    const tx = {
      client: { findFirst: jest.fn().mockResolvedValue(client) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    };
    const prisma = prismaFor(tx);
    const service = new CapabilityAuthorizationService(prisma as never);

    await expect(service.authorizeClient(context(), clientId)).resolves.toEqual(client);
    expect(prisma.withTenantUser).toHaveBeenCalledTimes(1);
  });

  it('reuses the same checks inside an existing transaction without nesting another tenant transaction', async () => {
    const client = {
      id: clientId,
      name: 'Allowed in transaction',
      website: null,
      description: null,
      sectorTag: null,
      status: 'active',
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    const tx = {
      client: { findFirst: jest.fn().mockResolvedValue(client) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    };
    const prisma = prismaFor(tx);
    const service = new CapabilityAuthorizationService(prisma as never);

    await expect(
      service.authorizeClientWithinTx(tx as never, context(), clientId),
    ).resolves.toEqual(client);
    expect(prisma.withTenantUser).not.toHaveBeenCalled();
    expect(tx.client.findFirst).toHaveBeenCalledWith({
      where: { id: clientId, tenantId },
      select: {
        id: true,
        name: true,
        website: true,
        description: true,
        sectorTag: true,
        status: true,
        updatedAt: true,
      },
    });
  });

  it('applies the ethical-wall denial identically inside an existing transaction', async () => {
    const tx = {
      client: {
        findFirst: jest.fn().mockResolvedValue({
          id: clientId,
          name: 'Walled client',
          website: null,
          description: null,
          sectorTag: null,
          status: 'active',
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: false }]),
    };
    const prisma = prismaFor(tx);
    const service = new CapabilityAuthorizationService(prisma as never);

    await expect(
      service.authorizeClientWithinTx(tx as never, context(), clientId),
    ).rejects.toMatchObject({ code: 'CAPABILITY_ETHICAL_WALL' });
    expect(prisma.withTenantUser).not.toHaveBeenCalled();
  });
});
