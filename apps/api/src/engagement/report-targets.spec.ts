import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { DirectoryService } from '../directory/directory.service.js';
import {
  archiveReportTarget, clearReportTargetOverride, createReportTarget, linkReportTarget,
  updateReportTarget, upsertReportTargetOverride,
} from './report-targets.js';

const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as TenantContext;
const directory = {
  getMemberContextById: jest.fn(async (id: string) => id === 'missing' ? null : ({
    id: 'member-123', fullName: 'Avery Member', officeLocation: '123 Rayburn HOB',
    committees: ['Armed Services'], staff: [{ fullName: 'Alex Staffer' }],
  })),
} as unknown as DirectoryService;

// A storage harness exercises complete mutations and their round trips; the SQL
// migration rehearsal separately covers real uniqueness and trigger behavior.
function harness() {
  const targets = new Map<string, any>();
  const overrides = new Map<string, any>();
  let nextId = 0;
  const uniqueTarget = (where: any) => {
    if (where.id) return targets.get(where.id) ?? null;
    const key = where.tenantId_scopeKey_officeKey;
    return [...targets.values()].find((item) => item.tenantId === key.tenantId && item.scopeKey === key.scopeKey && item.officeKey === key.officeKey) ?? null;
  };
  const withOverrides = (target: any, include: any) => target && include?.annualOverrides
    ? { ...target, annualOverrides: [...overrides.values()].filter((item) => item.targetId === target.id) } : target;
  const create = (data: any) => {
    const target = {
      id: `target-${++nextId}`, tenantId: ctx.tenantId, clientId: 'client-a', scopeKey: 'client-a',
      officeKey: `manual:${nextId}`, memberPrincipal: 'Avery Member', committee: null, staffer: null,
      building: null, leadOwner: null, archivedAt: null, displayOverrides: [], firstReportYear: 2026,
      prepStatus: 'auto', outreachStatus: 'auto', submissionStatus: 'auto', source: 'manual', ...data,
    };
    targets.set(target.id, target);
    return target;
  };
  const tx = {
    $executeRaw: jest.fn(async () => 0),
    client: { findFirst: async ({ where }: any) => ['client-a', 'client-b'].includes(where.id) ? { id: where.id } : null },
    engagementReportTargetOffice: {
      findUnique: async ({ where, include }: any) => withOverrides(uniqueTarget(where), include),
      findUniqueOrThrow: async ({ where }: any) => uniqueTarget(where),
      findFirst: async ({ where, include }: any) => withOverrides([...targets.values()].find((item) =>
        item.tenantId === where.tenantId && (!where.id || item.id === where.id) &&
        (!where.officeKey || item.officeKey === where.officeKey) &&
        (!where.OR || where.OR.some((clause: any) => item.clientId === clause.clientId)),
      ) ?? null, include),
      create: async ({ data }: any) => create(data),
      upsert: async ({ where, create: data, update }: any) => {
        const existing = uniqueTarget(where);
        if (existing) { Object.assign(existing, update); return existing; }
        return create(data);
      },
      update: async ({ where, data }: any) => { const target = uniqueTarget(where); Object.assign(target, data); return target; },
      delete: jest.fn(async ({ where }: any) => {
        targets.delete(where.id);
        for (const [key, value] of overrides) if (value.targetId === where.id) overrides.delete(key);
      }),
    },
    engagementReportTargetOverride: {
      upsert: async ({ where, create: data, update }: any) => {
        const key = `${where.targetId_reportYear.targetId}:${where.targetId_reportYear.reportYear}`;
        const existing = overrides.get(key);
        const value = existing ? { ...existing, ...update } : { prepStatus: 'auto', outreachStatus: 'auto', submissionStatus: 'auto', ...data };
        overrides.set(key, value);
        return value;
      },
      updateMany: async ({ where, data }: any) => {
        const key = `${where.targetId}:${where.reportYear}`;
        if (overrides.has(key)) Object.assign(overrides.get(key), data);
      },
    },
  };
  const prisma = { withTenant: (_tenant: string, fn: (tx: any) => unknown) => fn(tx) } as unknown as PrismaService;
  return { prisma, tx, targets, overrides, create };
}

