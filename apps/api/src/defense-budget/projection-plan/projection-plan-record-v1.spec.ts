import { RDTE_PROJECTION_EXCLUSION_V1_VALUES } from '../rdte/projection/rdte-canonical-projection-plan-v1.js';
import { NON_RDTE_PROJECTION_EXCLUSION_V1_VALUES } from '../non-rdte/non-rdte-canonical-projection-plan-v1.js';
import {
  PROJECTION_EXCLUSION_BLOCKS_PROMOTION_V1,
  ProjectionPlanClassificationErrorV1,
  buildProjectionPlanRecordV1,
  projectionPlanIdV1,
  summarizeProjectionPlanV1,
  projectionPlanDocumentViewV1Schema,
} from './projection-plan-record-v1.js';
import { PrismaProjectionPlanRepositoryV1 } from './projection-plan-repository-prisma-v1.js';

const SHA = (c: string) => c.repeat(64);

function planDocument(
  overrides: {
    candidates?: unknown[];
    exclusions?: { reason: string }[];
    cycleId?: string;
    fiscalYear?: number;
    contentSha256?: string;
  } = {},
): Record<string, unknown> {
  return {
    schemaVersion: 'rdte_canonical_projection_plan_v1',
    cycleId: overrides.cycleId ?? 'cycle-fy2027',
    fiscalYear: overrides.fiscalYear ?? 2027,
    contentSha256: overrides.contentSha256 ?? SHA('1'),
    candidates: overrides.candidates ?? [
      { operation: 'insert', artifactContentSha256: SHA('a') },
      { operation: 'update', artifactContentSha256: SHA('b') },
    ],
    ...(overrides.exclusions != null ? { exclusions: overrides.exclusions } : {}),
  };
}

const view = (doc: Record<string, unknown>) => projectionPlanDocumentViewV1Schema.parse(doc);

describe('exclusion classification', () => {
  it('classifies every reason from both family vocabularies', () => {
    // A new reason in either contract fails here rather than silently landing
    // in the permissive bucket.
    for (const reason of [
      ...RDTE_PROJECTION_EXCLUSION_V1_VALUES,
      ...NON_RDTE_PROJECTION_EXCLUSION_V1_VALUES,
    ]) {
      expect(PROJECTION_EXCLUSION_BLOCKS_PROMOTION_V1).toHaveProperty(reason);
      expect(typeof PROJECTION_EXCLUSION_BLOCKS_PROMOTION_V1[reason]).toBe('boolean');
    }
  });

  it('treats a duplicate natural key as blocking', () => {
    expect(PROJECTION_EXCLUSION_BLOCKS_PROMOTION_V1.duplicate_conflict).toBe(true);
  });

  it('does not block on a value that was correctly excluded by design', () => {
    expect(PROJECTION_EXCLUSION_BLOCKS_PROMOTION_V1.contextual_only_value).toBe(false);
    expect(PROJECTION_EXCLUSION_BLOCKS_PROMOTION_V1.outyear_not_request).toBe(false);
  });
});

