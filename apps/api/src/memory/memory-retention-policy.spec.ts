import { readMemoryRetentionPolicy } from './memory-retention-policy.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TenantContext } from '@capiro/shared';
const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000001',
  clerkUserId: 'synthetic-user',
  role: 'standard_user',
} as TenantContext;

it('returns unavailable when the installed policy is absent instead of defaulting to assumed durations', async () => {
  const query = jest
    .fn()
    .mockResolvedValueOnce([{ role: 'standard_user' }])
    .mockResolvedValueOnce([{ ready: false }]);
  const prisma = {
    withTenantUser: (_tenant: string, _user: string, work: (tx: unknown) => unknown) =>
      work({ $queryRaw: query }),
  } as unknown as PrismaService;
  await expect(readMemoryRetentionPolicy(prisma, ctx)).rejects.toMatchObject({ status: 503 });
  expect(query).toHaveBeenCalledTimes(2);
});
