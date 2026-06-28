/**
 * Client anonymization (Phase 6 / handoff §12.13). When a draft has
 * config.anonymize=true, the client name + any office names are replaced with
 * neutral placeholders before the text leaves the editor (preview/export) and
 * before it is sent to the model as context. Deterministic + reversible map so
 * the UI can show a legend ("[CLIENT] = Aerovance Systems").
 */

export interface AnonymizeMap {
  // placeholder -> original
  legend: Record<string, string>;
}

export interface AnonymizeResult {
  text: string;
  map: AnonymizeMap;
}

/** Escape a string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a whole-word matcher for a needle. Adds \b only on edges that are word
 * characters, so a short token (e.g. an acronym) never redacts a substring
 * inside a larger word (E-15: "too broad" over-redaction).
 */
function boundaryRegExp(needle: string, flags = 'gi'): RegExp {
  const esc = escapeRegExp(needle);
  const left = /^\w/.test(needle) ? '\\b' : '';
  const right = /\w$/.test(needle) ? '\\b' : '';
  return new RegExp(`${left}${esc}${right}`, flags);
}

/**
 * Replace the client name and office names with placeholders. Longest names
 * first so a containing name (e.g. "Acme Defense Systems") is replaced before
 * a substring ("Acme"). Case-insensitive, whole-token.
 */
export function anonymizeText(
  text: string,
  opts: { client?: string | null; offices?: string[] },
): AnonymizeResult {
  const legend: Record<string, string> = {};
  let out = text;

  const targets: { value: string; placeholder: string }[] = [];
  if (opts.client && opts.client.trim()) {
    targets.push({ value: opts.client.trim(), placeholder: '[CLIENT]' });
  }
  (opts.offices ?? []).forEach((office, i) => {
    if (office && office.trim()) {
      targets.push({ value: office.trim(), placeholder: `[OFFICE_${i + 1}]` });
    }
  });

  // Longest first to avoid partial-token clobbering.
  targets.sort((a, b) => b.value.length - a.value.length);

  for (const t of targets) {
    const re = boundaryRegExp(t.value);
    if (re.test(out)) {
      out = out.replace(boundaryRegExp(t.value), t.placeholder);
      legend[t.placeholder] = t.value;
    }
  }

  return { text: out, map: { legend } };
}

/** Reverse an anonymization using its legend (for de-anonymized export). */
export function deanonymizeText(text: string, map: AnonymizeMap): string {
  let out = text;
  for (const [placeholder, original] of Object.entries(map.legend)) {
    out = out.split(placeholder).join(original);
  }
  return out;
}

/**
 * Apply a reviewed redaction map (from the Anonymize review modal) to a string.
 * Each redaction maps a literal name to its chosen prose replacement. Longest
 * names first to avoid partial-token clobbering. Scope is honored at the field
 * level by the caller for "this mention only"; here every supplied redaction is
 * applied globally (the caller filters to the in-scope set when needed).
 */
export function applyRedactions(
  text: string,
  redactions: Array<{ from: string; to: string }>,
): string {
  let out = text;
  const sorted = [...redactions].sort((a, b) => b.from.length - a.from.length);
  for (const r of sorted) {
    if (!r.from || !r.to || r.from === r.to) continue;
    if (r.from.trim().length < 3) continue; // never redact 1–2 char fragments
    // Whole-word, case-insensitive: matches the modal's occurrence count without
    // redacting substrings inside larger words.
    out = out.replace(boundaryRegExp(r.from), r.to);
  }
  return out;
}

// ── Detection (Anonymize review modal) ───────────────────────────────────────

export type DetectionKind = 'client' | 'office' | 'program';

export interface NameDetection {
  /** The detected literal name. */
  from: string;
  kind: DetectionKind;
  /** Default prose placeholder (NOT a bracket token): "the client" etc. */
  suggested: string;
  /** How many times it appears across the supplied corpus. */
  occurrences: number;
  /**
   * 'high' = a structured client/product/office name (trustworthy, pre-checked
   * in the review modal); 'low' = a heuristically-mined proper noun (pre-checked
   * OFF so the user opts IN — avoids the "everything became the program" bug).
   */
  confidence: 'high' | 'low';
}

/** Default prose replacement for a detection kind. */
export function genericFor(kind: DetectionKind): string {
  switch (kind) {
    case 'client':
      return 'the client';
    case 'office':
      return 'the office';
    case 'program':
      return 'the program';
  }
}

/** Strip simple HTML tags so detection counts run against prose, not markup. */
function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ');
}

function countOccurrences(corpus: string, needle: string): number {
  if (!needle.trim()) return 0;
  return (corpus.match(boundaryRegExp(needle.trim())) ?? []).length;
}

/**
 * Heuristically pull program/product proper-noun phrases out of the title +
 * section bodies: runs of Capitalized / ALL-CAPS / alphanumeric-coded tokens
 * (e.g. "JaiaBot HYDRO", "PE 0603270A"). Used to surface program names the
 * structured client/office fields don't carry. Tokens already covered by the
 * structured names are filtered out by the caller.
 */
