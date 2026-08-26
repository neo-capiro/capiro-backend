/**
 * Phase 10B-2D -- materialization boundary tests.
 *
 * Proves the required-family paths end to end using an in-memory fake
 * `MaterializationArtifactSourcePortV1` (durable-candidate-shaped) and a
 * real `buildProjectionPlanRecordV1` + in-memory `ProjectionPlanRepositoryV1`
 * fake (so persist -> reload -> proof-binding is exercised, not stubbed
 * away):
 *
 *   - ready procurement/om/milcon corpus -> existing non-RDT&E pipeline
 *     invoked -> normal projection/certification artifact persisted -> same
 *     artifact reloaded and reported back.
 *   - incomplete corpus (missing required document) -> no certification call
 *     (`no_candidates_yet`).
 *   - REJECT candidate -> no certification call (`candidate_rejected`).
 *   - alternative_funding/execution/rdte/committee -> `missing_durable_input`,
 *     never invoke a certifier.
 *   - restart/idempotency: two identical materialization attempts converge
 *     to the same projectionPlanId and do not duplicate the artifact.
 */
import { describe, it, expect } from '@jest/globals';
import {
  materializeNonRdteFamilyCertificationV1,
  isMaterializableNonRdteFamily,
  MISSING_DURABLE_INPUT_NOTES,
  type MaterializationArtifactSourcePortV1,
  type MaterializationCandidateArtifactRefV1,
  type MaterializationRequestV1,
} from './family-certification-materialization-v1.js';
import {
  buildProjectionPlanRecordV1,
  defenseBudgetProjectionPlanRecordV1Schema,
  type DefenseBudgetProjectionPlanRecordV1,
} from '../../projection-plan/projection-plan-record-v1.js';
import type { ProjectionPlanRepositoryV1 } from '../../projection-plan/projection-plan-repository-prisma-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import type { BudgetCycleManifestDocumentV1 } from '../../contracts/budget-cycle-manifest-v1.js';
import type { CycleFamilyReadinessIdentityV1 } from './cycle-family-readiness-v1.js';

const SHA = 'a'.repeat(64);

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */
/*
 * IMPORTANT: unlike non-rdte-cycle-pipeline-v1.spec.ts (which builds its
 * `familyReport` fixture BY HAND and never runs artifacts through a
 * composer), `materializeNonRdteFamilyCertificationV1` calls
 * `composeOmFamily`/`composeProcurementFamily`/`composeMilconFamily`
 * itself on the reloaded artifacts (see family-certification-
 * materialization-v1.ts lines 362-393). An artifact with `assertions: []`
 * composes to zero identities, which fails composeOmFamily's own
 * `o1_identity_missing`/`required_identity_not_found` gates -- the
 * pipeline then correctly reports `certification_failed`. Fixtures here
 * must carry REAL `om_line` + `funding` assertions that resolve to the
 * exact required identity key the test's manifest declares
 * (`OM_SAG:ARMY:O&M, ARMY:SAG1`), matching the shape
 * om-composer-v1.spec.ts's own fixtures use.
 */

const OM_CODE = 'SAG1';
const OM_ACCOUNT = 'O&M, ARMY';
const OM_COMPONENT = 'ARMY';

function makeArtifact(
  key: string,
  exhibit: string,
  family: 'procurement' | 'om' | 'milcon',
  moneyMillions = '30',
): DefenseBudgetExtractionArtifactV1 {
  const assertions =
    family === 'om'
      ? [
          {
            assertionId: `asrt_om_line_${key}`,
            assertionKind: 'om_line',
            sourceFactIds: [],
            evidenceIds: [],
            confidence: 1,
            identity: {
              lineKind: 'OM_SAG',
              code: OM_CODE,
              account: OM_ACCOUNT,
              component: OM_COMPONENT,
            },
            title: 'Operations and Maintenance Support',
          },
          {
            assertionId: `asrt_om_funding_${key}`,
            assertionKind: 'funding',
            sourceFactIds: [],
            evidenceIds: [],
            confidence: 1,
            identity: {
              lineKind: 'OM_SAG',
              code: OM_CODE,
              account: OM_ACCOUNT,
              component: OM_COMPONENT,
            },
            fiscalYear: 2027,
            field: 'request',
            money: {
              originalValue: moneyMillions,
              originalUnit: 'millions',
              valueMillions: moneyMillions,
            },
          },
        ]
      : [];
  return {
    artifactId: `art_${key}`,
    schemaVersion: 'defense_budget_extraction_v1',
    source: {
      manifestDocumentKey: key,
      sourcePdfSha256: SHA,
      sourceLocator: `fixture://${key}.pdf`,
      fiscalYear: 2027,
      family,
      exhibit,
      budgetCycle: 'pb_fy2027',
      component: 'ARMY',
      sourceUrl: `fixture://${key}.pdf`,
    },
    contentSha256: SHA,
    assertions,
    evidence: [],
    omissions: [],
    warnings: [],
    parserRuns: [],
    extractedAt: '2026-01-01T00:00:00Z',
  } as unknown as DefenseBudgetExtractionArtifactV1;
}

