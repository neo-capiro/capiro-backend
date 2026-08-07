import { describe, expect, jest, test } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { ProgramElementWriterService } from './program-element-writer.service.js';

const PE = '0603270A';
const basePe = { peCode: PE, title: 'Test Program Element' };

function cloneMap<T extends Record<string, unknown>>(map: Map<string, T>): Map<string, T> {
  return new Map([...map.entries()].map(([key, value]) => [key, { ...value }]));
}

function createHarness() {
  const peRows = new Map<string, Record<string, unknown>>();
  const years = new Map<string, Record<string, unknown>>();
  const observations: Array<Record<string, unknown>> = [];
  const reviews: Array<Record<string, unknown>> = [];
  const outboxes = new Map<string, Record<string, unknown>>();
  const changes = new Map<string, Record<string, unknown>>();
  const quarantineRows: Array<Record<string, unknown>> = [];
  const watches: Array<{ tenantId: string; peCode: string }> = [];
  const capabilities: Array<{ tenantId: string; clientId: string; peNumber?: string; peNumbers?: string[] }> = [];
  const milestones = new Map<string, Record<string, unknown>>();
  let nextId = 1;
  let failOutboxInsert = false;
  let materializedViewRefreshCount = 0;

  const ykey = (peCode: string, fy: number) => `${peCode}::${fy}`;
  const updateObject = (
    target: Record<string, unknown> | undefined,
    data: Record<string, unknown> | undefined,
  ) => {
    if (!target || !data) return;
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in (value as Record<string, unknown>)) {
        target[key] = Number(target[key] ?? 0) + Number((value as { increment: number }).increment);
      } else if (value !== undefined) target[key] = value;
    }
  };
  const matches = (
    row: Record<string, unknown> | undefined,
    where: Record<string, unknown> | undefined,
  ): boolean => {
    if (!row) return false;
    if (!where) return true;
    return Object.entries(where).every(([key, expected]) => {
      const actual = row[key];
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        const obj = expected as Record<string, unknown>;
        if ('not' in obj) return actual !== obj.not;
        if ('in' in obj) return (obj.in as unknown[]).includes(actual);
      }
      return actual === expected;
    });
  };

  const tx: any = {
    // The writer takes a pg advisory lock via $executeRaw before touching a
    // PE-year row. Absent from this fake, every test here throws
    // "tx.$executeRaw is not a function" before reaching its assertion.
    $executeRaw: jest.fn(async () => 0),
    $queryRaw: jest.fn(async () => {
      const pending = [...outboxes.values()].find((row) => ['pending', 'failed'].includes(String(row.status)));
      return pending
        ? [{
            id: pending.id,
            dedupe_key: pending.dedupeKey,
            pe_code: pending.peCode,
            event_type: pending.eventType,
            payload_jsonb: pending.payload,
            status: pending.status,
          }]
        : [];
    }),
    programElement: {
      findUnique: jest.fn(async ({ where }: any) => peRows.get(where.peCode) ?? null),
      count: jest.fn(async () => peRows.size),
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data };
        peRows.set(data.peCode, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = { ...(peRows.get(where.peCode) ?? {}), ...data };
        peRows.set(where.peCode, row);
        return row;
      }),
    },
    programElementYear: {
      findUnique: jest.fn(async ({ where }: any) => years.get(ykey(where.peCode_fy.peCode, where.peCode_fy.fy)) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `y-${nextId++}`, ...data };
        years.set(ykey(data.peCode, data.fy), row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const key = ykey(where.peCode_fy.peCode, where.peCode_fy.fy);
        const row = { ...(years.get(key) ?? {}), ...data };
        years.set(key, row);
        return row;
      }),
    },
    programElementYearSourceValue: {
      upsert: jest.fn(async ({ where, create, update, select }: any) => {
        let row = observations.find((item) => item.observationKey === where.observationKey);
        if (!row) {
          row = { id: `o-${nextId++}`, recordedAt: new Date(), writtenAt: new Date(), ...create };
          observations.push(row!);
        } else updateObject(row, update as Record<string, unknown>);
        return Object.fromEntries(Object.keys(select).map((key) => [key, row?.[key]]));
      }),
      findFirst: jest.fn(async ({ where }: any) => observations.find((row) => matches(row, where)) ?? null),
      findMany: jest.fn(async ({ select }: any = {}) =>
        select?.source
          ? observations.map((row) => ({ source: row.source, recordedAt: row.recordedAt }))
          : observations,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of observations) {
          if (matches(row, where)) {
            updateObject(row, data as Record<string, unknown>);
            count += 1;
          }
        }
        return { count };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = observations.find((item) => item.observationKey === where.observationKey);
        if (!row) throw new Error('missing observation');
        updateObject(row, data as Record<string, unknown>);
        return row;
      }),
      count: jest.fn(async () => observations.length),
    },
    reconciliationReviewQueue: {
      findFirst: jest.fn(async ({ where }: any) => reviews.find((row) => matches(row, where)) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `r-${nextId++}`, ...data };
        reviews.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = reviews.find((item) => item.id === where.id);
        if (!row) throw new Error('missing review');
        updateObject(row, data as Record<string, unknown>);
        return row;
      }),
    },
    programElementChangeOutbox: {
      upsert: jest.fn(async ({ where, create }: any) => {
        if (failOutboxInsert) throw new Error('outbox insert failed');
        let row = outboxes.get(where.dedupeKey);
        if (!row) {
          row = { id: `b-${nextId++}`, status: 'pending', attempts: 0, createdAt: new Date(), ...create };
          outboxes.set(where.dedupeKey, row!);
        }
        return { id: row!.id };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = [...outboxes.values()].find((item) => item.id === where.id);
        if (!row) throw new Error('missing outbox');
        updateObject(row, data as Record<string, unknown>);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = [...outboxes.values()].find((item) => item.id === where.id);
        if (!row) return { count: 0 };
        updateObject(row, data);
        return { count: 1 };
      }),
      findMany: jest.fn(async () => [...outboxes.values()].map((row) => ({ id: row.id }))),
      count: jest.fn(async () => outboxes.size),
    },
    programElementWatch: {
      findMany: jest.fn(async ({ where }: any) => watches.filter((row) => row.peCode === where.peCode)),
    },
    clientCapability: {
      findMany: jest.fn(async ({ where }: any) => {
        const peCode = where.OR?.[0]?.peNumber ?? where.peNumber;
        return capabilities.filter((row) => row.peNumber === peCode || row.peNumbers?.includes(peCode));
      }),
    },
    intelligenceChange: {
      upsert: jest.fn(async ({ where, create }: any) => {
        if (!changes.has(where.dedupeKey)) changes.set(where.dedupeKey, create);
        return changes.get(where.dedupeKey);
      }),
      create: jest.fn(async ({ data }: any) => {
        changes.set(`legacy-${changes.size}`, data);
        return data;
      }),
    },
    programElementMilestone: {
      findUnique: jest.fn(async ({ where }: any) => milestones.get(`${where.peCode_milestoneType.peCode}:${where.peCode_milestoneType.milestoneType}`) ?? null),
      create: jest.fn(async ({ data }: any) => {
        milestones.set(`${data.peCode}:${data.milestoneType}`, data);
        return data;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const key = `${where.peCode_milestoneType.peCode}:${where.peCode_milestoneType.milestoneType}`;
        const row = { ...(milestones.get(key) ?? {}), ...data };
        milestones.set(key, row);
        return row;
      }),
    },
    programElementQuarantine: {
      create: jest.fn(async ({ data }: any) => {
        quarantineRows.push(data);
        return data;
      }),
      count: jest.fn(async () => quarantineRows.length),
    },
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      if (sql.includes('refresh_program_element_detail_mv')) materializedViewRefreshCount += 1;
      return 0;
    }),
  };

  const root: any = {
    ...tx,
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => {
      const snapshot = {
        years: cloneMap(years),
        observations: observations.map((row) => ({ ...row })),
        reviews: reviews.map((row) => ({ ...row })),
        outboxes: cloneMap(outboxes),
      };
      try {
        return await fn(tx);
      } catch (error) {
        years.clear();
        for (const [key, value] of snapshot.years) years.set(key, value);
        observations.splice(0, observations.length, ...snapshot.observations);
        reviews.splice(0, reviews.length, ...snapshot.reviews);
        outboxes.clear();
        for (const [key, value] of snapshot.outboxes) outboxes.set(key, value);
        throw error;
      }
    }),
    withSystem: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const metrics = { emitCount: jest.fn(async () => undefined), emitSeconds: jest.fn(async () => undefined), emitGauge: jest.fn(async () => undefined) };
  const service = new ProgramElementWriterService(root, metrics as never);

  return {
    service,
    root,
    tx,
    peRows,
    years,
    observations,
    reviews,
    outboxes,
    changes,
    watches,
    capabilities,
    quarantineRows,
    setFailOutboxInsert(value: boolean) { failOutboxInsert = value; },
    get materializedViewRefreshCount() { return materializedViewRefreshCount; },
  };
}

