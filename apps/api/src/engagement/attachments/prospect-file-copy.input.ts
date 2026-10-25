import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';

export const copyUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const MAX_COPY_BYTES = 25 * 1024 * 1024;
const command = z
  .object({
    schemaVersion: z.literal(1),
    requestId: copyUuid,
    prospectId: copyUuid,
    clientId: copyUuid,
    expectedProspectUpdatedAt: z
      .string()
      .refine(
        (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
      ),
    sourceId: copyUuid,
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    contentLength: z.number().int().min(1).max(MAX_COPY_BYTES),
    folder: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .transform((value) => value || null),
  })
  .strict();
export type ProspectFileCopyCommand = z.infer<typeof command>;
export function parseProspectFileCopy(value: unknown): ProspectFileCopyCommand {
  const parsed = command.safeParse(value);
  if (!parsed.success)
    throw new BadRequestException('Review the exact prospect upload and target client');
  return parsed.data;
}
export function prospectFileCopyDigest(ctx: TenantContext, value: ProspectFileCopyCommand) {
  return createHash('sha256')
    .update(JSON.stringify(['prospect-file-copy', 1, ctx.tenantId, ctx.userId, value]))
    .digest('hex');
}
export const prospectCopyPrefix = (tenantId: string) =>
  `tenants/${tenantId}/engagement/prospect-client-copies/`;
