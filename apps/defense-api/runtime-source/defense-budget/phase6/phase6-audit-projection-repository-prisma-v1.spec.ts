import { Phase6AuditProjectionRepository } from './phase6-audit-projection-repository.js';
import {
  PrismaPhase6AuditProjectionTransactionClientV1,
  type Phase6ProjectionPrismaLikeV1,
  type Phase6ProjectionTxLikeV1,
} from './phase6-audit-projection-repository-prisma-v1.js';
import type { Phase6NativeProjectionV1 } from './phase6-native-projection-v1.js';
import { certifyPhase6CycleV1 } from './phase6-cycle-certification-v1.js';

const SHA = (c: string) => c.repeat(64);

function projection(overrides: Partial<Phase6NativeProjectionV1> = {}): Phase6NativeProjectionV1 {
  return {
    schemaVersion: 'phase6_native_projection_v1',
    projectionId: 'p1',
    naturalKey: `${SHA('9')}|2027|hac_d|hacDMark`,
    idempotencyKey: 'idem-1',
    projectionKind: 'stage_position',
    verificationCandidateId: 'vc-1',
    verificationRunId: 'vr-1',
    artifactId: 'artifact-1',
    artifactContentSha256: SHA('a'),
    sourceDocumentId: 'doc-1',
    sourcePdfSha256: SHA('b'),
    sourceProfileHash: SHA('c'),
    nativeIdentityHash: SHA('9'),
    track: 'appropriations',
    stage: 'hac_d',
    fundingField: 'hacDMark',
    money: { originalValue: '125', originalUnit: 'millions', valueMillions: '125' },
    directOrDerived: 'direct',
    evidenceIds: ['ev-1'],
    bindingStatus: 'accepted',
    projectionStatus: 'verified',
    payload: { fiscalYear: 2027 },
    canonicalWriteAllowed: false,
    ...overrides,
  };
}

