/**
 * Pure helpers for the DoW-Directory org-graph import (scripts/import-dow-orgs.ts).
 * Extracted so the quality gate is unit-testable against real directory samples —
 * the org strings come from PDF text segmentation and include person-name bleed,
 * prose fragments, and truncations that must NEVER become program_office rows.
 */

/** Honorific / rank prefixes that mark a PERSON string, not an office. */
const RANK_PREFIX =
  /^(COL|LTC|LTG|MAJ|GEN|BG|MG|CPT|CAPT|CDR|RDML|RADM|VADM|ADM|SGT|CSM|SES|CW[0-9]|Mr\.?|Ms\.?|Mrs\.?|Dr\.?|Hon\.?|Lt\.?|Col\.?|Brig\.?|Maj\.?|Gen\.?)\s/i;

/** A name must carry (or be) one of these to be an office without headcount support. */
const OFFICE_KEYWORD =
  /\b(PEO|JPEO|DPEO|PAE|CPE|JPM|Office|Command|Directorate|Agency|Center|Centre|Division|Program|Executive|Secretariat|Headquarters|Laboratory|Corps|Force|Department|Bureau|Board|Activity|Group|Wing|Fleet|Systems|School|Institute|Arsenal|Depot|Service)\b/i;

/**
 * Generic single-word org labels — real offices are never JUST this word.
 * ("Directorate" appears 60x in the directory as a truncated heading.)
 */
const GENERIC_BARE = new Set(
  [
    'directorate', 'office', 'command', 'division', 'center', 'centre', 'agency',
    'department', 'headquarters', 'program', 'group', 'board', 'bureau', 'activity',
    'staff', 'service', 'services', 'systems', 'leadership', 'organization',
  ],
);

/** Prose tells: sentence fragments from paragraph text, never org names. */
const PROSE_PATTERNS = [
  /subordinate to/i,
  /responsible for/i,
  /starting on page/i,
  /\bversus\b/i,
  /\bby extension\b/i,
  /\bsee (also|page)\b/i,
  /\bfor (meteorology|more|additional)\b/i,
  // verb-phrase fragments lifted from paragraphs ("X operates the ...", "CPE ES2
  // has four portfolios", "Engineers reports to ...", "... is the current ...")
  /\b(operates|manages|provides|oversees|includes|consists of|serves as|reports to|under a|was the)\b/i,
  /\b(is|are) (the|a|an)\b/i,
  /\b(has|have) (a|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i,
  /^duties of/i,
  /^rev\s*\d+$/i, // document-revision artifact ("Rev 6")
  /^\d+\s/, // counting prose ("13 Capability Program Executives")
  /www\.|https?:/i, // URLs are never office names
  /\bcontribution to\b/i, // "Air Force's contribution to CJADC2 ..."
  /\b\w+-based (model|approach|structure)\b/i, // "PEO-based model"
  /\s[—–•·]\s/, // em-dash/bullet separators = layout fragments, not names
];

/**
 * Defense contractors / consultancies: real entities, but they belong in the
 * performer/company space — NEVER in program_office (government org graph).
 */
const KNOWN_COMPANIES =
  /\b(Lockheed|Raytheon|RTX|Boeing|Northrop|BAE Systems|General Dynamics|L3Harris|Anduril|Palantir|SAIC|Leidos|Booz|Accenture|Deloitte|Huntington Ingalls|Textron|Sierra Nevada|Kratos|Maxar|Peraton|CACI|MITRE(?! Corporation FFRDC)|Amentum|Jacobs|KBR|Oshkosh|AeroVironment|Shield AI|Systems Planning and Analysis)\b/i;

/** True when parentheses are balanced (fragments like "Combat Command)" fail). */
function hasBalancedParens(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Strip zero-width chars, mangled-encoding artifacts, markdown bleed, trailing punctuation. */
export function cleanOrgName(raw: string): string {
  return raw
    .replace(/[​‌‍﻿™®]/g, '')
    .replace(/^\s*#+\s*/, '') // markdown-heading bleed from the parse
    .replace(/\s*[:?.,;|]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Quality gate: is this cleaned string a real office name?
 * peopleCount = how many directory people list it as their org (corroboration).
 */
export function isCleanOffice(name: string, peopleCount: number): boolean {
  if (name.length < 3 || name.length > 90) return false;
  if (RANK_PREFIX.test(name)) return false; // person-name bleed
  if (/^[a-z]/.test(name)) return false; // prose fragment starts lowercase
  if (GENERIC_BARE.has(name.toLowerCase())) return false; // bare generic heading
  if (PROSE_PATTERNS.some((rx) => rx.test(name))) return false;
  if (KNOWN_COMPANIES.test(name)) return false; // contractors live in performer space
  if (/\b(of|to|for|and|the|by|in|with|or)$/i.test(name)) return false; // truncated
  if ((name.match(/\. /g) ?? []).length >= 2) return false; // multi-sentence prose
  if ((name.match(/,/g) ?? []).length >= 3) return false; // list-like prose
  if (/[?]/.test(name)) return false; // unresolved mangled character mid-string
  if (!hasBalancedParens(name)) return false; // fragment ("Combat Command)")
  return OFFICE_KEYWORD.test(name) || peopleCount >= 3;
}

/** Map an office name to the ProgramOffice.officeType vocabulary. */
export function classifyOfficeType(name: string): string {
  if (/\bPAE\b/i.test(name)) return 'pae';
  if (/\b(J?PEO|DPEO|Program Executive)\b/i.test(name)) return 'peo';
  if (/\bCPE\b/i.test(name)) return 'cpe';
  if (/^(PM|JPM|Product Manager|Project Manager|Program Manager)\b/i.test(name)) return 'pm';
  if (/\bContracting\b/i.test(name)) return 'contracting_office';
  if (/\bCommand\b/i.test(name)) return 'command';
  if (/\bDirectorate\b/i.test(name)) return 'directorate';
  return 'other';
}

/** Directory role labels -> PersonRole.roleType vocabulary. */
export const DOW_ROLE_MAP: Record<string, string> = {
  PEO: 'peo',
  PM: 'pm',
  DPM: 'pm',
  APM: 'pm',
  DEP_DIRECTOR: 'deputy',
  CE: 'chief_engineer',
  KO: 'contracting_officer',
  DIRECTOR: 'other',
  SECRETARY: 'other',
  OTHER: 'other',
};

/** Normalize a directory service string to the platform's service codes. */
export function normalizeDowService(s: string | null | undefined): string | null {
  const v = (s ?? '').trim().toUpperCase();
  if (!v) return null;
  if (v.startsWith('ARMY')) return 'ARMY';
  if (v.startsWith('NAVY')) return 'NAVY';
  if (v.includes('MARINE')) return 'USMC';
  if (v.includes('SPACE')) return 'SF';
  if (v.includes('AIR')) return 'AF';
  return v.length <= 8 ? v : 'DW';
}
