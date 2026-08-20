import { certifyPhase6CycleV1 } from './phase6-cycle-certification-v1.js';
import {
  phase6NativeProjectionV1Schema,
  type Phase6NativeProjectionV1,
} from './phase6-native-projection-v1.js';
import {
  Phase6AuditProjectionRepository,
  type Phase6AuditProjectionStore,
} from './phase6-audit-projection-repository.js';

const SHA = 'a'.repeat(64);
function projection(overrides: Partial<Phase6NativeProjectionV1> = {}): Phase6NativeProjectionV1 {
  return phase6NativeProjectionV1Schema.parse({
    schemaVersion: 'phase6_native_projection_v1',
    projectionId: 'p1',
    naturalKey: 'nk1',
    idempotencyKey: 'idem1',
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
    money: { originalValue: '10', originalUnit: 'millions', valueMillions: '10' },
    directOrDerived: 'direct',
    evidenceIds: ['e1'],
    bindingStatus: 'accepted',
    projectionStatus: 'verified',
    payload: {},
    canonicalWriteAllowed: false,
    ...overrides,
  });
}
function certification(projections: Phase6NativeProjectionV1[] = [projection()]) {
  return certifyPhase6CycleV1({
    schemaVersion: 'phase6_cycle_certification_input_v1',
    cycleId: 'fy2027',
    fiscalYear: 2027,
    manifestHash: SHA,
    documents: [
      { documentKey: 'hacd', required: true, status: 'present', sourceProofStatus: 'PASS' },
    ],
    projections,
    comparisons: [{ code: 'request_reference', outcome: 'PASS', required: true }],
    lineFamilyCoverage: { RDTE_PE: projections.length },
    bindingCounts: {
      accepted: projections.length,
      candidate: 0,
      unresolved: 0,
      conflicting: 0,
    },
    enactmentProofCoverage: { direct: 0, incorporated: 0, unresolved: 0, blocked: 0 },
    reprogrammingCoverage: 0,
    executionCoverage: 0,
    parserStats: { localPages: 1, paidPages: 0, cacheHits: 0 },
  });
}

class Store implements Phase6AuditProjectionStore {
  projections = new Map<string, Phase6NativeProjectionV1>();
  natural = new Map<string, Phase6NativeProjectionV1>();
  certifications = new Map<string, ReturnType<typeof certification>>();
  bindings = new Map<string, Array<{ projectionId: string; ordinal: number }>>();

  async findByIdempotencyKey(key: string) {
    const value = this.projections.get(key);
    return value == null
      ? null
      : { projectionId: value.projectionId, naturalKey: value.naturalKey };
  }
  async findLiveByNaturalKey(key: string) {
    const value = this.natural.get(key);
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
    this.projections.set(value.idempotencyKey, value);
    this.natural.set(value.naturalKey, value);
  }
  async insertCertification(value: ReturnType<typeof certification>) {
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

describe('Phase 6 final audit repository', () => {
  it('persists and replays the exact certification projection bindings', async () => {
    const store = new Store();
    const repository = new Phase6AuditProjectionRepository({
      transaction: async (fn) => fn(store),
    });
    const first = await repository.persistAuditOnly({
      projections: [projection()],
      certification: certification(),
      auditPersistenceAuthorized: true,
    });
    expect(first).toMatchObject({
      insertedProjectionIds: ['p1'],
      certificationProjectionIds: ['p1'],
      certificationReplayed: false,
    });
    expect(await store.findProjectionIdsForCertification(first.certificationContentSha256)).toEqual(
      ['p1'],
    );

    const second = await repository.persistAuditOnly({
      projections: [projection()],
      certification: certification(),
      auditPersistenceAuthorized: true,
    });
    expect(second).toMatchObject({
      replayedProjectionIds: ['p1'],
      certificationProjectionIds: ['p1'],
      certificationReplayed: true,
    });
  });

  it('fails before persistence when a certification is paired with a different projection set', async () => {
    const store = new Store();
    const repository = new Phase6AuditProjectionRepository({
      transaction: async (fn) => fn(store),
    });
    const certified = projection();
    const different = projection({
      projectionId: 'p2',
      idempotencyKey: 'idem2',
      naturalKey: 'nk2',
      money: { originalValue: '11', originalUnit: 'millions', valueMillions: '11' },
    });

    await expect(
      repository.persistAuditOnly({
        projections: [different],
        certification: certification([certified]),
        auditPersistenceAuthorized: true,
      }),
    ).rejects.toThrow(/does not bind the supplied projection set/);
    expect(store.projections.size).toBe(0);
    expect(store.certifications.size).toBe(0);
  });

  it('fails if persisted certification bindings disagree with the certified set', async () => {
    const store = new Store();
    const repository = new Phase6AuditProjectionRepository({
      transaction: async (fn) => fn(store),
    });
    const cert = certification();
    await store.insertProjection(projection());
    await store.insertCertification(cert);
    store.bindings.set(cert.contentSha256, [{ projectionId: 'different-projection', ordinal: 0 }]);

    await expect(
      repository.persistAuditOnly({
        projections: [projection()],
        certification: cert,
        auditPersistenceAuthorized: true,
      }),
    ).rejects.toThrow(/bindings do not match/);
  });

  it('fails when an idempotency key points to a different natural key', async () => {
    const store = new Store();
    await store.insertProjection(projection());
    const repository = new Phase6AuditProjectionRepository({
      transaction: async (fn) => fn(store),
    });
    // Same idempotency/projection id as the live row, but a different natural key.
    // Certification must bind THIS supplied set so the set-hash gate does not fire first;
    // the idempotency collision is checked inside the transaction against the live row.
    const mutated = { ...projection(), naturalKey: 'different' };
    await expect(
      repository.persistAuditOnly({
        projections: [mutated],
        certification: certification([mutated]),
        auditPersistenceAuthorized: true,
      }),
    ).rejects.toThrow(/different projection/);
  });

  it('requires explicit audit-persistence authorization at the type/runtime boundary', async () => {
    const store = new Store();
    const repository = new Phase6AuditProjectionRepository({
      transaction: async (fn) => fn(store),
    });
    await expect(
      repository.persistAuditOnly({
        projections: [projection()],
        certification: certification(),
        auditPersistenceAuthorized: false as true,
      }),
    ).rejects.toThrow(/explicit authorization/);
  });
});
