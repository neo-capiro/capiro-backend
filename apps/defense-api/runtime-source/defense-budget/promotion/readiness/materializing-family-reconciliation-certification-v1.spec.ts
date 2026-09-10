/**
 * Phase 10B-2D -- decorator-level tests for
 * `MaterializingFamilyReconciliationCertificationV1`.
 *
 * Unlike `family-certification-materialization-v1.spec.ts` (which exercises
 * the materialization boundary function directly), this file proves the
 * DECORATOR's own composition contract:
 *
 *   - the existing #1298 read-only adapter is always asked first, and its
 *     `certified: true` result is returned VERBATIM with zero materialization
 *     attempt (fast path);
 *   - materialization is attempted ONLY when the existing read reports
 *     `certified: false` AND `certificationStatus === 'INCOMPLETE'` -- a
 *     NEEDS_REVIEW or REJECTED result from Phase 4/5/6 is a real outcome the
 *     decorator must never silently retry by filing a second competing row;
 *   - on a successful materialization, the decorator NEVER returns the
 *     materialization's own in-memory verdict -- it always re-reads through
 *     the EXACT SAME unchanged read-only adapter, so readiness and Phase 7
 *     eligibility keep agreeing on certification status/SHA via one shared
 *     interpretation (`family-certified-plan-read-v1.ts`);
 *   - committee remains read-only while RDT&E enters durable materialization;
 *   - a missing durable manifest is reported, not silently treated as an
 *     empty one;
 *   - a materialization attempt that does not reach `materialized` (e.g.
 *     `no_candidates_yet`) still returns the ORIGINAL existing result (with
 *     detail appended), and does NOT re-read through the adapter a second
 *     time -- there is nothing new to see.
 */
import { MaterializingFamilyReconciliationCertificationV1 } from './materializing-family-reconciliation-certification-v1.js';
import type {
  FamilyReconciliationCertificationPortV1,
  FamilyReconciliationCertificationResultV1,
} from './cycle-family-readiness-orchestrator-v1.js';
import type { CycleFamilyReadinessIdentityV1, CycleFamilyCorpusInputV1 } from './cycle-family-readiness-v1.js';
import type {
  MaterializationArtifactSourcePortV1,
  MaterializationCandidateArtifactRefV1,
  MaterializationManifestInputV1,
} from './family-certification-materialization-v1.js';
import type { ManifestForMaterializationPortV1 } from './materializing-family-reconciliation-certification-v1.js';
import {
  buildProjectionPlanRecordV1,
  defenseBudgetProjectionPlanRecordV1Schema,
  type DefenseBudgetProjectionPlanRecordV1,
} from '../../projection-plan/projection-plan-record-v1.js';
import type { ProjectionPlanRepositoryV1 } from '../../projection-plan/projection-plan-repository-prisma-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import type { BudgetCycleManifestDocumentV1 } from '../../contracts/budget-cycle-manifest-v1.js';

const SHA = 'a'.repeat(64);
const OM_CODE = 'SAG1';
const OM_ACCOUNT = 'O&M, ARMY';
const OM_COMPONENT = 'ARMY';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function identity(
  familyGroup: CycleFamilyReadinessIdentityV1['familyGroup'],
): CycleFamilyReadinessIdentityV1 {
  return { fiscalYear: 2027, authorityTrack: 'authorization', familyGroup };
}

function corpus(
  familyGroup: CycleFamilyReadinessIdentityV1['familyGroup'],
  cycleId = 'cycle-fy2027-authorization',
): CycleFamilyCorpusInputV1 {
  return { identity: identity(familyGroup), cycleId, expectedSources: [] };
}

function result(
  overrides: Partial<FamilyReconciliationCertificationResultV1> = {},
): FamilyReconciliationCertificationResultV1 {
  return {
    certified: false,
    certificationStatus: 'INCOMPLETE',
    blockingFindingCount: 0,
    certificationContentSha256: null,
    certificationRowId: null,
    reason: 'no projection plan filed yet',
    ...overrides,
  };
}

/** A queue-driven fake read-only adapter: returns queued results in order, records every call. */
class FakeReadOnlyAdapter implements FamilyReconciliationCertificationPortV1 {
  public calls: Array<{ identity: CycleFamilyReadinessIdentityV1; cycleId: string }> = [];
  private readonly queue: FamilyReconciliationCertificationResultV1[];

  constructor(...results: FamilyReconciliationCertificationResultV1[]) {
    this.queue = [...results];
  }

