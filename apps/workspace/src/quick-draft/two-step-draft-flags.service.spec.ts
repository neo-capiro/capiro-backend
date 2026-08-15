import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { TwoStepDraftFlagsService } from './two-step-draft-flags.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function createMockPrisma(
  settings: Record<string, unknown> | null = null,
): PrismaService {
  return {
    $queryRaw: jest.fn().mockResolvedValue(
      settings
        ? [{ settings_jsonb: settings }] as never
        : [] as never,
    ) as never,
  } as unknown as PrismaService;
}

describe('TwoStepDraftFlagsService', () => {
  let prisma: PrismaService;
  let service: TwoStepDraftFlagsService;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new TwoStepDraftFlagsService(prisma);
  });

  it('returns false when the flag is absent (default off)', async () => {
    const mockPrisma = createMockPrisma({
      clioFeatureFlags: {},
    });
    const svc = new TwoStepDraftFlagsService(mockPrisma);
    expect(await svc.isTwoStepDraftEnabled('tenant-1')).toBe(false);
  });

  it('returns true when the flag is explicitly set to true', async () => {
    const mockPrisma = createMockPrisma({
      clioFeatureFlags: {
        'workspace.twoStepMaxDraftEnabled': true,
      },
    });
    const svc = new TwoStepDraftFlagsService(mockPrisma);
    expect(await svc.isTwoStepDraftEnabled('tenant-1')).toBe(true);
  });

  it('returns false when the flag is explicitly set to false', async () => {
    const mockPrisma = createMockPrisma({
      clioFeatureFlags: {
        'workspace.twoStepMaxDraftEnabled': false,
      },
    });
    const svc = new TwoStepDraftFlagsService(mockPrisma);
    expect(await svc.isTwoStepDraftEnabled('tenant-1')).toBe(false);
  });

  it('returns false when the tenant does not exist', async () => {
    const mockPrisma = createMockPrisma(null);
    const svc = new TwoStepDraftFlagsService(mockPrisma);
    expect(await svc.isTwoStepDraftEnabled('unknown-tenant')).toBe(false);
  });

  it('returns false on database read failure', async () => {
    const mockPrisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('DB error') as never) as never,
    } as unknown as PrismaService;
    const svc = new TwoStepDraftFlagsService(mockPrisma);
    expect(await svc.isTwoStepDraftEnabled('tenant-1')).toBe(false);
  });

  it('caches the result for 60 seconds', async () => {
    const mockPrisma = createMockPrisma({
      clioFeatureFlags: {
        'workspace.twoStepMaxDraftEnabled': true,
      },
    });
    const svc = new TwoStepDraftFlagsService(mockPrisma);
    await svc.isTwoStepDraftEnabled('tenant-1');
    await svc.isTwoStepDraftEnabled('tenant-1');
    expect((mockPrisma.$queryRaw as jest.Mock)).toHaveBeenCalledTimes(1);
  });
});
