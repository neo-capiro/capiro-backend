import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalJsonStringify,
  targetCriteriaV1Schema,
  type OutreachCampaignSpecV1,
} from '../state/outreach-campaign-spec.v1.js';
import { outreachStyleSampleInputV1Schema } from '../state/outreach-style-sample.contract.js';

export const OUTREACH_TEMPLATE_SPEC_VERSION = 'outreach_v3_template_v1' as const;
export const OUTREACH_TEMPLATE_SCOPES = ['private', 'firm', 'client'] as const;

// Team/coalition scope and a release-controlled system/Capiro origin are
// explicitly deferred (closeout runbook 3.3/6.3): neither has a real
// membership/seed model yet, so adding them here would either fabricate
// governance that doesn't exist or block on unrelated infrastructure. Keep
// the UI truthful instead — see VNextOutreachTemplateLibrary's empty "Capiro"
// category.

// Control characters (excluding \t\n\r, which are legitimate in prose) are
// rejected everywhere a person can type free text (closeout runbook 4.5).
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
const noControlChars = (value: string) => !CONTROL_CHAR_RE.test(value);

const nullableText = (max: number) =>
  z.string().max(max).refine(noControlChars, 'Contains a disallowed control character.').nullable();

/**
 * Fields this document is allowed to disagree with the previous published
 * version about, tagged with how a NEW campaign should treat that field
 * (closeout runbook 4.2). This does not change what is compiled into a
 * campaign — SET_* commands still carry the concrete value already on
 * `spec` — it only tells the UI/wizard/receipt how to explain that value.
 */
export const OUTREACH_TEMPLATE_FIELD_RESOLUTION_MODES = [
  'fixed',
  'suggested',
  'ask_each_campaign',
  'meri_determines_user_confirms',
  'required_unresolved',
  'not_applicable',
] as const;
const fieldResolutionModeSchema = z.enum(OUTREACH_TEMPLATE_FIELD_RESOLUTION_MODES);
export type OutreachTemplateFieldResolutionMode = (typeof OUTREACH_TEMPLATE_FIELD_RESOLUTION_MODES)[number];

const DEFAULTS_POLICY_FIELDS = [
  'goal',
  'objective',
  'topic',
  'desiredOutcome',
  'ask',
  'whyNow',
  'sponsorScope',
  'audience',
  'delivery',
  'personalization',
  'contextPolicy',
  'campaignAngle',
  'tone',
  'length',
  'subjectStyle',
  'ctaStyle',
  'senderPolicy',
  'signaturePolicy',
  'schedulingPolicy',
  'attachmentPolicy',
  'followUpPolicy',
] as const;
export type OutreachTemplateDefaultsPolicyField = (typeof DEFAULTS_POLICY_FIELDS)[number];

const defaultsPolicyShape = Object.fromEntries(
  DEFAULTS_POLICY_FIELDS.map((field) => [field, fieldResolutionModeSchema]),
) as Record<OutreachTemplateDefaultsPolicyField, typeof fieldResolutionModeSchema>;
export const outreachTemplateDefaultsPolicySchema = z.object(defaultsPolicyShape).strict();
export type OutreachTemplateDefaultsPolicy = z.infer<typeof outreachTemplateDefaultsPolicySchema>;

/** A campaign created straight from a source session has no authored policy
 * distinctions yet — every field it carried was a concrete, fixed value. */
export const DEFAULT_TEMPLATE_DEFAULTS_POLICY: OutreachTemplateDefaultsPolicy = Object.fromEntries(
  DEFAULTS_POLICY_FIELDS.map((field) => [field, 'fixed' as const]),
) as OutreachTemplateDefaultsPolicy;

/**
 * Bounded, non-compiled guidance strings (closeout runbook 4.2/4.4). None of
 * these have a corresponding canonical Outreach V3 command — there is no
 * SET_SUBJECT_STYLE, SET_SCHEDULE, etc. — so they are never applied to a
 * campaign automatically. They are displayed to the operator as governed
 * instructions during Plan/Drafts instead of being silently enforced,
 * exactly like a template's style samples are voice guidance, not evidence.
 */
export const outreachTemplateGuidanceSchema = z
  .object({
    audienceRule: nullableText(2_000),
    contextPolicy: nullableText(2_000),
    subjectStyle: nullableText(500),
    ctaStyle: nullableText(500),
    senderPolicy: nullableText(1_000),
    signaturePolicy: nullableText(1_000),
    schedulingPolicy: nullableText(1_000),
    attachmentPolicy: nullableText(1_000),
    followUpPolicy: nullableText(1_000),
  })
  .strict();
