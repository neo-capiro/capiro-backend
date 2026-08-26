import {
  PrismaPromotionEligibilityReadRepositoryV1,
  PromotionEligibilityReadUnavailableErrorV1,
  type EligibilityReadPrismaLikeV1,
} from './promotion-eligibility-read-repository-prisma-v1.js';
import { buildProjectionPlanRecordV1 } from '../projection-plan/projection-plan-record-v1.js';

const SHA = (c: string) => c.repeat(64);

/**
 * Routes each query to a canned result by matching the table it reads, so tests
 * describe *what* is in storage rather than the order the adapter happens to
 * ask for it.
 */
class TableRoutedPrisma implements EligibilityReadPrismaLikeV1 {
  readonly queries: { sql: string; values: unknown[] }[] = [];
  tables: Record<string, unknown[]> = {};

  async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
    this.queries.push({ sql: query, values });
    for (const [table, rows] of Object.entries(this.tables)) {
      if (query.includes(`"${table}"`)) return rows as unknown as T;
    }
    return [] as unknown as T;
  }

  async $executeRawUnsafe(): Promise<number> {
    throw new Error('the eligibility read repository must never write');
  }

  sqlFor(table: string): string {
    const hit = this.queries.find((q) => q.sql.includes(`"${table}"`));
    return (hit?.sql ?? '').replace(/\s+/g, ' ').trim();
  }
}

function candidateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidateId: '11111111-1111-1111-1111-111111111111',
    status: 'VERIFICATION_PASSED',
    terminalVerificationRunId: 'run-1',
    family: 'om',
    extractionMethod: 'deterministic_pdfplumber',
    artifactSha256: SHA('a'),
    sourceSha256: SHA('b'),
    verificationPolicySha256: SHA('c'),
    manifestSha256: SHA('d'),
    reviewDecisionId: null,
    reviewerActorId: null,
    acceptedAssertionIds: ['assert-1'],
    sourceProfileSha256: null,
    sourceProfileHashCount: 0,
    ...overrides,
  };
}

