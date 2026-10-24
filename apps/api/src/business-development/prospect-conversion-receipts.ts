import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { prospectResourceScope, type TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { requireOwnerClient } from '../clients/client-ordered-owner.access.js';
import { lockClientCapacity } from '../clients/client-capacity.js';
import {
  parseProspectConversion,
  prospectConversionDigest,
  type ProspectConversionCommand,
  type ProspectConversionReceipt,
} from './prospect-conversion.types.js';

type Tx = Prisma.TransactionClient;
type Stored = { command: unknown; payloadDigest: string; receipt: ProspectConversionReceipt };
type Prospect = {
  updatedAt: Date;
  linkedClientId: string | null;
  convertedAt: Date | null;
  displayName: string;
};
const unavailable = () => new NotFoundException('Prospect conversion is unavailable');

async function lockProspect(tx: Tx, ctx: TenantContext, prospectId: string): Promise<Prospect> {
  const rows = await tx.$queryRaw<
    Prospect[]
  >`SELECT updated_at AS "updatedAt",linked_client_id::text AS "linkedClientId",converted_at AS "convertedAt",display_name AS "displayName"
    FROM business_development_prospects WHERE tenant_id=${ctx.tenantId}::uuid AND id=${prospectId}::uuid FOR UPDATE`;
  if (!rows[0]) throw unavailable();
  return rows[0];
}
async function authorize(
  tx: Tx,
  ctx: TenantContext,
  command: ProspectConversionCommand,
  targetClientId?: string,
) {
  // Match the current file/client owner order: client before membership. The
  // prospect is already locked, so its linked target cannot change underneath.
  if (targetClientId) await requireOwnerClient(tx, ctx, targetClientId);
  const scope = await prospectResourceScope(
    tx,
    ctx.tenantId,
    { userId: ctx.userId },
    command.prospectId,
    'read',
  );
  if (!scope || scope.clerkUserId !== ctx.clerkUserId) throw unavailable();
}
async function storedReceipt(tx: Tx, ctx: TenantContext, requestId: string) {
  const rows = await tx.$queryRaw<Stored[]>`SELECT command,payload_digest AS "payloadDigest",receipt
    FROM prospect_conversion_receipts WHERE tenant_id=${ctx.tenantId}::uuid AND actor_user_id=${ctx.userId}::uuid AND request_id=${requestId}::uuid`;
  return rows[0];
}
function checkedReceipt(stored: Stored, command: ProspectConversionCommand) {
  const receipt = stored.receipt;
  if (
    !receipt ||
    stored.payloadDigest !== prospectConversionDigest(command) ||
    JSON.stringify(parseProspectConversion(command.prospectId, stored.command)) !==
      JSON.stringify(command) ||
    receipt.schemaVersion !== 1 ||
    receipt.requestId !== command.requestId ||
    receipt.prospectId !== command.prospectId ||
    (command.mode === 'existing_client' && receipt.clientId !== command.clientId) ||
    receipt.payloadDigest !== stored.payloadDigest ||
    receipt.outcome !== (command.mode === 'existing_client' ? 'linked' : 'created') ||
    receipt.expectedUpdatedAt !== command.expectedUpdatedAt ||
    !Number.isFinite(Date.parse(receipt.prospectUpdatedAt)) ||
    !Number.isFinite(Date.parse(receipt.committedAt))
  )
    throw new ServiceUnavailableException('The conversion receipt cannot be verified');
  return receipt;
}

/** Caller owns the transaction; existing conversion, audit and this receipt commit together. */
export async function commitProspectConversion(
  tx: Tx,
  ctx: TenantContext,
  command: ProspectConversionCommand,
  convert: () => Promise<{ clientId: string; created: boolean }>,
): Promise<ProspectConversionReceipt> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`prospect-conversion:${ctx.tenantId}:${ctx.userId}:${command.requestId}`},0))`;
  const current = await lockProspect(tx, ctx, command.prospectId);
  // Keep legacy conversion's prospect -> capacity -> tenant/member order.
  // Otherwise a queued billing UPDATE can form a cycle with ordinary create:
  // conversion holds tenant SHARE waiting for capacity; create holds capacity
  // waiting behind billing; billing waits for conversion's tenant SHARE.
  // Replays and existing-client links do not need admission or slot availability.
  if (command.mode === 'new_client' && !current.linkedClientId && !current.convertedAt)
    await lockClientCapacity(tx, ctx.tenantId);
  // A changed target is unavailable; never acquire a second client out of order.
  if (
    command.mode === 'existing_client' &&
    current.linkedClientId &&
    current.linkedClientId !== command.clientId
  )
    throw unavailable();
  await authorize(
    tx,
    ctx,
    command,
    current.linkedClientId ?? (command.mode === 'existing_client' ? command.clientId : undefined),
  );
  const existing = await storedReceipt(tx, ctx, command.requestId);
  if (existing) {
    if (existing.payloadDigest !== prospectConversionDigest(command))
      throw new ConflictException('This request ID belongs to another conversion');
    const receipt = checkedReceipt(existing, command);
    if (current.linkedClientId !== receipt.clientId || !current.convertedAt) throw unavailable();
    return receipt;
  }
  if (
    current.updatedAt.toISOString() !== command.expectedUpdatedAt ||
    current.linkedClientId ||
    current.convertedAt
  )
    throw new ConflictException('The prospect changed. Reload and review the conversion.');
  if (command.mode === 'new_client' && current.displayName !== command.clientName)
    throw new ConflictException('The prospect name changed. Reload and review the new client.');
  if (
    !(await prospectResourceScope(
      tx,
      ctx.tenantId,
      { userId: ctx.userId },
      command.prospectId,
      'write',
    ))
  )
    throw unavailable();
  const outcome = await convert();
  if (
    command.mode === 'existing_client' &&
    (outcome.created || outcome.clientId !== command.clientId)
  )
    throw new ConflictException('The conversion did not link the reviewed existing client');
  if (command.mode === 'new_client' && !outcome.created)
    throw new ConflictException(
      'A matching client already exists. Review an explicit existing-client link.',
    );
  const after = await lockProspect(tx, ctx, command.prospectId);
  if (after.linkedClientId !== outcome.clientId || !after.convertedAt) throw unavailable();
  if (command.mode === 'new_client') await requireOwnerClient(tx, ctx, outcome.clientId);
  const [time] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
  const receipt: ProspectConversionReceipt = {
    schemaVersion: 1,
    requestId: command.requestId,
    prospectId: command.prospectId,
    clientId: outcome.clientId,
    payloadDigest: prospectConversionDigest(command),
    outcome: outcome.created ? 'created' : 'linked',
    expectedUpdatedAt: command.expectedUpdatedAt,
    prospectUpdatedAt: after.updatedAt.toISOString(),
    committedAt: time!.at.toISOString(),
  };
  await tx.$executeRaw`INSERT INTO prospect_conversion_receipts(tenant_id,prospect_id,client_id,actor_user_id,request_id,payload_digest,command,receipt)
    VALUES(${ctx.tenantId}::uuid,${command.prospectId}::uuid,${outcome.clientId}::uuid,${ctx.userId}::uuid,${command.requestId}::uuid,
      ${receipt.payloadDigest},${JSON.stringify(command)}::jsonb,${JSON.stringify(receipt)}::jsonb)`;
  return receipt;
}

/** Historical outcome is returned only after the exact current owner/target checks. */
export async function readProspectConversion(
  tx: Tx,
  ctx: TenantContext,
  prospectId: string,
  requestId: string,
) {
  const current = await lockProspect(tx, ctx, prospectId);
  const stored = await storedReceipt(tx, ctx, requestId);
  if (!stored) throw unavailable();
  const command = parseProspectConversion(prospectId, stored.command);
  const receipt = checkedReceipt(stored, command);
  if (
    command.requestId !== requestId ||
    current.linkedClientId !== receipt.clientId ||
    !current.convertedAt
  )
    throw unavailable();
  await authorize(tx, ctx, command, receipt.clientId);
  return receipt;
}