export type OutreachTemplateGuidance = z.infer<typeof outreachTemplateGuidanceSchema>;
export const BLANK_TEMPLATE_GUIDANCE: OutreachTemplateGuidance = {
  audienceRule: null,
  contextPolicy: null,
  subjectStyle: null,
  ctaStyle: null,
  senderPolicy: null,
  signaturePolicy: null,
  schedulingPolicy: null,
  attachmentPolicy: null,
  followUpPolicy: null,
};

/**
 * First-class guardrail policy (closeout runbook 4.4). These are declarative
 * — Phase 1's own send-authority spine already enforces the real send/
 * approval boundary and is not reconfigured per template — so applying a
 * template never loosens or replaces that boundary. They exist so the
 * template can DOCUMENT and DISPLAY the operating rules a governed playbook
 * expects, and so a future authority change has a real place to read from
 * instead of a free-text description.
 */
export const outreachTemplateGuardrailsSchema = z
  .object({
    editAuthority: z.enum(['owner_only', 'managers', 'firm_admins']),
    publishAuthority: z.enum(['owner_only', 'tenant_admin', 'independent_reviewer']),
    sendAuthority: z.enum(['owner_only', 'any_authorized_sender', 'tenant_admin']),
    approvalMode: z.enum(['individual', 'bulk_allowed']),
    partialSendAllowed: z.boolean(),
    requiredContextClasses: z.array(z.string().max(80).refine(noControlChars)).max(20),
    requiredPreflightChecks: z.array(z.string().max(80).refine(noControlChars)).max(20),
    senderRequirement: z.enum(['any_authorized', 'specific_role_required', 'not_applicable']),
    attachmentRequirement: z.enum(['none', 'optional', 'required']),
    followUpRequired: z.boolean(),
    variablesAutoResolveAllowed: z.boolean(),
    allowSkipValidPlanDecision: z.boolean(),
  })
  .strict();
export type OutreachTemplateGuardrails = z.infer<typeof outreachTemplateGuardrailsSchema>;
export const DEFAULT_TEMPLATE_GUARDRAILS: OutreachTemplateGuardrails = {
  editAuthority: 'owner_only',
  publishAuthority: 'tenant_admin',
  sendAuthority: 'any_authorized_sender',
  approvalMode: 'individual',
  partialSendAllowed: false,
  requiredContextClasses: [],
  requiredPreflightChecks: [],
  senderRequirement: 'any_authorized',
  attachmentRequirement: 'none',
  followUpRequired: false,
  variablesAutoResolveAllowed: false,
  allowSkipValidPlanDecision: false,
};

/**
 * A typed, reusable question (closeout runbook 4.3). `appliesTo` names which
 * text fields on THIS spec may contain a literal `{key}` token that
 * `substituteOutreachTemplateVariables()` replaces at apply time — a variable
 * with an empty `appliesTo` is still a real question (its resolved value is
 * recorded on the application for provenance) even though it never appears
 * in any generated text.
 */
export const OUTREACH_TEMPLATE_VARIABLE_TEXT_FIELDS = [
  'goal',
  'objective',
  'topic',
  'desiredOutcome',
  'ask',
  'whyNow',
  'campaignAngle',
] as const;
export type OutreachTemplateVariableTextField = (typeof OUTREACH_TEMPLATE_VARIABLE_TEXT_FIELDS)[number];

export const OUTREACH_TEMPLATE_VARIABLE_RESOLUTION_POLICIES = [
  'meri_can_determine',
  'user_must_confirm',
  'always_ask',
] as const;
export type OutreachTemplateVariableResolutionPolicy =
  (typeof OUTREACH_TEMPLATE_VARIABLE_RESOLUTION_POLICIES)[number];

