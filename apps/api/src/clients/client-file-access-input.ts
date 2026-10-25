import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const file = z
  .object({
    id: uuid,
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
  })
  .strict();
const schema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: uuid,
    clientId: uuid,
    operation: z.enum(['file-access', 'folder-access']),
    folder: z.string().trim().max(120).nullable(),
    files: z.array(file).min(1).max(100),
    viewerMode: z.enum(['all', 'restricted']),
    viewerUserIds: z.array(uuid).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.files.map((item) => item.id)).size !== value.files.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate file' });
    if (new Set(value.viewerUserIds).size !== value.viewerUserIds.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate viewer' });
    if (value.operation === 'file-access' && value.files.length !== 1)
      ctx.addIssue({ code: 'custom', message: 'One file is required' });
    if (value.viewerMode === 'all' && value.viewerUserIds.length)
      ctx.addIssue({ code: 'custom', message: 'All-member access requires an empty viewer list' });
  });

export type FileAccessCommand = z.infer<typeof schema>;
export type FileAccessResult = {
  files: Array<{ id: string; previousRevision: number; revision: number }>;
};

/** The reviewed manifest is the whole write set, including for a folder label. */
export function parseFileAccessCommand(clientId: string, raw: unknown): FileAccessCommand {
  const parsed = schema.safeParse(raw);
  if (!parsed.success || parsed.data.clientId !== clientId)
    throw new BadRequestException('Invalid reviewed file access change');
  return {
    ...parsed.data,
    folder: parsed.data.folder || null,
    files: [...parsed.data.files].sort((a, b) => a.id.localeCompare(b.id)),
    viewerUserIds: [...parsed.data.viewerUserIds].sort(),
  };
}

export function fileAccessDigest(ctx: TenantContext, command: FileAccessCommand) {
  return createHash('sha256')
    .update(JSON.stringify(['file-access', 1, ctx.tenantId, ctx.userId, command]))
    .digest('hex');
}

export function fileAccessRequestId(raw: string) {
  if (!uuid.safeParse(raw).success) throw new BadRequestException('Invalid file access request');
  return raw;
}
