/** Phase 6 Workstream N — final transactional audit-only persistence repository. */
import {
  phase6ProjectionSetSha256V1,
  type Phase6CycleCertificationV1,
} from './phase6-cycle-certification-v1.js';
import type { Phase6NativeProjectionV1 } from './phase6-native-projection-v1.js';

export interface Phase6AuditProjectionStore {
  findByIdempotencyKey(key: string): Promise<{ projectionId: string; naturalKey: string } | null>;
  findLiveByNaturalKey(key: string): Promise<{ projectionId: string; idempotencyKey: string } | null>;
  findCertificationByContentSha256(contentSha256: string): Promise<{
    cycleId: string;
    contentSha256: string;
    projectionSetSha256: string | null;
    projectionCount: number | null;
  } | null>;
  findProjectionIdsForCertification(contentSha256: string): Promise<string[]>;
  insertProjection(projection: Phase6NativeProjectionV1): Promise<void>;
  insertCertification(certification: Phase6CycleCertificationV1): Promise<void>;
  insertCertificationProjectionBinding(
    certificationContentSha256: string,
    projectionId: string,
    ordinal: number,
  ): Promise<void>;
}

export interface Phase6AuditProjectionTransactionClient {
  transaction<T>(fn: (store: Phase6AuditProjectionStore) => Promise<T>): Promise<T>;
}

export interface Phase6AuditPersistenceReceipt {
  schemaVersion: 'phase6_audit_persistence_receipt_v1';
  mode: 'audit_only';
  insertedProjectionIds: string[];
  replayedProjectionIds: string[];
  certificationProjectionIds: string[];
  certificationContentSha256: string;
  certificationReplayed: boolean;
  canonicalWrites: false;
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class Phase6AuditProjectionRepository {
  constructor(private readonly client: Phase6AuditProjectionTransactionClient) {}

  async persistAuditOnly(input: {
    projections: readonly Phase6NativeProjectionV1[];
    certification: Phase6CycleCertificationV1;
    auditPersistenceAuthorized: true;
  }): Promise<Phase6AuditPersistenceReceipt> {
    if (!input.auditPersistenceAuthorized) {
      throw new Error('audit persistence requires explicit authorization');
    }

    // The certification is the authority for the exact producer output. Refuse
    // a caller that pairs a valid certification with a different in-memory set.
    const sortedProjections = [...input.projections].sort((a, b) =>
      a.projectionId.localeCompare(b.projectionId),
    );
    const projectionSetSha256 = phase6ProjectionSetSha256V1(sortedProjections);
    if (
      input.certification.projectionCount !== sortedProjections.length ||
      input.certification.projectionSetSha256 !== projectionSetSha256
    ) {
      throw new Error('certification does not bind the supplied projection set');
    }

    return this.client.transaction(async (store) => {
      const insertedProjectionIds: string[] = [];
      const replayedProjectionIds: string[] = [];
      for (const projection of sortedProjections) {
        const replay = await store.findByIdempotencyKey(projection.idempotencyKey);
        if (replay != null) {
          if (
            replay.projectionId !== projection.projectionId ||
            replay.naturalKey !== projection.naturalKey
          ) {
            throw new Error('idempotency key resolves to a different projection');
          }
          replayedProjectionIds.push(projection.projectionId);
          continue;
        }
        const live = await store.findLiveByNaturalKey(projection.naturalKey);
        if (live != null && live.idempotencyKey !== projection.idempotencyKey) {
          throw new Error(
            `conflicting live projection for natural key ${projection.naturalKey}: ${live.projectionId}`,
          );
        }
        await store.insertProjection(projection);
        insertedProjectionIds.push(projection.projectionId);
      }

      const certificationReplay = await store.findCertificationByContentSha256(
        input.certification.contentSha256,
      );
      let certificationReplayed = false;
      if (certificationReplay != null) {
        if (
          certificationReplay.cycleId !== input.certification.cycleId ||
          certificationReplay.contentSha256 !== input.certification.contentSha256 ||
          certificationReplay.projectionSetSha256 !== input.certification.projectionSetSha256 ||
          certificationReplay.projectionCount !== input.certification.projectionCount
        ) {
          throw new Error('certification content hash resolves to a different cycle or projection set');
        }
        certificationReplayed = true;
      } else {
        await store.insertCertification(input.certification);
      }

      const expectedProjectionIds = sortedProjections.map((projection) => projection.projectionId);
      const existingProjectionIds = (
        await store.findProjectionIdsForCertification(input.certification.contentSha256)
      ).sort((a, b) => a.localeCompare(b));

      if (existingProjectionIds.length === 0 && expectedProjectionIds.length > 0) {
        for (const [ordinal, projection] of sortedProjections.entries()) {
          await store.insertCertificationProjectionBinding(
            input.certification.contentSha256,
            projection.projectionId,
            ordinal,
          );
        }
      } else if (!sameOrderedStrings(existingProjectionIds, expectedProjectionIds)) {
        throw new Error('persisted certification projection bindings do not match the certified set');
      }

      // A zero-projection certification is unambiguous because the certification
      // row itself stores projection_count=0 and the exact empty-set hash.
      const certificationProjectionIds = expectedProjectionIds;
      return {
        schemaVersion: 'phase6_audit_persistence_receipt_v1',
        mode: 'audit_only',
        insertedProjectionIds,
        replayedProjectionIds,
        certificationProjectionIds,
        certificationContentSha256: input.certification.contentSha256,
        certificationReplayed,
        canonicalWrites: false,
      };
    });
  }
}