function planRow(
  overrides: { family?: string; candidates?: unknown[]; contentSha256?: string } = {},
): Record<string, unknown> {
  const record = buildProjectionPlanRecordV1({
    family: overrides.family ?? 'om',
    producerVersion: 'p@1',
    certificationId: null,
    certificationSha256: SHA('c'),
    planDocument: {
      schemaVersion: 'non_rdte_canonical_projection_plan_v1',
      cycleId: 'cycle-fy2027',
      fiscalYear: 2027,
      contentSha256: overrides.contentSha256 ?? SHA('1'),
      candidates: overrides.candidates ?? [
        { operation: 'insert', artifactContentSha256: SHA('a') },
      ],
    },
  });
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

describe('loadCycleCertifications', () => {
  it('maps committee rows and scopes by cycle and fiscal year when committee is requested', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      phase6_cycle_certification: [
        { certificationId: 'cert-a', contentSha256: SHA('1'), status: 'CERTIFIED' },
        { certificationId: 'cert-b', contentSha256: SHA('2'), status: 'DRAFT' },
      ],
    };
    const repo = new PrismaPromotionEligibilityReadRepositoryV1(prisma);

    await expect(
      repo.loadCycleCertifications('cycle-fy2027', 2027, ['committee']),
    ).resolves.toEqual([
      { certificationId: 'cert-a', contentSha256: SHA('1'), status: 'CERTIFIED' },
      { certificationId: 'cert-b', contentSha256: SHA('2'), status: 'DRAFT' },
    ]);
    expect(prisma.queries[0]?.values).toEqual(['cycle-fy2027', 2027]);
  });

  it('returns uncertified committee rows too, because "none certified" is a distinct refusal', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      phase6_cycle_certification: [
        { certificationId: 'cert-b', contentSha256: SHA('2'), status: 'DRAFT' },
      ],
    };
    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(prisma).loadCycleCertifications('c', 2027, [
        'committee',
      ]),
    ).resolves.toHaveLength(1);
  });

  it('never queries phase6_cycle_certification when committee is not requested', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      phase6_cycle_certification: [
        { certificationId: 'cert-a', contentSha256: SHA('1'), status: 'CERTIFIED' },
      ],
    };
    await new PrismaPromotionEligibilityReadRepositoryV1(prisma).loadCycleCertifications(
      'c',
      2027,
      ['om'],
    );
    expect(prisma.queries.some((q) => q.sql.includes('phase6_cycle_certification'))).toBe(false);
  });

  /* -- Phase 10B-2C: embedded-bundle families (rdte/procurement/om/milcon) -- */

  function embeddedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      family: 'om',
      projectionPlanId: 'pp-om-1',
      certificationSha256: SHA('e'),
      status: 'PROJECTABLE',
      planDocument: { certification: 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION' },
      ...overrides,
    };
  }

  it.each([['rdte' as const], ['procurement' as const], ['om' as const], ['milcon' as const]])(
    'reads %s certification from the embedded bundle on defense_budget_projection_plan',
    async (family) => {
      const prisma = new TableRoutedPrisma();
      prisma.tables = {
        defense_budget_projection_plan: [embeddedRow({ family })],
      };
      const repo = new PrismaPromotionEligibilityReadRepositoryV1(prisma);

      const result = await repo.loadCycleCertifications('cycle-fy2027', 2027, [family]);

      expect(result).toEqual([
        { certificationId: 'plan:pp-om-1', contentSha256: SHA('e'), status: 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION' },
      ]);
      // Scoped by exact cycle + family, never by fiscalYear for this path
      // (defense_budget_projection_plan has no fiscalYear column in this query).
      expect(prisma.queries[0]?.values).toEqual(['cycle-fy2027', family]);
      // Must never query phase6_cycle_certification for a non-committee-only request.
      expect(prisma.queries.some((q) => q.sql.includes('phase6_cycle_certification'))).toBe(false);
    },
  );

  it('reports a non-CERTIFIED embedded status rather than dropping the row', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      defense_budget_projection_plan: [
        embeddedRow({ status: 'BLOCKED', planDocument: { certification: 'REJECTED' } }),
      ],
    };
    const result = await new PrismaPromotionEligibilityReadRepositoryV1(
      prisma,
    ).loadCycleCertifications('c', 2027, ['om']);
    expect(result).toEqual([{ certificationId: 'plan:pp-om-1', contentSha256: SHA('e'), status: 'REJECTED' }]);
  });

  it('mixes committee and embedded-bundle families in one call without conflating them', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      phase6_cycle_certification: [
        { certificationId: 'cert-committee', contentSha256: SHA('f'), status: 'CERTIFIED' },
      ],
      defense_budget_projection_plan: [embeddedRow()],
    };
    const result = await new PrismaPromotionEligibilityReadRepositoryV1(
      prisma,
    ).loadCycleCertifications('c', 2027, ['om', 'committee']);

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        { certificationId: 'cert-committee', contentSha256: SHA('f'), status: 'CERTIFIED' },
        { certificationId: 'plan:pp-om-1', contentSha256: SHA('e'), status: 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION' },
      ]),
    );
  });

  it('a family with no supported certifier (alternative_funding is not a BudgetFamilyV1, so use an unsupported member) contributes nothing and issues no query for it', async () => {
    // BudgetFamilyV1 has no alternative_funding/execution member (those are
    // AuthorityTrack values) — the closest in-contract analog of "requested
    // but structurally unsupported" is a family this repository does not
    // recognize as either committee or an embedded-bundle family, e.g.
    // 'unknown' or 'public_law'. Neither should ever touch either table.
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      phase6_cycle_certification: [
        { certificationId: 'cert-a', contentSha256: SHA('1'), status: 'CERTIFIED' },
      ],
      defense_budget_projection_plan: [embeddedRow()],
    };
    const result = await new PrismaPromotionEligibilityReadRepositoryV1(
      prisma,
    ).loadCycleCertifications('c', 2027, ['unknown']);

    expect(result).toEqual([]);
    expect(prisma.queries).toEqual([]);
  });

  it('scopes the embedded-bundle query by exact family — a different family in the same cycle is excluded from the query', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      defense_budget_projection_plan: [embeddedRow({ family: 'om' })],
    };
    await new PrismaPromotionEligibilityReadRepositoryV1(prisma).loadCycleCertifications(
      'c',
      2027,
      ['rdte'],
    );
    // The SQL scopes by family IN (...) with 'rdte' bound — 'om' rows in the
    // fake are irrelevant here because the real query would filter them out;
    // this test proves the adapter sent 'rdte', not 'om', as the bound value.
    expect(prisma.queries[0]?.values).toEqual(['c', 'rdte']);
  });
});

