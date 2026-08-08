/**
 * Phase 7 Workstream N — production projection source tests.
 *
 * The behaviour that matters here is what happens to what the source *cannot*
 * read. A family with no reader must be reported, never silently contribute
 * zero projections, because an empty plan for an unread family is
 * indistinguishable from an empty plan for a family with nothing to promote.
 */
import {
  PrismaPromotionProjectionSourceV1,
  PROJECTION_SOURCE_SUPPORTED_FAMILIES_V1,
  type ProjectionPrismaLikeV1,
} from './promotion-projection-source-prisma-v1.js';
import type { StoredExecutionPlanV1 } from './canonical-promotion-service-v1.js';

const SHA = (c: string): string => c.repeat(64);

const OM_ROW = {
  naturalKey: 'OM_SAG:ARMY:OMA:121',
  component: 'ARMY',
  account: 'OMA',
  sagCode: '121',
  title: 'Rehearsal SAG',
  fiscalYear: 2027,
  fundingField: 'request',
  amountMillions: '12.345678',
  originalValue: '12345.678',
  originalUnit: 'thousands',
  assertionId: 'assert-om',
  verificationCandidateId: 'cand-om',
  verificationRunId: 'run-om',
  verificationDecisionId: 'decision-om',
  artifactId: 'artifact-om',
  artifactContentSha256: SHA('c'),
  sourcePdfSha256: SHA('d'),
  evidenceIds: ['ev-om'],
  sourceDocumentKey: 'p7-plan-source',
};

/** Answers the two queries `loadOm` issues, by shape rather than by order. */
function fakePrisma(rows: unknown[], identityCount = rows.length): ProjectionPrismaLikeV1 {
  return {
    async $queryRawUnsafe<T>(query: string): Promise<T> {
      if (query.includes('count(*)')) return [{ count: BigInt(identityCount) }] as unknown as T;
      return rows as unknown as T;
    },
  };
}

describe('PrismaPromotionProjectionSourceV1 — unsupported families', () => {
  it('reports a family it cannot read instead of returning nothing for it', async () => {
    const source = new PrismaPromotionProjectionSourceV1(fakePrisma([]));
    const result = await source.loadForScope({ fiscalYear: 2027, families: ['rdte'] });

    expect(result.unsupportedFamilies).toEqual(['rdte']);
    expect(result.projections).toHaveLength(0);
  });

  it('separates the readable family from the unreadable one in a mixed scope', async () => {
    const source = new PrismaPromotionProjectionSourceV1(fakePrisma([OM_ROW]));
    const result = await source.loadForScope({
      fiscalYear: 2027,
      families: ['om', 'procurement'],
    });

    expect(result.unsupportedFamilies).toEqual(['procurement']);
    // The readable family still produced its rows — the block is reported, not
    // achieved by refusing to read anything at all.
    expect(result.projections.length).toBeGreaterThan(0);
  });

  it('names only families outside the supported set', async () => {
    const source = new PrismaPromotionProjectionSourceV1(fakePrisma([OM_ROW]));
    const result = await source.loadForScope({ fiscalYear: 2027, families: ['om'] });

    expect(PROJECTION_SOURCE_SUPPORTED_FAMILIES_V1).toContain('om');
    expect(result.unsupportedFamilies).toEqual([]);
  });
});

