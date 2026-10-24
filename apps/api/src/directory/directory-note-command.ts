import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireOwnerActor } from '../clients/client-ordered-owner.access.js';

const inputSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    kind: z.literal('note'),
    directoryContactName: z.string().trim().min(1).max(240),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();
export type MemberNoteCommand = z.infer<typeof inputSchema>;
const noteSelect = {
  id: true,
  tenantId: true,
  createdByUserId: true,
  directoryContactId: true,
  directoryContactName: true,
  body: true,
  createdAt: true,
  createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
} satisfies Prisma.DirectoryContactNoteSelect;
type Note = Prisma.DirectoryContactNoteGetPayload<{ select: typeof noteSelect }>;

function memberIdentity(memberId: string) {
  // A staff ID, Bioguide alias or bare numeric ID must not become a member ID.
  if (!/^member-[1-9]\d*$/.test(memberId))
    throw new BadRequestException('Use the canonical Directory member identity');
  return memberId;
}
export function parseMemberNoteCommand(memberId: string, input: unknown) {
  memberIdentity(memberId);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new BadRequestException('Review the Directory note command');
  return parsed.data;
}
export function memberNoteDigest(ctx: TenantContext, memberId: string, command: MemberNoteCommand) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'directory-member-note',
        1,
        ctx.tenantId,
        ctx.userId,
        command.requestId,
        memberId,
        command.directoryContactName,
        command.body,
      ]),
    )
    .digest('hex');
}
function receipt(ctx: TenantContext, note: Note) {
  const command = parseMemberNoteCommand(note.directoryContactId, {
    schemaVersion: 1,
    requestId: note.id,
    kind: 'note',
    directoryContactName: note.directoryContactName,
    body: note.body,
  });
  const { tenantId, createdByUserId: actorUserId, ...saved } = note;
  return {
    schemaVersion: 1 as const,
    requestId: note.id,
    tenantId,
    actorUserId,
    payloadDigest: memberNoteDigest(ctx, note.directoryContactId, command),
    note: saved,
  };
}

/** The existing immutable note ID is the request key. Note and audit commit together.
 * There is no note update/delete writer; adding one requires a retained receipt owner. */
export async function commitMemberNote(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  memberId: string,
  command: MemberNoteCommand,
  currentMember: () => Promise<{ id: string; name: string }>,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`directory-member-note:${ctx.tenantId}:${command.requestId}`},0))`;
  await requireOwnerActor(tx, ctx, false, true);
  const existing = await tx.directoryContactNote.findFirst({
    where: { tenantId: ctx.tenantId, id: command.requestId },
    select: noteSelect,
  });
  if (existing) {
    if (
      existing.createdByUserId !== ctx.userId ||
      existing.directoryContactId !== memberId ||
      existing.directoryContactName !== command.directoryContactName ||
      existing.body !== command.body
    )
      throw new ConflictException('This request ID belongs to a different Directory note');
    return receipt(ctx, existing);
  }
  const member = await currentMember();
  if (member.id !== memberId || member.name !== command.directoryContactName)
    throw new ConflictException('The Directory member changed. Refresh and review the note.');
  const note = await tx.directoryContactNote.create({
    data: {
      id: command.requestId,
      tenantId: ctx.tenantId,
      createdByUserId: ctx.userId,
      directoryContactId: member.id,
      directoryContactName: member.name,
      body: command.body,
    },
    select: noteSelect,
  });
  await tx.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: 'directory_contact_note.created',
      entityType: 'directory_contact_note',
      entityId: note.id,
      after: {
        directoryContactId: memberId,
        directoryContactName: member.name,
        schemaVersion: 1,
        payloadDigest: memberNoteDigest(ctx, memberId, command),
      },
    },
  });
  return receipt(ctx, note);
}

/** Absence is unresolved, never evidence that a previous POST did not commit. */
export async function readMemberNoteReceipt(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  memberId: string,
  requestId: string,
) {
  memberIdentity(memberId);
  const parsed = z.string().uuid().safeParse(requestId);
  if (!parsed.success) throw new BadRequestException('Invalid Directory note request ID');
  await requireOwnerActor(tx, ctx, false, true);
  const note = await tx.directoryContactNote.findFirst({
    where: {
      id: parsed.data.toLowerCase(),
      tenantId: ctx.tenantId,
      createdByUserId: ctx.userId,
      directoryContactId: memberId,
    },
    select: noteSelect,
  });
  if (!note) throw new NotFoundException('The Directory note receipt is unavailable');
  return receipt(ctx, note);
}
