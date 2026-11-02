import { Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { VersionsService } from '../versions/versions.service.js';

export const SAVED_SNAPSHOT_EXPORT_MAX_BYTES = 4_500_000;

/** Lossless JSON export of one immutable saved version through its canonical current read authority.
 * This never renders rich content, substitutes a working copy, restores a version or grants sharing.
 */
@Injectable()
export class SavedSnapshotExportService {
  constructor(private readonly versions: VersionsService) {}

  async read(tenantId: string, draftId: string, versionId: string, actorId: string) {
    const row = await this.versions.getSaved(tenantId, draftId, versionId, actorId);
    if (row.id !== versionId || row.draftId !== draftId || row.tenantId !== tenantId ||
      !row.snapshot || typeof row.snapshot !== 'object' || Array.isArray(row.snapshot))
      throw new NotFoundException('Saved snapshot unavailable');
    const result = {
      schemaVersion: 1 as const, tenantId, draftId, id: row.id,
      label: row.label, authorId: row.authorId, authorKind: row.authorKind,
      createdAt: row.createdAt.toISOString(), snapshot: row.snapshot,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > SAVED_SNAPSHOT_EXPORT_MAX_BYTES)
      throw new PayloadTooLargeException({
        code: 'SAVED_SNAPSHOT_EXPORT_TOO_LARGE',
        message: 'This saved snapshot exceeds the export limit. No partial snapshot was returned.',
      });
    return result;
  }
}

