import { z } from 'zod';
import {
  canonicalJsonStringify,
  OUTREACH_V3_LIMITS,
  targetCriteriaV1Schema,
} from './outreach-campaign-spec.v1.js';
import {
  outreachRejectedTargetRecommendationV1Schema,
  outreachTargetLocatorV1Schema,
} from '../../capabilities/targets/outreach-target.contract.js';
import { OutreachCommandError } from './outreach-command-errors.js';

export const OUTREACH_IMPLEMENTED_COMMAND_TYPES = [
  'SET_GOAL',
  'SET_OBJECTIVE',
  'SET_TOPIC',
  'SET_DESIRED_OUTCOME',
  'SET_ASK',
  'CLEAR_ASK',
  'SET_WHY_NOW',
  'SET_SPONSOR_SCOPE',
  'SET_TARGET_CRITERIA',
  'ADD_TARGET_REFS',
  'REMOVE_TARGET_REFS',
  'REJECT_TARGET_RECOMMENDATION',
  'SET_DELIVERY_PATTERN',
  'SET_PERSONALIZATION',
  'SET_CAMPAIGN_ANGLE',
  'SET_TONE',
  'SET_LENGTH',
  'RESTORE_STATE_VERSION',
] as const;

export const OUTREACH_FUTURE_COMMAND_TYPES = [
  'ACCEPT_CONTEXT_REFS',
  'EXCLUDE_CONTEXT_REFS',
  'SET_SENDER_REF',
  'SET_ATTACHMENT_REFS',
  'REQUEST_SAMPLE_GENERATION',
  'REQUEST_FULL_GENERATION',
  'REQUEST_SEND_REVIEW',
] as const;

export const OUTREACH_COMMAND_TYPES = [
  ...OUTREACH_IMPLEMENTED_COMMAND_TYPES,
  ...OUTREACH_FUTURE_COMMAND_TYPES,
] as const;

export type OutreachCommandType = (typeof OUTREACH_COMMAND_TYPES)[number];
export type OutreachImplementedCommandType = (typeof OUTREACH_IMPLEMENTED_COMMAND_TYPES)[number];
export type OutreachFutureCommandType = (typeof OUTREACH_FUTURE_COMMAND_TYPES)[number];

const FORBIDDEN_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

const boundedString = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((value) => !FORBIDDEN_CONTROL_CHARACTERS.test(value), {
      message: 'Text contains disallowed control characters.',
    });

const nullableBoundedText = (max: number) => boundedString(max).nullable();
const boundedRef = boundedString(384, 1);
const emptyPayload = z.object({}).strict();
const futureRefsPayload = z.object({ refs: z.array(boundedRef).min(1).max(500) }).strict();

const sponsorPayloadSchema = z
  .object({
    kind: z.enum([
      'undecided',
      'firm',
      'client',
      'multi_client',
      'coalition',
      'internal_team',
      'none',
    ]),
    label: nullableBoundedText(OUTREACH_V3_LIMITS.sponsorLabel),
    clientRefs: z
      .array(z.object({ clientId: z.string().uuid() }).strict())
      .max(OUTREACH_V3_LIMITS.sponsorClientRefs),
  })
  .strict()
  .superRefine((value, ctx) => {
    const uniqueClientCount = new Set(value.clientRefs.map((ref) => ref.clientId)).size;
    if (
      ['undecided', 'firm', 'internal_team', 'none'].includes(value.kind) &&
      uniqueClientCount !== 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clientRefs'],
        message: `${value.kind} sponsor scope cannot contain client references.`,
      });
    }
    if (value.kind === 'client' && uniqueClientCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clientRefs'],
        message: 'Client sponsor scope requires exactly one unique client reference.',
      });
    }
    if (value.kind === 'multi_client' && uniqueClientCount < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clientRefs'],
        message: 'Multi-client sponsor scope requires at least two unique client references.',
      });
    }
    if (value.kind === 'coalition' && !value.label?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['label'],
        message: 'Coalition sponsor scope requires a label.',
      });
    }
  });

