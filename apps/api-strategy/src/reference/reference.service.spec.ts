import { describe, expect, it, jest } from '@jest/globals';
import { ReferenceService } from './reference.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

// fork() validates + parses per-kind BEFORE any DB work; a stub whose
// withTenantUser must never run proves the reject short-circuits.
function stubPrisma() {
  const withTenantUser = jest.fn(async () => {
    throw new Error('withTenantUser must not run when validation fails');
  });
  return { prisma: { withTenantUser } as unknown as PrismaService, withTenantUser };
}

describe('ReferenceService.fork validation', () => {
  it('rejects a congress milestone missing its dates', async () => {
    const { prisma, withTenantUser } = stubPrisma();
    const svc = new ReferenceService(prisma);
    await expect(
      svc.fork('t', 'u', 'congress', { rows: [{ label: 'CR deadline' }] }),
    ).rejects.toThrow(/start and end/);
    expect(withTenantUser).not.toHaveBeenCalled();
  });

  it('rejects a congress milestone whose end precedes its start', async () => {
    const { prisma } = stubPrisma();
    const svc = new ReferenceService(prisma);
    await expect(
      svc.fork('t', 'u', 'congress', {
        rows: [{ label: 'Backwards', startsOn: '2027-06-01', endsOn: '2027-05-01' }],
      }),
    ).rejects.toThrow(/end after it starts/);
  });

  it('rejects a zero-length congress milestone (equal start/end)', async () => {
    const { prisma } = stubPrisma();
    const svc = new ReferenceService(prisma);
    await expect(
      svc.fork('t', 'u', 'congress', {
        rows: [{ label: 'Point', startsOn: '2027-06-01', endsOn: '2027-06-01' }],
      }),
    ).rejects.toThrow(/end after it starts/);
  });

  it('rejects a calendar-impossible congress date', async () => {
    const { prisma } = stubPrisma();
    const svc = new ReferenceService(prisma);
    await expect(
      svc.fork('t', 'u', 'congress', {
        rows: [{ label: 'Bad', startsOn: '2027-02-30', endsOn: '2027-03-30' }],
      }),
    ).rejects.toThrow();
  });

  it('rejects a PPBE row missing its fiscal year', async () => {
    const { prisma, withTenantUser } = stubPrisma();
    const svc = new ReferenceService(prisma);
    await expect(
      svc.fork('t', 'u', 'ppbe', { rows: [{ label: 'Budget review' }] }),
    ).rejects.toThrow(/fiscal year/);
    expect(withTenantUser).not.toHaveBeenCalled();
  });
});
