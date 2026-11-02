import { readTargetContext, type TargetContextQueryDto } from './client-target-context.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TenantContext } from '@capiro/shared';

const id = '30000000-0000-4000-8000-000000000001';
it.each([
  null,
  {},
  { section: 'all' },
  { section: ['steps'] },
  { section: 'steps', after: 'bad' },
  { section: 'steps', after: null },
  { section: 'steps', tenantId: id },
  { section: 'steps', limit: 1000 },
])('refuses unsupported context selections before database access: %j', async (query) => {
  const withTenantUser = jest.fn();
  await expect(
    readTargetContext(
      { withTenantUser } as unknown as PrismaService,
      {} as TenantContext,
      id,
      id,
      query as TargetContextQueryDto,
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(withTenantUser).not.toHaveBeenCalled();
});
it('refuses malformed target identities before database access', async () => {
  const withTenantUser = jest.fn();
  await expect(
    readTargetContext(
      { withTenantUser } as unknown as PrismaService,
      {} as TenantContext,
      id,
      '../target',
      { section: 'steps' },
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(withTenantUser).not.toHaveBeenCalled();
});