function certification(projections: Phase6NativeProjectionV1[] = [projection()]) {
  return certifyPhase6CycleV1({
    schemaVersion: 'phase6_cycle_certification_input_v1',
    cycleId: 'cycle-fy2027',
    fiscalYear: 2027,
    manifestHash: SHA('1'),
    documents: [{ documentKey: 'hac-d-report', required: true, status: 'present' }],
    projections,
    comparisons: [],
    lineFamilyCoverage: {},
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

/** An in-memory stand-in for the phase6 audit tables, keyed like Postgres unique constraints. */
class FakePhase6Db {
  projectionsByIdempotencyKey = new Map<string, { projectionId: string; naturalKey: string }>();
  liveByNaturalKey = new Map<string, { projectionId: string; idempotencyKey: string }>();
  certificationsByContentSha = new Map<
    string,
    {
      cycleId: string;
      contentSha256: string;
      projectionSetSha256: string | null;
      projectionCount: number | null;
    }
  >();
  bindingsByCertificationSha = new Map<string, Array<{ projectionId: string; ordinal: number }>>();
  insertedProjections: Phase6NativeProjectionV1[] = [];
  insertedCertifications: unknown[] = [];

  asPrisma(): Phase6ProjectionPrismaLikeV1 {
    const db = this;
    return {
      async $transaction<T>(fn: (tx: Phase6ProjectionTxLikeV1) => Promise<T>): Promise<T> {
        // Fake has no real rollback; every test below only exercises the
        // happy/idempotent paths, so commit-on-return is sufficient here.
        return fn(db.tx());
      },
    };
  }

  private tx(): Phase6ProjectionTxLikeV1 {
    const db = this;
    return {
      async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
        if (query.includes('FROM "phase6_audit_projection" WHERE "idempotency_key"')) {
          const row = db.projectionsByIdempotencyKey.get(String(values[0]));
          return (row ? [row] : []) as unknown as T;
        }
        if (query.includes('FROM "phase6_audit_projection" WHERE "natural_key"')) {
          const row = db.liveByNaturalKey.get(String(values[0]));
          return (row ? [row] : []) as unknown as T;
        }
        if (query.includes('FROM "phase6_cycle_certification"')) {
          const row = db.certificationsByContentSha.get(String(values[0]));
          return (row ? [row] : []) as unknown as T;
        }
        if (query.includes('FROM "phase6_cycle_certification_projection"')) {
          const bindings = [...(db.bindingsByCertificationSha.get(String(values[0])) ?? [])]
            .sort((a, b) => a.ordinal - b.ordinal || a.projectionId.localeCompare(b.projectionId))
            .map((binding) => ({ projectionId: binding.projectionId }));
          return bindings as unknown as T;
        }
        throw new Error(`FakePhase6Db: unrecognized query: ${query}`);
      },
      async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
        // Column order matches the INSERT's own column list in
        // phase6-audit-projection-repository-prisma-v1.ts.
        if (query.includes('INSERT INTO "phase6_audit_projection"')) {
          const projectionId = String(values[0]);
          const naturalKey = String(values[1]);
          const idempotencyKey = String(values[2]);
          db.projectionsByIdempotencyKey.set(idempotencyKey, { projectionId, naturalKey });
          db.liveByNaturalKey.set(naturalKey, { projectionId, idempotencyKey });
          db.insertedProjections.push(
            values as unknown as Phase6NativeProjectionV1, // not reconstructed; presence is what these tests check
          );
          return 1;
        }
        if (query.includes('INSERT INTO "phase6_cycle_certification"')) {
          // $1 cycleId, $2 fiscalYear, $3 manifestHash, $4 contentSha256,
          // $5 status, $6 projectionSetSha256, $7 projectionCount, $8 report
          const cycleId = String(values[0]);
          const contentSha256 = String(values[3]);
          const projectionSetSha256 = values[5] == null ? null : String(values[5]);
          const projectionCount = values[6] == null ? null : Number(values[6]);
          const report = String(values[7]);
          db.certificationsByContentSha.set(contentSha256, {
            cycleId,
            contentSha256,
            projectionSetSha256,
            projectionCount,
          });
          db.insertedCertifications.push(report);
          return 1;
        }
        if (query.includes('INSERT INTO "phase6_cycle_certification_projection"')) {
          const certificationContentSha256 = String(values[0]);
          const projectionId = String(values[1]);
          const ordinal = Number(values[2]);
          const current = db.bindingsByCertificationSha.get(certificationContentSha256) ?? [];
          current.push({ projectionId, ordinal });
          db.bindingsByCertificationSha.set(certificationContentSha256, current);
          return 1;
        }
        throw new Error(`FakePhase6Db: unrecognized statement: ${query}`);
      },
    };
  }
}

describe('PrismaPhase6AuditProjectionTransactionClientV1 + Phase6AuditProjectionRepository', () => {
  it('persists a first-time projection and certification', async () => {
    const db = new FakePhase6Db();
    const repository = new Phase6AuditProjectionRepository(
      new PrismaPhase6AuditProjectionTransactionClientV1(db.asPrisma()),
    );
    const proj = projection();
    const cert = certification([proj]);

    const receipt = await repository.persistAuditOnly({
      projections: [proj],
      certification: cert,
      auditPersistenceAuthorized: true,
    });

    expect(receipt.insertedProjectionIds).toEqual(['p1']);
    expect(receipt.replayedProjectionIds).toEqual([]);
    expect(receipt.certificationReplayed).toBe(false);
    expect(receipt.canonicalWrites).toBe(false);
    expect(db.projectionsByIdempotencyKey.has('idem-1')).toBe(true);
    expect(db.certificationsByContentSha.get(cert.contentSha256)).toMatchObject({
      projectionSetSha256: cert.projectionSetSha256,
      projectionCount: 1,
    });
    expect(db.bindingsByCertificationSha.get(cert.contentSha256)).toEqual([
      { projectionId: 'p1', ordinal: 0 },
    ]);
  });

  it('replays an identical idempotency key rather than inserting twice', async () => {
    const db = new FakePhase6Db();
    const repository = new Phase6AuditProjectionRepository(
      new PrismaPhase6AuditProjectionTransactionClientV1(db.asPrisma()),
    );
    const proj = projection();
    const cert = certification([proj]);

    await repository.persistAuditOnly({
      projections: [proj],
      certification: cert,
      auditPersistenceAuthorized: true,
    });
    const second = await repository.persistAuditOnly({
      projections: [proj],
      certification: cert,
      auditPersistenceAuthorized: true,
    });

    expect(second.insertedProjectionIds).toEqual([]);
    expect(second.replayedProjectionIds).toEqual(['p1']);
    expect(second.certificationReplayed).toBe(true);
  });

  it('refuses a conflicting live projection at a shared natural key', async () => {
    const db = new FakePhase6Db();
    const repository = new Phase6AuditProjectionRepository(
      new PrismaPhase6AuditProjectionTransactionClientV1(db.asPrisma()),
    );
    const first = projection();
    const firstCert = certification([first]);

    await repository.persistAuditOnly({
      projections: [first],
      certification: firstCert,
      auditPersistenceAuthorized: true,
    });

    // Same natural key, different idempotency/projection id — certification
    // must bind THIS supplied set so the set-hash gate does not fire first.
    const conflict = projection({ projectionId: 'p2', idempotencyKey: 'idem-2' });
    await expect(
      repository.persistAuditOnly({
        projections: [conflict],
        certification: certification([conflict]),
        auditPersistenceAuthorized: true,
      }),
    ).rejects.toThrow(/conflicting live projection/);
  });

  it('never bypasses the explicit authorization literal', async () => {
    const db = new FakePhase6Db();
    const repository = new Phase6AuditProjectionRepository(
      new PrismaPhase6AuditProjectionTransactionClientV1(db.asPrisma()),
    );
    const proj = projection();

    await expect(
      repository.persistAuditOnly({
        projections: [proj],
        certification: certification([proj]),
        // @ts-expect-error -- exercising the runtime guard, not just the type
        auditPersistenceAuthorized: false,
      }),
    ).rejects.toThrow(/explicit authorization/);
  });
});