const VARIABLE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export const outreachTemplateVariableSchema = z
  .object({
    key: z.string().regex(VARIABLE_KEY_RE, 'Use a stable lowercase_key like client or event_date.'),
    label: z.string().max(120).refine(noControlChars),
    question: nullableText(500),
    type: z.enum(['text', 'number', 'date', 'url', 'email', 'choice']),
    choices: z.array(z.string().max(120).refine(noControlChars)).max(20).nullable(),
    required: z.boolean(),
    defaultValue: nullableText(500),
    resolutionPolicy: z.enum(OUTREACH_TEMPLATE_VARIABLE_RESOLUTION_POLICIES),
    scope: z.enum(['public', 'client_confidential']),
    appliesTo: z.array(z.enum(OUTREACH_TEMPLATE_VARIABLE_TEXT_FIELDS)).max(
      OUTREACH_TEMPLATE_VARIABLE_TEXT_FIELDS.length,
    ),
  })
  .strict()
  .superRefine((variable, ctx) => {
    if (variable.type === 'choice' && (!variable.choices || variable.choices.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['choices'],
        message: 'A choice variable needs at least one choice.',
      });
    }
    if (variable.type !== 'choice' && variable.choices !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['choices'],
        message: 'Choices are allowed only for a choice-type variable.',
      });
    }
    // "always_ask" is meaningless with a stored default that would just get
    // silently reused every time — the whole point is a fresh answer per
    // campaign (see substituteOutreachTemplateVariables()).
    if (variable.resolutionPolicy === 'always_ask' && variable.defaultValue !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultValue'],
        message: 'A variable asked every campaign cannot carry a stored default.',
      });
    }
  });
export type OutreachTemplateVariable = z.infer<typeof outreachTemplateVariableSchema>;

const templateVariablesSchema = z
  .array(outreachTemplateVariableSchema)
  .max(20)
  .superRefine((variables, ctx) => {
    const seen = new Set<string>();
    variables.forEach((variable, index) => {
      if (seen.has(variable.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'key'],
          message: `Variable key "${variable.key}" is used more than once.`,
        });
      }
      seen.add(variable.key);
    });
  });

/**
 * A user-authored email skeleton stored on the template.
 *
 * This is the structural half of a template, distinct from the campaign-settings
 * half above: `goal`/`strategy`/`delivery` decide WHAT the campaign is, this
 * decides what the email LOOKS like. It is nullable because every template
 * created before this feature — and every template projected from a live
 * campaign via `templateSpecFromCampaign` — legitimately has no skeleton, and
 * those must keep working unchanged (generation simply stays in free-body mode).
 *
 * Token syntax here is DOUBLE-brace `{{slot}}`, deliberately different from the
 * single-brace `{key}` campaign variables above: they are resolved by different
 * code at different times (variables at template-apply, slots at generation), and
 * a shared syntax would let the variable resolver silently consume a slot token.
 */
const contentSkeletonSlotSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use a stable lowercase_key like why_it_matters.'),
    label: z.string().min(1).max(120).refine(noControlChars),
    instruction: z.string().min(1).max(1_000).refine(noControlChars),
    required: z.boolean(),
  })
  .strict();

export const outreachTemplateContentSkeletonSchema = z
  .object({
    subject: z.string().max(400).refine(noControlChars),
    body: z.string().min(1).max(8_000).refine(noControlChars),
    slots: z.array(contentSkeletonSlotSchema).max(12),
  })
  .strict()
  .superRefine((skeleton, ctx) => {
    // Both directions of slot/token agreement are errors. An undeclared token
    // would render as literal "{{foo}}" in a real email to a congressional
    // office; a declared-but-unplaced slot means the author believes they are
    // collecting prose that will never appear.
    const declared = new Set(skeleton.slots.map((slot) => slot.key));
    const used = new Set<string>();
    for (const text of [skeleton.subject, skeleton.body]) {
      for (const match of text.matchAll(/\{\{([a-z][a-z0-9_]{0,39})\}\}/g)) {
        used.add(match[1]!);
      }
    }
    for (const key of used) {
      if (!declared.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['body'],
          message: `"{{${key}}}" is used in the template but is not a declared section.`,
        });
      }
    }
    skeleton.slots.forEach((slot, index) => {
      if (!used.has(slot.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slots', index, 'key'],
          message: `Section "${slot.key}" is never placed in the template. Add {{${slot.key}}} where it belongs.`,
        });
      }
    });
    const seen = new Set<string>();
    skeleton.slots.forEach((slot, index) => {
      if (seen.has(slot.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slots', index, 'key'],
          message: `Section key "${slot.key}" is used more than once.`,
        });
      }
      seen.add(slot.key);
    });
    if (!used.size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['body'],
        message:
          'This template has no {{sections}}, so every recipient would receive identical text. Add at least one section.',
      });
    }
  });

export type OutreachTemplateContentSkeleton = z.infer<
  typeof outreachTemplateContentSkeletonSchema
>;

