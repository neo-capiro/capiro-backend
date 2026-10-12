import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { z } from 'zod';

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const instant = z
  .string()
  .max(40)
  .refine(
    (value) =>
      /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      isISO8601(value, { strict: true, strictSeparator: true }) &&
      Number.isFinite(new Date(value).getTime()),
    'An explicit date, time and UTC offset are required',
  );
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => isISO8601(value, { strict: true }));
const zone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    if (/^[+\-\d]/.test(value)) return false;
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });
const activity = z
  .object({
    kind: z.enum(['email', 'call', 'note', 'request', 'decision', 'commitment']),
    title: z.string().trim().min(1).max(300),
    body: z
      .string()
      .trim()
      .max(5000)
      .nullable()
      .optional()
      .transform((v) => v || null),
    occurredAt: instant.optional(),
    dueAt: instant.nullable().optional().default(null),
    personId: uuid.nullable().optional().default(null),
  })
  .strict()
  .refine(
    (v) => !v.dueAt || v.kind === 'request' || v.kind === 'commitment',
    'Only commitments and requests carry a due instant',
  );
const followUp = z
  .object({
    assigneeUserId: uuid,
    dueOn: date.nullable().optional().default(null),
    dueTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .optional()
      .default(null),
    timeZone: zone.nullable().optional().default(null),
  })
  .strict()
  .refine(
    (v) => (v.dueOn ? !!v.timeZone : !v.dueTime && !v.timeZone),
    'A dated follow-up requires an explicit IANA zone; time/zone require a date',
  );
const command = z.object({ requestId: uuid, activity, followUp: followUp.optional() }).strict();
export type ActivityCommandInput = z.infer<typeof command>;

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new BadRequestException('Invalid activity command');
  return result.data;
}
export const commandUuid = (raw: unknown) => parse(uuid, raw);
export const activityCommandInput = (raw: unknown) => parse(command, raw);
export const resumeVersion = (raw: unknown) =>
  parse(z.object({ expectedVersion: z.number().int().min(0).max(2147483646) }).strict(), raw)
    .expectedVersion;
// The strict, bounded schema emits fields in a stable order before hashing.
export const activityCommandHash = (input: ActivityCommandInput) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

export function plannerPayload(
  input: NonNullable<ActivityCommandInput['followUp']>,
  clerkId: string,
) {
  return {
    name: 'Follow up on logged activity',
    description: '',
    assigneeId: clerkId,
    dueOn: input.dueOn,
    dueTime: input.dueTime,
    timeZone: input.timeZone,
    clientId: null,
    meetingId: null,
    parentId: null,
    memberships: [],
    collaborators: [],
  };
}
