import {
  createReviewAcceptanceRepositoryV1,
  reviewAcceptanceSqlV1,
  reviewAcceptancePreviewSqlV1,
  computeReviewDecisionHashV1,
  ReviewAcceptanceValidationErrorV1,
  ACCEPTANCE_POLICY_ID_V1,
  ACCEPTANCE_POLICY_HASH_V1,
} from './defense-budget-ingestion-outbox-review-acceptance-v1.js';
import type { ReadCheckV1, ReadDiscrepancyV1 } from '../verification/persistence/verification-repository.js';

const NOW = new Date('2026-08-30T00:00:00.000Z');
const ROW_ID = '1c6b97bf-e978-4d14-b015-97b88d6b8de3';
const SOURCE_DOCUMENT_ID = '62e8a102-4f01-471b-9cb6-eab58cb41270';
const CANDIDATE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const RUN_ID = 'rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr';
const REVIEW_DECISION_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const ARTIFACT_SHA = 'a'.repeat(64);
const SOURCE_SHA = 'b'.repeat(64);
const MANIFEST_SHA = 'c'.repeat(64);

describe('review acceptance -- structural SQL guarantees', () => {
  test('acceptance is one statement naming exactly one table', () => {
    const sql = reviewAcceptanceSqlV1();
    expect(sql.trim().split(';')).toHaveLength(1);
    expect(sql).toContain('"defense_budget_ingestion_outbox"');
    expect(sql).not.toMatch(
      /budget_verification_run_v1|budget_verification_check_v1|budget_verification_discrepancy_v1|budget_review_decision_v1|budget_extraction_candidate_v1/,
    );
  });

  test('acceptance is exact-row only: WHERE filters on the named id, never a batch/family/FY predicate', () => {
    const sql = reviewAcceptanceSqlV1();
    expect(sql).toContain('o."id"=$1::uuid');
    expect(sql).not.toMatch(/LIMIT|ORDER BY/);
  });

  test('eligibility requires dead_letter, unleased, review_required + REVIEW, exact source document -- all in the WHERE', () => {
    const sql = reviewAcceptanceSqlV1();
    expect(sql).toContain(`o."state"='dead_letter'`);
    expect(sql).toContain(`o."leased_by" IS NULL`);
    expect(sql).toContain(`o."metadata_jsonb"->>'governedDisposition'='review_required'`);
    expect(sql).toContain(`o."metadata_jsonb"->>'verifierDecision'='REVIEW'`);
    expect(sql).toContain(`o."metadata_jsonb"->>'sourceDocumentId'=$5::text`);
  });

  test('takes the row lock before mutating (FOR UPDATE)', () => {
    expect(reviewAcceptanceSqlV1()).toContain('FOR UPDATE OF o');
  });

  test('transitions to succeeded and clears the lease/error, matching markSucceeded semantics', () => {
    const sql = reviewAcceptanceSqlV1();
    expect(sql).toContain(`"state"='succeeded'`);
    expect(sql).toContain('"leased_by"=NULL');
    expect(sql).toContain('"leased_until"=NULL');
    expect(sql).toContain('"last_error"=NULL');
  });

  test('sets readinessPhase=pending, never a different phase', () => {
    expect(reviewAcceptanceSqlV1()).toContain(`'readinessPhase', 'pending'`);
  });

  test('preserves verifierDecision/governedDisposition truthfully -- never deletes or overwrites them to look like PASS', () => {
    const sql = reviewAcceptanceSqlV1();
    expect(sql).not.toMatch(/-\s*'governedDisposition'/);
    expect(sql).not.toMatch(/-\s*'verifierDecision'/);
    expect(sql).not.toMatch(/'verifierDecision',\s*'PASS'/);
  });

  test('acceptance history is appended, never replacing prior entries', () => {
    expect(reviewAcceptanceSqlV1()).toMatch(
      /COALESCE\(t\."metadata_jsonb"->'governedAcceptanceHistory', '\[\]'::jsonb\)\s*\|\|/,
    );
  });

  test('preview is read-only: a plain SELECT, no UPDATE/INSERT/DELETE keyword', () => {
    const sql = reviewAcceptancePreviewSqlV1();
    expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
    expect(sql).not.toMatch(/UPDATE|INSERT|DELETE/i);
  });
});

