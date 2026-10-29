import { PrismaService } from '../src/prisma/prisma.service.js';
import { main } from './diag-engagement-campaigns.js';

jest.mock('../src/prisma/prisma.service.js', () => ({ PrismaService: jest.fn() }));

const originalArgv = process.argv;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeEach(() => {
  process.argv = ['node', 'diag-engagement-campaigns.ts'];
  process.env.DATABASE_URL = 'synthetic-unused-by-mocked-database';
});

afterEach(() => {
  process.argv = originalArgv;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

function fixture(campaigns: unknown[] = []) {
  const tx = {
    engagementCampaign: { groupBy: jest.fn(async () => campaigns) },
    engagementCampaignRecipient: {
      groupBy: jest.fn(async () => [{ tenantId: 'tenant-a', _count: { _all: 3 } }]),
    },
    tenant: { findMany: jest.fn(async () => [{ id: 'tenant-a', slug: 'synthetic-a' }]) },
  };
  // An unscoped ordinary role sees no rows after tenant RLS is enabled.
  const bare = jest.fn(async () => []);
  const prisma = {
    engagementCampaign: { groupBy: bare },
    engagementCampaignRecipient: { groupBy: bare },
    tenant: { findMany: bare },
    withSystem: jest.fn(async (read: (client: typeof tx) => unknown) => read(tx)),
    $disconnect: jest.fn(async () => {}),
  };
  jest.mocked(PrismaService).mockImplementation(() => prisma as never);
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  return { tx, prisma, bare, log };
}

it('reports all tenant aggregates through the explicit read-only system owner', async () => {
  const f = fixture([
    {
      tenantId: 'tenant-a',
      status: 'draft',
      _count: { _all: 2 },
      _max: { updatedAt: new Date('2026-10-27T00:00:00Z') },
    },
    { tenantId: 'tenant-b', status: 'complete', _count: { _all: 1 }, _max: { updatedAt: null } },
  ]);
  await main();
  expect(f.prisma.withSystem).toHaveBeenCalledTimes(1);
  expect(f.prisma.withSystem).toHaveBeenCalledWith(expect.any(Function), { readOnly: true });
  expect(f.bare).not.toHaveBeenCalled();
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining('campaigns=2 (draft=2)'));
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining('recipients=3'));
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining('campaigns=1 (complete=1)'));
  expect(f.log).not.toHaveBeenCalledWith(expect.stringContaining('surface is unused'));
  expect(f.prisma.$disconnect).toHaveBeenCalledTimes(1);
});

it('reports unused only after a successful system-scoped empty read', async () => {
  const f = fixture();
  await main();
  expect(f.prisma.withSystem).toHaveBeenCalledTimes(1);
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining('surface is unused'));
  expect(f.prisma.$disconnect).toHaveBeenCalledTimes(1);
});

it('propagates scope/read failure instead of reporting unused and still disconnects', async () => {
  const f = fixture();
  f.tx.engagementCampaign.groupBy.mockRejectedValueOnce(new Error('synthetic read refusal'));
  await expect(main()).rejects.toThrow('synthetic read refusal');
  expect(f.log).not.toHaveBeenCalled();
  expect(f.prisma.$disconnect).toHaveBeenCalledTimes(1);
});
