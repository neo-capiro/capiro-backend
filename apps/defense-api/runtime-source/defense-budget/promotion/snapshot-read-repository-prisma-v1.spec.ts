import {
  buildSnapshotOverrideSqlV1,
  createSnapshotReadPortPrismaV1,
} from './snapshot-read-repository-prisma-v1.js';
import type { SnapshotCanonicalRowV1 } from './snapshot-read-repository-v1.js';

const SNAPSHOT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

function row(overrides: Partial<SnapshotCanonicalRowV1> = {}): SnapshotCanonicalRowV1 {
  return {
    snapshotId: SNAPSHOT_ID,
    canonicalEntity: 'canonical_om_sag_year',
    canonicalNaturalKey: 'ARMY|OMA|SAG-1|2027|request',
    parentNaturalKey: 'ARMY|OMA|SAG-1',
    family: 'om',
    fiscalYear: 2027,
    fundingField: 'request',
    stage: null,
    canonicalRowHash: 'a'.repeat(64),
    money: { originalValue: '1250', originalUnit: 'thousands', valueMillions: '1.25' },
    quantity: null,
    unitCostDollars: null,
    textValue: null,
    dateValue: null,
    attributes: {},
    directOrDerived: 'direct',
    lineage: {
      sourceProjectionId: 'projection-1',
      verificationCandidateId: 'candidate-1',
      verificationRunId: 'run-1',
      artifactId: 'artifact-1',
      sourceDocumentId: 'document-1',
      enactmentProofId: null,
    },
    ...overrides,
  };
}

describe('snapshot override query', () => {
  it('returns no query for an empty snapshot row set', () => {
    expect(buildSnapshotOverrideSqlV1([])).toBeNull();
  });

  it('binds every target dimension explicitly rather than querying a broad PE family/FY', () => {
    const built = buildSnapshotOverrideSqlV1([row()]);
    expect(built).not.toBeNull();
    expect(built!.params).toEqual([
      'canonical_om_sag_year',
      'ARMY|OMA|SAG-1|2027|request',
      2027,
      'request',
    ]);
    expect(built!.sql).toContain('"canonical_entity" = $1');
    expect(built!.sql).toContain('"canonical_natural_key" = $2');
    expect(built!.sql).toContain('"fiscal_year" IS NOT DISTINCT FROM $3::int');
    expect(built!.sql).toContain('"funding_field" IS NOT DISTINCT FROM $4');
  });

  it('deduplicates an identical target before building SQL', () => {
    const built = buildSnapshotOverrideSqlV1([row(), row()]);
    expect(built!.params).toHaveLength(4);
    expect((built!.sql.match(/canonical_entity/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('keeps nullable FY/field target identity explicit', () => {
    const built = buildSnapshotOverrideSqlV1([
      row({
        canonicalNaturalKey: 'ARMY|OMA|SAG-1',
        fiscalYear: null,
        fundingField: null,
      }),
    ]);
    expect(built!.params).toEqual(['canonical_om_sag_year', 'ARMY|OMA|SAG-1', null, null]);
    expect(built!.sql).toContain('IS NOT DISTINCT FROM');
  });

  it('loads all versions for exact selected rows so lifecycle selection happens after retrieval', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const prisma = {
      async $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T> {
        queries.push({ sql, params });
        if (sql.includes('defense_budget_manual_override')) return [] as unknown as T;
        return [] as unknown as T;
      },
    };
    const port = createSnapshotReadPortPrismaV1(prisma);
    await port.loadManualOverridesForRows!([row()]);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('ORDER BY');
    expect(queries[0]!.sql).toContain('"version" DESC');
    expect(queries[0]!.sql).not.toContain("status = 'approved'");
  });
});