describe('review acceptance -- fail-closed input validation (never reaches the database)', () => {
  function fakeVerificationRepo() {
    return { readChecks: async () => [], readDiscrepancies: async () => [] };
  }

  test('missing actor refuses before any query is issued', async () => {
    const calls: string[] = [];
    const prisma = { async $queryRawUnsafe<T>(sql: string) { calls.push(sql); return [] as T; } };
    const repo = createReviewAcceptanceRepositoryV1(prisma, fakeVerificationRepo());
    await expect(
      repo.acceptReviewedIngestionV1({
        rowId: ROW_ID,
        reviewDecisionId: REVIEW_DECISION_ID,
        now: NOW,
        actor: '  ',
        reason: 'human accepted the irreducible omissions',
      }),
    ).rejects.toThrow(ReviewAcceptanceValidationErrorV1);
    expect(calls).toHaveLength(0);
  });

  test('missing reason refuses before any query is issued', async () => {
    const calls: string[] = [];
    const prisma = { async $queryRawUnsafe<T>(sql: string) { calls.push(sql); return [] as T; } };
    const repo = createReviewAcceptanceRepositoryV1(prisma, fakeVerificationRepo());
    await expect(
      repo.acceptReviewedIngestionV1({
        rowId: ROW_ID,
        reviewDecisionId: REVIEW_DECISION_ID,
        now: NOW,
        actor: 'neo@capiro.ai',
        reason: '',
      }),
    ).rejects.toThrow(ReviewAcceptanceValidationErrorV1);
    expect(calls).toHaveLength(0);
  });

  test('missing reviewDecisionId refuses before any query is issued', async () => {
    const calls: string[] = [];
    const prisma = { async $queryRawUnsafe<T>(sql: string) { calls.push(sql); return [] as T; } };
    const repo = createReviewAcceptanceRepositoryV1(prisma, fakeVerificationRepo());
    await expect(
      repo.acceptReviewedIngestionV1({
        rowId: ROW_ID,
        reviewDecisionId: '',
        now: NOW,
        actor: 'neo@capiro.ai',
        reason: 'human accepted the irreducible omissions',
      }),
    ).rejects.toThrow(ReviewAcceptanceValidationErrorV1);
    expect(calls).toHaveLength(0);
  });
});

