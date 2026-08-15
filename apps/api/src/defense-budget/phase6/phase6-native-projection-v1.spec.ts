import {
  certifyPhase6CycleV1,
  type Phase6CycleCertificationInputV1,
  type Phase6CycleCertificationV1,
} from './phase6-cycle-certification-v1.js';
import {
  phase6NativeProjectionV1Schema,
  type Phase6NativeProjectionV1,
} from './phase6-native-projection-v1.js';
import {
  Phase6AuditProjectionRepository,
  type Phase6AuditProjectionStore,
} from './phase6-audit-projection-repository.js';
import { buildPhase6OperatorPlanV1 } from './phase6-cycle-runner-v1.js';

const SHA = 'a'.repeat(64);

function projection(overrides: Partial<Phase6NativeProjectionV1> = {}): Phase6NativeProjectionV1 {
  return phase6NativeProjectionV1Schema.parse({
    schemaVersion: 'phase6_native_projection_v1',
    projectionId: 'p1',
    naturalKey: 'RDTE_PE|0605053A|2027|hacDMark',
    idempotencyKey: 'idem-p1',
    projectionKind: 'stage_position',
    verificationCandidateId: 'vc1',
    verificationRunId: 'vr1',
    artifactId: 'a1',
    artifactContentSha256: SHA,
    sourceDocumentId: 'doc1',
    sourcePdfSha256: SHA,
    sourceProfileHash: SHA,
    nativeIdentityHash: SHA,
    track: 'appropriations',
    stage: 'hac_d',
    fundingField: 'hacDMark',
    money: { originalValue: '125', originalUnit: 'millions', valueMillions: '125' },
    directOrDerived: 'direct',
    evidenceIds: ['e1'],
    bindingStatus: 'accepted',
    projectionStatus: 'verified',
    payload: {},
    canonicalWriteAllowed: false,
    ...overrides,
  });
}

function cycle(
  overrides: Partial<Phase6CycleCertificationInputV1> = {},
): Phase6CycleCertificationInputV1 {
  return {
    schemaVersion: 'phase6_cycle_certification_input_v1',
    cycleId: 'fy2027-defense-stage-cycle',
    fiscalYear: 2027,
    manifestHash: SHA,
    documents: [
      {
        documentKey: 'hacd',
        required: true,
        status: 'present',
        profileHash: SHA,
        sourceProofStatus: 'PASS',
      },
    ],
    projections: [projection()],
    comparisons: [{ code: 'request_reference', outcome: 'PASS', required: true }],
    lineFamilyCoverage: { RDTE_PE: 1 },
    bindingCounts: { accepted: 1, candidate: 0, unresolved: 0, conflicting: 0 },
    enactmentProofCoverage: { direct: 0, incorporated: 0, unresolved: 0, blocked: 0 },
    reprogrammingCoverage: 0,
    executionCoverage: 0,
    parserStats: { localPages: 10, paidPages: 0, cacheHits: 4 },
    ...overrides,
  };
}

class FakeStore implements Phase6AuditProjectionStore {
  byIdempotency = new Map<string, Phase6NativeProjectionV1>();
  byNatural = new Map<string, Phase6NativeProjectionV1>();
  certifications = new Map<string, Phase6CycleCertificationV1>();
  bindings = new Map<string, Array<{ projectionId: string; ordinal: number }>>();

  async findByIdempotencyKey(key: string) {
    const value = this.byIdempotency.get(key);
    return value == null
      ? null
      : { projectionId: value.projectionId, naturalKey: value.naturalKey };
  }

  async findLiveByNaturalKey(key: string) {
    const value = this.byNatural.get(key);
    return value == null
      ? null
      : { projectionId: value.projectionId, idempotencyKey: value.idempotencyKey };
  }

  async findCertificationByContentSha256(contentSha256: string) {
    const value = this.certifications.get(contentSha256);
    return value == null
      ? null
      : {
          cycleId: value.cycleId,
          contentSha256: value.contentSha256,
          projectionSetSha256: value.projectionSetSha256,
          projectionCount: value.projectionCount,
        };
  }

  async findProjectionIdsForCertification(contentSha256: string) {
    return [...(this.bindings.get(contentSha256) ?? [])]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((binding) => binding.projectionId);
  }

  async insertProjection(value: Phase6NativeProjectionV1) {
    this.byIdempotency.set(value.idempotencyKey, value);
    this.byNatural.set(value.naturalKey, value);
  }

  async insertCertification(value: Phase6CycleCertificationV1) {
    this.certifications.set(value.contentSha256, value);
  }

  async insertCertificationProjectionBinding(
    certificationContentSha256: string,
    projectionId: string,
    ordinal: number,
  ) {
    const current = this.bindings.get(certificationContentSha256) ?? [];
    current.push({ projectionId, ordinal });
    this.bindings.set(certificationContentSha256, current);
  }
}

