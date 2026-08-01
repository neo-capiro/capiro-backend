import { describe, expect, jest, test } from '@jest/globals';
import {
  ReconciliationService,
  buildObservationKey,
  relativeDelta,
  shouldQueue,
  type FieldReconcileResult,
  type ReconcileInput,
} from './reconciliation.service.js';

describe('reconciliation pure rules', () => {
  test('relative delta and enacted threshold preserve zero semantics', () => {
    expect(relativeDelta(0, 0)).toBe(0);
    expect(relativeDelta(1000, 1200)).toBeCloseTo(0.1667, 3);
    expect(shouldQueue('hascMark', 1000, 1050).queued).toBe(false);
    expect(shouldQueue('hascMark', 1000, 1300).reason).toBe('over_threshold');
    expect(shouldQueue('enacted', 1000, 1001).reason).toBe('enacted_conflict');
    expect(shouldQueue('request', null, 0)).toEqual({ queued: false, deltaPct: null });
  });

  test('observation key is stable and changes with source evidence', () => {
    const base = {
      sourceDocumentId: '00000000-0000-0000-0000-000000000001',
      source: 'r_doc_fy27',
      parseJobId: '00000000-0000-0000-0000-000000000002',
      peCode: '0603270A',
      fy: 2027,
      fieldName: 'request' as const,
      originalValue: 13_500,
      originalUnit: 'thousands',
      canonicalValueM: 13.5,
      pageNumber: 10,
      sourceSpanHash: 'span-a',
      extractorVersion: 'v1',
    };
    expect(buildObservationKey(base)).toBe(buildObservationKey({ ...base }));
    expect(buildObservationKey(base)).not.toBe(buildObservationKey({ ...base, sourceSpanHash: 'span-b' }));
  });
});

type Observation = {
  id: string;
  observationKey: string;
  peCode: string;
  fy: number;
  fieldName: string;
  source: string;
  sourceDocumentId: string | null;
  isWinner: boolean;
  observationCount: number;
  lastObservedAt: Date;
  canonicalValueM: number;
};
type Review = Record<string, unknown> & { id: string; observationCount: number };

function incrementValue(current: unknown, update: unknown): unknown {
  if (update && typeof update === 'object' && 'increment' in (update as Record<string, unknown>)) {
    return Number(current ?? 0) + Number((update as { increment: number }).increment);
  }
  return update;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('not' in (expected as Record<string, unknown>)) return actual !== (expected as { not: unknown }).not;
    }
    return actual === expected;
  });
}

function makeHarness() {
  const observations: Observation[] = [];
  const reviews: Review[] = [];
  let nextId = 1;
  const client = {
    programElementYearSourceValue: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        let row = observations.find((item) => item.observationKey === where.observationKey);
        if (!row) {
          row = {
            id: `o-${nextId++}`,
            observationKey: create.observationKey,
            peCode: create.peCode,
            fy: create.fy,
            fieldName: create.fieldName,
            source: create.source,
            sourceDocumentId: create.sourceDocumentId ?? null,
            isWinner: create.isWinner,
            observationCount: create.observationCount,
            lastObservedAt: create.lastObservedAt,
            canonicalValueM: Number(create.canonicalValueM),
          };
          observations.push(row);
        } else {
          for (const [key, value] of Object.entries(update as Record<string, unknown>)) {
            if (value !== undefined) (row as Record<string, unknown>)[key] = incrementValue((row as Record<string, unknown>)[key], value);
          }
        }
        return { id: row.id, source: row.source, sourceDocumentId: row.sourceDocumentId, isWinner: row.isWinner };
      }),
      findFirst: jest.fn(async ({ where }: any) => observations.find((row) => matches(row as any, where)) ?? null),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of observations) {
          if (matches(row as any, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = observations.find((item) => item.observationKey === where.observationKey);
        if (!row) throw new Error('missing observation');
        Object.assign(row, data);
        return row;
      }),
    },
    reconciliationReviewQueue: {
      findFirst: jest.fn(async ({ where }: any) => reviews.find((row) => matches(row, where)) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `r-${nextId++}`, ...data } as Review;
        reviews.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = reviews.find((item) => item.id === where.id);
        if (!row) throw new Error('missing review');
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
          row[key] = incrementValue(row[key], value);
        }
        return row;
      }),
    },
  };
  const service = new ReconciliationService({} as never);
  const reconcile = (input: ReconcileInput): Promise<FieldReconcileResult[]> => service.reconcile(input, client as never);
  const apply = (results: FieldReconcileResult[]) =>
    service.applyWinnerFlags({ peCode: '0603270A', fy: 2027, results }, client as never);
  return { observations, reviews, client, reconcile, apply };
}