  async reconcileAndCertify(
    identityArg: CycleFamilyReadinessIdentityV1,
    corpusArg: CycleFamilyCorpusInputV1,
  ): Promise<FamilyReconciliationCertificationResultV1> {
    this.calls.push({ identity: identityArg, cycleId: corpusArg.cycleId });
    const next = this.queue.shift();
    if (next == null) {
      throw new Error('FakeReadOnlyAdapter: no more queued results -- test called it more times than expected');
    }
    return next;
  }
}

class FakeManifestSource implements ManifestForMaterializationPortV1 {
  public calls = 0;
  constructor(private readonly manifest: MaterializationManifestInputV1 | null) {}
  async loadManifestForIdentity(): Promise<MaterializationManifestInputV1 | null> {
    this.calls += 1;
    return this.manifest;
  }
}

function omManifest(): MaterializationManifestInputV1 {
  return {
    manifestContentSha256: SHA,
    documents: [makeManifestDoc('o1', 'O-1', true), makeManifestDoc('op5', 'OP-5', true)],
    requiredIdentityKeys: [`OM_SAG:${OM_COMPONENT}:${OM_ACCOUNT}:${OM_CODE}`],
    requiredNarrativeSections: [],
  };
}

function makeManifestDoc(key: string, exhibit: string, required: boolean): BudgetCycleManifestDocumentV1 {
  return {
    documentKey: key,
    required,
    title: `Fixture ${exhibit}`,
    sourceLocator: `fixture://${key}.pdf`,
    family: 'om',
    exhibit,
    authority: 'procurement',
    component: OM_COMPONENT,
    budgetCycle: 'pb_fy2027',
    documentType: 'pdf',
    parserPolicy: 'native_structured',
    requiredDataCategories: ['identity', 'funding'],
    expectedLineKinds: ['PROCUREMENT_BLIN'],
  } as unknown as BudgetCycleManifestDocumentV1;
}

function makeOmArtifact(key: string, exhibit: string): DefenseBudgetExtractionArtifactV1 {
  return {
    artifactId: `art_${key}`,
    schemaVersion: 'defense_budget_extraction_v1',
    source: {
      manifestDocumentKey: key,
      sourcePdfSha256: SHA,
      sourceLocator: `fixture://${key}.pdf`,
      fiscalYear: 2027,
      family: 'om',
      exhibit,
      budgetCycle: 'pb_fy2027',
      component: OM_COMPONENT,
      sourceUrl: `fixture://${key}.pdf`,
    },
    contentSha256: SHA,
    assertions: [
      {
        assertionId: `asrt_om_line_${key}`,
        assertionKind: 'om_line',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        identity: { lineKind: 'OM_SAG', code: OM_CODE, account: OM_ACCOUNT, component: OM_COMPONENT },
        title: 'Operations and Maintenance Support',
      },
      {
        assertionId: `asrt_om_funding_${key}`,
        assertionKind: 'funding',
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        identity: { lineKind: 'OM_SAG', code: OM_CODE, account: OM_ACCOUNT, component: OM_COMPONENT },
        fiscalYear: 2027,
        field: 'request',
        money: { originalValue: '30', originalUnit: 'millions', valueMillions: '30' },
      },
    ],
    evidence: [],
    omissions: [],
    warnings: [],
    parserRuns: [],
    extractedAt: '2026-01-01T00:00:00Z',
  } as unknown as DefenseBudgetExtractionArtifactV1;
}

function candidateRef(input: {
  documentKey: string;
  candidateId: string;
  runId: string;
  decision: 'PASS' | 'REVIEW' | 'REJECT';
  status: 'VERIFICATION_PASSED' | 'REVIEW_ACCEPTED' | 'NEEDS_REVIEW' | 'REJECTED';
}): MaterializationCandidateArtifactRefV1 {
  return {
    manifestDocumentKey: input.documentKey,
    extractionArtifactId: `art_${input.documentKey}`,
    extractionArtifactSha256: SHA,
    extractionArtifactLocator: `fixture://${input.documentKey}.extraction.json`,
    sourceDocumentId: `doc_${input.documentKey}`,
    sourceSha256: SHA,
    candidateId: input.candidateId,
    verificationRunId: input.runId,
    decision: input.decision,
    status: input.status,
    manifestContentSha256: SHA,
    acceptedAssertionIds: [],
  };
}

