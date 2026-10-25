import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const command = z
  .object({
    schemaVersion: z.literal(1),
    requestId: uuid,
    clientId: uuid,
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
  })
  .strict();
export type ClientFileDeleteCommand = z.infer<typeof command> & { attachmentId: string };
export function fileDeleteUuid(value: unknown): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success)
    throw new BadRequestException('A canonical request or file UUID is required');
  return parsed.data;
}
export function parseClientFileDelete(attachmentId: string, raw: unknown): ClientFileDeleteCommand {
  const parsed = command.safeParse(raw);
  if (!parsed.success)
    throw new BadRequestException('Review the current client file before requesting deletion');
  return {
    schemaVersion: parsed.data.schemaVersion,
    requestId: parsed.data.requestId,
    clientId: parsed.data.clientId,
    expectedRevision: parsed.data.expectedRevision,
    attachmentId: fileDeleteUuid(attachmentId),
  };
}
export function clientFileDeleteDigest(ctx: TenantContext, value: ClientFileDeleteCommand) {
  return createHash('sha256')
    .update(JSON.stringify(['client-file-delete', 1, ctx.tenantId, ctx.userId, value]))
    .digest('hex');
}
