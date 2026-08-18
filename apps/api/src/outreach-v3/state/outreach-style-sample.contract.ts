import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * User-supplied example emails ("style samples") used as few-shot exemplars for
 * campaign drafting.
 *
 * Three properties are deliberate:
 *
 *   1. **Content-addressed.** `sampleKey` is a hash of the normalized subject +
 *      body, so the pure command reducer never needs a clock or a random id, and
 *      pasting the same example twice is idempotent rather than a duplicate.
 *   2. **Voice only, never evidence.** A sample is prior correspondence the user
 *      pasted; it is not a governed Evidence Packet source and carries no
 *      verification class, no as-of date and no client scope. The prompt renders
 *      it inside the untrusted-content spotlight and says so explicitly, and it
 *      never enters the Message Plan's supportedClaims. That is the whole reason
 *      this is a separate concept from `writing_guidance` context refs, which DO
 *      go through the context resolver.
 *   3. **User-authored only.** The reasoning model may not propose these
 *      commands (see OUTREACH_USER_AUTHORED_COMMAND_TYPES) — a model inventing
 *      "an example of how you write" is a fabricated exemplar whose voice the
 *      user's own drafts would then imitate.
 */
export const OUTREACH_STYLE_SAMPLE_LIMITS = Object.freeze({
  /** Bounded so a campaign spec cannot be inflated past campaignSpecBytes. */
  maxSamples: 5,
  label: 160,
  subject: 500,
  body: 20_000,
});

const FORBIDDEN_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function boundedText(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((value) => !FORBIDDEN_CONTROL_CHARACTERS.test(value), {
      message: 'Text contains disallowed control characters.',
    });
}

/** What the browser (or a command author) submits. No derived fields. */
export const outreachStyleSampleInputV1Schema = z
  .object({
    label: boundedText(OUTREACH_STYLE_SAMPLE_LIMITS.label).nullable(),
    subject: boundedText(OUTREACH_STYLE_SAMPLE_LIMITS.subject).nullable(),
    body: boundedText(OUTREACH_STYLE_SAMPLE_LIMITS.body, 1),
  })
  .strict();

/** What canonical Campaign Spec stores: the input plus its derived key. */
export const outreachStyleSampleV1Schema = outreachStyleSampleInputV1Schema
  .extend({ sampleKey: boundedText(128, 1) })
  .strict();

export type OutreachStyleSampleInputV1 = z.infer<typeof outreachStyleSampleInputV1Schema>;
export type OutreachStyleSampleV1 = z.infer<typeof outreachStyleSampleV1Schema>;

function normalizeMultiline(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function normalizeSingleLine(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\r\n?/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.length === 0 ? null : normalized;
}

/**
 * The identity of a sample is its CONTENT, not its label.
 *
 * Renaming a sample must not orphan the key the user's Remove button holds, and
 * two identically-worded examples filed under different labels are the same
 * exemplar as far as the model is concerned.
 */
export function styleSampleKeyFor(input: { subject: string | null; body: string }): string {
  const canonical = JSON.stringify({
    subject: normalizeSingleLine(input.subject),
    body: normalizeMultiline(input.body),
  });
  return `sample:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function normalizeStyleSampleInputV1(input: unknown): OutreachStyleSampleInputV1 {
  const parsed = outreachStyleSampleInputV1Schema.parse(input);
  const body = normalizeMultiline(parsed.body);
  if (!body) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.too_small,
        minimum: 1,
        type: 'string',
        inclusive: true,
        path: ['body'],
        message: 'An example email needs a body.',
      },
    ]);
  }
  return {
    label: normalizeSingleLine(parsed.label),
    subject: normalizeSingleLine(parsed.subject),
    body,
  };
}

export function resolveStyleSampleV1(input: unknown): OutreachStyleSampleV1 {
  const normalized = normalizeStyleSampleInputV1(input);
  return { ...normalized, sampleKey: styleSampleKeyFor(normalized) };
}

/**
 * Canonical stored ordering is INSERTION order, deduped by `sampleKey`, not
 * sorted.
 *
 * Every other list in the Campaign Spec sorts by its derived key because those
 * lists are sets whose order carries no meaning. Few-shot exemplar order is read
 * by the model, and the user chose it — so here the order IS part of the state.
 * That keeps the spec content-addressed (the same list always hashes the same)
 * while "example 1, then example 2" survives a round trip.
 */
export function normalizeStyleSamplesV1(
  values: readonly OutreachStyleSampleV1[],
): OutreachStyleSampleV1[] {
  const byKey = new Map<string, OutreachStyleSampleV1>();
  for (const value of values) {
    // Project onto the CONTENT fields before re-resolving. These values already
    // carry a `sampleKey`, and the input schema is strict precisely so a command
    // payload cannot supply one — so the stored key is dropped here and re-derived
    // from the content. That is what makes a stored key impossible to forge: it is
    // recomputed on every normalization rather than trusted once on the way in.
    const resolved = resolveStyleSampleV1({
      label: value.label,
      subject: value.subject,
      body: value.body,
    });
    if (!byKey.has(resolved.sampleKey)) byKey.set(resolved.sampleKey, resolved);
  }
  return [...byKey.values()].slice(0, OUTREACH_STYLE_SAMPLE_LIMITS.maxSamples);
}