function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    peCode: '0603270A',
    fy: 2027,
    source: 'r_doc_fy27',
    authority: 'presidents_budget_request',
    values: { request: 13.5 },
    currentValues: { request: null },
    context: {
      authority: 'presidents_budget_request',
      sourceDocumentId: '00000000-0000-0000-0000-000000000001',
      parseJobId: '00000000-0000-0000-0000-000000000002',
      pageNumber: 10,
      sourceSpanHash: 'span',
      extractorVersion: 'v1',
      originalValues: { request: { value: 13_500, unit: 'thousands' } },
    },
    ...overrides,
  };
}

describe('ReconciliationService deterministic observations', () => {
  test('exact replay increments observation count, not row count', async () => {
    const h = makeHarness();
    const first = await h.reconcile(input());
    await h.apply(first);
    const second = await h.reconcile(input({ currentValues: { request: 13.5 } }));
    await h.apply(second);
    expect(h.observations).toHaveLength(1);
    expect(h.observations[0]?.observationCount).toBe(2);
    expect(h.observations[0]?.isWinner).toBe(true);
  });

  test('HASC request is retained but cannot replace the PB request', async () => {
    const h = makeHarness();
    const pb = await h.reconcile(input());
    await h.apply(pb);
    const hasc = await h.reconcile(
      input({
        source: 'hasc_report_fy27',
        authority: 'hasc_authorization',
        values: { request: 99 },
        currentValues: { request: 13.5 },
        context: { authority: 'hasc_authorization', originalValues: { request: { value: 99, unit: 'millions' } } },
      }),
    );
    await h.apply(hasc);
    expect(hasc[0]).toMatchObject({ shouldWin: false, conflictType: 'unauthorized_field_source', queued: true });
    expect(h.observations.filter((row) => row.isWinner)).toHaveLength(1);
    expect(h.observations.find((row) => row.isWinner)?.source).toBe('r_doc_fy27');
  });

  test('newer conflict refreshes the open review details', async () => {
    const h = makeHarness();
    const pb = await h.reconcile(input());
    await h.apply(pb);
    const unauthorized = (value: number) =>
      input({
        source: 'hasc_report_fy27',
        authority: 'hasc_authorization',
        values: { request: value },
        currentValues: { request: 13.5 },
        context: { authority: 'hasc_authorization', originalValues: { request: { value, unit: 'millions' } } },
      });
    await h.reconcile(unauthorized(20));
    await h.reconcile(unauthorized(22));
    expect(h.reviews).toHaveLength(1);
    expect(h.reviews[0]?.conflictingValue).toBe('22');
    expect(h.reviews[0]?.observationCount).toBe(2);
  });

  test('manual override remains the sole winner against future automated syncs', async () => {
    const h = makeHarness();
    const manual = await h.reconcile(
      input({
        source: 'manual_override',
        authority: 'manual_override',
        values: { request: 50 },
        currentValues: { request: null },
        context: { authority: 'manual_override', originalValues: { request: { value: 50, unit: 'millions' } } },
      }),
    );
    await h.apply(manual);
    const pb = await h.reconcile(input({ values: { request: 60 }, currentValues: { request: 50 }, context: { authority: 'presidents_budget_request', originalValues: { request: { value: 60, unit: 'millions' } } } }));
    await h.apply(pb);
    expect(pb[0]).toMatchObject({ shouldWin: false, reason: 'manual_override_protected' });
    expect(h.observations.find((row) => row.isWinner)?.source).toBe('manual_override');
  });

  test('any enacted disagreement queues even when the delta is tiny', async () => {
    const h = makeHarness();
    const results = await h.reconcile(
      input({
        source: 'public_law_fy27',
        authority: 'enacted_public_law',
        values: { enacted: 100.001 },
        currentValues: { enacted: 100 },
        context: { authority: 'enacted_public_law', originalValues: { enacted: { value: 100.001, unit: 'millions' } } },
      }),
    );
    expect(results[0]).toMatchObject({ queued: true, reason: 'enacted_conflict' });
  });
});
