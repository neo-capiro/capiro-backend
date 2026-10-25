import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { z } from 'zod';

const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const timestamp = z
  .string()
  .datetime()
  .refine((v) => new Date(v).toISOString() === v);
const source = { sourceId: uuid, expectedVersion: z.number().int().min(1).max(2147483647) };
const item = z.discriminatedUnion('action', [
  z.object({ ...source, action: z.literal('create'), createRequestId: uuid }).strict(),
  z
    .object({ ...source, action: z.literal('link'), personId: uuid, expectedUpdatedAt: timestamp })
    .strict(),
  z.object({ ...source, action: z.literal('skip') }).strict(),
]);
const schema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: uuid,
    prospectId: uuid,
    clientId: uuid,
    expectedProspectUpdatedAt: timestamp,
    items: z.array(item).min(1).max(50),
  })
  .strict();

export type ContactTransferCommand = z.infer<typeof schema>;
export type ContactTransferResult = {
  items: Array<{
    sourceId: string;
    sourceVersion: number;
    action: 'create' | 'link' | 'skip';
    personId: string | null;
  }>;
};
export function transferUuid(value: string) {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid contact transfer identifier');
  return parsed.data;
}
export function parseContactTransfer(prospectId: string, raw: unknown): ContactTransferCommand {
  const parsed = schema.safeParse(raw);
  if (!parsed.success || parsed.data.prospectId !== transferUuid(prospectId))
    throw new BadRequestException('Review the contact transfer and selected versions');
  const command = parsed.data;
  const creates = command.items.filter((entry) => entry.action === 'create');
  if (
    new Set(command.items.map((entry) => entry.sourceId)).size !== command.items.length ||
    new Set(creates.map((entry) => entry.createRequestId)).size !== creates.length
  )
    throw new BadRequestException('Select each source contact and create request only once');
  command.items.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return command;
}
export function contactTransferDigest(ctx: TenantContext, command: ContactTransferCommand) {
  return createHash('sha256')
    .update(JSON.stringify(['prospect-contact-transfer', 1, ctx.tenantId, ctx.userId, command]))
    .digest('hex');
}
