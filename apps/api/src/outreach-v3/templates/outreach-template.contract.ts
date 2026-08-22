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

const nullableText = (max: number) => z.string().max(max).nullable();

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
  })
  .strict()
  .superRefine((spec, ctx) => {
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
  });
}
