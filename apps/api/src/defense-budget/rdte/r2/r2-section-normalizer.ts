/**
 * r2-section-normalizer — identify and normalize R-2 narrative section labels
 * from block text.
 *
 * Maps letter-prefixed headings (A., B., C., ...) and unlabeled headings to
 * canonical narrative categories defined by the Phase 1 contract
 * (NarrativeTypeV1). Handles malformed headings and unknown sections.
 *
 * Pure module.
 */
import type { NarrativeTypeV1 } from '../../contracts/extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface R2SectionLabel {
  /** Canonical narrative type from the Phase 1 vocabulary. */
  narrativeType: NarrativeTypeV1;
  /** Exact section label as printed in the source. */
  exactLabel: string;
  /** Letter prefix when present (e.g. 'A', 'B', 'C'). */
  letterPrefix?: string;
  /** True when the heading was recognized but malformed. */
  malformed: boolean;
}

/* ------------------------------------------------------------------ */
/* Section heading patterns                                            */
/* ------------------------------------------------------------------ */

/**
 * Matches a letter-prefixed section heading:
 *   "A. Mission Description and Budget Item Justification"
 *   "B. Accomplishments/Planned Programs"
 *   "C. Other Program Funding"
 *   "D. Acquisition Strategy"
 *   "E. Performance Metrics"
 */
const LETTER_HEADING_RE = /^\s*([A-Z])\.\s*(.+)$/;

/**
 * Known section-title → narrative-type mapping.
 * Keys are lowercase-normalized for case-insensitive matching.
 * Longest match wins to handle compound titles.
 */
const SECTION_TITLE_MAP: ReadonlyArray<readonly [string, NarrativeTypeV1]> = [
  ['mission description and budget item justification', 'mission'],
  ['mission description', 'mission'],
  ['budget item justification', 'mission'],
  ['description/rationale', 'description'],
  ['description', 'description'],
  ['rationale', 'rationale'],
  ['accomplishments/planned programs', 'accomplishments'],
  ['accomplishments', 'accomplishments'],
  ['planned programs', 'plans'],
  ['plans', 'plans'],
  ['schedule notes', 'schedule_notes'],
  ['schedule', 'schedule_notes'],
  ['performance metrics', 'other'],
  ['acquisition strategy', 'other'],
  ['other program funding', 'other'],
  ['program management', 'other'],
  ['technical', 'other'],
  ['risk', 'other'],
];

/**
 * Normalize a raw heading text into a canonical section label.
 *
 * Returns null when the text is not a recognized section heading.
 */
export function normalizeR2SectionLabel(rawText: string): R2SectionLabel | null {
  const trimmed = rawText.trim();
  if (trimmed === '') return null;

  /* Try letter-prefixed heading first. */
  const letterMatch = LETTER_HEADING_RE.exec(trimmed);
  if (letterMatch) {
    const letter = letterMatch[1]!;
    const title = letterMatch[2]!.trim();
    const mapped = mapTitleToNarrativeType(title);
    if (mapped != null) {
      return {
        narrativeType: mapped,
        exactLabel: trimmed,
        letterPrefix: letter,
        malformed: false,
      };
    }
    /* Letter prefix but unrecognized title — treat as 'other' with exact label. */
    return {
      narrativeType: 'other',
      exactLabel: trimmed,
      letterPrefix: letter,
      malformed: false,
    };
  }

  /* Try unlabeled heading (no letter prefix). */
  const mapped = mapTitleToNarrativeType(trimmed);
  if (mapped != null) {
    return {
      narrativeType: mapped,
      exactLabel: trimmed,
      malformed: false,
    };
  }

  return null;
}

/**
 * Check whether a text block looks like a section heading.
 * More permissive than normalizeR2SectionLabel — catches malformed headings.
 */
export function isLikelySectionHeading(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  if (LETTER_HEADING_RE.test(trimmed)) return true;
  /* Short lines that are all-caps or title-case and match known vocabulary. */
  if (trimmed.length < 120 && mapTitleToNarrativeType(trimmed) != null) return true;
  return false;
}

/**
 * Identify malformed headings — text that looks like it should be a heading
 * but doesn't parse cleanly.
 */
export function detectMalformedHeading(text: string): R2SectionLabel | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  /* Letter prefix but empty title. */
  const letterMatch = LETTER_HEADING_RE.exec(trimmed);
  if (letterMatch) {
    const title = letterMatch[2]!.trim();
    if (title === '') {
      return {
        narrativeType: 'other',
        exactLabel: trimmed,
        letterPrefix: letterMatch[1]!,
        malformed: true,
      };
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Internal                                                            */
/* ------------------------------------------------------------------ */

function mapTitleToNarrativeType(title: string): NarrativeTypeV1 | null {
  const lower = title
    .toLowerCase()
    .replace(/[^a-z0-9/\s]/g, '')
    .trim();
  /* Longest match first. */
  for (const [key, type] of SECTION_TITLE_MAP) {
    if (lower === key || lower.startsWith(key)) {
      return type;
    }
  }
  return null;
}
