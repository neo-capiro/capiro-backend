/**
 * Phase 7 Workstream A.7 / A.9 — the service reloads every trusted record and
 * audits every attempt.
 */
import {
  DefenseBudgetPromotionEligibilityServiceV1,
  PrismaPromotionAuditSinkV1,
  type PromotionAuditEntryV1,
  type PromotionAuditSinkV1,
  type PromotionEligibilityRepositoryV1,
  type PromotionEligibilityRequestV1,
  type TrustedActiveSnapshotRecordV1,
  type TrustedCandidateRecordV1,
  type TrustedCycleCertificationRecordV1,
  type TrustedProjectionPlanRecordV1,
} from './promotion-eligibility-service-v1.js';

const SHA = (c: string) => c.repeat(64);
const NOW = new Date('2027-09-30T00:00:00.000Z');

function candidate(overrides: Partial<TrustedCandidateRecordV1> = {}): TrustedCandidateRecordV1 {
  return {
    candidateId: 'cand-1',
    status: 'VERIFICATION_PASSED',
    terminalVerificationRunId: 'run-1',
    // A governed family by default, so the source-profile path stays exercised
    // by the existing assertions; the ungoverned (Phase 1–5) case has its own
    // tests below.
    family: 'committee',
    extractionMethod: 'deterministic_pdfplumber',
    extractorActorId: 'actor-extractor',
    acceptedAssertionIds: ['a-2', 'a-1'],
    artifactSha256: SHA('a'),
    sourceSha256: SHA('b'),
    sourceProfileSha256: SHA('c'),
    verificationPolicySha256: SHA('d'),
    manifestSha256: SHA('e'),
    ...overrides,
  };
}

interface FakeState {
  certifications: TrustedCycleCertificationRecordV1[];
  candidates: TrustedCandidateRecordV1[];
  latestTerminalRunId: Record<string, string | null>;
  projectionPlans: TrustedProjectionPlanRecordV1[];
  openConflicts: number;
  unsupported: number;
  activeSnapshot: TrustedActiveSnapshotRecordV1 | null;
}

function defaultState(): FakeState {
  return {
    certifications: [
      { certificationId: 'cert-1', contentSha256: SHA('1'), status: 'CERTIFIED_READY' },
    ],
    candidates: [candidate()],
    latestTerminalRunId: { 'cand-1': 'run-1' },
    projectionPlans: [{ projectionPlanId: 'pp-1', contentSha256: SHA('2') }],
    openConflicts: 0,
    unsupported: 0,
    activeSnapshot: null,
  };
}

class FakeRepository implements PromotionEligibilityRepositoryV1 {
  constructor(public state: FakeState) {}
  async loadCycleCertifications() {
    return this.state.certifications;
  }
  async loadCandidates() {
    return this.state.candidates;
  }
  async loadLatestTerminalRunId(candidateId: string) {
    return this.state.latestTerminalRunId[candidateId] ?? null;
  }
  async loadProjectionPlans() {
    return this.state.projectionPlans;
  }
  async countOpenBlockingConflicts() {
    return this.state.openConflicts;
  }
  async countUnsupportedProjections() {
    return this.state.unsupported;
  }
  async loadActiveSnapshot() {
    return this.state.activeSnapshot;
  }
}

class RecordingAudit implements PromotionAuditSinkV1 {
  entries: PromotionAuditEntryV1[] = [];
  async record(entry: PromotionAuditEntryV1) {
    this.entries.push(entry);
  }
}

const REQUEST: PromotionEligibilityRequestV1 = {
  cycleId: 'cycle-fy2027',
  fiscalYear: 2027,
  families: ['om'],
  environment: 'dev',
  requestedByActorId: 'actor-operator',
};

function build(state: FakeState = defaultState()) {
  const repository = new FakeRepository(state);
  const audit = new RecordingAudit();
  const service = new DefenseBudgetPromotionEligibilityServiceV1(repository, audit, {
    now: () => NOW,
    eligibilityId: (request) => `elig:${request.cycleId}:${request.fiscalYear}`,
  });
  return { repository, audit, service, state };
}