export const outreachTemplateSpecV1Schema = z
  .object({
    schemaVersion: z.literal(OUTREACH_TEMPLATE_SPEC_VERSION),
    goal: z
      .object({
        goal: nullableText(2_000),
        objective: nullableText(4_000),
        topic: nullableText(500),
        desiredOutcome: nullableText(2_000),
        ask: z
          .object({
            mode: z.enum(['undecided', 'explicit', 'none']),
            text: nullableText(2_000),
          })
          .strict(),
        whyNow: nullableText(2_000),
      })
      .strict(),
    sponsor: z
      .object({
        kind: z.enum(['undecided', 'firm', 'client', 'coalition', 'internal_team', 'none']),
        label: nullableText(240),
      })
      .strict(),
    targeting: z.object({ criteria: targetCriteriaV1Schema.nullable() }).strict(),
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
    strategy: z
      .object({
        campaignAngle: nullableText(4_000),
        tone: nullableText(120),
        length: z.enum(['undecided', 'short', 'medium', 'long', 'custom']),
        customLengthInstruction: nullableText(1_000),
      })
      .strict(),
    styleSamples: z.array(outreachStyleSampleInputV1Schema).max(5),
    /**
     * Nullable AND optional by design: pre-existing templates and
     * campaign-projected templates have no skeleton, and generation correctly
     * falls back to free-body mode for them. Never make this required.
     *
     * `.nullable().optional()` rather than `.nullable().default(null)`: a zod
     * default makes the field REQUIRED on the parsed output type, so every
     * existing construction site (including test fixtures) would fail to
     * compile — a purely additive field must not force a caller change.
     */
    contentSkeleton: outreachTemplateContentSkeletonSchema.nullable().optional(),
    variables: templateVariablesSchema,
    defaultsPolicy: outreachTemplateDefaultsPolicySchema,
    guidance: outreachTemplateGuidanceSchema,
    guardrails: outreachTemplateGuardrailsSchema,
  })
  .strict()
  .superRefine((spec, ctx) => {
    const declaredKeys = new Map(spec.variables.map((variable) => [variable.key, variable]));
    const textFields: Array<[OutreachTemplateVariableTextField, string | null, (string | number)[]]> = [
      ['goal', spec.goal.goal, ['goal', 'goal']],
      ['objective', spec.goal.objective, ['goal', 'objective']],
      ['topic', spec.goal.topic, ['goal', 'topic']],
      ['desiredOutcome', spec.goal.desiredOutcome, ['goal', 'desiredOutcome']],
      ['ask', spec.goal.ask.text, ['goal', 'ask', 'text']],
      ['whyNow', spec.goal.whyNow, ['goal', 'whyNow']],
      ['campaignAngle', spec.strategy.campaignAngle, ['strategy', 'campaignAngle']],
    ];
    for (const [field, text, path] of textFields) {
      if (!text) continue;
      for (const match of text.matchAll(/\{([a-z][a-z0-9_]{0,39})\}/g)) {
        const key = match[1]!;
        const variable = declaredKeys.get(key);
        if (!variable) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `"{${key}}" is not a declared variable.`,
          });
        } else if (!variable.appliesTo.includes(field)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `Variable "${key}" is not allowed in this field. Add it to the variable's appliesTo list.`,
          });
        }
      }
    }
    if (spec.goal.ask.mode === 'explicit' && !spec.goal.ask.text?.trim()) {
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
        message: 'Ask text must be null unless the ask is explicit.',
      });
    }
    if (spec.sponsor.kind === 'coalition' && !spec.sponsor.label?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sponsor', 'label'],
        message: 'A coalition template requires a sponsor label.',
      });
    }
    if (spec.sponsor.kind !== 'coalition' && spec.sponsor.label !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sponsor', 'label'],
        message: 'Only coalition templates may retain a sponsor label.',
      });
    }
    if (spec.strategy.length === 'custom' && !spec.strategy.customLengthInstruction?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strategy', 'customLengthInstruction'],
        message: 'Custom length requires an instruction.',
      });
    }
    if (spec.strategy.length !== 'custom' && spec.strategy.customLengthInstruction !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strategy', 'customLengthInstruction'],
        message: 'Custom instruction is allowed only for custom length.',
      });
    }
  });

export type OutreachTemplateSpecV1 = z.infer<typeof outreachTemplateSpecV1Schema>;
export type OutreachTemplateScope = (typeof OUTREACH_TEMPLATE_SCOPES)[number];

export function parseOutreachTemplateSpecV1(input: unknown): OutreachTemplateSpecV1 {
  return outreachTemplateSpecV1Schema.parse(input);
}