export const OUTREACH_COMMAND_PAYLOAD_SCHEMAS = {
  SET_GOAL: z.object({ value: nullableBoundedText(OUTREACH_V3_LIMITS.goal) }).strict(),
  SET_OBJECTIVE: z.object({ value: nullableBoundedText(OUTREACH_V3_LIMITS.objective) }).strict(),
  SET_TOPIC: z.object({ value: nullableBoundedText(OUTREACH_V3_LIMITS.topic) }).strict(),
  SET_DESIRED_OUTCOME: z
    .object({ value: nullableBoundedText(OUTREACH_V3_LIMITS.desiredOutcome) })
    .strict(),
  SET_ASK: z
    .object({
      mode: z.enum(['explicit', 'none']),
      text: nullableBoundedText(OUTREACH_V3_LIMITS.askText),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.mode === 'explicit' && !value.text?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: 'Explicit ask needs text.' });
      }
      if (value.mode === 'none' && value.text !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['text'],
          message: 'No-ask mode requires null text.',
        });
      }
    }),
  CLEAR_ASK: emptyPayload,
  SET_WHY_NOW: z.object({ value: nullableBoundedText(OUTREACH_V3_LIMITS.whyNow) }).strict(),
  SET_SPONSOR_SCOPE: sponsorPayloadSchema,
  SET_TARGET_CRITERIA: z.object({ value: targetCriteriaV1Schema.nullable() }).strict(),
  ADD_TARGET_REFS: z
    .object({
      refs: z
        .array(outreachTargetLocatorV1Schema)
        .min(1)
        .max(OUTREACH_V3_LIMITS.futureTargetRefs),
    })
    .strict(),
  REMOVE_TARGET_REFS: z
    .object({
      targetKeys: z.array(boundedRef).min(1).max(OUTREACH_V3_LIMITS.futureTargetRefs),
    })
    .strict(),
  REJECT_TARGET_RECOMMENDATION: outreachRejectedTargetRecommendationV1Schema,
  SET_DELIVERY_PATTERN: z
    .object({
      value: z.enum(['undecided', 'personalized_separate', 'uniform_separate', 'shared_thread']),
    })
    .strict(),
  SET_PERSONALIZATION: z
    .object({ value: z.enum(['undecided', 'high', 'light', 'none']) })
    .strict(),
  SET_CAMPAIGN_ANGLE: z
    .object({ value: nullableBoundedText(OUTREACH_V3_LIMITS.campaignAngle) })
    .strict(),
  SET_TONE: z.object({ value: nullableBoundedText(OUTREACH_V3_LIMITS.tone) }).strict(),
  SET_LENGTH: z
    .object({
      value: z.enum(['undecided', 'short', 'medium', 'long', 'custom']),
      customInstruction: nullableBoundedText(OUTREACH_V3_LIMITS.customLengthInstruction),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.value === 'custom' && !value.customInstruction?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['customInstruction'],
          message: 'Custom length requires an instruction.',
        });
      }
      if (value.value !== 'custom' && value.customInstruction !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['customInstruction'],
          message: 'Custom instruction is allowed only for custom length.',
        });
      }
    }),
  RESTORE_STATE_VERSION: z.object({ version: z.number().int().positive() }).strict(),
  ACCEPT_CONTEXT_REFS: futureRefsPayload,
  EXCLUDE_CONTEXT_REFS: futureRefsPayload,
  SET_SENDER_REF: z.object({ senderRef: boundedRef }).strict(),
  SET_ATTACHMENT_REFS: futureRefsPayload,
  REQUEST_SAMPLE_GENERATION: emptyPayload,
  REQUEST_FULL_GENERATION: emptyPayload,
  REQUEST_SEND_REVIEW: emptyPayload,
} satisfies Record<OutreachCommandType, z.ZodTypeAny>;

export interface OutreachCommandEnvelope<T = unknown> {
  type: OutreachCommandType;
  schemaVersion: 1;
  payload: T;
}

export interface ParsedOutreachCommandEnvelope extends OutreachCommandEnvelope {
  payload: unknown;
}

const envelopeShellSchema = z
  .object({
    type: z.enum(OUTREACH_COMMAND_TYPES),
    schemaVersion: z.literal(1),
    payload: z.unknown(),
  })
  .strict();

function commandInvalid(): OutreachCommandError {
  return new OutreachCommandError(
    'OUTREACH_COMMAND_INVALID',
    'The outreach command is invalid.',
    400,
  );
}

export function parseOutreachCommandEnvelope(input: unknown): ParsedOutreachCommandEnvelope {
  try {
    const shell = envelopeShellSchema.parse(input);
    const payload = OUTREACH_COMMAND_PAYLOAD_SCHEMAS[shell.type].parse(shell.payload);
    return { ...shell, payload };
  } catch (error) {
    if (error instanceof OutreachCommandError) throw error;
    throw commandInvalid();
  }
}

export interface ApplyOutreachCommandBatchInput {
  batchId: string;
  expectedStateVersion: number;
  commands: ParsedOutreachCommandEnvelope[];
}

const batchShellSchema = z
  .object({
    batchId: z.string().uuid(),
    expectedStateVersion: z.number().int().positive(),
    commands: z.array(z.unknown()).min(1).max(OUTREACH_V3_LIMITS.commandsPerBatch),
  })
  .strict();

export function parseOutreachCommandBatch(input: unknown): ApplyOutreachCommandBatchInput {
  let shell: z.infer<typeof batchShellSchema>;
  try {
    shell = batchShellSchema.parse(input);
  } catch (error) {
    if (error instanceof OutreachCommandError) throw error;
    throw commandInvalid();
  }

  const bytes = Buffer.byteLength(canonicalJsonStringify(shell), 'utf8');
  if (bytes > OUTREACH_V3_LIMITS.commandBatchBytes) {
    throw new OutreachCommandError(
      'OUTREACH_COMMAND_BATCH_TOO_LARGE',
      'The command batch exceeds the allowed size.',
      413,
      { bytes, maxBytes: OUTREACH_V3_LIMITS.commandBatchBytes },
    );
  }

  try {
    return {
      batchId: shell.batchId,
      expectedStateVersion: shell.expectedStateVersion,
      commands: shell.commands.map(parseOutreachCommandEnvelope),
    };
  } catch (error) {
    if (error instanceof OutreachCommandError) throw error;
    throw commandInvalid();
  }
}

export function isFutureOutreachCommand(type: OutreachCommandType): type is OutreachFutureCommandType {
  return (OUTREACH_FUTURE_COMMAND_TYPES as readonly string[]).includes(type);
}