function extractProgramNames(corpus: string): string[] {
  const found = new Map<string, true>();
  // Capitalized / mixed-case / coded multi-token runs, 1–4 words.
  const re = /\b([A-Z][A-Za-z0-9]+(?:[ -][A-Z0-9][A-Za-z0-9]*){0,3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(corpus)) !== null) {
    const phrase = m[1]!.trim();
    const multiToken = /[ -]/.test(phrase);
    const hasDigit = /\d/.test(phrase); // coded designator e.g. "PE 0603270A"
    if (phrase.length < 4) continue;
    // Require a coded token (digit) OR a multi-word proper run. Lone Title-Case
    // words and bare acronyms (DOD, GAO, FY2026…) are the dominant false-
    // positive source (E-15 "incorrect identifications") — drop them.
    if (!hasDigit && !multiToken) continue;
    const low = phrase.toLowerCase();
    if (STOP_PHRASES.has(low)) continue;
    if (ACRONYM_STOP.has(phrase.toUpperCase())) continue;
    // Drop phrases whose every token is a generic/heading word ("Executive
    // Summary", "Fiscal Year", "Defense Department").
    const tokens = low.split(/[ -]+/).filter(Boolean);
    if (tokens.length > 0 && tokens.every((t) => STOP_WORDS.has(t))) continue;
    found.set(phrase, true);
  }
  return [...found.keys()];
}

// Headings / section phrases that look proper-noun-ish but aren't programs.
const STOP_PHRASES = new Set([
  'executive summary',
  'background',
  'the program',
  'the client',
  'the office',
  'funding history',
  'budget request',
  'fiscal year',
  'cover letter',
  'next steps',
  'request',
  'recommendation',
  'introduction',
  'overview',
  'talking points',
  'key facts',
  'national security',
  'problem statement',
  'program description',
]);

// Agency / committee / budget acronyms that are NOT the client's program.
const ACRONYM_STOP = new Set([
  'DOD',
  'DOE',
  'DON',
  'GAO',
  'OMB',
  'CBO',
  'CRS',
  'FY',
  'US',
  'USA',
  'USC',
  'NDAA',
  'HASC',
  'SASC',
  'HAC',
  'SAC',
  'COCOM',
  'DOJ',
  'DHS',
  'NASA',
  'EPA',
  'VA',
  'HHS',
  'FAA',
  'FDA',
  'NIH',
  'NSF',
  'PE',
  'UPL',
  'UFR',
  'R&D',
]);

// Generic tokens used to drop all-generic phrases (every token must be generic).
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'program',
  'client',
  'office',
  'summary',
  'executive',
  'background',
  'introduction',
  'overview',
  'request',
  'recommendation',
  'section',
  'fiscal',
  'year',
  'budget',
  'funding',
  'history',
  'committee',
  'subcommittee',
  'congress',
  'senate',
  'house',
  'federal',
  'national',
  'defense',
  'department',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'problem',
  'statement',
  'description',
]);

/**
 * Detect anonymization candidates for the review modal. Sources:
 *  - client name (cfg.client / draft.client)         → kind "client"
 *  - office names (cfg.offices[])                     → kind "office"
 *  - program/product names from the title + sections  → kind "program"
 * Occurrence counts are computed across title + all section bodies so the modal
 * can offer "All occurrences" vs "This mention only". The product name is
 * always offered as a program candidate (it's the most common direct reference).
 */
export function detectNames(opts: {
  client?: string | null;
  product?: string | null;
  offices?: string[];
  title?: string | null;
  sectionTexts?: string[];
}): NameDetection[] {
  const corpus = [opts.title ?? '', ...(opts.sectionTexts ?? []).map(stripHtml)]
    .filter(Boolean)
    .join('\n');

  const out: NameDetection[] = [];
  const seen = new Set<string>();
  const push = (
    from: string | null | undefined,
    kind: DetectionKind,
    confidence: 'high' | 'low' = 'high',
  ) => {
    const name = (from ?? '').trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      from: name,
      kind,
      suggested: genericFor(kind),
      // At least 1 so a name present only in structured config still appears.
      occurrences: Math.max(1, countOccurrences(corpus, name)),
      confidence,
    });
  };

  // Structured fields = high confidence (pre-checked in the modal).
  push(opts.client, 'client', 'high');
  push(opts.product, 'program', 'high');
  for (const office of opts.offices ?? []) push(office, 'office', 'high');

  // Heuristically-mined proper nouns = LOW confidence (pre-checked OFF), skipping
  // anything already surfaced via the structured fields.
  for (const phrase of extractProgramNames(corpus)) {
    if (countOccurrences(corpus, phrase) < 1) continue;
    push(phrase, 'program', 'low');
  }

  // Longest names first (review-card ordering mirrors apply-order priority).
  return out.sort((a, b) => b.from.length - a.from.length);
}
