import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireOwnerClient } from './client-ordered-owner.access.js';
import { inferPlacementFromTitle } from './client-hierarchy.helpers.js';

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => v ?? null);
const commandSchema = z
  .object({
    requestId: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase()),
    name: z.string().trim().min(1).max(300),
    title: optionalText(300),
    email: z
      .string()
      .email()
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    phone: optionalText(120),
    role: optionalText(300),
    notes: optionalText(20000),
    lastContact: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional()
      .transform((v) => (v ? new Date(v).toISOString() : null)),
  })
  .strict();
export type PersonCreateCommand = z.infer<typeof commandSchema>;
export function parsePersonCreateCommand(input: unknown) {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException('Review the contact details and request ID');
  return parsed.data;
}
export function personCreateDigest(
  ctx: TenantContext,
  clientId: string,
  input: PersonCreateCommand,
) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'client-person-create',
        1,
        ctx.tenantId.toLowerCase(),
        ctx.userId.toLowerCase(),
        clientId.toLowerCase(),
        input.requestId,
        input.name,
        input.title,
        input.email,
        input.phone,
        input.role,
        input.notes,
        input.lastContact,
      ]),
    )
    .digest('hex');
}
type Saved = { requestId: string; payloadDigest: string; personId: string; createdAt: Date };
async function saved(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  requestId: string,
) {
  const rows = await tx.$queryRaw<Saved[]>`
    SELECT request_id::text AS "requestId", payload_digest AS "payloadDigest",
      person_id::text AS "personId", created_at AS "createdAt"
    FROM client_person_create_receipts
    WHERE tenant_id=${ctx.tenantId}::uuid AND actor_user_id=${ctx.userId}::uuid
      AND client_id=${clientId}::uuid AND request_id=${requestId}::uuid`;
  return rows[0];
}
async function receipt(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  row: Saved,
) {
  const present = await tx.clientPerson.findFirst({
    where: { id: row.personId, tenantId: ctx.tenantId, clientId },
    select: { id: true },
  });
  return {
    schemaVersion: 1 as const,
    status: 'completed' as const,
    tenantId: ctx.tenantId.toLowerCase(),
    actorUserId: ctx.userId.toLowerCase(),
    clientId: clientId.toLowerCase(),
    ...row,
    createdAt: row.createdAt.toISOString(),
    available: Boolean(present),
  };
}

/** The canonical client lock serializes admission and lookup. Only the contact
 * and its consumed request record are committed here; import merging is separate. */
export async function commitPersonCreate(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  input: PersonCreateCommand,
) {
  await requireOwnerClient(tx, ctx, clientId);
  const digest = personCreateDigest(ctx, clientId, input);
  const previous = await saved(tx, ctx, clientId, input.requestId);
  if (previous) {
    if (previous.payloadDigest !== digest)
      throw new ConflictException('This request ID belongs to different contact details');
    return { receipt: await receipt(tx, ctx, clientId, previous), created: false };
  }
  const { requestId, lastContact, ...fields } = input;
  const inferred = inferPlacementFromTitle(input.title);
  const person = await tx.clientPerson.create({
    data: {
      ...fields,
      tenantId: ctx.tenantId,
      clientId,
      lastContact: lastContact ? new Date(lastContact) : null,
      hierarchyLevel: inferred.level,
      placementConfidence: inferred.confidence,
      reviewRequired: inferred.reviewRequired,
      placementSource: 'auto_title',
    },
  });
  const rows = await tx.$queryRaw<Saved[]>`
    INSERT INTO client_person_create_receipts
      (tenant_id, actor_user_id, client_id, request_id, payload_digest, person_id)
    VALUES (${ctx.tenantId}::uuid, ${ctx.userId}::uuid, ${clientId}::uuid,
      ${requestId}::uuid, ${digest}, ${person.id}::uuid)
    RETURNING request_id::text AS "requestId", payload_digest AS "payloadDigest",
      person_id::text AS "personId", created_at AS "createdAt"`;
  return { receipt: await receipt(tx, ctx, clientId, rows[0]!), created: true };
}
export async function readPersonCreate(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  requestId: string,
) {
  const parsed = z.string().uuid().safeParse(requestId);
  if (!parsed.success) throw new BadRequestException('Invalid contact request ID');
  await requireOwnerClient(tx, ctx, clientId);
  const row = await saved(tx, ctx, clientId, parsed.data.toLowerCase());
  if (!row) throw new NotFoundException('Contact creation receipt is unavailable');
  return receipt(tx, ctx, clientId, row);
}