describe('loadLatestTerminalRunId', () => {
  it('returns the newest run and casts the candidate id to uuid', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = { budget_verification_run_v1: [{ runId: 'run-9' }] };
    const repo = new PrismaPromotionEligibilityReadRepositoryV1(prisma);

    await expect(repo.loadLatestTerminalRunId(SHA('1').slice(0, 8))).resolves.toBe('run-9');
    expect(prisma.sqlFor('budget_verification_run_v1')).toContain('"candidate_id" = $1::uuid');
  });

  it('does not filter by run status, so a review-accepted candidate is not called stale', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = { budget_verification_run_v1: [{ runId: 'r' }] };
    await new PrismaPromotionEligibilityReadRepositoryV1(prisma).loadLatestTerminalRunId('x');
    expect(prisma.sqlFor('budget_verification_run_v1')).not.toContain('VERIFICATION_PASSED');
  });

  it('returns null when the candidate has no runs', async () => {
    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(
        new TableRoutedPrisma(),
      ).loadLatestTerminalRunId('x'),
    ).resolves.toBeNull();
  });
});

describe('loadActiveSnapshot', () => {
  it('joins the activation pointer to the snapshot it names', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      defense_budget_active_snapshot: [
        { snapshotId: 'snap-1', snapshotHash: SHA('3'), status: 'ACTIVE' },
      ],
    };
    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(prisma).loadActiveSnapshot(
        'defense_budget',
        'dev',
      ),
    ).resolves.toEqual({ snapshotId: 'snap-1', snapshotHash: SHA('3') });
  });

  it('returns null when no activation pointer exists', async () => {
    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(new TableRoutedPrisma()).loadActiveSnapshot(
        'defense_budget',
        'dev',
      ),
    ).resolves.toBeNull();
  });

  it('refuses an activation pointer naming an unhashed snapshot instead of reporting "none"', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      defense_budget_active_snapshot: [
        { snapshotId: 'snap-broken', snapshotHash: null, status: 'STAGING' },
      ],
    };
    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(prisma).loadActiveSnapshot(
        'defense_budget',
        'dev',
      ),
    ).rejects.toThrow(/must never name an unhashed snapshot/);
  });
});

/* ------------------------------------------------------------------ */
/* Gap 5 decision 1 — candidates                                       */
/* ------------------------------------------------------------------ */