describe('summarizeProjectionPlanV1', () => {
  it('reports a clean plan as PROJECTABLE with zero counts', () => {
    const summary = summarizeProjectionPlanV1(view(planDocument()));
    expect(summary).toMatchObject({ status: 'PROJECTABLE', conflictCount: 0, unsupportedCount: 0 });
  });

  it('counts operation === conflict, which is decision 4s authoritative signal', () => {
    const summary = summarizeProjectionPlanV1(
      view(
        planDocument({
          candidates: [
            { operation: 'insert', artifactContentSha256: SHA('a') },
            { operation: 'conflict', artifactContentSha256: SHA('a') },
          ],
        }),
      ),
    );
    expect(summary.conflictCount).toBe(1);
    expect(summary.status).toBe('BLOCKED');
  });

  it('counts a blocking exclusion but not a by-design one', () => {
    const summary = summarizeProjectionPlanV1(
      view(
        planDocument({
          candidates: [
            {
              operation: 'no_op',
              artifactContentSha256: SHA('a'),
              exclusionReason: 'unresolved_evidence',
            },
            {
              operation: 'no_op',
              artifactContentSha256: SHA('a'),
              exclusionReason: 'contextual_only_value',
            },
          ],
        }),
      ),
    );
    expect(summary.unsupportedCount).toBe(1);
    expect(summary.exclusionBreakdown).toEqual({
      unresolved_evidence: 1,
      contextual_only_value: 1,
    });
    expect(summary.status).toBe('BLOCKED');
  });

  it('reports every exclusion reason even when it does not block', () => {
    const summary = summarizeProjectionPlanV1(
      view(
        planDocument({
          candidates: [
            {
              operation: 'no_op',
              artifactContentSha256: SHA('a'),
              exclusionReason: 'outyear_not_request',
            },
          ],
        }),
      ),
    );
    expect(summary.status).toBe('PROJECTABLE');
    expect(summary.exclusionBreakdown).toEqual({ outyear_not_request: 1 });
  });

  it('counts record-level exclusions too', () => {
    const summary = summarizeProjectionPlanV1(
      view(planDocument({ exclusions: [{ reason: 'artifact_rejected' }] })),
    );
    expect(summary.unsupportedCount).toBe(1);
  });

  it('refuses an unclassified exclusion reason instead of assuming it is harmless', () => {
    expect(() =>
      summarizeProjectionPlanV1(
        view(
          planDocument({
            candidates: [
              {
                operation: 'no_op',
                artifactContentSha256: SHA('a'),
                exclusionReason: 'some_new_reason',
              },
            ],
          }),
        ),
      ),
    ).toThrow(ProjectionPlanClassificationErrorV1);
  });

  it('binds the exact artifact set, order-independently and de-duplicated', () => {
    const a = summarizeProjectionPlanV1(
      view(
        planDocument({
          candidates: [
            { operation: 'insert', artifactContentSha256: SHA('a') },
            { operation: 'insert', artifactContentSha256: SHA('b') },
            { operation: 'insert', artifactContentSha256: SHA('a') },
          ],
        }),
      ),
    );
    const b = summarizeProjectionPlanV1(
      view(
        planDocument({
          candidates: [
            { operation: 'insert', artifactContentSha256: SHA('b') },
            { operation: 'insert', artifactContentSha256: SHA('a') },
          ],
        }),
      ),
    );
    expect(a.artifactSetSha256).toBe(b.artifactSetSha256);
  });

  it('changes the artifact binding when the artifact set changes', () => {
    const a = summarizeProjectionPlanV1(view(planDocument()));
    const b = summarizeProjectionPlanV1(
      view(
        planDocument({ candidates: [{ operation: 'insert', artifactContentSha256: SHA('9') }] }),
      ),
    );
    expect(a.artifactSetSha256).not.toBe(b.artifactSetSha256);
  });
});

describe('projectionPlanIdV1', () => {
  it('is content-addressed, so recomputing the same plan is a replay', () => {
    const input = { family: 'rdte', cycleId: 'c', fiscalYear: 2027, contentSha256: SHA('1') };
    expect(projectionPlanIdV1(input)).toBe(projectionPlanIdV1({ ...input }));
  });

  it('separates plans that differ in family, cycle, year, or content', () => {
    const base = { family: 'rdte', cycleId: 'c', fiscalYear: 2027, contentSha256: SHA('1') };
    const ids = new Set([
      projectionPlanIdV1(base),
      projectionPlanIdV1({ ...base, family: 'om' }),
      projectionPlanIdV1({ ...base, cycleId: 'other' }),
      projectionPlanIdV1({ ...base, fiscalYear: 2028 }),
      projectionPlanIdV1({ ...base, contentSha256: SHA('2') }),
    ]);
    expect(ids.size).toBe(5);
  });
});