describe('review acceptance -- eligibility and state-transition outcomes against a stateful fake', () => {
  const OMISSION_DISCREPANCY: ReadDiscrepancyV1 = {
    discrepancyId: 'disc-omission-1',
    code: 'review_omission',
    severity: 'review',
    description:
      'review omission for source fact "sf1": R-1 omission: 3 trailing numeric tokens (need 4 or 5 for a confident column mapping) -- ambiguous, not guessed at page 56: 54 1201017SF Global Sensor Integrated on Network (GSIN) 07 U 4,574 5,321 5,321',
    assertionIds: [],
    evidenceIds: [],
    referenceArtifactIds: [],
  };

  function passingCheck(code: string, overrides: Partial<ReadCheckV1> = {}): ReadCheckV1 {
    return {
      checkId: `chk-${code}`,
      code,
      ruleVersion: 'v1',
      outcome: 'PASS',
      required: true,
      blocking: true,
      riskPoints: 0,
      message: 'ok',
      assertionIds: [],
      evidenceIds: [],
      referenceArtifactIds: [],
      ...overrides,
    };
  }

  const ALL_PASSING_CHECKS: ReadCheckV1[] = [
    passingCheck('identity_validation'),
    passingCheck('numeric_validation'),
    passingCheck('r1_specific'),
    passingCheck('duplicate_detection'),
    passingCheck('warning_policy'),
    passingCheck('money_evidence_policy'),
    passingCheck('page_only_reconciliation'),
    passingCheck('rdte_summary_detail'),
    passingCheck('completeness', { outcome: 'NOT_RUN' }),
  ];

  class StatefulFakeV1 {
    outbox: Map<string, Record<string, unknown>>;
    reviewDecisions: Map<string, Record<string, unknown>>;
    runs: Map<string, Record<string, unknown>>;
    candidates: Map<string, Record<string, unknown>>;
    checksByRun: Map<string, ReadCheckV1[]>;
    discrepanciesByRun: Map<string, ReadDiscrepancyV1[]>;

    constructor() {
      this.outbox = new Map([
        [
          ROW_ID,
          {
            id: ROW_ID,
            state: 'dead_letter',
            leased_by: null,
            metadata_jsonb: {
              sourceDocumentId: SOURCE_DOCUMENT_ID,
              governedDisposition: 'review_required',
              verifierDecision: 'REVIEW',
            },
          },
        ],
        // 8 legacy rows, structurally untouched by a target-row acceptance.
        ...Array.from({ length: 8 }, (_, i) => {
          const id = `legacy-${i}`;
          return [
            id,
            {
              id,
              state: 'dead_letter',
              leased_by: null,
              metadata_jsonb: {
                sourceDocumentId: `legacy-doc-${i}`,
                governedDisposition: 'review_required',
                verifierDecision: 'REVIEW',
              },
            },
          ] as const;
        }),
      ]);
      this.reviewDecisions = new Map([
        [
          REVIEW_DECISION_ID,
          {
            id: REVIEW_DECISION_ID,
            candidate_id: CANDIDATE_ID,
            run_id: RUN_ID,
            decision: 'accept',
            source_sha256: SOURCE_SHA,
            extraction_artifact_sha256: ARTIFACT_SHA,
            manifest_content_sha256: MANIFEST_SHA,
            created_at: '2026-08-29T00:00:00.000Z',
          },
        ],
      ]);
      this.runs = new Map([[RUN_ID, { id: RUN_ID, candidate_id: CANDIDATE_ID, decision: 'REVIEW' }]]);
      this.candidates = new Map([
        [
          CANDIDATE_ID,
          {
            id: CANDIDATE_ID,
            source_document_id: SOURCE_DOCUMENT_ID,
            extraction_artifact_id: 'art-1',
            extraction_artifact_sha256: ARTIFACT_SHA,
            source_sha256: SOURCE_SHA,
            manifest_content_sha256: MANIFEST_SHA,
            policy_version: 'v1',
            policy_sha256: 'p'.repeat(64),
          },
        ],
      ]);
      this.checksByRun = new Map([[RUN_ID, ALL_PASSING_CHECKS]]);
      this.discrepanciesByRun = new Map([[RUN_ID, [OMISSION_DISCREPANCY]]]);
    }

    verificationRepo() {
      return {
        readChecks: async (runId: string) => this.checksByRun.get(runId) ?? [],
        readDiscrepancies: async (runId: string) => this.discrepanciesByRun.get(runId) ?? [],
      };
    }

    async $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> {
      if (sql.includes('governedAcceptanceHistory')) {
        const [rowId, nowIso, actor, reason, sourceDocumentId] = values as [
          string,
          string,
          string,
          string,
          string,
        ];
        const row = this.outbox.get(rowId);
        if (!row) return [] as T;
        const metadata = (row.metadata_jsonb ?? {}) as Record<string, unknown>;
        const eligible =
          row.state === 'dead_letter' &&
          row.leased_by == null &&
          metadata.governedDisposition === 'review_required' &&
          metadata.verifierDecision === 'REVIEW' &&
          metadata.sourceDocumentId === sourceDocumentId;
        if (!eligible) return [] as T;
        row.state = 'succeeded';
        row.leased_by = null;
        (row as Record<string, unknown>).leased_until = null;
        (row as Record<string, unknown>).last_error = null;
        row.metadata_jsonb = {
          ...metadata,
          readinessPhase: 'pending',
          readinessAttempts: 0,
          ingestionResolution: 'governed_review_accepted',
          reviewDecisionId: values[5],
          reviewDecisionHash: values[6],
          reviewAcceptedAt: nowIso,
          reviewAcceptedBy: actor,
          acceptancePolicyId: values[7],
          acceptancePolicyHash: values[8],
          governedAcceptanceHistory: [
            ...((metadata.governedAcceptanceHistory as unknown[]) ?? []),
            { acceptedAt: nowIso, acceptedBy: actor, reason },
          ],
        };
        return [{ id: rowId }] as T;
      }
      if (sql.includes('review_decision_id')) {
        const [reviewDecisionId] = values as [string];
        const rd = this.reviewDecisions.get(reviewDecisionId);
        if (!rd) return [] as T;
        const run = this.runs.get(String(rd.run_id));
        if (!run || run.candidate_id !== rd.candidate_id) return [] as T;
        const candidate = this.candidates.get(String(rd.candidate_id));
        if (!candidate) return [] as T;
        return [
          {
            review_decision_id: rd.id,
            candidate_id: rd.candidate_id,
            run_id: rd.run_id,
            review_decision: rd.decision,
            rd_source_sha256: rd.source_sha256,
            rd_artifact_sha256: rd.extraction_artifact_sha256,
            rd_manifest_sha256: rd.manifest_content_sha256,
            review_decision_created_at: rd.created_at,
            run_decision: run.decision,
            run_candidate_id: run.candidate_id,
            policy_version: candidate.policy_version,
            policy_sha256: candidate.policy_sha256,
            candidate_source_document_id: candidate.source_document_id,
            candidate_artifact_id: candidate.extraction_artifact_id,
            candidate_artifact_sha256: candidate.extraction_artifact_sha256,
            candidate_source_sha256: candidate.source_sha256,
            candidate_manifest_sha256: candidate.manifest_content_sha256,
          },
        ] as T;
      }
      // preview
      const [rowId] = values as [string];
      const row = this.outbox.get(rowId);
      if (!row) return [] as T;
      const metadata = (row.metadata_jsonb ?? {}) as Record<string, unknown>;
      return [
        {
          id: row.id,
          state: row.state,
          governed_disposition: metadata.governedDisposition ?? null,
          verifier_decision: metadata.verifierDecision ?? null,
          source_document_id: metadata.sourceDocumentId ?? null,
          leased_by: row.leased_by,
        },
      ] as T;
    }
  }

  test('eligible REVIEW dead_letter row + accepted decision + all reconcilable checks PASS + only allowed irreducible omissions -> succeeded, readiness pending', async () => {
    const fake = new StatefulFakeV1();
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'human accepted the irreducible ambiguous-trailing-numeric-count omissions',
    });
    expect(result).toEqual({ ok: true, id: ROW_ID, readinessPhase: 'pending' });
    const row = fake.outbox.get(ROW_ID)!;
    expect(row.state).toBe('succeeded');
    expect(row.leased_by).toBeNull();
    const metadata = row.metadata_jsonb as Record<string, unknown>;
    expect(metadata.readinessPhase).toBe('pending');
    expect(metadata.verifierDecision).toBe('REVIEW'); // never erased
    expect(metadata.governedDisposition).toBe('review_required'); // never erased
    expect(metadata.ingestionResolution).toBe('governed_review_accepted');
    expect(metadata.reviewDecisionId).toBe(REVIEW_DECISION_ID);
    expect(Array.isArray(metadata.governedAcceptanceHistory)).toBe(true);
    expect((metadata.governedAcceptanceHistory as unknown[]).length).toBe(1);
  });

  test('REVIEW + no acceptance recorded (unknown review decision id) -> remains terminal', async () => {
    const fake = new StatefulFakeV1();
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: 'review_decision_not_found' }),
    );
    expect(fake.outbox.get(ROW_ID)!.state).toBe('dead_letter');
  });

  test('REVIEW + rejected review decision -> remains terminal', async () => {
    const fake = new StatefulFakeV1();
    fake.reviewDecisions.get(REVIEW_DECISION_ID)!.decision = 'reject';
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'review_decision_not_accept' }));
    expect(fake.outbox.get(ROW_ID)!.state).toBe('dead_letter');
  });

  test('REVIEW + accepted decision but money_evidence_policy NOT_RUN -> remains terminal', async () => {
    const fake = new StatefulFakeV1();
    fake.checksByRun.set(
      RUN_ID,
      ALL_PASSING_CHECKS.map((c) => (c.code === 'money_evidence_policy' ? { ...c, outcome: 'NOT_RUN' } : c)),
    );
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('acceptance_ineligible');
      expect(result.detail).toMatch(/money_evidence_policy/);
    }
    expect(fake.outbox.get(ROW_ID)!.state).toBe('dead_letter');
  });

  test('REVIEW + accepted decision but page_only_reconciliation NOT_RUN -> remains terminal', async () => {
    const fake = new StatefulFakeV1();
    fake.checksByRun.set(
      RUN_ID,
      ALL_PASSING_CHECKS.map((c) =>
        c.code === 'page_only_reconciliation' ? { ...c, outcome: 'NOT_RUN' } : c,
      ),
    );
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/page_only_reconciliation/);
    expect(fake.outbox.get(ROW_ID)!.state).toBe('dead_letter');
  });

  test('REVIEW + accepted decision but required rdte_summary_detail NOT_RUN -> remains terminal', async () => {
    const fake = new StatefulFakeV1();
    fake.checksByRun.set(
      RUN_ID,
      ALL_PASSING_CHECKS.map((c) =>
        c.code === 'rdte_summary_detail' ? { ...c, outcome: 'NOT_RUN', required: true } : c,
      ),
    );
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/rdte_summary_detail/);
    expect(fake.outbox.get(ROW_ID)!.state).toBe('dead_letter');
  });

  test('rdte_summary_detail NOT_RUN but not policy-required -> does not block eligibility on its own', async () => {
    const fake = new StatefulFakeV1();
    fake.checksByRun.set(
      RUN_ID,
      ALL_PASSING_CHECKS.map((c) =>
        c.code === 'rdte_summary_detail' ? { ...c, outcome: 'NOT_RUN', required: false } : c,
      ),
    );
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(result.ok).toBe(true);
  });

  test('an unrecognized (non-allow-listed) review-severity discrepancy fails closed', async () => {
    const fake = new StatefulFakeV1();
    fake.discrepanciesByRun.set(RUN_ID, [
      { ...OMISSION_DISCREPANCY, discrepancyId: 'disc-unknown', description: 'some brand new, never-seen review condition' },
    ]);
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('acceptance_ineligible');
      expect(result.eligibility?.unrecognizedDiscrepancyIds).toContain('disc-unknown');
    }
  });

  test('any FAIL check refuses regardless of which one', async () => {
    const fake = new StatefulFakeV1();
    fake.checksByRun.set(
      RUN_ID,
      ALL_PASSING_CHECKS.map((c) => (c.code === 'identity_validation' ? { ...c, outcome: 'FAIL' } : c)),
    );
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(result.ok).toBe(false);
  });

  test('PASS-decision run is refused by this command -- it only governs REVIEW', async () => {
    const fake = new StatefulFakeV1();
    fake.runs.get(RUN_ID)!.decision = 'PASS';
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: 'review_run_not_review_decision' }),
    );
  });

  test('REJECT-decision run is never accepted through this command', async () => {
    const fake = new StatefulFakeV1();
    fake.runs.get(RUN_ID)!.decision = 'REJECT';
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(result.ok).toBe(false);
  });

  test('wrong outbox row id -> refused', async () => {
    const fake = new StatefulFakeV1();
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: '99999999-9999-9999-9999-999999999999',
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'row_not_found' }));
  });

  test('review decision bound to a different source document than the target row -> refused', async () => {
    const fake = new StatefulFakeV1();
    fake.candidates.get(CANDIDATE_ID)!.source_document_id = 'some-other-document-id';
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'source_document_mismatch' }));
  });

  test('tampered hash: review decision hashes disagree with its own candidate -> refused', async () => {
    const fake = new StatefulFakeV1();
    fake.reviewDecisions.get(REVIEW_DECISION_ID)!.extraction_artifact_sha256 = 'f'.repeat(64);
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'review_binding_mismatch' }));
  });

  test('review decision run does not belong to its own candidate -> not found (structural join failure)', async () => {
    const fake = new StatefulFakeV1();
    fake.runs.get(RUN_ID)!.candidate_id = 'some-other-candidate';
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const result = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'review_decision_not_found' }));
  });

  test('legacy 8 rows are structurally untouched by a target-row acceptance', async () => {
    const fake = new StatefulFakeV1();
    const before = Array.from({ length: 8 }, (_, i) => structuredClone(fake.outbox.get(`legacy-${i}`)));
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    const after = Array.from({ length: 8 }, (_, i) => fake.outbox.get(`legacy-${i}`));
    expect(after).toEqual(before);
  });

  test('preview never mutates the target row', async () => {
    const fake = new StatefulFakeV1();
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    await repo.previewAcceptanceTarget(ROW_ID);
    expect(fake.outbox.get(ROW_ID)!.state).toBe('dead_letter');
  });

  test('acceptance is idempotent-safe: a second attempt on an already-succeeded row is refused, not double-applied', async () => {
    const fake = new StatefulFakeV1();
    const repo = createReviewAcceptanceRepositoryV1(fake, fake.verificationRepo());
    const first = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt',
    });
    expect(first.ok).toBe(true);
    const second = await repo.acceptReviewedIngestionV1({
      rowId: ROW_ID,
      reviewDecisionId: REVIEW_DECISION_ID,
      now: NOW,
      actor: 'neo@capiro.ai',
      reason: 'attempt again',
    });
    expect(second).toEqual(expect.objectContaining({ ok: false, reason: 'row_not_eligible_disposition' }));
    const metadata = fake.outbox.get(ROW_ID)!.metadata_jsonb as Record<string, unknown>;
    expect((metadata.governedAcceptanceHistory as unknown[]).length).toBe(1);
  });
});

