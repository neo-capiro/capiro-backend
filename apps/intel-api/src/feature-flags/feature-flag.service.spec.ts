import { describe, expect, jest, test } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import {
  BILL_360_FEATURE,
  DEFENSE_FUNDING_INTEL_FEATURE,
  DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE,
  DISTRICT_NEXUS_STRATEGIC_FEATURE,
  FeatureFlagService,
  HEARING_WATCH_FEATURE,
} from './feature-flag.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const TENANT = 'external-tenant-1';
const INTERNAL = 'internal-tenant-1';

function prismaMock(opts: { findUnique?: unknown; findMany?: unknown[] }) {
  const findUnique = jest.fn().mockResolvedValue(opts.findUnique ?? null);
  const findMany = jest.fn().mockResolvedValue(opts.findMany ?? []);
  const withTenant = jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({ featureFlag: { findUnique, findMany } }),
  );
  return {
    prisma: { withTenant } as unknown as PrismaService,
    withTenant,
    findUnique,
    findMany,
  };
}

function configMock(internalTenantId?: string): ConfigService {
  return { get: () => internalTenantId } as unknown as ConfigService;
}

describe('FeatureFlagService.isEnabled', () => {
  test('internal missing row → true (gap-filling default)', async () => {
    const { prisma } = prismaMock({ findUnique: null });
    const svc = new FeatureFlagService(prisma, configMock(INTERNAL));
    await expect(
      svc.isEnabled(DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE, INTERNAL),
    ).resolves.toBe(true);
  });

  test('internal enabled row (explicit) → true', async () => {
    const { prisma } = prismaMock({ findUnique: { enabled: true } });
    const svc = new FeatureFlagService(prisma, configMock(INTERNAL));
    await expect(
      svc.isEnabled(DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE, INTERNAL),
    ).resolves.toBe(true);
  });

  test('internal explicit disabled row → false (the fixed defect)', async () => {
    // Before the fix, isEnabled() short-circuited true before ever reading
    // this row — an explicit off-switch for the internal tenant had zero
    // effect. The row must now be read first and its value is authoritative.
    const { prisma, withTenant } = prismaMock({ findUnique: { enabled: false } });
    const svc = new FeatureFlagService(prisma, configMock(INTERNAL));
    await expect(
      svc.isEnabled(DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE, INTERNAL),
    ).resolves.toBe(false);
    expect(withTenant).toHaveBeenCalledWith(INTERNAL, expect.any(Function));
  });

  test('external missing row → false (no fallback for non-internal tenants)', async () => {
    const { prisma } = prismaMock({ findUnique: null });
    const svc = new FeatureFlagService(prisma, configMock(INTERNAL));
    await expect(svc.isEnabled(DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE, TENANT)).resolves.toBe(
      false,
    );
  });

  test('external enabled row → true', async () => {
    const { prisma } = prismaMock({ findUnique: { enabled: true } });
    const svc = new FeatureFlagService(prisma, configMock(INTERNAL));
    await expect(svc.isEnabled(DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE, TENANT)).resolves.toBe(
      true,
    );
  });

  test('reads under withTenant scoped to the caller tenantId', async () => {
    const { prisma, withTenant } = prismaMock({ findUnique: null });
    const svc = new FeatureFlagService(prisma, configMock());
    await svc.isEnabled(HEARING_WATCH_FEATURE, TENANT);
    expect(withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });

  test('no configured internal tenant id → external default is false on missing row', async () => {
    const { prisma } = prismaMock({ findUnique: null });
    const svc = new FeatureFlagService(prisma, configMock(undefined));
    await expect(svc.isEnabled(HEARING_WATCH_FEATURE, TENANT)).resolves.toBe(false);
  });
});

describe('FeatureFlagService.enabledFor', () => {
  test('internal missing rows → all canary features default true', async () => {
    const { prisma } = prismaMock({ findMany: [] });
    const svc = new FeatureFlagService(prisma, configMock(INTERNAL));
    const out = await svc.enabledFor(INTERNAL);
    expect(out[HEARING_WATCH_FEATURE]).toBe(true);
    expect(out[BILL_360_FEATURE]).toBe(true);
    expect(out[DEFENSE_FUNDING_INTEL_FEATURE]).toBe(true);
    expect(out[DISTRICT_NEXUS_STRATEGIC_FEATURE]).toBe(true);
    expect(out[DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE]).toBe(true);
  });

  test('internal explicit disabled row for one canary feature → only that feature is off', async () => {
    // The exact release defect this fix closes: an explicit enabled:false
    // row for capiro-internal must independently turn off ONE canary feature
    // without affecting the others.
    const { prisma } = prismaMock({
      findMany: [{ feature: DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE, enabled: false }],
    });
    const svc = new FeatureFlagService(prisma, configMock(INTERNAL));
    const out = await svc.enabledFor(INTERNAL);
    expect(out[DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE]).toBeUndefined();
    expect(out[HEARING_WATCH_FEATURE]).toBe(true);
    expect(out[BILL_360_FEATURE]).toBe(true);
    expect(out[DEFENSE_FUNDING_INTEL_FEATURE]).toBe(true);
    expect(out[DISTRICT_NEXUS_STRATEGIC_FEATURE]).toBe(true);
  });

  test('internal explicit enabled row for a canary feature → still true, no double-count surprises', async () => {
    const { prisma } = prismaMock({
      findMany: [{ feature: DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE, enabled: true }],
    });
    const svc = new FeatureFlagService(prisma, configMock(INTERNAL));
    const out = await svc.enabledFor(INTERNAL);
    expect(out[DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE]).toBe(true);
  });

  test('external tenant only sees its own enabled rows, no canary defaults', async () => {
    const { prisma } = prismaMock({ findMany: [{ feature: 'tracker_v2', enabled: true }] });
    const svc = new FeatureFlagService(prisma, configMock(INTERNAL));
    const out = await svc.enabledFor(TENANT);
    expect(out).toEqual({ tracker_v2: true });
    expect(out[DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE]).toBeUndefined();
  });

  test('external tenant with a disabled row for a non-canary feature sees it absent, not present', async () => {
    const { prisma } = prismaMock({ findMany: [{ feature: 'tracker_v2', enabled: false }] });
    const svc = new FeatureFlagService(prisma, configMock(INTERNAL));
    const out = await svc.enabledFor(TENANT);
    expect(out.tracker_v2).toBeUndefined();
  });

  test('reads under withTenant scoped to the caller tenantId, fetching all rows not just enabled ones', async () => {
    const { prisma, withTenant, findMany } = prismaMock({ findMany: [] });
    const svc = new FeatureFlagService(prisma, configMock());
    await svc.enabledFor(TENANT);
    expect(withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(findMany).toHaveBeenCalledWith({ where: { tenantId: TENANT } });
  });
});