describe('buildProjectionPlanRecordV1', () => {
  const input = {
    family: 'rdte',
    producerVersion: 'build-rdte-cycle@test',
    certificationId: null,
    certificationSha256: SHA('c'),
    planDocument: planDocument(),
  };

  it('derives id, summary, and artifact binding from the document', () => {
    const record = buildProjectionPlanRecordV1(input);
    expect(record.projectionPlanId).toMatch(/^pp_[0-9a-f]{64}$/);
    expect(record).toMatchObject({
      family: 'rdte',
      cycleId: 'cycle-fy2027',
      fiscalYear: 2027,
      status: 'PROJECTABLE',
      conflictCount: 0,
      unsupportedCount: 0,
    });
  });

  it('refuses a family outside the budget vocabulary', () => {
    expect(() => buildProjectionPlanRecordV1({ ...input, family: 'not_a_family' })).toThrow();
  });

  it('refuses a document that is not a recognizable plan envelope', () => {
    expect(() => buildProjectionPlanRecordV1({ ...input, planDocument: { nope: true } })).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Repository                                                          */
/* ------------------------------------------------------------------ */

class FakePrisma {
  readonly inserts: unknown[][] = [];
  rows: Record<string, unknown>[] = [];

  async $executeRawUnsafe(_query: string, ...values: unknown[]): Promise<number> {
    this.inserts.push(values);
    return 1;
  }

  async $queryRawUnsafe<T>(_query: string, ..._values: unknown[]): Promise<T> {
    return this.rows as unknown as T;
  }
}

function rowFor(record: ReturnType<typeof buildProjectionPlanRecordV1>): Record<string, unknown> {
  return {
    projectionPlanId: record.projectionPlanId,
    recordSchemaVersion: record.recordSchemaVersion,
    schemaVersion: record.schemaVersion,
    family: record.family,
    cycleId: record.cycleId,
    fiscalYear: record.fiscalYear,
    contentSha256: record.contentSha256,
    producerVersion: record.producerVersion,
    certificationId: record.certificationId,
    certificationSha256: record.certificationSha256,
    artifactSetSha256: record.artifactSetSha256,
    status: record.status,
    conflictCount: record.conflictCount,
    unsupportedCount: record.unsupportedCount,
    planDocument: record.planDocument,
    planLocator: null,
  };
}

describe('PrismaProjectionPlanRepositoryV1', () => {
  const record = buildProjectionPlanRecordV1({
    family: 'rdte',
    producerVersion: 'p@1',
    certificationId: null,
    certificationSha256: SHA('c'),
    planDocument: planDocument(),
  });

  it('round-trips a plan and verifies it on the way out', async () => {
    const prisma = new FakePrisma();
    const repo = new PrismaProjectionPlanRepositoryV1(prisma);
    await repo.insert(record);
    prisma.rows = [rowFor(record)];

    await expect(repo.loadVerified(record.projectionPlanId)).resolves.toMatchObject({
      projectionPlanId: record.projectionPlanId,
      status: 'PROJECTABLE',
    });
  });

  it('refuses a document filed under a different content SHA', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [{ ...rowFor(record), contentSha256: SHA('9') }];
    await expect(
      new PrismaProjectionPlanRepositoryV1(prisma).loadVerified(record.projectionPlanId),
    ).rejects.toThrow(/storage was tampered with/);
  });

  it('refuses a stored summary that disagrees with its own document', async () => {
    // The integrity check decision 4 asks for: the count is derived from the
    // immutable plan, and the denormalized value is only ever a cross-check.
    const prisma = new FakePrisma();
    prisma.rows = [{ ...rowFor(record), status: 'BLOCKED', conflictCount: 5 }];
    await expect(
      new PrismaProjectionPlanRepositoryV1(prisma).loadVerified(record.projectionPlanId),
    ).rejects.toThrow(/stored summary disagrees with its document/);
  });

  it('refuses a locator-stored plan rather than reading it as empty', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [{ ...rowFor(record), planDocument: null, planLocator: 's3://plans/x.json' }];
    await expect(
      new PrismaProjectionPlanRepositoryV1(prisma).loadVerified(record.projectionPlanId),
    ).rejects.toThrow(/only reads inline plan documents/);
  });

  it('returns nothing for an empty family scope rather than querying', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [rowFor(record)];
    await expect(
      new PrismaProjectionPlanRepositoryV1(prisma).loadForScope('cycle-fy2027', []),
    ).resolves.toEqual([]);
  });
});
