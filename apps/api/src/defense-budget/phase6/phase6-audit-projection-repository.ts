/** Phase 6 Workstream N — final transactional audit-only persistence repository. */
import type { Phase6CycleCertificationV1 } from './phase6-cycle-certification-v1.js';
import type { Phase6NativeProjectionV1 } from './phase6-native-projection-v1.js';

export interface Phase6AuditProjectionStore {
  findByIdempotencyKey(key: string): Promise<{ projectionId: string; naturalKey: string } | null>;
  findLiveByNaturalKey(key: string): Promise<{ projectionId: string; idempotencyKey: string } | null>;
  findCertificationByContentSha256(
    contentSha256: string,
  ): Promise<{ cycleId: string; contentSha256: string } | null>;
  insertProjection(projection: Phase6NativeProjectionV1): Promise<void>;
  insertCertification(certification: Phase6CycleCertificationV1): Promise<void>;
}

export interface Phase6AuditProjectionTransactionClient {
  transaction<T>(fn: (store: Phase6AuditProjectionStore) => Promise<T>): Promise<T>;
}

export interface Phase6AuditPersistenceReceipt {
  schemaVersion: 'phase6_audit_persistence_receipt_v1';
  mode: 'audit_only';
  insertedProjectionIds: string[];
  replayedProjectionIds: string[];
  certificationContentSha256: string;
  certificationReplayed: boolean;
  canonicalWrites: false;
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
    return this.client.transaction(async (store) => {
      const insertedProjectionIds: string[] = [];
      const replayedProjectionIds: string[] = [];
      for (const projection of [...input.projections].sort((a, b) =>
        a.projectionId.localeCompare(b.projectionId),
      )) {
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
          certificationReplay.contentSha256 !== input.certification.contentSha256
        ) {
          throw new Error('certification content hash resolves to a different cycle');
        }
        certificationReplayed = true;
      } else {
        await store.insertCertification(input.certification);
      }

      return {
        schemaVersion: 'phase6_audit_persistence_receipt_v1',
        mode: 'audit_only',
        insertedProjectionIds,
        replayedProjectionIds,
        certificationContentSha256: input.certification.contentSha256,
        certificationReplayed,
        canonicalWrites: false,
      };
    });
  }
}