/** A ready OM corpus artifact source (both required documents PASS). */
class FakeArtifactSource implements MaterializationArtifactSourcePortV1 {
  public loadCandidateRefsCalls = 0;
  public loadVerifiedArtifactCalls = 0;
  constructor(
    private readonly refs: Map<string, MaterializationCandidateArtifactRefV1> = new Map([
      ['o1', candidateRef({ documentKey: 'o1', candidateId: 'c-o1', runId: 'r-o1', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
      ['op5', candidateRef({ documentKey: 'op5', candidateId: 'c-op5', runId: 'r-op5', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
    ]),
    private readonly artifacts: Map<string, DefenseBudgetExtractionArtifactV1> = new Map([
      ['o1', makeOmArtifact('o1', 'O-1')],
      ['op5', makeOmArtifact('op5', 'OP-5')],
    ]),
  ) {}

  async loadCandidateRefs(input: {
    cycleId: string;
    manifestDocumentKeys: readonly string[];
  }): Promise<ReadonlyMap<string, MaterializationCandidateArtifactRefV1>> {
    this.loadCandidateRefsCalls += 1;
    const output = new Map<string, MaterializationCandidateArtifactRefV1>();
    for (const key of input.manifestDocumentKeys) {
      const ref = this.refs.get(key);
      if (ref != null) output.set(key, ref);
    }
    return output;
  }

  async loadVerifiedArtifact(
    ref: MaterializationCandidateArtifactRefV1,
  ): Promise<DefenseBudgetExtractionArtifactV1> {
    this.loadVerifiedArtifactCalls += 1;
    const artifact = this.artifacts.get(ref.manifestDocumentKey);
    if (artifact == null) throw new Error(`no fixture artifact registered for ${ref.manifestDocumentKey}`);
    return artifact;
  }
}

/** Empty/incomplete OM corpus: OP-5 has no candidate yet. */
class FakeIncompleteArtifactSource implements MaterializationArtifactSourcePortV1 {
  async loadCandidateRefs(): Promise<ReadonlyMap<string, MaterializationCandidateArtifactRefV1>> {
    return new Map([
      ['o1', candidateRef({ documentKey: 'o1', candidateId: 'c-o1', runId: 'r-o1', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
    ]);
  }
  async loadVerifiedArtifact(): Promise<DefenseBudgetExtractionArtifactV1> {
    throw new Error('should not be called for an incomplete corpus');
  }
}

class InMemoryProjectionPlanRepository implements ProjectionPlanRepositoryV1 {
  public insertCalls = 0;
  private readonly rows = new Map<string, DefenseBudgetProjectionPlanRecordV1>();
  async insert(record: DefenseBudgetProjectionPlanRecordV1): Promise<void> {
    this.insertCalls += 1;
    const parsed = defenseBudgetProjectionPlanRecordV1Schema.parse(record);
    if (this.rows.has(parsed.projectionPlanId)) return;
    this.rows.set(parsed.projectionPlanId, parsed);
  }
  async loadVerified(id: string): Promise<DefenseBudgetProjectionPlanRecordV1 | null> {
    return this.rows.get(id) ?? null;
  }
  async loadForScope(): Promise<DefenseBudgetProjectionPlanRecordV1[]> {
    return [...this.rows.values()];
  }
}

function buildDecorator(input: {
  readOnlyAdapter: FamilyReconciliationCertificationPortV1;
  manifestSource: ManifestForMaterializationPortV1;
  artifactSource: MaterializationArtifactSourcePortV1;
  projectionPlans: ProjectionPlanRepositoryV1;
}): MaterializingFamilyReconciliationCertificationV1 {
  return new MaterializingFamilyReconciliationCertificationV1(
    input.readOnlyAdapter,
    input.manifestSource,
    input.artifactSource,
    input.projectionPlans,
    'test-materializer@1',
  );
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('MaterializingFamilyReconciliationCertificationV1', () => {
  it('fast path: already certified -> returned verbatim, no manifest/materialization attempt', async () => {
    const certified = result({
      certified: true,
      certificationStatus: 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION',
      certificationContentSha256: SHA,
    });
    const readOnlyAdapter = new FakeReadOnlyAdapter(certified);
    const manifestSource = new FakeManifestSource(omManifest());
    const artifactSource = new FakeArtifactSource();
    const projectionPlans = new InMemoryProjectionPlanRepository();
    const decorator = buildDecorator({ readOnlyAdapter, manifestSource, artifactSource, projectionPlans });

    const outcome = await decorator.reconcileAndCertify(identity('om'), corpus('om'));

    expect(outcome).toEqual(certified);
    expect(readOnlyAdapter.calls).toHaveLength(1);
    expect(manifestSource.calls).toBe(0);
    expect(artifactSource.loadCandidateRefsCalls).toBe(0);
    expect(projectionPlans.insertCalls).toBe(0);
  });

  it('NEEDS_REVIEW is a real Phase 4/5/6 outcome -- returned unchanged, never retried via materialization', async () => {
    const needsReview = result({ certified: false, certificationStatus: 'NEEDS_REVIEW' });
    const readOnlyAdapter = new FakeReadOnlyAdapter(needsReview);
    const manifestSource = new FakeManifestSource(omManifest());
    const artifactSource = new FakeArtifactSource();
    const projectionPlans = new InMemoryProjectionPlanRepository();
    const decorator = buildDecorator({ readOnlyAdapter, manifestSource, artifactSource, projectionPlans });

    const outcome = await decorator.reconcileAndCertify(identity('om'), corpus('om'));

    expect(outcome).toEqual(needsReview);
    expect(readOnlyAdapter.calls).toHaveLength(1);
    expect(manifestSource.calls).toBe(0);
    expect(artifactSource.loadCandidateRefsCalls).toBe(0);
  });

  it('REJECTED is a real Phase 4/5/6 outcome -- returned unchanged, never retried via materialization', async () => {
    const rejected = result({ certified: false, certificationStatus: 'REJECTED' });
    const readOnlyAdapter = new FakeReadOnlyAdapter(rejected);
    const manifestSource = new FakeManifestSource(omManifest());
    const artifactSource = new FakeArtifactSource();
    const projectionPlans = new InMemoryProjectionPlanRepository();
    const decorator = buildDecorator({ readOnlyAdapter, manifestSource, artifactSource, projectionPlans });

    const outcome = await decorator.reconcileAndCertify(identity('om'), corpus('om'));

    expect(outcome).toEqual(rejected);
    expect(readOnlyAdapter.calls).toHaveLength(1);
    expect(manifestSource.calls).toBe(0);
  });

  it('rdte enters durable materialization and reports a missing governed manifest', async () => {
    const incomplete = result({ certificationStatus: 'INCOMPLETE' });
    const readOnlyAdapter = new FakeReadOnlyAdapter(incomplete);
    const manifestSource = new FakeManifestSource(null);
    const artifactSource = new FakeArtifactSource();
    const projectionPlans = new InMemoryProjectionPlanRepository();
    const decorator = buildDecorator({ readOnlyAdapter, manifestSource, artifactSource, projectionPlans });

    const outcome = await decorator.reconcileAndCertify(identity('rdte'), corpus('rdte'));

    expect(outcome.certified).toBe(false);
    expect(outcome.reason).toContain('no durable governed manifest');
    expect(readOnlyAdapter.calls).toHaveLength(1);
    expect(manifestSource.calls).toBe(1);
    expect(artifactSource.loadCandidateRefsCalls).toBe(0);
  });

  it('committee (non-materializable family): falls through with its exact per-family note, manifest/artifact source never touched', async () => {
    const incomplete = result({ certificationStatus: 'INCOMPLETE' });
    const readOnlyAdapter = new FakeReadOnlyAdapter(incomplete);
    const manifestSource = new FakeManifestSource(omManifest());
    const artifactSource = new FakeArtifactSource();
    const projectionPlans = new InMemoryProjectionPlanRepository();
    const decorator = buildDecorator({ readOnlyAdapter, manifestSource, artifactSource, projectionPlans });

    const outcome = await decorator.reconcileAndCertify(identity('committee'), corpus('committee'));

    expect(outcome.certified).toBe(false);
    expect(outcome.reason).toContain('Phase6CycleCertificationInputV1');
    expect(manifestSource.calls).toBe(0);
  });

  it('missing durable manifest is reported, never silently treated as empty -- no materialization attempted', async () => {
    const incomplete = result({ certificationStatus: 'INCOMPLETE' });
    const readOnlyAdapter = new FakeReadOnlyAdapter(incomplete);
    const manifestSource = new FakeManifestSource(null);
    const artifactSource = new FakeArtifactSource();
    const projectionPlans = new InMemoryProjectionPlanRepository();
    const decorator = buildDecorator({ readOnlyAdapter, manifestSource, artifactSource, projectionPlans });

    const outcome = await decorator.reconcileAndCertify(identity('om'), corpus('om'));

    expect(outcome.certified).toBe(false);
    expect(outcome.reason).toContain('no durable governed manifest could be resolved');
    expect(manifestSource.calls).toBe(1);
    expect(artifactSource.loadCandidateRefsCalls).toBe(0);
    expect(projectionPlans.insertCalls).toBe(0);
  });

  it('successful materialization: decorator NEVER returns its own verdict, always re-reads through the SAME read-only adapter', async () => {
    const incomplete = result({ certificationStatus: 'INCOMPLETE' });
    const nowCertified = result({
      certified: true,
      certificationStatus: 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION',
      certificationContentSha256: SHA,
      reason: 'read after materialization',
    });
    // Two queued results: first call (fast-path check) -> INCOMPLETE;
    // second call (re-read after materialization) -> now certified.
    const readOnlyAdapter = new FakeReadOnlyAdapter(incomplete, nowCertified);
    const manifestSource = new FakeManifestSource(omManifest());
    const artifactSource = new FakeArtifactSource();
    const projectionPlans = new InMemoryProjectionPlanRepository();
    const decorator = buildDecorator({ readOnlyAdapter, manifestSource, artifactSource, projectionPlans });

    const outcome = await decorator.reconcileAndCertify(identity('om'), corpus('om'));

    // The decorator's returned value IS the second read-only result, not a
    // freshly-constructed object describing the materialization's own
    // MaterializationResultV1 -- proves the indirection is real, not just
    // documented.
    expect(outcome).toEqual(nowCertified);
    expect(readOnlyAdapter.calls).toHaveLength(2);
    expect(manifestSource.calls).toBe(1);
    expect(artifactSource.loadCandidateRefsCalls).toBe(1);
    expect(projectionPlans.insertCalls).toBe(1);
  });

  it('materialization attempt that does not reach "materialized" (no_candidates_yet): original existing result returned with detail appended, read-only adapter NOT called a second time', async () => {
    const incomplete = result({ certificationStatus: 'INCOMPLETE', reason: 'no projection plan filed yet' });
    const readOnlyAdapter = new FakeReadOnlyAdapter(incomplete);
    const manifestSource = new FakeManifestSource(omManifest());
    const artifactSource = new FakeIncompleteArtifactSource();
    const projectionPlans = new InMemoryProjectionPlanRepository();
    const decorator = buildDecorator({ readOnlyAdapter, manifestSource, artifactSource, projectionPlans });

    const outcome = await decorator.reconcileAndCertify(identity('om'), corpus('om'));

    expect(outcome.certified).toBe(false);
    expect(outcome.certificationStatus).toBe('INCOMPLETE');
    expect(outcome.reason).toContain('no projection plan filed yet');
    expect(outcome.reason).toContain('materialization attempt');
    expect(outcome.reason).toContain('no terminal verification candidate yet');
    // Only the ORIGINAL fast-path read happened -- there is no new
    // certification row to re-read, so a second adapter call would be a
    // wasted round trip against nothing new.
    expect(readOnlyAdapter.calls).toHaveLength(1);
    expect(projectionPlans.insertCalls).toBe(0);
  });

  it('alternative_funding/execution never reach the manifest or artifact source', async () => {
    // `CycleFamilyReadinessIdentityV1['familyGroup']` itself has no member
    // for these two tracks -- evaluateCycleFamilyReadinessV1 already returns
    // certification_not_supported for them before readiness ever reaches
    // this decorator (see cycle-family-readiness-v1.ts's
    // UNSUPPORTED_READINESS_TRACKS), so there is no real identity to
    // construct here. Exercised instead via isMaterializableNonRdteFamily,
    // which is the exact narrowing this decorator calls internally.
    for (const family of ['alternative_funding', 'execution']) {
      const incomplete = result({ certificationStatus: 'INCOMPLETE' });
      const readOnlyAdapter = new FakeReadOnlyAdapter(incomplete);
      const manifestSource = new FakeManifestSource(omManifest());
      const artifactSource = new FakeArtifactSource();
      const projectionPlans = new InMemoryProjectionPlanRepository();
      const decorator = buildDecorator({ readOnlyAdapter, manifestSource, artifactSource, projectionPlans });

      await decorator.reconcileAndCertify(
        { fiscalYear: 2027, authorityTrack: 'authorization', familyGroup: family as never },
        { identity: { fiscalYear: 2027, authorityTrack: 'authorization', familyGroup: family as never }, cycleId: 'c', expectedSources: [] },
      );

      expect(manifestSource.calls).toBe(0);
      expect(artifactSource.loadCandidateRefsCalls).toBe(0);
    }
  });
});
