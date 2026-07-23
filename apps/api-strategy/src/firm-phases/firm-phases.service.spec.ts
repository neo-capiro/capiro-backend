import { describe, expect, it, jest } from '@jest/globals';
import { FirmPhasesService } from './firm-phases.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

// Ordering validation runs BEFORE any DB work, so a stub whose withTenantUser
// must never be called proves rejection short-circuits before the tx.
function stubPrisma() {
  const withTenantUser = jest.fn(async () => {
    throw new Error('withTenantUser must not run when validation fails');
  });
  return { prisma: { withTenantUser } as unknown as PrismaService, withTenantUser };
}

describe('FirmPhasesService.replace validation', () => {
  it('rejects a phase whose end is not after its start (no DB touch)', async () => {
    const { prisma, withTenantUser } = stubPrisma();
    const svc = new FirmPhasesService(prisma);
    await expect(
      svc.replace('t', 'u', {
        rows: [{ label: 'Bad', startFy: 2027, startQ: 3, endFy: 2027, endQ: 3 }],
      }),
    ).rejects.toThrow(/end after it starts/);
    expect(withTenantUser).not.toHaveBeenCalled();
  });

  it('rejects an end quarter before the start across FYs', async () => {
    const { prisma, withTenantUser } = stubPrisma();
    const svc = new FirmPhasesService(prisma);
    await expect(
      svc.replace('t', 'u', {
        rows: [{ label: 'Backwards', startFy: 2028, startQ: 1, endFy: 2027, endQ: 4 }],
      }),
    ).rejects.toThrow();
    expect(withTenantUser).not.toHaveBeenCalled();
  });
});
