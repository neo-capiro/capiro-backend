/**
 * VERSIONED anonymization for feedback that leaves the conversation and becomes
 * evaluation material.
 *
 * WHY THIS EXISTS. `exportFeedbackForEvaluation` shipped a raw 1200-character
 * `responseExcerpt` straight out of `clio_message.body` — an un-anonymized slab of
 * a real client conversation, handed to whoever runs the export, with no review
 * step and no record of what redaction (if any) had been applied.
 * `reviewFeedbackFixtureCandidate` already refuses to accept a fixture without an
 * `anonymizationVersion`; this is the thing that produces one.
 *
 * DESIGN
 * - The VERSION is part of the output and is stored on the row. A future redaction
 *   improvement bumps the version, so an old fixture is never silently claimed to
 *   have been redacted by rules that did not exist when it was made.
 * - Redaction is DENY-BY-DEFAULT for the shapes that carry identity: named client
 *   and office strings supplied by the caller, then emails, phone numbers, URLs,
 *   dollar amounts, and long digit runs. Dollar amounts matter because a figure is
 *   frequently the identifying detail in this domain.
 * - The output is a bounded EXCERPT, not the body. Reviewers need enough to judge
 *   whether the answer was wrong; they do not need the conversation.
 * - Pure and synchronous, so it is trivially testable and cannot fail a request.
 */

export const FEEDBACK_ANONYMIZATION_VERSION = 'feedback-anon-v1';

export interface AnonymizedExcerpt {
  text: string;
  anonymizationVersion: string;
  /** Count per placeholder, so a reviewer can see how heavily redacted it is. */
  redactions: Record<string, number>;
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-token matcher. `\b` is added only on edges that are word characters, so a
 * short name or acronym never redacts a substring inside a longer word — the
 * over-redaction failure the workspace anonymizer already learned to avoid.
 */
function boundaryRegExp(needle: string): RegExp {
  const escaped = escapeRegExp(needle);
  const left = /^\w/.test(needle) ? '\\b' : '';
  const right = /\w$/.test(needle) ? '\\b' : '';
  return new RegExp(`${left}${escaped}${right}`, 'gi');
}

const PATTERNS: ReadonlyArray<{ placeholder: string; re: RegExp }> = [
  { placeholder: '[EMAIL]', re: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { placeholder: '[URL]', re: /https?:\/\/\S+/gi },
  // Phone before the generic digit run, so a formatted number becomes [PHONE].
  { placeholder: '[PHONE]', re: /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g },
  // Dollar figures: in this domain the number IS often the identifying detail.
  {
    placeholder: '[AMOUNT]',
    re: /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:million|billion|thousand|[MBK])?/gi,
  },
  // Any remaining run of 5+ digits (ids, account numbers, ZIP+4).
  { placeholder: '[NUMBER]', re: /\b\d{5,}\b/g },
];

/**
 * Produce a bounded, redacted excerpt of a response body.
 *
 * `names` are the caller-known identifying strings (client name, office names).
 * They are replaced LONGEST FIRST so a containing name is redacted before one of
 * its substrings.
 */
export function anonymizeFeedbackExcerpt(
  body: string,
  options: { names?: ReadonlyArray<string | null | undefined>; maxChars?: number } = {},
): AnonymizedExcerpt {
  const redactions: Record<string, number> = {};
  const bump = (placeholder: string, count: number): void => {
    if (count > 0) redactions[placeholder] = (redactions[placeholder] ?? 0) + count;
  };

  let text = String(body ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  const names = [...new Set((options.names ?? []).filter((n): n is string => !!n && !!n.trim()))]
    .map((n) => n.trim())
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    const re = boundaryRegExp(name);
    const matches = text.match(re);
    if (matches?.length) {
      bump('[CLIENT]', matches.length);
      text = text.replace(re, '[CLIENT]');
    }
  }
  for (const { placeholder, re } of PATTERNS) {
    const matches = text.match(re);
    if (matches?.length) {
      bump(placeholder, matches.length);
      text = text.replace(re, placeholder);
    }
  }

  // Bounded AFTER redaction, so truncation can never expose something the
  // redaction pass would have caught later in the string.
  const max = Math.min(Math.max(options.maxChars ?? 600, 80), 1000);
  if (text.length > max) text = `${text.slice(0, max)}…`;
  return { text, anonymizationVersion: FEEDBACK_ANONYMIZATION_VERSION, redactions };
}
