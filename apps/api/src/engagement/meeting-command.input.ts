import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TenantContext } from '@capiro/shared';

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const instant = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const commandSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: uuid,
    operation: z.enum([
      'create',
      'update',
      'note-create',
      'note-update',
      'note-approve',
      'debrief-create',
      'debrief-update',
      'debrief-approve',
      'share',
      'unshare',
    ]),
    meetingId: uuid.nullable(),
    expectedClientId: uuid.nullable(),
    expectedRevision: instant.nullable(),
    meeting: z
      .object({
        subject: z.string().trim().min(1).max(240),
        description: z.string().max(20000).nullable(),
        location: z.string().max(2000).nullable(),
        startsAt: instant,
        endsAt: instant,
        assignClient: z.boolean(),
        clientId: uuid.nullable(),
      })
      .strict()
      .nullable(),
    artifact: z
      .object({
        id: uuid.nullable(),
        revision: instant.nullable(),
        body: z.string().trim().min(1).max(20000).nullable(),
        confidential: z.boolean().nullable(),
      })
      .strict()
      .nullable(),
    artifacts: z
      .array(
        z
          .object({
            type: z.enum(['note', 'debrief', 'prep', 'attachment']),
            id: uuid,
            revision: instant,
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = () =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Review the meeting command fields' });
    if (value.operation === 'create') {
      if (
        value.meetingId !== null ||
        value.expectedRevision !== null ||
        value.expectedClientId !== null
      )
        issue();
    } else if (!value.meetingId || !value.expectedRevision) issue();
    if (value.operation === 'create' || value.operation === 'update') {
      if (!value.meeting || value.artifact || value.artifacts.length) return issue();
      if (value.operation === 'create' && !value.meeting.assignClient) issue();
      if (Date.parse(value.meeting.endsAt) <= Date.parse(value.meeting.startsAt)) issue();
      if (!value.meeting.assignClient && value.meeting.clientId !== null) issue();
    } else if (value.operation === 'share' || value.operation === 'unshare') {
      if (value.meeting || value.artifact || !value.artifacts.length) issue();
      if (
        new Set(value.artifacts.map((item) => `${item.type}:${item.id}`)).size !==
        value.artifacts.length
      )
        issue();
    } else {
      if (value.meeting || !value.artifact || value.artifacts.length) return issue();
      const create = value.operation.endsWith('-create');
      if (
        create
          ? value.artifact.id !== null || value.artifact.revision !== null
          : !value.artifact.id || !value.artifact.revision
      )
        issue();
      const approve = value.operation.endsWith('-approve');
      if (
        approve
          ? value.artifact.body !== null || value.artifact.confidential !== null
          : value.artifact.body === null || value.artifact.confidential === null
      )
        issue();
    }
  });
export type MeetingCommand = z.infer<typeof commandSchema>;
export function parseMeetingCommand(raw: unknown): MeetingCommand {
  const result = commandSchema.safeParse(raw);
  if (!result.success) throw new BadRequestException('Review the meeting command');
  // Selected-set order has no mutation meaning; bind one deterministic order.
  result.data.artifacts.sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
  return result.data;
}
export function meetingCommandDigest(ctx: TenantContext, command: MeetingCommand) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'meeting-command',
        1,
        ctx.tenantId.toLowerCase(),
        ctx.userId.toLowerCase(),
        command,
      ]),
    )
    .digest('hex');
}
export function meetingCommandRequestId(raw: string) {
  const result = uuid.safeParse(raw);
  if (!result.success) throw new BadRequestException('Invalid meeting command request');
  return result.data;
}