describe('loadCandidates', () => {
  it('reads the denormalized family and extraction method', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = { budget_extraction_candidate_v1: [candidateRow()] };

    const [candidate] = await new PrismaPromotionEligibilityReadRepositoryV1(
      prisma,
    ).loadCandidates('cycle-fy2027', ['om']);

    expect(candidate).toMatchObject({
      family: 'om',
      extractionMethod: 'deterministic_pdfplumber',
      sourceProfileSha256: null,
      acceptedAssertionIds: ['assert-1'],
    });
  });

  it('scopes by family in SQL rather than filtering in memory', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = { budget_extraction_candidate_v1: [candidateRow()] };
    await new PrismaPromotionEligibilityReadRepositoryV1(prisma).loadCandidates('cycle-fy2027', [
      'om',
      'rdte',
    ]);

    const sql = prisma.sqlFor('budget_extraction_candidate_v1');
    expect(sql).toContain('c."family" IN ($2, $3)');
    expect(prisma.queries[0]?.values).toEqual(['cycle-fy2027', 'om', 'rdte']);
  });

  it('queries nothing at all for an empty family scope', async () => {
    const prisma = new TableRoutedPrisma();
    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(prisma).loadCandidates('c', []),
    ).resolves.toEqual([]);
    expect(prisma.queries).toEqual([]);
  });

  it('refuses a candidate whose metadata was never backfilled', async () => {
    // The defaulting this exists to prevent: a null extraction method fed into
    // isHighRiskExtractionMethodV1 would make the authorizer-equals-extractor
    // control vacuous.
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      budget_extraction_candidate_v1: [candidateRow({ extractionMethod: null })],
    };
    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(prisma).loadCandidates('c', ['om']),
    ).rejects.toBeInstanceOf(PromotionEligibilityReadUnavailableErrorV1);
  });

  it('names the backfill command in the refusal', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = { budget_extraction_candidate_v1: [candidateRow({ family: null })] };
    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(prisma).loadCandidates('c', ['om']),
    ).rejects.toThrow(/backfill-budget-candidate-source-metadata-v1/);
  });

  it('resolves a governed family source profile from its Phase 6 projections', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      budget_extraction_candidate_v1: [
        candidateRow({
          family: 'committee',
          sourceProfileSha256: SHA('e'),
          sourceProfileHashCount: 1,
        }),
      ],
    };

    const [candidate] = await new PrismaPromotionEligibilityReadRepositoryV1(
      prisma,
    ).loadCandidates('c', ['committee']);

    expect(candidate?.sourceProfileSha256).toBe(SHA('e'));
  });

  it('nulls the profile for an ungoverned family even if a hash somehow exists', async () => {
    // The fabrication direction: the eligibility contract refuses a non-null
    // profile on an ungoverned family, so the repository must not supply one.
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      budget_extraction_candidate_v1: [
        candidateRow({ family: 'rdte', sourceProfileSha256: SHA('e'), sourceProfileHashCount: 1 }),
      ],
    };

    const [candidate] = await new PrismaPromotionEligibilityReadRepositoryV1(
      prisma,
    ).loadCandidates('c', ['rdte']);

    expect(candidate?.sourceProfileSha256).toBeNull();
  });

  it('refuses a governed candidate spanning two distinct source profiles', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      budget_extraction_candidate_v1: [
        candidateRow({
          family: 'committee',
          sourceProfileSha256: SHA('e'),
          sourceProfileHashCount: 2,
        }),
      ],
    };
    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(prisma).loadCandidates('c', ['committee']),
    ).rejects.toThrow(/spans 2 distinct stage source profiles/);
  });

  it('refuses a malformed accepted-assertion list rather than reporting none accepted', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      budget_extraction_candidate_v1: [candidateRow({ acceptedAssertionIds: { nope: true } })],
    };
    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(prisma).loadCandidates('c', ['om']),
    ).rejects.toThrow(/malformed acceptedAssertionIds/);
  });

  it('accepts the assertion list as JSON text, as raw SQL returns it', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      budget_extraction_candidate_v1: [
        candidateRow({ acceptedAssertionIds: '["assert-1","assert-2"]' }),
      ],
    };
    const [candidate] = await new PrismaPromotionEligibilityReadRepositoryV1(
      prisma,
    ).loadCandidates('c', ['om']);
    expect(candidate?.acceptedAssertionIds).toEqual(['assert-1', 'assert-2']);
  });
});

/* ------------------------------------------------------------------ */
/* Gap 5 decisions 3 and 4 — plans and conflicts                       */
/* ------------------------------------------------------------------ */