describe('client-owned target lifecycle and annual overrides', () => {
  test('requires client, explicit year and Directory selection or deliberate manual-only', async () => {
    const { prisma } = harness();
    await expect(createReportTarget(prisma, directory, ctx, { clientId: null, reportYear: 2026, manualOnly: true, memberPrincipal: 'Avery' })).rejects.toThrow('Choose a client');
    await expect(createReportTarget(prisma, directory, ctx, { clientId: 'client-a', reportYear: undefined as any, directoryContactId: '123' })).rejects.toThrow('reportYear');
    await expect(createReportTarget(prisma, directory, ctx, { clientId: 'client-a', reportYear: 2026, memberPrincipal: 'Avery' })).rejects.toThrow('explicitly choose manual-only');
    await expect(createReportTarget(prisma, directory, ctx, { clientId: 'not-in-tenant', reportYear: 2026, directoryContactId: '123' })).rejects.toThrow('Client not found');
    await expect(createReportTarget(prisma, directory, ctx, { clientId: 'client-a', reportYear: 2026, directoryContactId: 'missing' })).rejects.toThrow('Directory contact not found');
  });

  test('canonical add is idempotent per client, preserves edits/blanks, and enriches absent values', async () => {
    const { prisma, targets } = harness();
    const input = { clientId: 'client-a', reportYear: 2026, directoryContactId: '123', memberPrincipal: 'Edited name', building: '', leadOwner: 'Morgan' };
    const [first, again] = await Promise.all([createReportTarget(prisma, directory, ctx, input), createReportTarget(prisma, directory, ctx, input)]);
    expect(first.id).toBe(again.id);
    expect(targets.size).toBe(1);
    const preserved = await createReportTarget(prisma, directory, ctx, { clientId: 'client-a', reportYear: 2025, directoryContactId: '123' });
    expect(preserved).toMatchObject({ memberPrincipal: 'Edited name', building: null, leadOwner: 'Morgan', firstReportYear: 2025, officeKey: 'directory:member-123' });
    await createReportTarget(prisma, directory, ctx, { clientId: 'client-b', reportYear: 2026, directoryContactId: '123' });
    expect(targets.size).toBe(2);
    expect([...targets.values()].find((row) => row.clientId === 'client-b')?.building).toBe('123 Rayburn HOB');
  });

  test('override validates canonical identity even when no target was planned', async () => {
    const { prisma, targets } = harness();
    await expect(upsertReportTargetOverride(prisma, directory, ctx, { clientId: 'client-a', reportYear: 2026, officeKey: 'directory:missing', prepStatus: 'complete' })).rejects.toThrow('Directory contact not found');
    await upsertReportTargetOverride(prisma, directory, ctx, { clientId: 'client-a', reportYear: 2026, officeKey: 'directory:123', prepStatus: 'complete' });
    expect([...targets.values()][0].officeKey).toBe('directory:member-123');
  });

  test('reusing a target enriches absent fields but reports conflicting submitted edits honestly', async () => {
    const { prisma, create } = harness();
    const target = create({ officeKey: 'directory:member-123', leadOwner: 'Morgan', building: null });
    const enriched = await createReportTarget(prisma, directory, ctx, { clientId: 'client-a', reportYear: 2026, directoryContactId: '123' });
    expect(enriched).toMatchObject({ id: target.id, reused: true, building: '123 Rayburn HOB', leadOwner: 'Morgan' });
    await expect(createReportTarget(prisma, directory, ctx, { clientId: 'client-a', reportYear: 2026, directoryContactId: '123', leadOwner: 'Taylor' })).rejects.toThrow('different saved values');
    expect(target.leadOwner).toBe('Morgan');
  });

  test('restores only the selected field/year and preserves metadata and unrelated overrides', async () => {
    const { prisma, targets, overrides } = harness();
    const target = await createReportTarget(prisma, directory, ctx, { clientId: 'client-a', reportYear: 2025, manualOnly: true, memberPrincipal: 'Avery', leadOwner: 'Morgan' });
    const base = { clientId: 'client-a', officeKey: target.officeKey, prepStatus: 'complete' as const, outreachStatus: 'in_progress' as const, submissionStatus: 'complete' as const };
    await upsertReportTargetOverride(prisma, directory, ctx, { ...base, reportYear: 2025 });
    await upsertReportTargetOverride(prisma, directory, ctx, { ...base, reportYear: 2026 });
    await clearReportTargetOverride(prisma, ctx, { ...base, reportYear: 2025, field: 'prepStatus' });
    await clearReportTargetOverride(prisma, ctx, { ...base, reportYear: 2025, field: 'prepStatus' });
    expect(overrides.get(`${target.id}:2025`)).toMatchObject({ prepStatus: 'auto', outreachStatus: 'in_progress', submissionStatus: 'complete' });
    expect(overrides.get(`${target.id}:2026`).prepStatus).toBe('complete');
    expect(targets.get(target.id).leadOwner).toBe('Morgan');
  });

  test('link rejects the wrong client and explicitly assigns legacy unassigned targets', async () => {
    const { prisma, create } = harness();
    const owned = create({ officeKey: 'manual:owned', clientId: 'client-b', scopeKey: 'client-b' });
    await expect(linkReportTarget(prisma, directory, ctx, { targetId: owned.id, clientId: 'client-a', directoryContactId: '123' })).rejects.toThrow('does not own');
    const legacy = create({ officeKey: 'manual:legacy', clientId: null, scopeKey: 'all' });
    const result = await linkReportTarget(prisma, directory, ctx, { targetId: legacy.id, clientId: 'client-a', directoryContactId: '123' });
    expect(result).toMatchObject({ id: legacy.id, clientId: 'client-a', scopeKey: 'client-a', officeKey: 'directory:member-123' });
    expect(owned.officeKey).toBe('manual:owned');
  });

  test('conflicting link preserves both records until display AND yearly values are resolved', async () => {
    const { prisma, create, targets, overrides, tx } = harness();
    const manual = create({ officeKey: 'manual:planned', leadOwner: 'Morgan', building: null, displayOverrides: ['building'] });
    const canonical = create({ officeKey: 'directory:member-123', leadOwner: 'Taylor', building: 'Rayburn' });
    await upsertReportTargetOverride(prisma, directory, ctx, { clientId: 'client-a', reportYear: 2025, officeKey: manual.officeKey, prepStatus: 'complete' });
    await upsertReportTargetOverride(prisma, directory, ctx, { clientId: 'client-a', reportYear: 2025, officeKey: canonical.officeKey, prepStatus: 'in_progress' });
    const input = { targetId: manual.id, clientId: 'client-a', directoryContactId: '123' };
    let response: any;
    try { await linkReportTarget(prisma, directory, ctx, input); } catch (error: any) { response = error.getResponse(); }
    expect(response.code).toBe('TARGET_LINK_CONFLICT');
    expect(response.conflicts.map((value: any) => value.field).sort()).toEqual(['2025.prepStatus', 'building', 'leadOwner']);
    expect(tx.engagementReportTargetOffice.delete).not.toHaveBeenCalled();
    expect(targets.size).toBe(2);
    const result = await linkReportTarget(prisma, directory, ctx, { ...input, conflictResolutions: { leadOwner: 'manual', building: 'manual', '2025.prepStatus': 'existing' } });
    expect(result).toMatchObject({ id: canonical.id, leadOwner: 'Morgan', building: null });
    expect(overrides.get(`${canonical.id}:2025`).prepStatus).toBe('in_progress');
    expect(targets.size).toBe(1);
  });

  test('client edit never makes a target firm-wide or drops a colliding record', async () => {
    const { prisma, create, targets } = harness();
    const target = create({ officeKey: 'directory:member-123' });
    create({ officeKey: target.officeKey, clientId: 'client-b', scopeKey: 'client-b' });
    await expect(updateReportTarget(prisma, ctx, target.id, { clientId: null })).rejects.toThrow('Choose a client');
    await expect(updateReportTarget(prisma, ctx, target.id, { clientId: 'client-b' })).rejects.toThrow('This client already has this target');
    expect(targets.size).toBe(2);
    expect(target.clientId).toBe('client-a');
  });

  test('archive is idempotent, retains annual history, and blocks silent resurrection', async () => {
    const { prisma, create, targets, overrides } = harness();
    const target = create({ officeKey: 'directory:member-123' });
    await upsertReportTargetOverride(prisma, directory, ctx, { clientId: 'client-a', officeKey: target.officeKey, reportYear: 2025, submissionStatus: 'complete' });
    await archiveReportTarget(prisma, ctx, target.id);
    const date = target.archivedAt;
    await archiveReportTarget(prisma, ctx, target.id);
    expect(target.archivedAt).toBe(date);
    expect(targets.size).toBe(1);
    expect(overrides.get(`${target.id}:2025`).submissionStatus).toBe('complete');
    await expect(createReportTarget(prisma, directory, ctx, { clientId: 'client-a', reportYear: 2026, directoryContactId: '123' })).rejects.toThrow();
    await expect(clearReportTargetOverride(prisma, ctx, { clientId: 'client-a', officeKey: target.officeKey, reportYear: 2025, field: 'submissionStatus' })).rejects.toThrow('Archived targets');
  });
});