describe('Phase 7 WS A.7 — eligibility is built from persistence, not from the caller', () => {
  it('produces an eligible record and a hash from loaded facts alone', async () => {
    const { service, audit } = build();
    const result = await service.evaluate(REQUEST);

    expect(result.eligible).toBe(true);
    expect(result.eligibilityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.eligibility?.candidates.map((c) => c.candidateId)).toEqual(['cand-1']);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.outcome).toBe('ALLOWED');
  });

  it('sorts and de-duplicates loaded identifier collections', async () => {
    const { service } = build();
    const result = await service.evaluate(REQUEST);
    // The repository returned ['a-2','a-1']; the contract sorts on parse.
    expect(result.eligibility?.candidates[0]?.acceptedAssertionIds).toEqual(['a-1', 'a-2']);
  });

  it('carries the mapping registry version and hash it will actually be promoted under', async () => {
    const { service } = build();
    const result = await service.evaluate(REQUEST);
    expect(result.eligibility?.mappingRegistryVersion).toBe('1.0.0');
    expect(result.eligibility?.mappingRegistryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats a missing active snapshot as a baseline promotion', async () => {
    const { service } = build();
    const result = await service.evaluate(REQUEST);
    expect(result.eligibility?.expectedActiveSnapshotId).toBeNull();
    expect(result.eligibility?.expectedActiveSnapshotHash).toBeNull();
  });

  it('binds to the snapshot that is actually active', async () => {
    const state = defaultState();
    state.activeSnapshot = { snapshotId: 'snap-live', snapshotHash: SHA('9') };
    const { service } = build(state);
    const result = await service.evaluate(REQUEST);
    expect(result.eligibility?.expectedActiveSnapshotId).toBe('snap-live');
    expect(result.eligibility?.expectedActiveSnapshotHash).toBe(SHA('9'));
  });

  it('is deterministic across repeated evaluation of the same facts', async () => {
    const first = await build().service.evaluate(REQUEST);
    const second = await build().service.evaluate(REQUEST);
    expect(second.eligibilityHash).toBe(first.eligibilityHash);
  });

  it('changes the hash when a trusted record in persistence changes', async () => {
    const baseline = await build().service.evaluate(REQUEST);
    const state = defaultState();
    state.projectionPlans = [{ projectionPlanId: 'pp-1', contentSha256: SHA('f') }];
    const changed = await build(state).service.evaluate(REQUEST);
    expect(changed.eligibilityHash).not.toBe(baseline.eligibilityHash);
  });
});

describe('Phase 7 WS A.7 — refusals', () => {
  const cases: [string, (state: FakeState) => void, string][] = [
    [
      'a candidate still awaiting review',
      (s) => {
        s.candidates = [candidate({ status: 'NEEDS_REVIEW' })];
      },
      'candidate_not_terminal',
    ],
    [
      'a rejected candidate',
      (s) => {
        s.candidates = [candidate({ status: 'REJECTED' })];
      },
      'candidate_not_terminal',
    ],
    [
      'a superseded candidate',
      (s) => {
        s.candidates = [candidate({ status: 'SUPERSEDED' })];
      },
      'candidate_superseded',
    ],
    [
      'a newer terminal run existing for the candidate',
      (s) => {
        s.latestTerminalRunId = { 'cand-1': 'run-2' };
      },
      'newer_terminal_run_exists',
    ],
    [
      'review acceptance with no review decision',
      (s) => {
        s.candidates = [candidate({ status: 'REVIEW_ACCEPTED', reviewDecisionId: null })];
      },
      'review_decision_missing',
    ],
    [
      'a candidate with no accepted assertions',
      (s) => {
        s.candidates = [candidate({ acceptedAssertionIds: [] })];
      },
      'assertion_not_accepted',
    ],
    [
      // Gap 5 decision 2. Its own reason, not the `projection_hash_mismatch`
      // the record's schema refinement would otherwise surface it as.
      'a governed family whose source profile was not recorded',
      (s) => {
        s.candidates = [candidate({ family: 'committee', sourceProfileSha256: null })];
      },
      'source_profile_missing',
    ],
    [
      'no cycle certification at all',
      (s) => {
        s.certifications = [];
      },
      'cycle_certification_missing',
    ],
    [
      'a cycle certification that is not CERTIFIED',
      (s) => {
        s.certifications = [
          { certificationId: 'cert-1', contentSha256: SHA('1'), status: 'FAILED' },
        ];
      },
      'cycle_certification_not_certified',
    ],
    [
      'an open blocking conflict',
      (s) => {
        s.openConflicts = 3;
      },
      'open_blocking_conflict',
    ],
    [
      'an unsupported projection kind',
      (s) => {
        s.unsupported = 1;
      },
      'unsupported_mapping',
    ],
    [
      'no verified projection plan',
      (s) => {
        s.projectionPlans = [];
      },
      'projection_hash_mismatch',
    ],
  ];

  for (const [label, mutate, expectedReason] of cases) {
    it(`refuses ${label}`, async () => {
      const state = defaultState();
      mutate(state);
      const { service } = build(state);
      const result = await service.evaluate(REQUEST);

      expect(result.eligible).toBe(false);
      expect(result.blocks.map((b) => b.reason)).toContain(expectedReason);
    });

    it(`produces no eligibility hash when refusing ${label}`, async () => {
      const state = defaultState();
      mutate(state);
      const { service } = build(state);
      const result = await service.evaluate(REQUEST);

      // A refusal must never yield a hash an authorization could bind to.
      expect(result.eligibilityHash).toBeNull();
      expect(result.eligibility).toBeNull();
    });
  }

  it('accepts a review-accepted candidate that carries its decision', async () => {
    const state = defaultState();
    state.candidates = [
      candidate({
        status: 'REVIEW_ACCEPTED',
        reviewDecisionId: 'decision-1',
        reviewerActorId: 'actor-reviewer',
      }),
    ];
    const { service } = build(state);
    const result = await service.evaluate(REQUEST);
    expect(result.eligible).toBe(true);
    expect(result.eligibility?.candidates[0]?.reviewerActorId).toBe('actor-reviewer');
  });

  it('refuses when the scope contains no candidates at all', async () => {
    const state = defaultState();
    state.candidates = [];
    const { service } = build(state);
    const result = await service.evaluate(REQUEST);
    expect(result.eligible).toBe(false);
    expect(result.eligibilityHash).toBeNull();
  });
});

