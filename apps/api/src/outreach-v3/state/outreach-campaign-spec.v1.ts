import { createHash } from 'node:crypto';
import { z } from 'zod';

export const OUTREACH_CAMPAIGN_SPEC_SCHEMA_VERSION = 'outreach_campaign_spec_v1' as const;

export const OUTREACH_V3_LIMITS = Object.freeze({
  campaignSpecBytes: 1024 * 1024,
  commandBatchBytes: 256 * 1024,
  commandsPerBatch: 20,
  sponsorClientRefs: 50,
  futureTargetRefs: 500,
  futureContextRefs: 500,
  goal: 2_000,
  objective: 4_000,
  topic: 500,
  desiredOutcome: 2_000,
  askText: 2_000,
  whyNow: 2_000,
  sponsorLabel: 240,
  targetCriteriaNotes: 4_000,
  targetCriteriaStrings: 120,
  campaignAngle: 4_000,
  tone: 120,
  customLengthInstruction: 1_000,
});

const FORBIDDEN_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

/** Locale-independent ordering for content-addressed canonical state. */
export function compareCanonicalStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function boundedText(max: number) {
  return z
    .string()
    .max(max)
    .refine((value) => !FORBIDDEN_CONTROL_CHARACTERS.test(value), {
      message: 'Text contains disallowed control characters.',
    });
}

function boundedNullableText(max: number) {
  return boundedText(max).nullable();
}

const clientRefSchema = z
  .object({
    clientId: z.string().uuid(),
  })
  .strict();

const targetCriteriaText = boundedText(OUTREACH_V3_LIMITS.targetCriteriaStrings).min(1);

export const targetCriteriaV1Schema = z
  .object({
    notes: boundedNullableText(OUTREACH_V3_LIMITS.targetCriteriaNotes),
    governmentLevels: z
      .array(z.enum(['federal', 'state', 'local', 'agency', 'mixed']))
      .max(20),
    chambers: z
      .array(z.enum(['house', 'senate', 'state_house', 'state_senate']))
      .max(20),
    committees: z.array(targetCriteriaText).max(100),
    agencies: z.array(targetCriteriaText).max(100),
    states: z.array(targetCriteriaText).max(100),
    relationshipPreference: z.enum(['any', 'existing', 'new', 'mixed']),
    includeStaff: z.boolean(),
    includePrincipals: z.boolean(),
  })
  .strict();

// Phase 2 preserves the final schema locations for target/context references but
// deliberately owns no target/context identity vocabulary. The arrays must remain
// empty until their owning phases introduce and authorize those reference types.
const reservedFutureRefsSchema = z.array(z.never()).max(0);

const outreachCampaignSpecV1BaseSchema = z
  .object({
    schemaVersion: z.literal(OUTREACH_CAMPAIGN_SPEC_SCHEMA_VERSION),
    goal: z
      .object({
        goal: boundedNullableText(OUTREACH_V3_LIMITS.goal),
        objective: boundedNullableText(OUTREACH_V3_LIMITS.objective),
        topic: boundedNullableText(OUTREACH_V3_LIMITS.topic),
        desiredOutcome: boundedNullableText(OUTREACH_V3_LIMITS.desiredOutcome),
        ask: z
          .object({
            mode: z.enum(['undecided', 'explicit', 'none']),
            text: boundedNullableText(OUTREACH_V3_LIMITS.askText),
          })
          .strict(),
        whyNow: boundedNullableText(OUTREACH_V3_LIMITS.whyNow),
      })
      .strict(),
    sponsor: z
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
        label: boundedNullableText(OUTREACH_V3_LIMITS.sponsorLabel),
        clientRefs: z.array(clientRefSchema).max(OUTREACH_V3_LIMITS.sponsorClientRefs),
      })
      .strict(),
    targeting: z
      .object({
        criteria: targetCriteriaV1Schema.nullable(),
        selectedTargetRefs: reservedFutureRefsSchema,
        rejectedRecommendationRefs: reservedFutureRefsSchema,
      })
      .strict(),
    delivery: z
      .object({
        pattern: z.enum([
          'undecided',
          'personalized_separate',
          'uniform_separate',
          'shared_thread',
        ]),
        personalization: z.enum(['undecided', 'high', 'light', 'none']),
      })
      .strict(),
    context: z
      .object({
        requiredPolicyRefs: reservedFutureRefsSchema,
        writingGuidanceRefs: reservedFutureRefsSchema,
        campaignFactRefs: reservedFutureRefsSchema,
        targetSpecificRefs: reservedFutureRefsSchema,
        groupSafeRefs: reservedFutureRefsSchema,
        excludedRefs: reservedFutureRefsSchema,
      })
      .strict(),
    strategy: z
      .object({
        campaignAngle: boundedNullableText(OUTREACH_V3_LIMITS.campaignAngle),
        tone: boundedNullableText(OUTREACH_V3_LIMITS.tone),
        length: z.enum(['undecided', 'short', 'medium', 'long', 'custom']),
        customLengthInstruction: boundedNullableText(
          OUTREACH_V3_LIMITS.customLengthInstruction,
        ),
      })
      .strict(),
  })
  .strict();

