/**
 * Detect chat messages that are really requests to build a deliverable
 * report/brief — the shape that should run through the enforced Deep Research
 * pipeline (`MeriResearchService`, which loads the strict `research`-surface
 * grounding block and can HOLD an ungrounded report) instead of the ordinary,
 * observe-only chat tool loop.
 *
 * Why this exists: the "Immobileyes report" incident (2026-07-15) was a full
 * federal deliverable — 15 Program Elements, a legislative tracker, an
 * acquisition-personnel map — typed straight into normal chat, where nothing
 * enforces grounding. The user never flipped the "Deep research" toggle, so the
 * ask ran loosely-grounded and fabricated PE titles/budgets, bill identities,
 * and officials. Server-side detection catches that class regardless of whether
 * the user knew the toggle existed.
 *
 * Design goal: PRECISION over recall. A false positive merely offers to run
 * Deep Research (a non-destructive, dismissible suggestion); we would rather
 * under-trigger and leave a borderline ask in chat than hijack ordinary
 * conversation. The detector is a pure, deterministic function of the message
 * text — no LLM call — so it is cheap enough to run on the chat hot path before
 * any routing decision.
 */

export interface ReportRequestDetection {
  /** The user's message, to seed the Deep Research session topic. */
  topic: string;
  /** Short human-readable reason, surfaced in the promote affordance. */
  reason: string;
}

/** Minimum word count — very short messages are never deliverable-report asks. */
const MIN_WORDS = 8;

/** Explicit "produce a deliverable" verbs. */
const BUILD_VERB = '(?:build|create|generate|produce|prepare|compile|put together|draft|write)';

/**
 * Report/brief deliverable nouns. Deliberately EXCLUDES email/letter/one-pager
 * (outreach), memo (alert-memo flow), and bare "analysis"/"overview" (too broad,
 * they collide with quick analyze_bill / summary asks).
 */
const REPORT_NOUN = '(?:report|briefing|brief|white ?paper|dossier|assessment|deep[ -]?dive)';

/**
 * Build verb adjacent to (within ~40 chars of) a report noun — the co-occurrence
 * requirement avoids matching "I read a report, can you find…". Non-greedy gap.
 */
const BUILD_REPORT_ADJACENCY = new RegExp(
  BUILD_VERB + '\\b[\\s\\S]{0,40}?\\b' + REPORT_NOUN + '\\b',
  'i',
);

/** Comprehensiveness qualifier — signals a real deliverable, not a one-liner. */
const SCOPE_QUALIFIER =
  /\b(full|detailed|comprehensive|in-?depth|thorough|complete|end-to-end|multi-(?:section|part)|exhaustive|robust)\b/i;

/** Multi-entity / survey shape — "every X", "all the Ys", "across …", "compare …". */
const MULTI_ENTITY = /\b(all|every|each|any and all|across|compare|landscape|survey of)\b/i;

/** Edit/revision to existing content — belongs in chat, not a fresh report. */
const EDIT_VERB =
  /\b(edit|revise|rewrite|reword|tighten|shorten|fix|tweak|update|polish|expand)\b/i;
const BACK_REFERENCE =
  /\b(this|that|it|above|the (?:draft|report|memo|brief|doc|document|section|version))\b/i;

/**
 * Explicit single-file document-generation ("make me a word doc of X") — these
 * already have the create_word/create_excel/create_powerpoint path; don't divert
 * them to Deep Research unless a report noun is also present.
 */
const SINGLE_FILE_DOCGEN =
  /\b(word doc(?:ument)?|\.docx|\.xlsx|\.pptx|excel|powerpoint|spreadsheet|slide ?deck)\b/i;

/**
 * Returns a detection when `content` is a high-confidence request to build a
 * deliverable report/brief, else null (stay in chat). Pure and deterministic.
 */
export function detectDeliverableReportRequest(content: string): ReportRequestDetection | null {
  const text = (content ?? '').trim();
  if (!text) return null;
  if (text.split(/\s+/).length < MIN_WORDS) return null;

  const lower = text.toLowerCase();

  // --- Negative filters (precision) ---
  // Edit/revise of existing content that back-references it.
  if (EDIT_VERB.test(lower) && BACK_REFERENCE.test(lower)) return null;
  // Single-file doc-gen with no report/brief noun.
  if (SINGLE_FILE_DOCGEN.test(lower) && !new RegExp(REPORT_NOUN, 'i').test(lower)) return null;

  // --- Positive requirements (all must hold) ---
  if (!BUILD_REPORT_ADJACENCY.test(text)) return null;
  if (!SCOPE_QUALIFIER.test(text) && !MULTI_ENTITY.test(text)) return null;

  return {
    topic: text.slice(0, 4000),
    reason:
      'This reads as a full report or brief — Deep Research grounds and verifies every claim.',
  };
}
