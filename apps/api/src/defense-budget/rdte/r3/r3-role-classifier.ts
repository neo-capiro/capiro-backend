/**
 * r3-role-classifier — classify performer role from source text evidence.
 *
 * Workstream J (Phase 4 plan §15). Role policy:
 *   - Default: PERFORMING_ACTIVITY
 *   - PRIME_CONTRACTOR only when the source explicitly labels or states a
 *     contractor/prime role.
 *   - UNKNOWN when the role cannot be resolved.
 *   - A string that resembles a company name does NOT by itself prove
 *     prime-contractor status.
 *
 * Pure module.
 */
import type { PerformerRoleV1 } from '../../contracts/extraction-artifact-v1.js';

/** Patterns that explicitly state a prime-contractor role. */
const PRIME_CONTRACTOR_RE =
  /\b(?:prime\s+contractor|prime\s+contract|contractor\s+of\s+record|lead\s+contractor|awarded\s+to|contract\s+awarded\s+to)\b/i;

/** Patterns that explicitly state a government/organic performing activity. */
const GOVERNMENT_RE =
  /\b(?:government|army|navy|air\s+force|marines|space\s+force|dod|department\s+of|laboratory|lab|center|arsenal|institute|university|college|academy|facility|command|agency|office|bureau|depot|shipyard|proving\s+ground|test\s+range)\b/i;

/** Patterns that explicitly mark the performer as TBD/unknown. */
const UNKNOWN_RE = /^\s*(?:TBD|TBA|N\/A|unknown|various|multiple|MIPR|TBD\s*-\s*TBD)\s*$/i;

export interface RoleClassification {
  role: PerformerRoleV1;
  /** True when the role was determined from explicit source evidence. */
  explicit: boolean;
  /** The text evidence that determined the role. */
  evidence: string;
}

/**
 * Classify the performer role from the performing-activity text and any
 * surrounding context (e.g. section headers, row labels).
 *
 * The classifier is conservative: it defaults to PERFORMING_ACTIVITY and
 * only promotes to PRIME_CONTRACTOR when the source explicitly says so.
 */
export function classifyPerformerRole(input: {
  performerText: string;
  /** Additional context from the same row or section header. */
  contextText?: string;
}): RoleClassification {
  const { performerText } = input;
  const combined = `${performerText} ${input.contextText ?? ''}`.trim();

  if (UNKNOWN_RE.test(performerText)) {
    return { role: 'UNKNOWN', explicit: true, evidence: performerText };
  }

  if (PRIME_CONTRACTOR_RE.test(combined)) {
    return { role: 'PRIME_CONTRACTOR', explicit: true, evidence: combined };
  }

  if (GOVERNMENT_RE.test(performerText)) {
    return { role: 'PERFORMING_ACTIVITY', explicit: true, evidence: performerText };
  }

  /* Default: PERFORMING_ACTIVITY. A company name alone does NOT prove
   * prime-contractor status. */
  return { role: 'PERFORMING_ACTIVITY', explicit: false, evidence: performerText };
}
