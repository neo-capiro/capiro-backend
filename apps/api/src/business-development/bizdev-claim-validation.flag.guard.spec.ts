import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BusinessDevelopmentClaimValidationFlagGuard } from './bizdev-claim-validation.flag.guard.js';

describe('BusinessDevelopmentClaimValidationFlagGuard', () => {
  const tenantId = randomUUID();

  const makeGuard = (tenantRow: unknown, rejectWith?: Error) => {
    const tx = {
      tenant: {
        findUnique: jest.fn(async () => {
          if (rejectWith) throw rejectWith;
          return tenantRow;
        }),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as never;
    return new BusinessDevelopmentClaimValidationFlagGuard(prisma);
  };

  test('enabled flag passes', async () => {
    const guard = makeGuard({
      settings: { clioFeatureFlags: { 'businessDevelopment.claimValidation.enabled': true } },
    });
    await expect(guard.assertEnabledForTenant(tenantId)).resolves.toBe(true);
  });

  test.each([
    [
      'false',
      { settings: { clioFeatureFlags: { 'businessDevelopment.claimValidation.enabled': false } } },
    ],
    ['missing', { settings: { clioFeatureFlags: {} } }],
    ['null settings', { settings: null }],
    ['missing tenant', null],
  ])('%s flag state fails with the same safe 404', async (_label, row) => {
    await expect(makeGuard(row).assertEnabledForTenant(tenantId)).rejects.toThrow(
      NotFoundException,
    );
  });

  test('other business-development flags do not enable claim validation', async () => {
    const guard = makeGuard({
      settings: {
        clioFeatureFlags: {
          'businessDevelopment.enabled': true,
          'businessDevelopment.brief.enabled': true,
          'businessDevelopment.meriProspectTools.enabled': true,
        },
      },
    });
    await expect(guard.assertEnabledForTenant(tenantId)).rejects.toThrow(NotFoundException);
  });

  test('DB errors and missing context fail with the same safe 404', async () => {
    await expect(
      makeGuard(undefined, new Error('db down')).assertEnabledForTenant(tenantId),
    ).rejects.toThrow(NotFoundException);
    await expect(makeGuard({ settings: {} }).assertEnabledForTenant(undefined)).rejects.toThrow(
      NotFoundException,
    );
  });
});