describe('loadProjectionPlans', () => {
  it('returns the persisted plan id and content hash', async () => {
    const prisma = new TableRoutedPrisma();
    const row = planRow();
    prisma.tables = { defense_budget_projection_plan: [row] };

    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(prisma).loadProjectionPlans('cycle-fy2027', [
        'om',
      ]),
    ).resolves.toEqual([
      { projectionPlanId: row.projectionPlanId, contentSha256: row.contentSha256 },
    ]);
  });

  it('returns nothing when the producer has filed no plan for the scope', async () => {
    // Not an error here: the service turns an empty plan list into its own
    // `projection_hash_mismatch` refusal, which is the operator-facing message.
    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(new TableRoutedPrisma()).loadProjectionPlans(
        'c',
        ['om'],
      ),
    ).resolves.toEqual([]);
  });

  it('refuses a stored plan whose document no longer matches its content hash', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      defense_budget_projection_plan: [{ ...planRow(), contentSha256: SHA('9') }],
    };
    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(prisma).loadProjectionPlans('c', ['om']),
    ).rejects.toThrow(/storage was tampered with/);
  });
});

describe('conflict and unsupported counts come from the persisted plan', () => {
  it('counts operation === conflict across the scope', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      defense_budget_projection_plan: [
        planRow({
          candidates: [
            { operation: 'insert', artifactContentSha256: SHA('a') },
            { operation: 'conflict', artifactContentSha256: SHA('a') },
          ],
        }),
      ],
    };

    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(prisma).countOpenBlockingConflicts('c', [
        'om',
      ]),
    ).resolves.toBe(1);
  });

  it('counts blocking exclusions as unsupported and ignores by-design ones', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      defense_budget_projection_plan: [
        planRow({
          candidates: [
            {
              operation: 'no_op',
              artifactContentSha256: SHA('a'),
              exclusionReason: 'duplicate_conflict',
            },
            {
              operation: 'no_op',
              artifactContentSha256: SHA('a'),
              exclusionReason: 'contextual_only_value',
            },
          ],
        }),
      ],
    };

    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(prisma).countUnsupportedProjections('c', [
        'om',
      ]),
    ).resolves.toBe(1);
  });

  it('reads zero from a genuinely clean plan, not from an absent one', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = { defense_budget_projection_plan: [planRow()] };
    const repo = new PrismaPromotionEligibilityReadRepositoryV1(prisma);

    await expect(repo.countOpenBlockingConflicts('c', ['om'])).resolves.toBe(0);
    await expect(repo.countUnsupportedProjections('c', ['om'])).resolves.toBe(0);
    // The plan really was read, so this zero is evidence rather than a stub.
    expect(prisma.sqlFor('defense_budget_projection_plan')).toContain(
      'FROM "defense_budget_projection_plan"',
    );
  });

  it('refuses rather than counting zero when a stored summary disagrees with its document', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      defense_budget_projection_plan: [{ ...planRow(), status: 'BLOCKED', conflictCount: 4 }],
    };
    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(prisma).countOpenBlockingConflicts('c', [
        'om',
      ]),
    ).rejects.toThrow(/stored summary disagrees with its document/);
  });

  it('refuses an unclassified exclusion reason rather than treating it as harmless', async () => {
    const prisma = new TableRoutedPrisma();
    prisma.tables = {
      defense_budget_projection_plan: [
        {
          ...planRow(),
          planDocument: {
            schemaVersion: 'non_rdte_canonical_projection_plan_v1',
            cycleId: 'cycle-fy2027',
            fiscalYear: 2027,
            contentSha256: SHA('1'),
            candidates: [
              {
                operation: 'no_op',
                artifactContentSha256: SHA('a'),
                exclusionReason: 'brand_new_reason',
              },
            ],
          },
        },
      ],
    };
    await expect(
      new PrismaPromotionEligibilityReadRepositoryV1(prisma).countUnsupportedProjections('c', [
        'om',
      ]),
    ).rejects.toThrow(/is not classified/);
  });

  it('never writes', async () => {
    const prisma = new TableRoutedPrisma();
    await expect(prisma.$executeRawUnsafe()).rejects.toThrow(/must never write/);
  });
});
