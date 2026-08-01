import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { ProgramElementReadService } from '../program-element-read.service.js';
import { ProgramElementWriterService } from '../program-element-writer.service.js';
import { MANUAL_OVERRIDE_SOURCE } from '../types.js';

const ctx: TenantContext = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  tenantSlug: 'capiro',
  userId: '00000000-0000-0000-0000-000000000002',
  clerkUserId: 'user_test',
  role: 'capiro_admin',
};

interface QueueEntry {
  id: string;
  peCode: string;
  fy: number;
  fieldName: string;
  currentValue: string | null;
  conflictingSource: string;
  conflictingValue: string | null;
  status: string;
  resolvedByUserId?: string | null;
  resolvedAt?: Date | null;
  resolutionNotes?: string | null;
}

/** Read-service mock: a queue + an audit log + a withTenant that just runs the callback. */
function makeReadService(entry: QueueEntry | null) {
  const queue: QueueEntry[] = entry ? [{ ...entry }] : [];
  const audits: Array<Record<string, unknown>> = [];
  const tx = {
    reconciliationReviewQueue: {
      update: async ({ where, data }: { where: { id: string }; data: Partial<QueueEntry> }) => {
        const e = queue.find((q) => q.id === where.id)!;
        Object.assign(e, data);
        return e;
      },
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => (audits.push(data), data) },
  };
  const prisma = {
    reconciliationReviewQueue: {
      findUnique: async ({ where }: { where: { id: string } }) => queue.find((q) => q.id === where.id) ?? null,
    },
    withTenant: async <T>(_tid: string, fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };
  const svc = new ProgramElementReadService(prisma as never, {} as never);
  return { svc, queue, audits };
}

function entryFixture(over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: 'r1',
    peCode: '0601102A',
    fy: 2027,
    fieldName: 'hascMark',
    currentValue: '100',
    conflictingSource: 'sasc_report',
    conflictingValue: '250.5',
    status: 'open',
    ...over,
  };
}

