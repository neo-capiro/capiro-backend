import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { prospectResourceScope, type TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  requireOwnerActor,
  requireOwnerClient,
} from '../../clients/client-ordered-owner.access.js';
import {
  commitPersonCreate,
  parsePersonCreateCommand,
} from '../../clients/client-people-command.js';
import { fields, type ContactRow } from './prospect-contacts.store.js';
import {
  contactTransferDigest,
  parseContactTransfer,
  transferUuid,
  type ContactTransferCommand,
  type ContactTransferResult,
} from './prospect-contact-transfer-input.js';

type Tx = Prisma.TransactionClient;
type Prospect = { updatedAt: Date; linkedClientId: string | null; convertedAt: Date | null };
type Person = ReturnType<typeof fields> & { id: string; updatedAt: Date };
type Saved = {
  requestId: string;
  prospectId: string;
  clientId: string;
  payloadDigest: string;
  status: 'completed' | 'refused';
  result: ContactTransferResult | null;
  createdAt: Date;
};
const unavailable = () => new NotFoundException('Contact transfer is unavailable');
const changed = () =>
  new ConflictException('The reviewed contacts changed. Review the transfer again.');

async function lockRequest(tx: Tx, ctx: TenantContext, requestId: string) {
  const key = JSON.stringify(['prospect-contact-transfer', ctx.tenantId, ctx.userId, requestId]);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`;
}
async function saved(tx: Tx, ctx: TenantContext, requestId: string) {
  const rows = await tx.$queryRaw<Saved[]>`
    SELECT request_id::text AS "requestId", prospect_id::text AS "prospectId", client_id::text AS "clientId",
      payload_digest AS "payloadDigest", status, result_jsonb AS result, created_at AS "createdAt"
    FROM prospect_contact_transfer_receipts WHERE tenant_id=${ctx.tenantId}::uuid
      AND actor_user_id=${ctx.userId}::uuid AND request_id=${requestId}::uuid`;
  return rows[0];
}
async function scope(
  tx: Tx,
  ctx: TenantContext,
  prospectId: string,
  clientId: string,
): Promise<Prospect> {
  // Match conversion's prospect -> client -> membership order, without a SHARE
  // upgrade. Never lock a second client after discovering a changed prospect link.
  const [prospect] = await tx.$queryRaw<Prospect[]>`
    SELECT updated_at AS "updatedAt", linked_client_id::text AS "linkedClientId", converted_at AS "convertedAt"
    FROM business_development_prospects WHERE tenant_id=${ctx.tenantId}::uuid AND id=${prospectId}::uuid FOR UPDATE`;
  if (!prospect || prospect.linkedClientId !== clientId || !prospect.convertedAt)
    throw unavailable();
  await requireOwnerClient(tx, ctx, clientId);
  const access = await prospectResourceScope(
    tx,
    ctx.tenantId,
    { userId: ctx.userId },
    prospectId,
    'read',
  );
  if (!access || access.clerkUserId !== ctx.clerkUserId) throw unavailable();
  return prospect;
}
function view(ctx: TenantContext, row: Saved) {
  return {
    schemaVersion: 1 as const,
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    ...row,
    createdAt: row.createdAt.toISOString(),
    refusal:
      row.status === 'refused'
        ? {
            code: 'PROSPECT_CONTACT_TRANSFER_REFUSED' as const,
            message:
              'The contact transfer was refused. Review the current source and target contacts.',
          }
        : null,
  };
}
function match(row: Saved, command: ContactTransferCommand, digest: string) {
  if (
    row.prospectId !== command.prospectId ||
    row.clientId !== command.clientId ||
    row.payloadDigest !== digest
  )
    throw new ConflictException('Request ID belongs to another contact transfer');
}
async function insert(
  tx: Tx,
  ctx: TenantContext,
  command: ContactTransferCommand,
  result: ContactTransferResult | null,
) {
  await tx.$executeRaw`INSERT INTO prospect_contact_transfer_receipts
    (tenant_id,actor_user_id,request_id,prospect_id,client_id,payload_digest,status,result_jsonb)
    VALUES (${ctx.tenantId}::uuid,${ctx.userId}::uuid,${command.requestId}::uuid,${command.prospectId}::uuid,
      ${command.clientId}::uuid,${contactTransferDigest(ctx, command)},${result ? 'completed' : 'refused'},
      ${result ? JSON.stringify(result) : null}::jsonb)`;
  return (await saved(tx, ctx, command.requestId))!;
}
async function transfer(tx: Tx, ctx: TenantContext, command: ContactTransferCommand) {
  const sources = await tx.$queryRaw<
    ContactRow[]
  >`SELECT * FROM business_development_prospect_contacts
    WHERE tenant_id=${ctx.tenantId}::uuid AND prospect_id=${command.prospectId}::uuid
      AND id=ANY(${command.items.map((entry) => entry.sourceId)}::uuid[]) AND removed_at IS NULL
    ORDER BY id FOR UPDATE`;
  if (
    sources.length !== command.items.length ||
    sources.some(
      (row, index) =>
        row.id !== command.items[index]!.sourceId ||
        row.version !== command.items[index]!.expectedVersion,
    )
  )
    throw changed();
  // The exclusive parent lock blocks new people's FK admission. Lock existing
  // rows too: a concurrent edit must not create an exact match after our review.
  const people = await tx.$queryRaw<
    Person[]
  >`SELECT id::text, name, title, email::text, phone, notes, updated_at AS "updatedAt"
    FROM client_people WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${command.clientId}::uuid ORDER BY id FOR UPDATE`;
  const result: ContactTransferResult = { items: [] };
  const createdIds: string[] = [];
  for (const [index, item] of command.items.entries()) {
    const source = fields(sources[index]!);
    let personId: string | null = null;
    if (item.action === 'link') {
      const target = people.find((person) => person.id === item.personId);
      if (
        !target ||
        target.updatedAt.toISOString() !== item.expectedUpdatedAt ||
        JSON.stringify(fields(target)) !== JSON.stringify(source)
      )
        throw changed();
      personId = target.id;
    } else if (item.action === 'create') {
      if (people.some((person) => JSON.stringify(fields(person)) === JSON.stringify(source)))
        throw changed();
      const created = await commitPersonCreate(
        tx,
        ctx,
        command.clientId,
        parsePersonCreateCommand({
          ...source,
          requestId: item.createRequestId,
        }),
      );
      // A different transfer or ordinary create consumed this per-item request.
      // Never adopt its old result or recreate a subsequently deleted person.
      if (!created.created) throw changed();
      personId = created.receipt.personId;
      createdIds.push(personId);
      people.push({ ...source, id: personId, updatedAt: new Date(created.receipt.createdAt) });
    }
    result.items.push({
      sourceId: item.sourceId,
      sourceVersion: item.expectedVersion,
      action: item.action,
      personId,
    });
  }
  return { result, createdIds };
}

export async function commitContactTransfer(
  prisma: PrismaService,
  ctx: TenantContext,
  prospectId: string,
  raw: unknown,
) {
  const command = parseContactTransfer(prospectId, raw),
    digest = contactTransferDigest(ctx, command);
  let admittedOriginal = false;
  try {
    return await prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        await lockRequest(tx, ctx, command.requestId);
        await requireOwnerActor(tx, ctx);
        const previous = await saved(tx, ctx, command.requestId);
        if (previous) match(previous, command, digest);
        const current = await scope(tx, ctx, command.prospectId, command.clientId);
        if (previous) return { receipt: view(ctx, previous), createdIds: [] as string[] };
        admittedOriginal = true;
        if (current.updatedAt.toISOString() !== command.expectedProspectUpdatedAt) throw changed();
        const { result, createdIds } = await transfer(tx, ctx, command);
        await tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            requestId: command.requestId,
            action: 'prospect.contacts.transferred',
            entityType: 'business_development_prospect',
            entityId: prospectId,
            before: {
              payloadDigest: digest,
              expectedProspectUpdatedAt: command.expectedProspectUpdatedAt,
            },
            after: { clientId: command.clientId, ...result },
          },
        });
        return { receipt: view(ctx, await insert(tx, ctx, command, result)), createdIds };
      },
      { timeoutMs: 30_000 },
    );
  } catch (error) {
    if (
      !admittedOriginal ||
      !(
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      )
    )
      throw error;
    // Only this original transaction's known rollback can produce a refusal.
    // Ambiguous transport/DB errors leave recovery pending; a concurrent commit wins.
    return prisma.withTenant(ctx.tenantId, async (tx) => {
      await lockRequest(tx, ctx, command.requestId);
      await requireOwnerActor(tx, ctx);
      const previous = await saved(tx, ctx, command.requestId);
      if (previous) match(previous, command, digest);
      await scope(tx, ctx, command.prospectId, command.clientId);
      return {
        receipt: view(ctx, previous ?? (await insert(tx, ctx, command, null))),
        createdIds: [] as string[],
      };
    });
  }
}
export async function readContactTransfer(
  prisma: PrismaService,
  ctx: TenantContext,
  rawProspectId: string,
  rawRequestId: string,
) {
  const prospectId = transferUuid(rawProspectId),
    requestId = transferUuid(rawRequestId);
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    await requireOwnerActor(tx, ctx);
    const row = await saved(tx, ctx, requestId);
    if (!row || row.prospectId !== prospectId) throw unavailable();
    await scope(tx, ctx, row.prospectId, row.clientId);
    // Historical outcome, independent of later source/target contact edits/deletes.
    return view(ctx, row);
  });
}
