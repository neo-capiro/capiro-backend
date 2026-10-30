import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';
import type { OutreachRecipientInput } from './engagement.service.js';
import { outreachTargetLocatorV1Schema } from '../capabilities/targets/outreach-target.contract.js';
import { outreachContextSelectionV1Schema } from '../capabilities/context/outreach-context.contract.js';

const text = (max: number) => z.string().max(max);
const role = z.enum(['to', 'cc', 'bcc']);
const contact = z
  .object({
    id: z.string().min(1).max(384),
    name: text(240),
    email: text(320).optional(),
    source: text(80).optional(),
    sourceRefId: text(384).optional(),
    role,
    title: text(240).optional(),
    office: text(240).optional(),
    state: text(80).optional(),
    district: text(80).optional(),
    chamber: text(80).optional(),
    personalNote: text(500).optional(),
    locator: outreachTargetLocatorV1Schema.optional(),
    cc: z.array(z.string().email().max(320)).max(25).optional(),
    bcc: z.array(z.string().email().max(320)).max(25).optional(),
  })
  .strict();
export const outreachCampaignStateSchema = z
  .object({
    title: z.string().min(1).max(240),
    direction: z.enum(['on-behalf', 'to-clients']),
    clientId: z.string().uuid().nullable(),
    templateId: text(384).nullable(),
    templateVersionId: z.string().uuid().nullable().optional(),
    mainIdea: text(8000),
    tone: z.enum(['professional', 'friendly', 'formal', 'concise']),
    length: z.enum(['short', 'standard', 'long']),
    recipients: z
      .array(
        contact
          .extend({
            kind: z.enum(['individual', 'list', 'group']),
            members: z.array(contact).max(500).optional(),
          })
          .strict(),
      )
      .max(500),
    contextItems: z
      .array(
        z
          .object({
            id: z.string().min(1).max(384),
            kind: z.enum([
              'bill',
              'stateBill',
              'intel',
              'email',
              'meeting',
              'note',
              'document',
              'debrief',
              'prep',
              'programElement',
              'capability',
              'clientOverview',
            ]),
            scope: z.string().min(1).max(768),
            userInstruction: text(2000).optional(),
            customNoteText: text(8000).optional(),
            noteUse: z.enum(['fact', 'instruction']).optional(),
          })
          .strict(),
      )
      .max(500),
    styleSamples: z
      .array(
        z
          .object({
            sampleKey: text(128),
            label: text(240).nullable(),
            subject: text(400).nullable(),
            body: text(12000),
          })
          .strict(),
      )
      .max(10),
    attachmentIds: z.array(z.string().uuid()).max(30),
    contextSelections: z.array(outreachContextSelectionV1Schema).max(500).optional(),
    contentSkeleton: z
      .object({
        subject: text(400),
        body: text(8000),
        slots: z
          .array(
            z
              .object({
                key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
                label: text(120),
                instruction: text(1000),
                required: z.boolean(),
              })
              .strict(),
          )
          .max(12),
      })
      .strict()
      .nullable()
      .optional(),
    sender: z
      .object({ connectionId: z.string().uuid().nullable(), signature: text(20000) })
      .strict(),
    lastStep: z.number().int().min(1).max(7),
  })
  .strict();
export type OutreachCampaignState = z.infer<typeof outreachCampaignStateSchema>;
export const campaignCreateSchema = z
  .object({ requestKey: z.string().uuid(), state: outreachCampaignStateSchema })
  .strict();
export const campaignSaveSchema = z
  .object({ expectedRevision: z.number().int().min(0), state: outreachCampaignStateSchema })
  .strict();
export const campaignGenerateSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    requestKey: z.string().uuid(),
    generationKeys: z.array(z.string().min(1).max(768)).min(1).max(500),
    mode: z.enum(['generate', 'regenerate', 'improve']),
    instruction: text(2000).optional(),
  })
  .strict();
export function parseCampaign<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException('Invalid outreach request');
  if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > 1024 * 1024)
    throw new BadRequestException('Outreach request is too large');
  return parsed.data;
}
export interface OutreachGenerationUnit {
  generationKey: string;
  recipient: OutreachRecipientInput;
}

/** Top-level Cc/Bcc contacts are copied on every unit; list members receive separate messages. */
export function expandCampaignUnits(state: OutreachCampaignState): OutreachGenerationUnit[] {
  const copies = (which: 'cc' | 'bcc') =>
    state.recipients
      .filter((r) => r.kind === 'individual' && r.role === which)
      .map((r) => r.email ?? '');
  const units: OutreachGenerationUnit[] = [];
  const add = (key: string, recipient: OutreachRecipientInput) => {
    const addresses = [
      recipient.email,
      ...copies('cc'),
      ...copies('bcc'),
      ...(recipient.cc ?? []),
      ...(recipient.bcc ?? []),
      ...(recipient.groupMembers ?? []).map((m) => m.email),
    ];
    if (addresses.some((email) => !email || !z.string().email().safeParse(email).success))
      throw new BadRequestException('Every recipient needs a valid email address');
    if (key.length > 512) throw new BadRequestException('Recipient generation key is too long');
    units.push({
      generationKey: key,
      recipient: {
        ...recipient,
        id: key,
        generationKey: key,
        cc: [...new Set([...copies('cc'), ...(recipient.cc ?? [])])],
        bcc: [...new Set([...copies('bcc'), ...(recipient.bcc ?? [])])],
      },
    });
  };
  for (const recipient of state.recipients) {
    if (recipient.role !== 'to') continue;
    if (recipient.kind === 'individual') add(`individual:${recipient.id}`, recipient);
    else if (recipient.kind === 'list') {
      for (const member of recipient.members ?? []) {
        if (member.role !== 'to') continue;
        add(`list:${recipient.id}:${member.id}`, {
          ...member,
          cc: [
            ...(member.cc ?? []),
            ...(recipient.cc ?? []),
            ...(recipient.members?.filter((m) => m.role === 'cc').map((m) => m.email ?? '') ?? []),
          ],
          bcc: [
            ...(member.bcc ?? []),
            ...(recipient.bcc ?? []),
            ...(recipient.members?.filter((m) => m.role === 'bcc').map((m) => m.email ?? '') ?? []),
          ],
        });
      }
    } else {
      const members = recipient.members ?? [];
      const to = members.filter((m) => m.role === 'to');
      if (!to.length) throw new BadRequestException('A group needs at least one To recipient');
      add(`group:${recipient.id}`, {
        ...recipient,
        email: to[0]!.email,
        groupMembers: to.map((m) => ({ name: m.name, email: m.email ?? '' })),
        cc: [
          ...(recipient.cc ?? []),
          ...members.flatMap((m) => m.cc ?? []),
          ...members.filter((m) => m.role === 'cc').map((m) => m.email ?? ''),
        ],
        bcc: [
          ...(recipient.bcc ?? []),
          ...members.flatMap((m) => m.bcc ?? []),
          ...members.filter((m) => m.role === 'bcc').map((m) => m.email ?? ''),
        ],
      });
    }
  }
  if (new Set(units.map((u) => u.generationKey)).size !== units.length)
    throw new BadRequestException('Recipient keys must be unique');
  return units;
}