describe('ProgramElementReadService.resolveReconciliation', () => {
  test('keep_current marks resolved without applying any value', async () => {
    const { svc, queue, audits } = makeReadService(entryFixture());
    const apply = jest.fn();
    const res = await svc.resolveReconciliation('r1', { decision: 'keep_current', notes: 'looks right' }, ctx, apply);

    expect(apply).not.toHaveBeenCalled();
    expect(res).toMatchObject({ resolved: true, decision: 'keep_current', appliedValue: null });
    expect(queue[0]).toMatchObject({ status: 'resolved', resolvedByUserId: ctx.userId, resolutionNotes: 'looks right' });
    expect(queue[0]?.resolvedAt).toBeInstanceOf(Date);
    expect(audits[0]).toMatchObject({ action: 'program_element.reconciliation.resolve', entityId: 'r1' });
  });

  test('accept_conflicting applies the conflicting value (in $M) via the callback', async () => {
    const { svc, queue } = makeReadService(entryFixture());
    const apply = jest.fn().mockResolvedValue(undefined);
    const res = await svc.resolveReconciliation('r1', { decision: 'accept_conflicting' }, ctx, apply);

    expect(apply).toHaveBeenCalledWith('0601102A', 2027, 'hascMark', 250.5);
    expect(res.appliedValue).toBe(250.5);
    expect(queue[0]?.status).toBe('resolved');
  });

  test('manual_value applies the operator-entered value', async () => {
    const { svc } = makeReadService(entryFixture());
    const apply = jest.fn().mockResolvedValue(undefined);
    const res = await svc.resolveReconciliation('r1', { decision: 'manual_value', manualValue: 199 }, ctx, apply);

    expect(apply).toHaveBeenCalledWith('0601102A', 2027, 'hascMark', 199);
    expect(res.appliedValue).toBe(199);
  });

  test('manual_value without a value is a 400 and applies nothing', async () => {
    const { svc, queue } = makeReadService(entryFixture());
    const apply = jest.fn();
    await expect(svc.resolveReconciliation('r1', { decision: 'manual_value' }, ctx, apply)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(apply).not.toHaveBeenCalled();
    expect(queue[0]?.status).toBe('open');
  });

  test('accept_conflicting with a null conflicting value is a 400 (no silent $0 write)', async () => {
    const { svc, queue } = makeReadService(entryFixture({ conflictingValue: null }));
    const apply = jest.fn();
    await expect(
      svc.resolveReconciliation('r1', { decision: 'accept_conflicting' }, ctx, apply),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(apply).not.toHaveBeenCalled();
    expect(queue[0]?.status).toBe('open');
  });

  test('unknown entry → 404; already-resolved entry → 400', async () => {
    const missing = makeReadService(null);
    await expect(
      missing.svc.resolveReconciliation('nope', { decision: 'keep_current' }, ctx, jest.fn()),
    ).rejects.toBeInstanceOf(NotFoundException);

    const resolved = makeReadService(entryFixture({ status: 'resolved' }));
    await expect(
      resolved.svc.resolveReconciliation('r1', { decision: 'keep_current' }, ctx, jest.fn()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/** Minimal in-memory transaction-client surface for the writer path. */
function makeWriterPrisma(seedYear: Record<string, unknown>) {
  const years = new Map<string, Record<string, unknown>>([
    [`${seedYear.peCode}:${seedYear.fy}`, { ...seedYear }],
  ]);
  const sourceValues: Array<Record<string, unknown>> = [
    {
      id: 'sv0',
      observationKey: 'legacy:sv0',
      peCode: seedYear.peCode,
      fy: seedYear.fy,
      fieldName: 'hascMark',
      source: 'hasc_report',
      valueDecimal: new Prisma.Decimal(100),
      canonicalValueM: new Prisma.Decimal(100),
      isWinner: true,
      recordedAt: new Date('2026-07-01T00:00:00Z'),
    },
  ];
  const queue: Array<Record<string, unknown>> = [];
  const outboxes: Array<Record<string, unknown>> = [];
  const key = (peCode: string, fy: number) => `${peCode}:${fy}`;

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([field, expected]) => {
      const actual = row[field];
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        const condition = expected as Record<string, unknown>;
        if ('not' in condition) return actual !== condition.not;
      }
      return actual === expected;
    });

  const prisma = {
    $queryRaw: async () => [],
    programElementYear: {
      findUnique: async ({ where }: { where: { peCode_fy: { peCode: string; fy: number } } }) =>
        years.get(key(where.peCode_fy.peCode, where.peCode_fy.fy)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        years.set(key(data.peCode as string, data.fy as number), { ...data });
        return data;
      },
      update: async ({
        where,
        data,
      }: {
        where: { peCode_fy: { peCode: string; fy: number } };
        data: Record<string, unknown>;
      }) => {
        const k = key(where.peCode_fy.peCode, where.peCode_fy.fy);
        const next = { ...(years.get(k) ?? {}), ...data };
        years.set(k, next);
        return next;
      },
    },
    programElementYearSourceValue: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        sourceValues.find((row) => matches(row, where)) ?? null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { observationKey: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        let row = sourceValues.find((item) => item.observationKey === where.observationKey);
        if (!row) {
          row = {
            id: `sv${sourceValues.length}`,
            recordedAt: new Date(),
            writtenAt: new Date(),
            ...create,
          };
          sourceValues.push(row!);
        } else {
          Object.assign(row, update);
        }
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const row of sourceValues) {
          if (matches(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
      update: async ({
        where,
        data,
      }: {
        where: { observationKey: string };
        data: Record<string, unknown>;
      }) => {
        const row = sourceValues.find((item) => item.observationKey === where.observationKey)!;
        Object.assign(row, data);
        return row;
      },
    },
    reconciliationReviewQueue: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        queue.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `q${queue.length}`, ...data };
        queue.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = queue.find((item) => item.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    programElementChangeOutbox: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        const row = { id: `outbox${outboxes.length}`, ...create };
        outboxes.push(row);
        return { id: row.id };
      },
    },
    programElementQuarantine: { create: async () => ({}) },
  };
  return { prisma, years, sourceValues, queue, outboxes, key };
}

describe('writer-path consistency: accepting a conflict via manual_override', () => {
  test('updates the canonical year value and flips is_winner without re-queuing', async () => {
    const { prisma, years, sourceValues, queue, key } = makeWriterPrisma({
      peCode: '0601102A',
      fy: 2027,
      hascMark: new Prisma.Decimal(100),
      request: new Prisma.Decimal(200),
      raw: { fieldSources: { hascMark: 'hasc_report', request: 'hasc_report' } },
    });
    const writer = new ProgramElementWriterService(prisma as never);

    // Accept a conflicting hascMark of 250.5 (what the resolve endpoint passes through).
    await writer.upsertProgramElementYear({ peCode: '0601102A', fy: 2027, hascMark: 250.5 }, MANUAL_OVERRIDE_SOURCE);

    // (a) canonical row updated to the accepted value (manual_override outranks hasc_report)…
    const row = years.get(key('0601102A', 2027))!;
    expect(Number(row.hascMark)).toBe(250.5);
    // …and the unrelated field is preserved (merge, not overwrite).
    expect(Number(row.request)).toBe(200);
    expect((row.raw as { fieldSources: Record<string, string> }).fieldSources.hascMark).toBe(MANUAL_OVERRIDE_SOURCE);

    // (b) is_winner flips at the exact field-observation level.
    const fieldObservations = sourceValues.filter((sv) => sv.fieldName === 'hascMark');
    const winners = fieldObservations.filter((sv) => sv.isWinner);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.source).toBe(MANUAL_OVERRIDE_SOURCE);
    expect(fieldObservations.find((sv) => sv.source === 'hasc_report')?.isWinner).toBe(false);

    // (c) the override itself is never queued for review.
    expect(queue).toHaveLength(0);
  });
});