function makeManifestDoc(
  key: string,
  exhibit: string,
  family: 'procurement' | 'om' | 'milcon',
  required: boolean,
): BudgetCycleManifestDocumentV1 {
  return {
    documentKey: key,
    required,
    title: `Fixture ${exhibit}`,
    sourceLocator: `fixture://${key}.pdf`,
    family,
    exhibit,
    authority: 'procurement',
    component: 'ARMY',
    budgetCycle: 'pb_fy2027',
    documentType: 'pdf',
    parserPolicy: 'native_structured',
    requiredDataCategories: ['identity', 'funding'],
    expectedLineKinds: ['PROCUREMENT_BLIN'],
  } as unknown as BudgetCycleManifestDocumentV1;
}

function identity(
  familyGroup: CycleFamilyReadinessIdentityV1['familyGroup'],
): CycleFamilyReadinessIdentityV1 {
  return { fiscalYear: 2027, authorityTrack: 'authorization', familyGroup };
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

/** In-memory `MaterializationArtifactSourcePortV1` over a fixed candidate/artifact map. */
class FakeArtifactSource implements MaterializationArtifactSourcePortV1 {
  public loadCandidateRefsCalls = 0;
  public loadVerifiedArtifactCalls = 0;
  constructor(
    private readonly refs: Map<string, MaterializationCandidateArtifactRefV1>,
    private readonly artifacts: Map<string, DefenseBudgetExtractionArtifactV1>,
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
    if (artifact == null) {
      throw new Error(`no fixture artifact registered for ${ref.manifestDocumentKey}`);
    }
    return artifact;
  }
}

/** In-memory `ProjectionPlanRepositoryV1` -- real insert/reload semantics, no DB. */
class InMemoryProjectionPlanRepository implements ProjectionPlanRepositoryV1 {
  public insertCalls = 0;
  private readonly rows = new Map<string, DefenseBudgetProjectionPlanRecordV1>();

  async insert(record: DefenseBudgetProjectionPlanRecordV1): Promise<void> {
    this.insertCalls += 1;
    const parsed = defenseBudgetProjectionPlanRecordV1Schema.parse(record);
    if (this.rows.has(parsed.projectionPlanId)) return; // ON CONFLICT DO NOTHING
    this.rows.set(parsed.projectionPlanId, parsed);
  }

  async loadVerified(projectionPlanId: string): Promise<DefenseBudgetProjectionPlanRecordV1 | null> {
    return this.rows.get(projectionPlanId) ?? null;
  }

  async loadForScope(): Promise<DefenseBudgetProjectionPlanRecordV1[]> {
    return [...this.rows.values()];
  }

  get rowCount(): number {
    return this.rows.size;
  }
}

function omManifest(overrides: Partial<{ documents: BudgetCycleManifestDocumentV1[] }> = {}) {
  return {
    manifestContentSha256: SHA,
    documents: overrides.documents ?? [
      makeManifestDoc('o1', 'O-1', 'om', true),
      makeManifestDoc('op5', 'OP-5', 'om', true),
    ],
    requiredIdentityKeys: ['OM_SAG:ARMY:O&M, ARMY:SAG1'],
    requiredNarrativeSections: [] as string[],
  };
}

describe('materializeNonRdteFamilyCertificationV1', () => {
  it('ready OM corpus: existing non-RDT&E path invoked, artifact persisted, reload proves identity', async () => {
    const refs = new Map([
      ['o1', candidateRef({ documentKey: 'o1', candidateId: 'c-o1', runId: 'r-o1', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
      ['op5', candidateRef({ documentKey: 'op5', candidateId: 'c-op5', runId: 'r-op5', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
    ]);
    const artifacts = new Map([
      ['o1', makeArtifact('o1', 'O-1', 'om')],
      ['op5', makeArtifact('op5', 'OP-5', 'om')],
    ]);
    const artifactSource = new FakeArtifactSource(refs, artifacts);
    const projectionPlans = new InMemoryProjectionPlanRepository();

    const request: MaterializationRequestV1 = {
      identity: identity('om'),
      cycleId: 'cycle-fy2027-authorization',
      manifest: omManifest(),
    };

    const result = await materializeNonRdteFamilyCertificationV1(request, {
      artifactSource,
      projectionPlans,
      producerVersion: 'test-materializer@1',
    });

    expect(result.outcome).toBe('materialized');
    expect(result.record).not.toBeNull();
    expect(result.record?.family).toBe('om');
    expect(result.record?.status).toBe('PROJECTABLE');
    expect(projectionPlans.insertCalls).toBe(1);
    expect(projectionPlans.rowCount).toBe(1);

    // Reload proof: the returned record IS the reloaded row, not the
    // in-memory build result -- verifyRowV1-shaped invariants must hold.
    const reloaded = await projectionPlans.loadVerified(result.record!.projectionPlanId);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.contentSha256).toBe(result.record?.contentSha256);
  });

  it('incomplete corpus (missing required OP-5 candidate) -> no_candidates_yet, no pipeline invocation', async () => {
    const refs = new Map([
      ['o1', candidateRef({ documentKey: 'o1', candidateId: 'c-o1', runId: 'r-o1', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
      // op5 intentionally absent -- required document has no candidate yet.
    ]);
    const artifacts = new Map([['o1', makeArtifact('o1', 'O-1', 'om')]]);
    const artifactSource = new FakeArtifactSource(refs, artifacts);
    const projectionPlans = new InMemoryProjectionPlanRepository();

    const result = await materializeNonRdteFamilyCertificationV1(
      { identity: identity('om'), cycleId: 'c', manifest: omManifest() },
      { artifactSource, projectionPlans, producerVersion: 'v1' },
    );

    expect(result.outcome).toBe('no_candidates_yet');
    expect(result.record).toBeNull();
    expect(projectionPlans.insertCalls).toBe(0);
    expect(artifactSource.loadVerifiedArtifactCalls).toBe(0);
  });

  it('REJECT candidate on a required document -> candidate_rejected, no pipeline invocation', async () => {
    const refs = new Map([
      ['o1', candidateRef({ documentKey: 'o1', candidateId: 'c-o1', runId: 'r-o1', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
      ['op5', candidateRef({ documentKey: 'op5', candidateId: 'c-op5', runId: 'r-op5', decision: 'REJECT', status: 'REJECTED' })],
    ]);
    const artifacts = new Map([
      ['o1', makeArtifact('o1', 'O-1', 'om')],
      ['op5', makeArtifact('op5', 'OP-5', 'om')],
    ]);
    const artifactSource = new FakeArtifactSource(refs, artifacts);
    const projectionPlans = new InMemoryProjectionPlanRepository();

    const result = await materializeNonRdteFamilyCertificationV1(
      { identity: identity('om'), cycleId: 'c', manifest: omManifest() },
      { artifactSource, projectionPlans, producerVersion: 'v1' },
    );

    expect(result.outcome).toBe('candidate_rejected');
    expect(projectionPlans.insertCalls).toBe(0);
  });

  it('a NEEDS_REVIEW candidate still awaiting review -> candidate_incomplete, no pipeline invocation', async () => {
    const refs = new Map([
      ['o1', candidateRef({ documentKey: 'o1', candidateId: 'c-o1', runId: 'r-o1', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
      ['op5', candidateRef({ documentKey: 'op5', candidateId: 'c-op5', runId: 'r-op5', decision: 'REVIEW', status: 'NEEDS_REVIEW' })],
    ]);
    const artifacts = new Map([
      ['o1', makeArtifact('o1', 'O-1', 'om')],
      ['op5', makeArtifact('op5', 'OP-5', 'om')],
    ]);
    const artifactSource = new FakeArtifactSource(refs, artifacts);
    const projectionPlans = new InMemoryProjectionPlanRepository();

    const result = await materializeNonRdteFamilyCertificationV1(
      { identity: identity('om'), cycleId: 'c', manifest: omManifest() },
      { artifactSource, projectionPlans, producerVersion: 'v1' },
    );

    expect(result.outcome).toBe('candidate_incomplete');
    expect(projectionPlans.insertCalls).toBe(0);
  });

  it.each(['rdte' as const, 'committee' as const, 'alternative_funding' as const, 'execution' as const])(
    '%s -> missing_durable_input, never invokes any certifier',
    async (family) => {
      const artifactSource = new FakeArtifactSource(new Map(), new Map());
      const projectionPlans = new InMemoryProjectionPlanRepository();
      const result = await materializeNonRdteFamilyCertificationV1(
        {
          identity: { fiscalYear: 2027, authorityTrack: 'authorization', familyGroup: family as never },
          cycleId: 'c',
          manifest: omManifest(),
        },
        { artifactSource, projectionPlans, producerVersion: 'v1' },
      );
      expect(result.outcome).toBe('missing_durable_input');
      expect(projectionPlans.insertCalls).toBe(0);
      expect(artifactSource.loadCandidateRefsCalls).toBe(0);
    },
  );

  it('isMaterializableNonRdteFamily narrows exactly procurement/om/milcon', () => {
    expect(isMaterializableNonRdteFamily('procurement')).toBe(true);
    expect(isMaterializableNonRdteFamily('om')).toBe(true);
    expect(isMaterializableNonRdteFamily('milcon')).toBe(true);
    expect(isMaterializableNonRdteFamily('rdte')).toBe(false);
    expect(isMaterializableNonRdteFamily('committee')).toBe(false);
    expect(isMaterializableNonRdteFamily('alternative_funding')).toBe(false);
  });

  it('MISSING_DURABLE_INPUT_NOTES names the exact gap for committee, and no longer for rdte', () => {
    expect(MISSING_DURABLE_INPUT_NOTES.rdte).toBeUndefined();
    expect(MISSING_DURABLE_INPUT_NOTES.committee).toContain('Phase6CycleCertificationInputV1');
  });

  it('restart/idempotency: two identical materialization attempts converge to the same projectionPlanId, no duplicate insert', async () => {
    const refs = new Map([
      ['o1', candidateRef({ documentKey: 'o1', candidateId: 'c-o1', runId: 'r-o1', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
      ['op5', candidateRef({ documentKey: 'op5', candidateId: 'c-op5', runId: 'r-op5', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
    ]);
    const artifacts = new Map([
      ['o1', makeArtifact('o1', 'O-1', 'om')],
      ['op5', makeArtifact('op5', 'OP-5', 'om')],
    ]);
    const artifactSource = new FakeArtifactSource(refs, artifacts);
    const projectionPlans = new InMemoryProjectionPlanRepository();
    const request: MaterializationRequestV1 = {
      identity: identity('om'),
      cycleId: 'cycle-fy2027-authorization',
      manifest: omManifest(),
    };

    const first = await materializeNonRdteFamilyCertificationV1(request, {
      artifactSource,
      projectionPlans,
      producerVersion: 'v1',
    });
    const second = await materializeNonRdteFamilyCertificationV1(request, {
      artifactSource,
      projectionPlans,
      producerVersion: 'v1',
    });

    expect(first.outcome).toBe('materialized');
    expect(second.outcome).toBe('materialized');
    expect(first.record?.projectionPlanId).toBe(second.record?.projectionPlanId);
    expect(first.record?.contentSha256).toBe(second.record?.contentSha256);
    // Two inserts were attempted (this simple fake doesn't dedupe calls),
    // but the underlying store converged to exactly one row -- the real
    // Prisma repository's ON CONFLICT DO NOTHING enforces the same
    // invariant against real concurrent writers.
    expect(projectionPlans.insertCalls).toBe(2);
    expect(projectionPlans.rowCount).toBe(1);
  });

  it('simulated crash: certification persisted, "process dies" before caller reads it, a fresh reload sees the exact same row (no duplicate on the next materialization attempt)', async () => {
    const refs = new Map([
      ['o1', candidateRef({ documentKey: 'o1', candidateId: 'c-o1', runId: 'r-o1', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
      ['op5', candidateRef({ documentKey: 'op5', candidateId: 'c-op5', runId: 'r-op5', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
    ]);
    const artifacts = new Map([
      ['o1', makeArtifact('o1', 'O-1', 'om')],
      ['op5', makeArtifact('op5', 'OP-5', 'om')],
    ]);
    const artifactSource = new FakeArtifactSource(refs, artifacts);
    // Shared durable store simulating survival across the "crash" -- a new
    // repository INSTANCE wrapping the SAME underlying rows models "process
    // restarts, database persists".
    const sharedRows = new Map<string, DefenseBudgetProjectionPlanRecordV1>();
    class SharedRowsRepository implements ProjectionPlanRepositoryV1 {
      async insert(record: DefenseBudgetProjectionPlanRecordV1): Promise<void> {
        const parsed = defenseBudgetProjectionPlanRecordV1Schema.parse(record);
        if (sharedRows.has(parsed.projectionPlanId)) return;
        sharedRows.set(parsed.projectionPlanId, parsed);
      }
      async loadVerified(id: string): Promise<DefenseBudgetProjectionPlanRecordV1 | null> {
        return sharedRows.get(id) ?? null;
      }
      async loadForScope(): Promise<DefenseBudgetProjectionPlanRecordV1[]> {
        return [...sharedRows.values()];
      }
    }

    const request: MaterializationRequestV1 = {
      identity: identity('om'),
      cycleId: 'cycle-fy2027-authorization',
      manifest: omManifest(),
    };

    // "Run before crash": persists successfully.
    const beforeCrash = await materializeNonRdteFamilyCertificationV1(request, {
      artifactSource,
      projectionPlans: new SharedRowsRepository(),
      producerVersion: 'v1',
    });
    expect(beforeCrash.outcome).toBe('materialized');
    expect(sharedRows.size).toBe(1);

    // "Restart": a brand-new repository instance over the SAME durable rows,
    // brand-new materialization call for the identical corpus.
    const afterRestart = await materializeNonRdteFamilyCertificationV1(request, {
      artifactSource,
      projectionPlans: new SharedRowsRepository(),
      producerVersion: 'v1',
    });
    expect(afterRestart.outcome).toBe('materialized');
    expect(afterRestart.record?.projectionPlanId).toBe(beforeCrash.record?.projectionPlanId);
    expect(sharedRows.size).toBe(1); // no duplicate certification/artifact
  });

  it('a changed certified input (different artifact content) produces a new immutable identity, not a mutation of the old one', async () => {
    const refs = new Map([
      ['o1', candidateRef({ documentKey: 'o1', candidateId: 'c-o1', runId: 'r-o1', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
      ['op5', candidateRef({ documentKey: 'op5', candidateId: 'c-op5', runId: 'r-op5', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
    ]);
    const artifactsV1 = new Map([
      ['o1', makeArtifact('o1', 'O-1', 'om')],
      ['op5', makeArtifact('op5', 'OP-5', 'om')],
    ]);
    const projectionPlans = new InMemoryProjectionPlanRepository();
    const request: MaterializationRequestV1 = {
      identity: identity('om'),
      cycleId: 'cycle-fy2027-authorization',
      manifest: omManifest(),
    };

    const first = await materializeNonRdteFamilyCertificationV1(request, {
      artifactSource: new FakeArtifactSource(refs, artifactsV1),
      projectionPlans,
      producerVersion: 'v1',
    });

    // Same candidates, but the artifact content itself changed (e.g. a
    // corrected re-extraction with a different content hash) -- this must
    // derive a DIFFERENT projectionPlanId. Keep the same om_line/funding
    // assertions (so the corpus stays certifiable through composeOmFamily)
    // and vary only contentSha256, which is what the certified bundle's own
    // `artifacts[].artifactContentSha256` binds on.
    const changedArtifact = {
      ...makeArtifact('o1', 'O-1', 'om'),
      contentSha256: 'b'.repeat(64),
    } as unknown as DefenseBudgetExtractionArtifactV1;
    const artifactsV2 = new Map([
      ['o1', changedArtifact],
      ['op5', makeArtifact('op5', 'OP-5', 'om')],
    ]);
    const second = await materializeNonRdteFamilyCertificationV1(request, {
      artifactSource: new FakeArtifactSource(refs, artifactsV2),
      projectionPlans,
      producerVersion: 'v1',
    });

    expect(first.outcome).toBe('materialized');
    expect(second.outcome).toBe('materialized');
    expect(first.record?.projectionPlanId).not.toBe(second.record?.projectionPlanId);
    // Old artifact is never mutated -- both rows remain independently reloadable.
    const oldReloaded = await projectionPlans.loadVerified(first.record!.projectionPlanId);
    expect(oldReloaded?.contentSha256).toBe(first.record?.contentSha256);
  });

  it('wrong cycle: a request cycleId the artifact source has no data for never widens/ignores scope -- fails closed to no_candidates_yet', async () => {
    // The fake's loadCandidateRefs only returns rows it was explicitly given
    // for the exact requested cycleId path -- proving the module passes the
    // exact cycleId through and never falls back to "any cycle" data.
    class CycleScopedArtifactSource implements MaterializationArtifactSourcePortV1 {
      public requestedCycleIds: string[] = [];
      async loadCandidateRefs(input: {
        cycleId: string;
        manifestDocumentKeys: readonly string[];
      }): Promise<ReadonlyMap<string, MaterializationCandidateArtifactRefV1>> {
        this.requestedCycleIds.push(input.cycleId);
        // Only 'cycle-fy2027-authorization' has data; any other cycleId
        // (e.g. a stale/wrong cycle reference) resolves to nothing.
        if (input.cycleId !== 'cycle-fy2027-authorization') return new Map();
        return new Map([
          ['o1', candidateRef({ documentKey: 'o1', candidateId: 'c-o1', runId: 'r-o1', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
          ['op5', candidateRef({ documentKey: 'op5', candidateId: 'c-op5', runId: 'r-op5', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
        ]);
      }
      async loadVerifiedArtifact(): Promise<DefenseBudgetExtractionArtifactV1> {
        throw new Error('should not reach an artifact reload for the wrong-cycle scope');
      }
    }
    const artifactSource = new CycleScopedArtifactSource();
    const projectionPlans = new InMemoryProjectionPlanRepository();

    const result = await materializeNonRdteFamilyCertificationV1(
      {
        identity: identity('om'),
        cycleId: 'cycle-fy2029-authorization', // wrong cycle for this corpus
        manifest: omManifest(),
      },
      { artifactSource, projectionPlans, producerVersion: 'v1' },
    );

    expect(result.outcome).toBe('no_candidates_yet');
    expect(artifactSource.requestedCycleIds).toEqual(['cycle-fy2029-authorization']);
    expect(projectionPlans.insertCalls).toBe(0);
  });

  it('wrong fiscal year: the identical certified corpus under a DIFFERENT fiscalYear identity derives a DIFFERENT immutable plan identity, never reusing another FY\'s materialization', async () => {
    const refs = new Map([
      ['o1', candidateRef({ documentKey: 'o1', candidateId: 'c-o1', runId: 'r-o1', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
      ['op5', candidateRef({ documentKey: 'op5', candidateId: 'c-op5', runId: 'r-op5', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
    ]);
    const artifacts = new Map([
      ['o1', makeArtifact('o1', 'O-1', 'om')],
      ['op5', makeArtifact('op5', 'OP-5', 'om')],
    ]);
    const projectionPlans = new InMemoryProjectionPlanRepository();

    const resultFy2027 = await materializeNonRdteFamilyCertificationV1(
      {
        identity: { fiscalYear: 2027, authorityTrack: 'authorization', familyGroup: 'om' },
        cycleId: 'cycle-fy2027-authorization',
        manifest: omManifest(),
      },
      { artifactSource: new FakeArtifactSource(refs, artifacts), projectionPlans, producerVersion: 'v1' },
    );
    const resultFy2028 = await materializeNonRdteFamilyCertificationV1(
      {
        identity: { fiscalYear: 2028, authorityTrack: 'authorization', familyGroup: 'om' },
        cycleId: 'cycle-fy2027-authorization', // same cycleId reused deliberately: fiscalYear alone must still discriminate
        manifest: omManifest(),
      },
      { artifactSource: new FakeArtifactSource(refs, artifacts), projectionPlans, producerVersion: 'v1' },
    );

    expect(resultFy2027.outcome).toBe('materialized');
    expect(resultFy2028.outcome).toBe('materialized');
    expect(resultFy2027.record?.projectionPlanId).not.toBe(resultFy2028.record?.projectionPlanId);
    expect(resultFy2027.record?.fiscalYear).toBe(2027);
    expect(resultFy2028.record?.fiscalYear).toBe(2028);
  });

  it('stale/superseded manifest: a changed manifestContentSha256 over the identical artifact set derives a DIFFERENT plan identity, never silently reusing the old manifest\'s materialization', async () => {
    const refs = new Map([
      ['o1', candidateRef({ documentKey: 'o1', candidateId: 'c-o1', runId: 'r-o1', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
      ['op5', candidateRef({ documentKey: 'op5', candidateId: 'c-op5', runId: 'r-op5', decision: 'PASS', status: 'VERIFICATION_PASSED' })],
    ]);
    const artifacts = new Map([
      ['o1', makeArtifact('o1', 'O-1', 'om')],
      ['op5', makeArtifact('op5', 'OP-5', 'om')],
    ]);
    const projectionPlans = new InMemoryProjectionPlanRepository();
    const request: MaterializationRequestV1 = {
      identity: identity('om'),
      cycleId: 'cycle-fy2027-authorization',
      manifest: omManifest(),
    };

    const originalManifest = await materializeNonRdteFamilyCertificationV1(request, {
      artifactSource: new FakeArtifactSource(refs, artifacts),
      projectionPlans,
      producerVersion: 'v1',
    });

    // A superseding manifest revision (different content hash), same
    // documents/artifacts otherwise -- this must NOT reuse the stale
    // manifest's materialized plan identity.
    const supersedingManifest = {
      ...omManifest(),
      manifestContentSha256: 'c'.repeat(64),
    };
    const supersededResult = await materializeNonRdteFamilyCertificationV1(
      { ...request, manifest: supersedingManifest },
      {
        artifactSource: new FakeArtifactSource(refs, artifacts),
        projectionPlans,
        producerVersion: 'v1',
      },
    );

    expect(originalManifest.outcome).toBe('materialized');
    expect(supersededResult.outcome).toBe('materialized');
    expect(originalManifest.record?.projectionPlanId).not.toBe(supersededResult.record?.projectionPlanId);
    // The stale manifest's plan is never mutated -- both remain independently reloadable.
    const staleReloaded = await projectionPlans.loadVerified(originalManifest.record!.projectionPlanId);
    expect(staleReloaded?.contentSha256).toBe(originalManifest.record?.contentSha256);
  });
});

describe('materializeNonRdteFamilyCertificationV1 -- authorization boundary', () => {
  it('[authorization boundary] the materialization boundary and decorator files (outside doc comments) never reference PROMOTER_DATABASE_URL, DefenseBudgetPromotionAuthorizationServiceV1.issue, or DefenseBudgetCanonicalPromotionServiceV1.execute', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs');
    const files = [
      require.resolve('./family-certification-materialization-v1.ts'),
      require.resolve('./materializing-family-reconciliation-certification-v1.ts'),
      require.resolve('./prisma-materialization-artifact-source-v1.ts'),
      require.resolve('./prisma-cycle-manifest-registry-v1.ts'),
    ];
    const forbidden = [
      'PROMOTER_DATABASE_URL',
      'DefenseBudgetPromotionAuthorizationServiceV1',
      'DefenseBudgetCanonicalPromotionServiceV1',
      '.issue(',
      '.execute(',
    ];
    for (const file of files) {
      const source: string = fs.readFileSync(file, 'utf8');
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const term of forbidden) {
        expect(withoutComments).not.toContain(term);
      }
    }
  });
});