describe('computeReviewDecisionHashV1', () => {
  test('is deterministic for identical inputs', () => {
    const input = {
      reviewDecisionId: REVIEW_DECISION_ID,
      candidateId: CANDIDATE_ID,
      runId: RUN_ID,
      decision: 'accept',
      sourceSha256: SOURCE_SHA,
      extractionArtifactSha256: ARTIFACT_SHA,
      manifestContentSha256: MANIFEST_SHA,
      createdAt: '2026-08-29T00:00:00.000Z',
    };
    expect(computeReviewDecisionHashV1(input)).toBe(computeReviewDecisionHashV1({ ...input }));
  });

  test('changes if any bound field changes', () => {
    const base = {
      reviewDecisionId: REVIEW_DECISION_ID,
      candidateId: CANDIDATE_ID,
      runId: RUN_ID,
      decision: 'accept',
      sourceSha256: SOURCE_SHA,
      extractionArtifactSha256: ARTIFACT_SHA,
      manifestContentSha256: MANIFEST_SHA,
      createdAt: '2026-08-29T00:00:00.000Z',
    };
    expect(computeReviewDecisionHashV1(base)).not.toBe(
      computeReviewDecisionHashV1({ ...base, decision: 'reject' }),
    );
  });
});

describe('acceptance policy identity constants', () => {
  test('policy id and hash are stable, non-empty', () => {
    expect(ACCEPTANCE_POLICY_ID_V1).toBe('rdte_r1_review_acceptance_policy_v1');
    expect(ACCEPTANCE_POLICY_HASH_V1).toHaveLength(64);
  });
});
