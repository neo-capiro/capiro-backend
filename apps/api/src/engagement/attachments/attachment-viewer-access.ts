import type { Prisma } from '@prisma/client';

/** Canonical Client Files viewer rule, also applied to meeting/mail parent reads.
 * Uploader access is unconditional; tenant administrators have no extra bypass. */
export function attachmentViewerWhere(userId: string): Prisma.EngagementAttachmentWhereInput[] {
  return [
    { viewerMode: 'all' },
    { viewerMode: 'restricted', viewerUserIds: { has: userId } },
    { uploadedByUserId: userId },
  ];
}
