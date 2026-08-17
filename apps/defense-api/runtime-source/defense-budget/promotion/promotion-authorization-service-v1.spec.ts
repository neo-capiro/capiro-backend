/**
 * Phase 7 Workstream A.10 — the guarded surface issues authorizations and
 * cannot reach canonical storage.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DefenseBudgetPromotionAuthorizationServiceV1,
  type IssueAuthorizationRequestV1,
  type PromotionAuthorizationRepositoryV1,
  type StoredPromotionPlanV1,
} from './promotion-authorization-service-v1.js';
import {
  defenseBudgetPromotionEligibilityV1Schema,
  promotionEligibilityHashV1,
} from './promotion-eligibility-v1.js';
import type { DefenseBudgetPromotionAuthorizationV1 } from './promotion-authorization-v1.js';
import type {
  PromotionAuditEntryV1,
  PromotionAuditSinkV1,
} from './promotion-eligibility-service-v1.js';

const SHA = (c: string) => c.repeat(64);
const NOW = new Date('2027-09-30T00:00:00.000Z');
const FUTURE = '2027-10-01T00:00:00.000Z';

function eligibility(overrides: Record<string, unknown> = {}) {
  return defenseBudgetPromotionEligibilityV1Schema.parse({
    schemaVersion: 'defense_budget_promotion_eligibility_v2',
    eligibilityId: 'elig-1',
    cycleId: 'cycle-fy2027',
    scope: { cycleId: 'cycle-fy2027', fiscalYear: 2027, families: ['om'], stages: [] },
    projectionPlanIds: ['pp-1'],
    projectionPlanHashes: [SHA('c')],
    mappingRegistryVersion: '1.0.0',
    mappingRegistryHash: SHA('d'),
    candidates: [
      {
        candidateId: 'cand-1',
        status: 'VERIFICATION_PASSED',
        terminalVerificationRunId: 'run-1',
        extractionMethod: 'deterministic_pdfplumber',
        family: 'committee',
        sourceProfileSha256: SHA('2'),
        extractorActorId: 'actor-extractor',
        acceptedAssertionIds: ['a-1'],
        artifactSha256: SHA('a'),
        sourceSha256: SHA('b'),
      },
    ],
    sourceDocumentHashes: [SHA('e')],
    artifactHashes: [SHA('f')],
    manifestHash: SHA('0'),
    sourceProfileHashes: [SHA('2')],
    verificationPolicyHashes: [SHA('3')],
    cycleCertificationIds: ['cert-1'],
    cycleCertificationHashes: [SHA('4')],
    expectedActiveSnapshotId: null,
    expectedActiveSnapshotHash: null,
    openConflictCount: 0,
    unsupportedItemCount: 0,
    generatedAt: '2027-09-29T00:00:00.000Z',
    ...overrides,
  });
}

function storedPlan(overrides: Partial<StoredPromotionPlanV1> = {}): StoredPromotionPlanV1 {
  const elig = overrides.eligibility ?? eligibility();
  return {
    planId: 'plan-1',
    planHash: SHA('9'),
    eligibilityHash: promotionEligibilityHashV1(elig),
    blockedCount: 0,
    expectedActiveSnapshotId: null,
    eligibility: elig,
    ...overrides,
  };
}

class FakeRepository implements PromotionAuthorizationRepositoryV1 {
  inserted: (DefenseBudgetPromotionAuthorizationV1 & { authorizationHash: string })[] = [];
  constructor(
    private readonly plan: StoredPromotionPlanV1 | null,
    private readonly existing: string[] = [],
  ) {}
  async loadPlan() {
    return this.plan;
  }
  async findAuthorizationById(authorizationId: string) {
    return this.existing.includes(authorizationId) ? { authorizationId } : null;
  }
  async insertAuthorization(
    record: DefenseBudgetPromotionAuthorizationV1 & { authorizationHash: string },
  ) {
    this.inserted.push(record);
  }
}

class RecordingAudit implements PromotionAuditSinkV1 {
  entries: PromotionAuditEntryV1[] = [];
  async record(entry: PromotionAuditEntryV1) {
    this.entries.push(entry);
  }
}

const REQUEST: IssueAuthorizationRequestV1 = {
  planId: 'plan-1',
  reason: 'FY2027 O&M baseline',
  expiresAt: FUTURE,
  authorizerActorId: 'actor-admin',
  authorizerRoles: ['capiro_admin'],
  authorizationId: 'auth-1',
};

function build(plan: StoredPromotionPlanV1 | null = storedPlan(), existing: string[] = []) {
  const repository = new FakeRepository(plan, existing);
  const audit = new RecordingAudit();
  const service = new DefenseBudgetPromotionAuthorizationServiceV1(repository, audit, {
    now: () => NOW,
  });
  return { repository, audit, service };
}

describe('Phase 7 WS A.10 — issuing an authorization', () => {
  it('issues an authorization bound to the stored plan and eligibility', async () => {
    const { service, repository } = build();
    const result = await service.issue(REQUEST);

    expect(result.issued).toBe(true);
    expect(repository.inserted).toHaveLength(1);
    const record = repository.inserted[0];
    expect(record?.planId).toBe('plan-1');
    expect(record?.planHash).toBe(SHA('9'));
    expect(record?.authorizationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.segregation.authorizerRole).toBe('capiro_admin');
  });

  it('derives segregation evidence from the eligibility, not from the requester', async () => {
    const { service, repository } = build();
    await service.issue(REQUEST);
    // The requester never supplied these; they came from the eligibility record.
    expect(repository.inserted[0]?.segregation.extractorActorIds).toEqual(['actor-extractor']);
  });

  it('takes scope and expected snapshot from the plan, never from the request', async () => {
    const { service, repository } = build();
    await service.issue(REQUEST);
    expect(repository.inserted[0]?.scope.cycleId).toBe('cycle-fy2027');
    expect(repository.inserted[0]?.expectedActiveSnapshotId).toBeNull();
  });

  it('audits the issuance', async () => {
    const { service, audit } = build();
    await service.issue(REQUEST);
    expect(audit.entries[0]?.attemptKind).toBe('AUTHORIZATION');
    expect(audit.entries[0]?.outcome).toBe('ALLOWED');
    expect(audit.entries[0]?.authorizationId).toBe('auth-1');
  });
});

describe('Phase 7 WS A.10 — refusals', () => {
  it('refuses a caller who does not hold capiro_admin', async () => {
    const { service, repository, audit } = build();
    const result = await service.issue({ ...REQUEST, authorizerRoles: ['tenant_admin'] });

    expect(result.issued).toBe(false);
    expect(result.refusals[0]?.reason).toBe('authorizer_not_admin');
    expect(repository.inserted).toHaveLength(0);
    expect(audit.entries[0]?.outcome).toBe('REFUSED');
  });

  it('refuses when the plan does not exist', async () => {
    const { service } = build(null);
    const result = await service.issue(REQUEST);
    expect(result.refusals[0]?.reason).toBe('plan_not_found');
  });

  it('refuses a plan that still has blocked items', async () => {
    const { service, repository } = build(storedPlan({ blockedCount: 2 }));
    const result = await service.issue(REQUEST);
    expect(result.refusals.map((r) => r.reason)).toContain('plan_has_blocked_items');
    expect(repository.inserted).toHaveLength(0);
  });

  it('refuses to re-issue an authorization id that already exists', async () => {
    const { service } = build(storedPlan(), ['auth-1']);
    const result = await service.issue(REQUEST);
    expect(result.refusals.map((r) => r.reason)).toContain('authorization_already_exists');
  });

  it('refuses an expiry that is not in the future', async () => {
    const { service } = build();
    const result = await service.issue({ ...REQUEST, expiresAt: '2027-09-29T00:00:00.000Z' });
    expect(result.refusals.map((r) => r.reason)).toContain('expiry_not_in_future');
  });

  it('refuses when the stored plan and its eligibility disagree', async () => {
    const { service } = build(storedPlan({ eligibilityHash: SHA('7') }));
    const result = await service.issue(REQUEST);
    expect(result.refusals.map((r) => r.reason)).toContain('eligibility_hash_mismatch');
  });

  it('refuses an authorizer who reviewed the same scope', async () => {
    const elig = eligibility({
      candidates: [
        {
          candidateId: 'cand-1',
          status: 'REVIEW_ACCEPTED',
          terminalVerificationRunId: 'run-1',
          extractionMethod: 'deterministic_pdfplumber',
          family: 'committee',
          sourceProfileSha256: SHA('2'),
          reviewDecisionId: 'decision-1',
          reviewerActorId: 'actor-admin',
          acceptedAssertionIds: ['a-1'],
          artifactSha256: SHA('a'),
          sourceSha256: SHA('b'),
        },
      ],
    });
    const { service, repository } = build(storedPlan({ eligibility: elig }));
    const result = await service.issue(REQUEST);

    expect(result.issued).toBe(false);
    expect(result.refusals.map((r) => r.reason)).toContain('segregation_violation');
    expect(repository.inserted).toHaveLength(0);
  });

  it('refuses an authorizer who extracted high-risk content in the same scope', async () => {
    const elig = eligibility({
      candidates: [
        {
          candidateId: 'cand-1',
          status: 'VERIFICATION_PASSED',
          terminalVerificationRunId: 'run-1',
          extractionMethod: 'manual',
          family: 'committee',
          sourceProfileSha256: SHA('2'),
          extractorActorId: 'actor-admin',
          acceptedAssertionIds: ['a-1'],
          artifactSha256: SHA('a'),
          sourceSha256: SHA('b'),
        },
      ],
    });
    const { service, repository } = build(storedPlan({ eligibility: elig }));
    const result = await service.issue(REQUEST);

    expect(result.issued).toBe(false);
    expect(result.refusals.map((r) => r.reason)).toContain('segregation_violation');
    expect(repository.inserted).toHaveLength(0);
  });

  it('permits an extractor to authorize when the extraction was not high-risk', async () => {
    const elig = eligibility({
      candidates: [
        {
          candidateId: 'cand-1',
          status: 'VERIFICATION_PASSED',
          terminalVerificationRunId: 'run-1',
          extractionMethod: 'native_structured',
          family: 'committee',
          sourceProfileSha256: SHA('2'),
          extractorActorId: 'actor-admin',
          acceptedAssertionIds: ['a-1'],
          artifactSha256: SHA('a'),
          sourceSha256: SHA('b'),
        },
      ],
    });
    const { service } = build(storedPlan({ eligibility: elig }));
    const result = await service.issue(REQUEST);
    expect(result.issued).toBe(true);
  });

  it('audits every refusal with its reasons', async () => {
    const { service, audit } = build(storedPlan({ blockedCount: 1 }));
    await service.issue(REQUEST);
    expect(audit.entries[0]?.outcome).toBe('REFUSED');
    expect(audit.entries[0]?.reasons).toContain('plan_has_blocked_items');
  });
});

describe('Phase 7 WS A.10 — the admin surface cannot reach canonical storage', () => {
  const source = readFileSync(join(__dirname, 'promotion-authorization-service-v1.ts'), 'utf8');

  it('imports no Prisma client and no legacy writer', () => {
    expect(source).not.toMatch(/from\s+['"]@prisma\/client['"]/);
    expect(source).not.toMatch(/ProgramElementWriterService/);
    expect(source).not.toMatch(/ReconciliationService/);
  });

  it('performs no Prisma DML', () => {
    const dml =
      /\b[A-Za-z_$][\w$]*\s*\.\s*[A-Za-z_$][\w$]*\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw|executeRawUnsafe)\s*\(/;
    expect(dml.test(source)).toBe(false);
  });

  it('names no canonical entity, snapshot table, or activation table', () => {
    for (const forbidden of [
      'defense_budget_canonical_row',
      'defense_budget_canonical_snapshot',
      'defense_budget_active_snapshot',
      'defense_budget_promotion_activation',
      'defense_budget_promotion_outbox',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('exposes a repository port whose only write method appends an authorization', () => {
    // The port is the whole capability surface: if a canonical write method is
    // ever added here, this assertion is what fails first.
    const portBody = source.slice(
      source.indexOf('export interface PromotionAuthorizationRepositoryV1'),
      source.indexOf(
        '/* ------------------------------------------------------------------ */\n/* A10c.',
      ),
    );
    const methods = [...portBody.matchAll(/^\s{2}(\w+)\s*\(/gm)].map((match) => match[1]);
    expect(methods.sort()).toEqual(['findAuthorizationById', 'insertAuthorization', 'loadPlan']);
  });
});