export function hashOutreachTemplateSpecV1(spec: OutreachTemplateSpecV1): string {
  const parsed = parseOutreachTemplateSpecV1(spec);
  return createHash('sha256').update(canonicalJsonStringify(parsed), 'utf8').digest('hex');
}

/** Project a live campaign into reusable intent only. */
export function templateSpecFromCampaign(campaign: OutreachCampaignSpecV1): OutreachTemplateSpecV1 {
  const sponsorKind = campaign.sponsor.kind === 'multi_client' ? 'undecided' : campaign.sponsor.kind;
  return parseOutreachTemplateSpecV1({
    schemaVersion: OUTREACH_TEMPLATE_SPEC_VERSION,
    goal: campaign.goal,
    sponsor: {
      kind: sponsorKind,
      label: sponsorKind === 'coalition' ? campaign.sponsor.label : null,
    },
    targeting: { criteria: campaign.targeting.criteria },
    delivery: campaign.delivery,
    strategy: campaign.strategy,
    styleSamples: (campaign.styleSamples ?? []).map((sample) => ({
      label: sample.label,
      subject: sample.subject,
      body: sample.body,
    })),
    // A campaign carries no authored skeleton — the skeleton lives on the
    // template it was applied FROM, and projecting a campaign backwards cannot
    // recover it. Null keeps the projected template in free-body mode, which is
    // exactly the behaviour it had before this feature existed.
    contentSkeleton: null,
    // A campaign has no authored variables/guardrails/field-resolution policy
    // yet — every value it carries is simply the fixed fact it currently has.
    variables: [],
    defaultsPolicy: DEFAULT_TEMPLATE_DEFAULTS_POLICY,
    guidance: BLANK_TEMPLATE_GUIDANCE,
    guardrails: DEFAULT_TEMPLATE_GUARDRAILS,
  });
}

/**
 * Resolve `{key}` tokens in reusable text fields to concrete values at
 * template-apply time (closeout runbook 4.3/6). This runs BEFORE
 * `compileOutreachTemplateBatch()` — the compiler itself only ever sees
 * already-resolved text, never a raw template token, so a placeholder can
 * never leak into a real drafted email. Resolution never touches the stored
 * template spec; resolved values live only on the application record.
 *
 * - `always_ask` variables ignore any stored default: the caller MUST supply
 *   a fresh value every time, or resolution fails for a required one.
 * - `meri_can_determine` / `user_must_confirm` variables may fall back to the
 *   variable's own `defaultValue` when the caller didn't supply one.
 * - An unresolved OPTIONAL variable's token is replaced with an empty string
 *   rather than left as literal `{key}` text a recipient could see.
 */
export function substituteOutreachTemplateVariables(
  spec: OutreachTemplateSpecV1,
  providedValues: Record<string, string>,
): OutreachTemplateSpecV1 {
  const missing: string[] = [];
  const resolved = new Map<string, string>();
  for (const variable of spec.variables) {
    const provided = providedValues[variable.key]?.trim();
    const fallback = variable.resolutionPolicy === 'always_ask' ? undefined : variable.defaultValue?.trim();
    const value = provided || fallback || '';
    if (variable.required && !value) {
      missing.push(variable.key);
      continue;
    }
    resolved.set(variable.key, value);
  }
  if (missing.length) {
    throw new OutreachTemplateVariablesMissingError(missing);
  }
  const replace = (text: string | null): string | null => {
    if (!text) return text;
    return text.replace(/\{([a-z][a-z0-9_]{0,39})\}/g, (token, key: string) =>
      resolved.has(key) ? resolved.get(key)! : token,
    );
  };
  return {
    ...spec,
    goal: {
      ...spec.goal,
      goal: replace(spec.goal.goal),
      objective: replace(spec.goal.objective),
      topic: replace(spec.goal.topic),
      desiredOutcome: replace(spec.goal.desiredOutcome),
      ask: { ...spec.goal.ask, text: replace(spec.goal.ask.text) },
      whyNow: replace(spec.goal.whyNow),
    },
    strategy: { ...spec.strategy, campaignAngle: replace(spec.strategy.campaignAngle) },
  };
}

export class OutreachTemplateVariablesMissingError extends Error {
  constructor(public readonly keys: string[]) {
    super(`Missing required template variable(s): ${keys.join(', ')}`);
    this.name = 'OutreachTemplateVariablesMissingError';
  }
}