export const outreachCampaignSpecV1Schema = outreachCampaignSpecV1BaseSchema.superRefine(
  (spec, ctx) => {
    const refs = spec.sponsor.clientRefs;
    const uniqueRefs = new Set(refs.map((ref) => ref.clientId));
    if (uniqueRefs.size !== refs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sponsor', 'clientRefs'],
        message: 'Sponsor client references must be unique after normalization.',
      });
    }

    const requireNoClients = ['undecided', 'firm', 'internal_team', 'none'].includes(
      spec.sponsor.kind,
    );
    if (requireNoClients && refs.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sponsor', 'clientRefs'],
        message: `${spec.sponsor.kind} sponsor scope cannot contain client references.`,
      });
    }
    if (spec.sponsor.kind === 'client' && refs.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sponsor', 'clientRefs'],
        message: 'Client sponsor scope requires exactly one client reference.',
      });
    }
    if (spec.sponsor.kind === 'multi_client' && refs.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sponsor', 'clientRefs'],
        message: 'Multi-client sponsor scope requires at least two client references.',
      });
    }
    if (spec.sponsor.kind === 'coalition' && !spec.sponsor.label) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sponsor', 'label'],
        message: 'Coalition sponsor scope requires a label.',
      });
    }

    if (spec.goal.ask.mode === 'explicit' && !spec.goal.ask.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['goal', 'ask', 'text'],
        message: 'An explicit ask requires text.',
      });
    }
    if (spec.goal.ask.mode !== 'explicit' && spec.goal.ask.text !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['goal', 'ask', 'text'],
        message: 'Ask text must be null unless ask mode is explicit.',
      });
    }

    if (spec.strategy.length === 'custom' && !spec.strategy.customLengthInstruction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strategy', 'customLengthInstruction'],
        message: 'Custom length requires an instruction.',
      });
    }
    if (
      spec.strategy.length !== 'custom' &&
      spec.strategy.customLengthInstruction !== null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strategy', 'customLengthInstruction'],
        message: 'Custom length instruction must be null unless length is custom.',
      });
    }
  },
);

export type OutreachCampaignSpecV1 = z.infer<typeof outreachCampaignSpecV1BaseSchema>;
export type TargetCriteriaV1 = z.infer<typeof targetCriteriaV1Schema>;
export type OutreachSponsorScopeV1 = OutreachCampaignSpecV1['sponsor'];

export function createBlankCampaignSpecV1(): OutreachCampaignSpecV1 {
  return {
    schemaVersion: OUTREACH_CAMPAIGN_SPEC_SCHEMA_VERSION,
    goal: {
      goal: null,
      objective: null,
      topic: null,
      desiredOutcome: null,
      ask: { mode: 'undecided', text: null },
      whyNow: null,
    },
    sponsor: {
      kind: 'undecided',
      label: null,
      clientRefs: [],
    },
    targeting: {
      criteria: null,
      selectedTargetRefs: [],
      rejectedRecommendationRefs: [],
    },
    delivery: {
      pattern: 'undecided',
      personalization: 'undecided',
    },
    context: {
      requiredPolicyRefs: [],
      writingGuidanceRefs: [],
      campaignFactRefs: [],
      targetSpecificRefs: [],
      groupSafeRefs: [],
      excludedRefs: [],
    },
    strategy: {
      campaignAngle: null,
      tone: null,
      length: 'undecided',
      customLengthInstruction: null,
    },
  };
}

