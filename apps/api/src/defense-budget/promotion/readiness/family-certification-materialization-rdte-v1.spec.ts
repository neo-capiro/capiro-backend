import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import type { DefenseBudgetProjectionPlanRecordV1 } from '../../projection-plan/projection-plan-record-v1.js';
import type { ProjectionPlanRepositoryV1 } from '../../projection-plan/projection-plan-repository-prisma-v1.js';
import type { MaterializationCandidateArtifactRefV1 } from './family-certification-materialization-v1.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const POLICY = 'c'.repeat(64);

jest.mock('../../rdte/cycle/rdte-cycle-pipeline-v1.js', () => ({
  buildRdteCycleArtifactsFromPersistedArtifacts: (input: unknown) => input,
  finalizeRdteCycle: ({ build }: { build: { documents: Array<{ artifact: DefenseBudgetExtractionArtifactV1 }> } }) => {
    const contentSha256 = build.documents[0]!.artifact.contentSha256;
    return {
      certification: 'CERTIFIED_RDTE_READY_FOR_PROJECTION', reason: 'ready',
      bundle: { contentSha256: SHA_B },
      projectionPlan: { schemaVersion: 'rdte_canonical_projection_plan_v1', cycleId: 'cycle-rdte', fiscalYear: 2027, contentSha256, candidates: [{ operation: 'insert', artifactContentSha256: contentSha256 }] },
    };
  },
}));

import { materializeRdteFamilyCertificationV1 } from './family-certification-materialization-rdte-v1.js';

function request() {
  return {
    identity: { fiscalYear: 2027, familyGroup: 'rdte', component: 'army', authority: 'presidents_budget', budgetCycle: 'PB' },
    cycleId: 'cycle-rdte',
    manifest: { manifestContentSha256: SHA_A, documents: [{ documentKey: 'r2', required: true, family: 'rdte', exhibit: 'R-2' }], requiredIdentityKeys: [], requiredNarrativeSections: [] },
  } as never;
}

function artifact(sha = SHA_A): DefenseBudgetExtractionArtifactV1 {
  return { artifactId: `artifact-${sha[0]}`, contentSha256: sha, assertions: [] } as unknown as DefenseBudgetExtractionArtifactV1;
}

function ref(
  status: MaterializationCandidateArtifactRefV1['status'],
  artifactSha256 = SHA_A,
): MaterializationCandidateArtifactRefV1 {
  return { manifestDocumentKey: 'r2', extractionArtifactId: `artifact-${artifactSha256[0]}`, extractionArtifactSha256: artifactSha256, extractionArtifactLocator: 'artifact.json', sourceDocumentId: 'source', sourceSha256: SHA_A, candidateId: `candidate-${artifactSha256[0]}`, verificationRunId: `run-${artifactSha256[0]}`, decision: status === 'REJECTED' ? 'REJECT' : status === 'VERIFICATION_PASSED' ? 'PASS' : 'REVIEW', status, manifestContentSha256: SHA_A, acceptedAssertionIds: [], rejectedAssertionIds: [], policySha256: POLICY };
}

class Plans implements ProjectionPlanRepositoryV1 {
  readonly rows = new Map<string, DefenseBudgetProjectionPlanRecordV1>();
  async insert(value: DefenseBudgetProjectionPlanRecordV1) { if (!this.rows.has(value.projectionPlanId)) this.rows.set(value.projectionPlanId, value); }
  async loadVerified(id: string) { return this.rows.get(id) ?? null; }
  async loadForScope() { return [...this.rows.values()]; }
}

describe('RDT&E durable certification materialization', () => {
  it.each(['VERIFICATION_PASSED', 'REVIEW_ACCEPTED'] as const)('%s candidate certifies and replay converges', async (status) => {
    const plans = new Plans(); const candidate = ref(status);
    const ports = { artifactSource: { loadCandidateRefs: async () => new Map([['r2', candidate]]), loadVerifiedArtifact: async () => artifact() }, projectionPlans: plans, producerVersion: 'test' };
    const first = await materializeRdteFamilyCertificationV1(request(), ports);
    const second = await materializeRdteFamilyCertificationV1(request(), ports);
    expect(first.outcome).toBe('materialized'); expect(second.outcome).toBe('materialized');
    expect(first.record?.projectionPlanId).toBe(second.record?.projectionPlanId); expect(plans.rows.size).toBe(1);
    expect(first.record?.family).toBe('rdte'); expect(first.record?.certificationSha256).toBe(SHA_B);
  });

  it.each([['NEEDS_REVIEW', 'candidate_incomplete'], ['REJECTED', 'candidate_rejected']] as const)('%s refuses certification', async (status, outcome) => {
    const candidate = ref(status); const plans = new Plans();
    const result = await materializeRdteFamilyCertificationV1(request(), { artifactSource: { loadCandidateRefs: async () => new Map([['r2', candidate]]), loadVerifiedArtifact: async () => { throw new Error('must not load'); } }, projectionPlans: plans, producerVersion: 'test' });
    expect(result.outcome).toBe(outcome); expect(plans.rows.size).toBe(0);
  });

  it('changed accepted artifact SHA creates a new immutable plan identity', async () => {
    const plans = new Plans(); let current = artifact(SHA_A); let candidate = ref('VERIFICATION_PASSED', SHA_A);
    const ports = { artifactSource: { loadCandidateRefs: async () => new Map([['r2', candidate]]), loadVerifiedArtifact: async () => current }, projectionPlans: plans, producerVersion: 'test' };
    const first = await materializeRdteFamilyCertificationV1(request(), ports); current = artifact(SHA_B); candidate = ref('VERIFICATION_PASSED', SHA_B);
    const second = await materializeRdteFamilyCertificationV1(request(), ports);
    expect(second.record?.projectionPlanId).not.toBe(first.record?.projectionPlanId); expect(plans.rows.size).toBe(2);
  });

  it('recovers after a crash following insert without duplicating the plan', async () => {
    const plans = new Plans(); const candidate = ref('VERIFICATION_PASSED'); let failReload = true;
    const crashingPlans: ProjectionPlanRepositoryV1 = {
      insert: (value) => plans.insert(value),
      loadVerified: async (id) => { if (failReload) { failReload = false; throw new Error('simulated crash'); } return plans.loadVerified(id); },
      loadForScope: () => plans.loadForScope(),
    };
    const ports = { artifactSource: { loadCandidateRefs: async () => new Map([['r2', candidate]]), loadVerifiedArtifact: async () => artifact() }, projectionPlans: crashingPlans, producerVersion: 'test' };
    await expect(materializeRdteFamilyCertificationV1(request(), ports)).rejects.toThrow('simulated crash');
    const recovered = await materializeRdteFamilyCertificationV1(request(), ports);
    expect(recovered.outcome).toBe('materialized'); expect(plans.rows.size).toBe(1);
  });
});
