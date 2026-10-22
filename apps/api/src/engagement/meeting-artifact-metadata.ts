import type { TenantContext } from '@capiro/shared';
import { canEditEncryptedEntry, canReadEncryptedEntry } from './engagement-access.helpers.js';

export interface MeetingArtifactMetadata {
  id: string;
  meetingId: string;
  createdAt: Date;
  keyVersion: string | null;
  clientId: string | null;
  status: string;
  confidential: boolean;
  accessLevel: string;
  authorUserId: string | null;
  author?: unknown;
  approvedAt?: Date | null;
  approvedByUserId?: string | null;
  approvedBy?: unknown;
  sharedAt: Date | null;
  sharedByUserId: string | null;
  sharedBy?: unknown;
  updatedAt: Date;
}

/** One lifecycle projection for exact reads, library rows and mutation receipts. */
export function projectMeetingArtifactMetadata<T extends MeetingArtifactMetadata>(ctx: TenantContext, row: T) {
  const readable = canReadEncryptedEntry(ctx, row);
  const editable = readable && canEditEncryptedEntry(ctx, row);
  return {
    id: row.id,
    meetingId: row.meetingId,
    clientId: row.clientId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    keyVersion: row.keyVersion,
    status: row.status,
    confidential: row.confidential,
    accessLevel: row.accessLevel,
    metadataVersion: 1 as const,
    revision: row.updatedAt.toISOString(),
    approvalKnown: readable && (row.status !== 'approved' || row.approvedAt != null),
    approvedAt: readable ? row.approvedAt ?? null : null,
    approvedByUserId: readable ? row.approvedByUserId ?? null : null,
    approvedBy: readable ? row.approvedBy ?? null : null,
    sharedAt: readable ? row.sharedAt : null,
    sharedByUserId: readable ? row.sharedByUserId : null,
    sharedBy: readable ? row.sharedBy ?? null : null,
    sharingKnown: readable,
    authorUserId: readable ? row.authorUserId : null,
    author: readable ? row.author ?? null : null,
    capabilities: {
      edit: editable,
      approve: editable && row.status !== 'approved',
      share: readable && row.clientId !== null && row.status === 'approved' && row.sharedAt === null,
      unshare: readable && row.sharedAt !== null && (editable || row.sharedByUserId === ctx.userId),
    },
  };
}
