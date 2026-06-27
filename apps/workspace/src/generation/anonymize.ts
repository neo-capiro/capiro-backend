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
    const re = new RegExp(escapeRegExp(t.value), 'gi');
    if (re.test(out)) {
      out = out.replace(re, t.placeholder);
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
    // Case-insensitive to match the modal's occurrence count (detectNames uses
    // 'gi') so every counted/approved mention is redacted on export.
    out = out.replace(new RegExp(escapeRegExp(r.from), 'gi'), r.to);
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
  const re = new RegExp(escapeRegExp(needle.trim()), 'gi');
  return (corpus.match(re) ?? []).length;
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
    // Skip lone short/common words; require either >1 token, a digit, or ALL-CAPS.
    const multiToken = /[ -]/.test(phrase);
    const hasDigit = /\d/.test(phrase);
    const allCaps = phrase === phrase.toUpperCase() && phrase.length >= 3;
    if (phrase.length < 4) continue;
    if (!multiToken && !hasDigit && !allCaps) continue;
    if (STOP_PHRASES.has(phrase.toLowerCase())) continue;
    found.set(phrase, true);
  }
  return [...found.keys()];
}

// Common heading/section phrases that look proper-noun-ish but aren't programs.
const STOP_PHRASES = new Set([
  'executive summary',
  'background',
  'the program',
  'the client',
  'funding history',
  'budget request',
  'fiscal year',
  'cover letter',
  'next steps',
  'request',
  'recommendation',
  'introduction',
  'overview',
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
  const push = (from: string | null | undefined, kind: DetectionKind) => {
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
    });
  };

  push(opts.client, 'client');
  push(opts.product, 'program');
  for (const office of opts.offices ?? []) push(office, 'office');

  // Program/product proper nouns mined from the prose, skipping anything we
  // already surfaced via the structured fields.
  for (const phrase of extractProgramNames(corpus)) {
    if (countOccurrences(corpus, phrase) < 1) continue;
    push(phrase, 'program');
  }

  // Longest names first (review-card ordering mirrors apply-order priority).
  return out.sort((a, b) => b.from.length - a.from.length);
}
