/**
 * Message Plan schema (Phase 1 §3.f2).
 *
 * The plan is a STRUCTURED commitment made before any prose exists: what this
 * message is for, why this recipient, why now, what the ask is, and — critically
 * — which claims it intends to make and which source ids support each one.
 *
 * Planning first is what makes the accuracy gates possible. A finished email is
 * hard to check: the claims are woven into sentences and their support is
 * implicit. A plan states each claim discretely alongside its source ids, so
 * "this claim cites a source that isn't in the packet" is a cheap, deterministic
 * check that runs BEFORE a single token of recipient-facing text is generated.
 *
 * `.strict()` everywhere is deliberate: an unknown property means the model
 * invented a field, which usually means it is smuggling content past a validator.
 */
import { z } from 'zod';
import { GA_AUDIENCES, GA_JURISDICTIONS } from './government-affairs-policy.registry.js';

/** What kind of assertion a claim is — decides which validator applies. */
export const CLAIM_TYPES = [
  'legislative_status',
  'funding_amount',
  'funding_stage',
  'date_or_deadline',
  'recipient_attribute',
  'recipient_position',
  'meeting_or_event',
  'client_fact',
  'relationship_history',
  'other',
] as const;

export const claimTypeSchema = z.enum(CLAIM_TYPES);

/**
 * One claim the draft intends to make, with its support.
 *
 * `sourceIds` must reference evidence actually present in the packet. `asOf` is
 * required-when-known rather than optional-by-convention because a legislative
 * or funding claim without an as-of date is the single most common way a stale
 * fact reaches a recipient as current.
 */
export const supportedClaimSchema = z
  .object({
    /** The claim in one sentence, as it will be asserted. */
    claim: z.string().min(1).max(600),
    /** Packet evidence source ids that support it. At least one. */
    sourceIds: z.array(z.string().min(1)).min(1).max(20),
    /** The as-of date of the supporting fact (ISO date), or null if none. */
    asOf: z.string().max(40).nullable(),
    claimType: claimTypeSchema,
  })
  .strict();

/** A claim the model considered but cannot support, kept so it can be excluded. */
export const riskyClaimSchema = z
  .object({
    claim: z.string().min(1).max(600),
    /** Why it is unsupported or risky. */
    reason: z.string().min(1).max(400),
    claimType: claimTypeSchema,
  })
  .strict();

export const messagePlanSchema = z
  .object({
    /** The message's purpose; validated against the policy's allowedIntents. */
    intent: z.string().min(1).max(80),
    jurisdiction: z.enum(GA_JURISDICTIONS as [string, ...string[]]),
    audienceType: z.enum(GA_AUDIENCES as [string, ...string[]]),
    /** The client being represented, or null for an internal message. */
    clientRepresented: z.string().max(200).nullable(),
    /** The concrete outcome this message is trying to produce. */
    desiredOutcome: z.string().min(1).max(600),
    /** Why THIS recipient — their role, jurisdiction, committee, relationship. */
    whyRecipient: z.array(z.string().min(1).max(400)).max(6),
    /** Why now — the timely hook. */
    whyNow: z.array(z.string().min(1).max(400)).max(6),
    /** What we are asking for on the client's behalf. */
    clientAsk: z.array(z.string().min(1).max(400)).max(6),
    supportedClaims: z.array(supportedClaimSchema).max(30),
    unsupportedOrRiskyClaims: z.array(riskyClaimSchema).max(30),
    tone: z.enum(['professional', 'friendly', 'formal', 'concise']),
    callToAction: z.string().min(1).max(400),
    /** Context the plan needed and did not have. Drives the honest-fallback. */
    missingCriticalContext: z.array(z.string().min(1).max(400)).max(10),
  })
  .strict();

export type MessagePlan = z.infer<typeof messagePlanSchema>;
export type SupportedClaim = z.infer<typeof supportedClaimSchema>;
export type RiskyClaim = z.infer<typeof riskyClaimSchema>;

/**
 * JSON Schema for the provider's structured-output mode. Hand-written rather than
 * generated so `additionalProperties: false` and `required` are exhaustive at
 * every level — both providers enforce strict mode only when they are.
 */
export const MESSAGE_PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'intent',
    'jurisdiction',
    'audienceType',
    'clientRepresented',
    'desiredOutcome',
    'whyRecipient',
    'whyNow',
    'clientAsk',
    'supportedClaims',
    'unsupportedOrRiskyClaims',
    'tone',
    'callToAction',
    'missingCriticalContext',
  ],
  properties: {
    intent: { type: 'string' },
    jurisdiction: { type: 'string', enum: GA_JURISDICTIONS },
    audienceType: { type: 'string', enum: GA_AUDIENCES },
    clientRepresented: { type: ['string', 'null'] },
    desiredOutcome: { type: 'string' },
    whyRecipient: { type: 'array', items: { type: 'string' } },
    whyNow: { type: 'array', items: { type: 'string' } },
    clientAsk: { type: 'array', items: { type: 'string' } },
    supportedClaims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'sourceIds', 'asOf', 'claimType'],
        properties: {
          claim: { type: 'string' },
          sourceIds: { type: 'array', items: { type: 'string' } },
          asOf: { type: ['string', 'null'] },
          claimType: { type: 'string', enum: CLAIM_TYPES },
        },
      },
    },
    unsupportedOrRiskyClaims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'reason', 'claimType'],
        properties: {
          claim: { type: 'string' },
          reason: { type: 'string' },
          claimType: { type: 'string', enum: CLAIM_TYPES },
        },
      },
    },
    tone: { type: 'string', enum: ['professional', 'friendly', 'formal', 'concise'] },
    callToAction: { type: 'string' },
    missingCriticalContext: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** One reason a plan was rejected. */
export interface PlanValidationIssue {
  code: string;
  message: string;
  /** The claim or field the issue attaches to, when applicable. */
  subject?: string;
}

export class MessagePlanInvalidError extends Error {
  readonly code = 'MESSAGE_PLAN_INVALID';
  readonly issues: PlanValidationIssue[];
  constructor(issues: PlanValidationIssue[]) {
    super(`Message plan invalid: ${issues.map((i) => i.code).join(', ')}`);
    this.name = 'MessagePlanInvalidError';
    this.issues = issues;
  }
}