describe('Phase 6 Workstream N projection/certification', () => {
  it('represents every non-position Phase 6 projection kind without canonical writes', () => {
    for (const kind of [
      'vehicle_proof',
      'native_line_binding',
      'stage_action',
      'provision_link',
      'enactment_proof',
      'post_enactment_metric',
    ] as const) {
      expect(
        projection({
          projectionId: `p-${kind}`,
          naturalKey: `key-${kind}`,
          idempotencyKey: `idem-${kind}`,
          projectionKind: kind,
          fundingField: undefined,
          money: undefined,
          directOrDerived: 'not_applicable',
          bindingStatus: 'not_applicable',
          projectionStatus: 'candidate',
        }).canonicalWriteAllowed,
      ).toBe(false);
    }
  });

  it('rejects invalid track/stage/field combinations', () => {
    expect(() => projection({ fundingField: 'sacDMark' })).toThrow(/may only own hacDMark/);
    expect(() => projection({ track: 'authorization' })).toThrow(/does not belong/);
  });

  it('rejects enacted rows without proof and candidate bindings on verified positions', () => {
    expect(() =>
      projection({
        stage: 'public_law',
        fundingField: 'enacted',
        naturalKey: 'enacted',
        idempotencyKey: 'enacted',
      }),
    ).toThrow(/enactmentProofId/);
    expect(() => projection({ bindingStatus: 'candidate' })).toThrow(/accepted native binding/);
  });

  it('requires CR line authority, reprogramming revised-total basis, and execution semantics', () => {
    expect(() =>
      projection({
        stage: 'continuing_resolution',
        fundingField: 'enacted',
        enactmentProofId: 'proof-cr',
      }),
    ).toThrow(/explicit line authority/);
    expect(() =>
      projection({
        track: 'post_enactment',
        stage: 'reprogramming',
        fundingField: 'reprogrammed',
      }),
    ).toThrow(/revised-total basis/);
    expect(() =>
      projection({
        track: 'post_enactment',
        stage: 'execution',
        fundingField: 'executed',
      }),
    ).toThrow(/execution metric/);
  });

  it('replays an identical audit projection and cycle certification idempotently', async () => {
    const store = new FakeStore();
    const repository = new Phase6AuditProjectionRepository({
      transaction: async (fn) => fn(store),
    });
    const certification = certifyPhase6CycleV1(cycle());
    const first = await repository.persistAuditOnly({
      projections: [projection()],
      certification,
      auditPersistenceAuthorized: true,
    });
    expect(first).toMatchObject({ insertedProjectionIds: ['p1'], certificationReplayed: false });

    const replay = await repository.persistAuditOnly({
      projections: [projection()],
      certification,
      auditPersistenceAuthorized: true,
    });
    expect(replay).toMatchObject({ replayedProjectionIds: ['p1'], certificationReplayed: true });
  });

  it('blocks a conflicting live projection with the same natural key', async () => {
    const store = new FakeStore();
    await store.insertProjection(
      projection({ projectionId: 'other', idempotencyKey: 'other-idem' }),
    );
    const repository = new Phase6AuditProjectionRepository({
      transaction: async (fn) => fn(store),
    });
    await expect(
      repository.persistAuditOnly({
        projections: [projection()],
        certification: certifyPhase6CycleV1(cycle()),
        auditPersistenceAuthorized: true,
      }),
    ).rejects.toThrow(/conflicting live projection/);
  });

  it('rolls the transaction back when persistence fails', async () => {
    const store = new FakeStore();
    const repository = new Phase6AuditProjectionRepository({
      transaction: async (fn) => {
        const byIdempotency = new Map(store.byIdempotency);
        const byNatural = new Map(store.byNatural);
        const certifications = new Map(store.certifications);
        const bindings = new Map(
          [...store.bindings.entries()].map(([key, value]) => [key, [...value]]),
        );
        try {
          await fn(store);
          throw new Error('force rollback');
        } catch (error) {
          store.byIdempotency = byIdempotency;
          store.byNatural = byNatural;
          store.certifications = certifications;
          store.bindings = bindings;
          throw error;
        }
      },
    });
    await expect(
      repository.persistAuditOnly({
        projections: [projection()],
        certification: certifyPhase6CycleV1(cycle()),
        auditPersistenceAuthorized: true,
      }),
    ).rejects.toThrow(/force rollback/);
    expect(store.byIdempotency.size).toBe(0);
    expect(store.certifications.size).toBe(0);
    expect(store.bindings.size).toBe(0);
  });

  it('keeps every operator command inspect-only by default', () => {
    for (const command of [
      'extract_stage_document',
      'compose_authorization_cycle',
      'compose_appropriations_cycle',
      'compose_post_enactment_evidence',
      'verify_full_stage_cycle',
      'report_cycle_certification',
    ] as const) {
      expect(buildPhase6OperatorPlanV1(command, cycle())).toMatchObject({
        mode: 'inspect',
        canonicalWrites: false,
        auditWrites: false,
        paidParserCalls: false,
      });
    }
  });

  it('produces deterministic certification and honest missing-state outcomes', () => {
    expect(certifyPhase6CycleV1(cycle())).toEqual(certifyPhase6CycleV1(cycle()));
    expect(
      certifyPhase6CycleV1(
        cycle({ documents: [{ documentKey: 'sacd', required: true, status: 'missing' }] }),
      ).status,
    ).toBe('INCOMPLETE');
    expect(
      certifyPhase6CycleV1(
        cycle({ comparisons: [{ code: 'conference', outcome: 'NOT_RUN', required: true }] }),
      ).status,
    ).toBe('NEEDS_REVIEW');
  });
});