describe('PrismaPromotionProjectionSourceV1 — O&M lineage', () => {
  it('carries the real lineage columns rather than rehearsal placeholders', async () => {
    const source = new PrismaPromotionProjectionSourceV1(fakePrisma([OM_ROW]));
    const { projections } = await source.loadForScope({ fiscalYear: 2027, families: ['om'] });

    const year = projections.find((entry) => entry.projectionKind === 'non_rdte:OmSagYear');
    expect(year).toBeDefined();
    expect(year!.lineage.artifactId).toBe('artifact-om');
    expect(year!.lineage.artifactContentSha256).toBe(SHA('c'));
    expect(year!.lineage.verificationCandidateId).toBe('cand-om');
    expect(year!.lineage.verificationRunId).toBe('run-om');
    expect(year!.lineage.sourcePdfSha256).toBe(SHA('d'));
    expect(year!.lineage.evidenceIds).toEqual(['ev-om']);
  });

  it('preserves the exact decimal without passing through a float', async () => {
    const source = new PrismaPromotionProjectionSourceV1(fakePrisma([OM_ROW]));
    const { projections } = await source.loadForScope({ fiscalYear: 2027, families: ['om'] });

    const year = projections.find((entry) => entry.projectionKind === 'non_rdte:OmSagYear');
    expect(year!.values.money?.valueMillions).toBe('12.345678');
    expect(year!.values.money?.originalValue).toBe('12345.678');
    expect(year!.values.money?.originalUnit).toBe('thousands');
  });

  it('derives the identity row from its own funding row, not a placeholder', async () => {
    const source = new PrismaPromotionProjectionSourceV1(fakePrisma([OM_ROW]));
    const { projections } = await source.loadForScope({ fiscalYear: 2027, families: ['om'] });

    const identity = projections.find((entry) => entry.projectionKind === 'non_rdte:OmSag');
    expect(identity).toBeDefined();
    // The identity table carries no lineage of its own; it must inherit the
    // attesting document rather than invent one.
    expect(identity!.lineage.artifactId).toBe('artifact-om');
    expect(identity!.lineage.sourcePdfSha256).toBe(SHA('d'));
  });

  it('emits one identity per SAG and one year row per funding row', async () => {
    const otherSag = {
      ...OM_ROW,
      naturalKey: 'OM_SAG:ARMY:OMA:122',
      sagCode: '122',
      amountMillions: '13.500000',
    };
    const source = new PrismaPromotionProjectionSourceV1(fakePrisma([OM_ROW, otherSag], 2));
    const { projections, refusals } = await source.loadForScope({
      fiscalYear: 2027,
      families: ['om'],
    });

    expect(refusals).toEqual([]);
    const identities = projections.filter((entry) => entry.projectionKind === 'non_rdte:OmSag');
    const years = projections.filter((entry) => entry.projectionKind === 'non_rdte:OmSagYear');
    expect(identities).toHaveLength(2);
    expect(years).toHaveLength(2);
  });

  it('returns a stage-owned funding field as a refusal rather than dropping it', async () => {
    // An OP-5 O&M projection carries no stage authority, so it may not assert
    // `enacted` — that position belongs to Phase 6's congressional lifecycle
    // with its enactment proof. The projector refuses it, and the refusal has
    // to reach the caller: a silently shortened read would produce a plan that
    // looks complete while missing a row its own scope claims.
    const enacted = { ...OM_ROW, fundingField: 'enacted', amountMillions: '13.000000' };
    const source = new PrismaPromotionProjectionSourceV1(fakePrisma([OM_ROW, enacted], 1));
    const { projections, refusals } = await source.loadForScope({
      fiscalYear: 2027,
      families: ['om'],
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.reason).toBe('stage_authority_violation');
    expect(
      projections.filter((entry) => entry.projectionKind === 'non_rdte:OmSagYear'),
    ).toHaveLength(1);
  });

  it('counts identities that carry no funding row inside the scope', async () => {
    const source = new PrismaPromotionProjectionSourceV1(fakePrisma([OM_ROW], 4));
    const result = await source.loadForScope({ fiscalYear: 2027, families: ['om'] });

    expect(result.identitiesWithoutScopedFunding).toBe(3);
  });
});

describe('PrismaPromotionProjectionSourceV1 — reload for execution', () => {
  function storedPlan(families: string[]): StoredExecutionPlanV1 {
    return {
      planId: 'plan-1',
      planHash: SHA('a'),
      eligibilityHash: SHA('e'),
      mappingRegistryHash: SHA('b'),
      mode: 'new_cycle',
      proposedSnapshotId: '99999999-9999-9999-9999-999999999999',
      expectedActiveSnapshotId: null,
      blockedCount: 0,
      plan: {
        scope: { cycleId: 'cycle-fy2027', fiscalYear: 2027, families, stages: [] },
      },
    } as unknown as StoredExecutionPlanV1;
  }

  it('refuses to reload a plan whose scope names an unreadable family', async () => {
    const source = new PrismaPromotionProjectionSourceV1(fakePrisma([]));
    // A short read here would let the executor's row-count check pass against
    // fewer rows than the plan authorized.
    await expect(source.loadForPlan(storedPlan(['milcon']))).rejects.toThrow(
      /no reader for family/,
    );
  });

  it('reloads a readable scope', async () => {
    const source = new PrismaPromotionProjectionSourceV1(fakePrisma([OM_ROW]));
    const projections = await source.loadForPlan(storedPlan(['om']));
    expect(projections.length).toBeGreaterThan(0);
  });
});