describe('Phase 7 WS A.9 — every attempt is audited', () => {
  it('records an ALLOWED entry with the eligibility hash', async () => {
    const { service, audit } = build();
    const result = await service.evaluate(REQUEST);
    const entry = audit.entries[0];

    expect(entry?.attemptKind).toBe('ELIGIBILITY');
    expect(entry?.outcome).toBe('ALLOWED');
    expect(entry?.eligibilityHash).toBe(result.eligibilityHash);
    expect(entry?.reasons).toEqual([]);
    expect(entry?.actorId).toBe('actor-operator');
  });

  it('records a REFUSED entry carrying every reason', async () => {
    const state = defaultState();
    state.openConflicts = 2;
    state.unsupported = 1;
    const { service, audit } = build(state);
    await service.evaluate(REQUEST);
    const entry = audit.entries[0];

    expect(entry?.outcome).toBe('REFUSED');
    expect(entry?.reasons).toEqual(
      expect.arrayContaining(['open_blocking_conflict', 'unsupported_mapping']),
    );
    expect(entry?.eligibilityHash).toBeNull();
    expect(entry?.detail).toContain('open blocking conflict');
  });

  it('records the requested scope, sorted, without any caller-supplied proof', async () => {
    const { service, audit } = build();
    await service.evaluate({ ...REQUEST, families: ['procurement', 'om'], stages: ['b', 'a'] });
    const scope = audit.entries[0]?.scope as Record<string, unknown>;

    expect(scope.families).toEqual(['om', 'procurement']);
    expect(scope.stages).toEqual(['a', 'b']);
    expect(scope.environment).toBe('dev');
    expect(scope.domain).toBe('defense_budget');
  });

  it('audits exactly once per attempt', async () => {
    const { service, audit } = build();
    await service.evaluate(REQUEST);
    await service.evaluate(REQUEST);
    expect(audit.entries).toHaveLength(2);
  });
});

describe('Phase 7 WS A.9 — the Prisma audit sink only ever creates', () => {
  it('writes one create call per entry and offers no update or delete', async () => {
    const calls: Record<string, unknown>[] = [];
    const sink = new PrismaPromotionAuditSinkV1({
      create: async (args) => {
        calls.push(args.data);
        return undefined;
      },
    });

    await sink.record({
      attemptKind: 'AUTHORIZATION',
      outcome: 'REFUSED',
      actorId: 'actor-admin',
      cycleId: 'cycle-fy2027',
      scope: { families: ['om'] },
      eligibilityHash: null,
      planId: 'plan-1',
      planHash: SHA('3'),
      authorizationId: 'auth-1',
      expectedActiveSnapshotId: null,
      reasons: ['authorization_expired'],
      detail: 'expired',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      attemptKind: 'AUTHORIZATION',
      outcome: 'REFUSED',
      planId: 'plan-1',
      reasons: ['authorization_expired'],
    });
    expect(Object.keys(sink)).not.toContain('update');
    expect((sink as unknown as Record<string, unknown>).delete).toBeUndefined();
  });
});