async function seed(h: ReturnType<typeof createHarness>): Promise<void> {
  await h.service.upsertProgramElement(basePe, 'fixture', 0.9);
}

describe('ProgramElementWriterService Phase D', () => {
  test('HASC request is observed but cannot replace PB request; HASC owns its mark', async () => {
    const h = createHarness();
    await seed(h);
    await h.service.upsertProgramElementYear({ peCode: PE, fy: 2027, request: 100 }, 'r_doc_fy27');
    await h.service.upsertProgramElementYear({ peCode: PE, fy: 2027, request: 999, hascMark: 90 }, 'hasc_report_fy27');
    const row = h.years.get(`${PE}::2027`)!;
    expect(String(row.request)).toBe('100');
    expect(String(row.hascMark)).toBe('90');
    expect(h.observations.some((item) => item.source === 'hasc_report_fy27' && item.fieldName === 'request')).toBe(true);
    expect(h.reviews.some((item) => item.conflictType === 'unauthorized_field_source')).toBe(true);
  });

  test('public law owns enacted but cannot own request', async () => {
    const h = createHarness();
    await seed(h);
    await h.service.upsertProgramElementYear({ peCode: PE, fy: 2027, request: 100 }, 'r_doc_fy27');
    await h.service.upsertProgramElementYear({ peCode: PE, fy: 2027, request: 500, enacted: 95 }, 'public_law_fy27');
    const row = h.years.get(`${PE}::2027`)!;
    expect(String(row.request)).toBe('100');
    expect(String(row.enacted)).toBe('95');
  });

  test('NDAA and appropriations conference remain separate fields', async () => {
    const h = createHarness();
    await seed(h);
    await h.service.upsertProgramElementYear({ peCode: PE, fy: 2027, ndaaConference: 88, conference: 999 }, 'conference_report_fy27');
    await h.service.upsertProgramElementYear({ peCode: PE, fy: 2027, conference: 84, ndaaConference: 777 }, 'approps_conference_report_fy27');
    const row = h.years.get(`${PE}::2027`)!;
    expect(String(row.ndaaConference)).toBe('88');
    expect(String(row.conference)).toBe('84');
  });

  test('zero is canonical and exact replay creates no duplicate observation or event', async () => {
    const h = createHarness();
    await seed(h);
    await h.service.upsertProgramElementYear({ peCode: PE, fy: 2027, request: 0 }, 'r_doc_fy27');
    const first = await h.service.upsertProgramElementYear({ peCode: PE, fy: 2027, request: 0 }, 'r_doc_fy27');
    expect(String(h.years.get(`${PE}::2027`)?.request)).toBe('0');
    expect(first.changed).toBe(false);
    expect(h.observations).toHaveLength(1);
    expect(h.observations[0]?.observationCount).toBe(2);
    expect(h.outboxes.size).toBe(0);
  });

  test('P-40 and OP-5 enrichment survives later R/P/O and committee writes', async () => {
    const h = createHarness();
    await h.service.upsertProgramElement({ ...basePe, raw: { pDocDetail: { contractors: ['A'] } } }, 'p_doc_fy27', 0.9);
    await h.service.upsertProgramElement({ ...basePe, raw: { op5Detail: { sag: 'X' } } }, 'o1_fy27', 0.9);
    await h.service.upsertProgramElement({ ...basePe, raw: { narrative: true } }, 'r_doc_fy27', 0.9);
    await h.service.upsertProgramElement({ ...basePe, raw: { committee: true } }, 'hasc_report_fy27', 0.9);
    const raw = h.peRows.get(PE)?.raw as Record<string, unknown>;
    expect(raw.pDocDetail).toEqual({ contractors: ['A'] });
    expect(raw.op5Detail).toEqual({ sag: 'X' });
    expect((raw.sourcePayloads as Record<string, unknown>).r_doc).toEqual({ narrative: true });
    expect((raw.sourcePayloads as Record<string, unknown>).hasc_report).toEqual({ committee: true });
  });

  test('canonical change, observations and outbox roll back together on failure', async () => {
    const h = createHarness();
    await seed(h);
    await h.service.upsertProgramElementYear({ peCode: PE, fy: 2027, request: 100 }, 'r_doc_fy27');
    const beforeObservationCount = h.observations.length;
    h.setFailOutboxInsert(true);
    await expect(h.service.upsertProgramElementYear({ peCode: PE, fy: 2027, request: 150 }, 'r_doc_fy27')).rejects.toThrow('outbox insert failed');
    expect(String(h.years.get(`${PE}::2027`)?.request)).toBe('100');
    expect(h.observations).toHaveLength(beforeObservationCount);
    expect(h.outboxes.size).toBe(0);
  });

  test('stable outbox dedupe emits once and watch-only tenant is discovered via withSystem', async () => {
    const h = createHarness();
    await seed(h);
    h.watches.push({ tenantId: 'tenant-a', peCode: PE });
    await h.service.upsertProgramElementYear({ peCode: PE, fy: 2027, request: 100 }, 'r_doc_fy27');
    const result = await h.service.upsertProgramElementYear({ peCode: PE, fy: 2027, request: 130 }, 'r_doc_fy27');
    expect(result.outboxIds).toHaveLength(1);
    expect(h.outboxes.size).toBe(1);
    expect(h.changes.size).toBe(1);
    expect(h.root.withSystem).toHaveBeenCalled();
    const replay = await h.service.upsertProgramElementYear({ peCode: PE, fy: 2027, request: 130 }, 'r_doc_fy27');
    expect(replay.changed).toBe(false);
    expect(h.outboxes.size).toBe(1);
    expect(h.changes.size).toBe(1);
  });

  test('data correction commits canonical evidence while suppressing user-facing change emission', async () => {
    const h = createHarness();
    await seed(h);
    h.watches.push({ tenantId: 'tenant-a', peCode: PE });
    await h.service.upsertProgramElementYear({ peCode: PE, fy: 2027, request: 100 }, 'r_doc_fy27');
    await h.service.upsertProgramElementYear(
      { peCode: PE, fy: 2027, request: 120 },
      'r_doc_fy27',
      { authority: 'presidents_budget_request', dataCorrection: true },
    );
    expect(String(h.years.get(`${PE}::2027`)?.request)).toBe('120');
    expect(h.outboxes.size).toBe(1);
    expect(h.changes.size).toBe(0);
  });

  test('invalid identifiers are quarantined and existing utility paths remain intact', async () => {
    const h = createHarness();
    expect((await h.service.upsertProgramElement({ peCode: 'BAD', title: 'Bad' }, 'fixture', 0.1)).inserted).toBe(false);
    expect((await h.service.upsertProgramElementYear({ peCode: 'BAD', fy: 2027, request: 1 }, 'r_doc')).changed).toBe(false);
    expect(h.quarantineRows).toHaveLength(2);
    await h.service.refreshProgramElementDetailMaterializedView();
    expect(h.materializedViewRefreshCount).toBe(1);
  });
});