function normalizeNullableText(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  return normalized.length === 0 ? null : normalized;
}

function normalizeSet(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    compareCanonicalStrings,
  );
}

export function normalizeCampaignSpecV1(spec: OutreachCampaignSpecV1): OutreachCampaignSpecV1 {
  const sortedClientRefs = [...spec.sponsor.clientRefs].sort((a, b) =>
    compareCanonicalStrings(a.clientId, b.clientId),
  );
  const normalized: OutreachCampaignSpecV1 = {
    ...spec,
    goal: {
      goal: normalizeNullableText(spec.goal.goal),
      objective: normalizeNullableText(spec.goal.objective),
      topic: normalizeNullableText(spec.goal.topic),
      desiredOutcome: normalizeNullableText(spec.goal.desiredOutcome),
      ask: {
        mode: spec.goal.ask.mode,
        text: normalizeNullableText(spec.goal.ask.text),
      },
      whyNow: normalizeNullableText(spec.goal.whyNow),
    },
    sponsor: {
      kind: spec.sponsor.kind,
      label: normalizeNullableText(spec.sponsor.label),
      clientRefs: sortedClientRefs.filter(
        (ref, index, array) => index === 0 || ref.clientId !== array[index - 1]?.clientId,
      ),
    },
    targeting: {
      criteria: spec.targeting.criteria
        ? {
            ...spec.targeting.criteria,
            notes: normalizeNullableText(spec.targeting.criteria.notes),
            governmentLevels: [...new Set(spec.targeting.criteria.governmentLevels)].sort(
              compareCanonicalStrings,
            ),
            chambers: [...new Set(spec.targeting.criteria.chambers)].sort(
              compareCanonicalStrings,
            ),
            committees: normalizeSet(spec.targeting.criteria.committees),
            agencies: normalizeSet(spec.targeting.criteria.agencies),
            states: normalizeSet(spec.targeting.criteria.states),
          }
        : null,
      selectedTargetRefs: [],
      rejectedRecommendationRefs: [],
    },
    delivery: { ...spec.delivery },
    context: {
      requiredPolicyRefs: [],
      writingGuidanceRefs: [],
      campaignFactRefs: [],
      targetSpecificRefs: [],
      groupSafeRefs: [],
      excludedRefs: [],
    },
    strategy: {
      campaignAngle: normalizeNullableText(spec.strategy.campaignAngle),
      tone: normalizeNullableText(spec.strategy.tone),
      length: spec.strategy.length,
      customLengthInstruction: normalizeNullableText(spec.strategy.customLengthInstruction),
    },
  };
  return outreachCampaignSpecV1Schema.parse(normalized);
}

export function parseCampaignSpecV1(input: unknown): OutreachCampaignSpecV1 {
  // Structural parsing intentionally precedes invariant validation so set-like
  // fields can canonicalize first (e.g. duplicate sponsor/client inputs).
  const structurallyValid = outreachCampaignSpecV1BaseSchema.parse(input);
  const normalized = normalizeCampaignSpecV1(structurallyValid);
  const bytes = Buffer.byteLength(canonicalJsonStringify(normalized), 'utf8');
  if (bytes > OUTREACH_V3_LIMITS.campaignSpecBytes) {
    throw new Error(`OUTREACH_CAMPAIGN_SPEC_TOO_LARGE:${bytes}`);
  }
  return normalized;
}

export function canonicalJsonStringify(value: unknown): string {
  if (value === undefined) throw new Error('undefined is not valid canonical JSON');
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('value is not valid canonical JSON');
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonStringify(entry)).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort(compareCanonicalStrings)
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(object[key])}`)
    .join(',')}}`;
}

export function canonicalizeCampaignSpecV1(input: unknown): string {
  return canonicalJsonStringify(parseCampaignSpecV1(input));
}

export function hashCampaignSpecV1(input: unknown): string {
  return createHash('sha256').update(canonicalizeCampaignSpecV1(input), 'utf8').digest('hex');
}
