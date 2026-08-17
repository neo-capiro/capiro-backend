/**
 * Domain term expansion for intel matching.
 *
 * Bill subjects, CRS policy areas, and Federal Register topics are stored as full
 * English phrases ("Electronic warfare", "Artificial intelligence"), but lobbyists
 * tag clients with short acronyms ("EW", "AI"). Trigram, whole-word, and embedding
 * matching all miss that acronym↔phrase gap, so before matching we expand a curated,
 * high-precision set of defense/government acronyms to their canonical phrases.
 *
 * Direction is one-way (acronym → phrase): the corpus uses the phrase, so that is the
 * direction that improves recall. The map is intentionally conservative — ambiguous
 * tokens (e.g. "VA", "IT", "ED") are omitted to avoid false expansions. Extend it as
 * new client tags appear.
 */

/** Canonical acronym → phrase expansions. Keys are lowercase, exact-token. */
export const ACRONYM_EXPANSIONS: Record<string, string> = {
  ai: 'artificial intelligence',
  ml: 'machine learning',
  nlp: 'natural language processing',
  ew: 'electronic warfare',
  c2: 'command and control',
  jadc2: 'joint all domain command and control',
  c4isr: 'command control communications computers intelligence surveillance reconnaissance',
  c5isr: 'command control communications computers cyber intelligence surveillance reconnaissance',
  isr: 'intelligence surveillance and reconnaissance',
  uas: 'unmanned aircraft systems',
  uav: 'unmanned aerial vehicle',
  ugv: 'unmanned ground vehicle',
  usv: 'unmanned surface vehicle',
  pnt: 'positioning navigation and timing',
  ems: 'electromagnetic spectrum',
  gps: 'global positioning system',
  hpc: 'high performance computing',
  cbrn: 'chemical biological radiological and nuclear',
  sof: 'special operations forces',
  sbir: 'small business innovation research',
  sttr: 'small business technology transfer',
  rdte: 'research development test and evaluation',
  ndaa: 'national defense authorization act',
  dod: 'department of defense',
  dhs: 'department of homeland security',
  cyber: 'cybersecurity',
  // ── Expanded set: short defense/aerospace acronyms (< 4 chars) that would
  //    be dropped by MIN_KEYWORD_TOKEN_LENGTH without expansion. Longer tags
  //    like "hypersonics", "quantum", "darpa" are already kept as raw keyword
  //    tokens and trigram-matched directly — they don't need acronym expansion.
  'c-uas': 'counter unmanned aircraft systems',
  cuas: 'counter unmanned aircraft systems',
  bmd: 'ballistic missile defense',
  gmd: 'ground based midcourse defense',
  dew: 'directed energy weapons',
  emw: 'enterprise mission owner weapons',
  sda: 'space development agency',
  mda: 'missile defense agency',
  onr: 'office of naval research',
  nrl: 'naval research laboratory',
  ari: 'army research laboratory',
  peo: 'program executive office',
  pma: 'program management aircraft',
  mse: 'mission systems engineering',
  rmf: 'risk management framework',
  dat: 'data analytics technology',
  jam: 'joint advanced manufacturing',
  rpa: 'robotic process automation',
};

/**
 * Minimum length for a raw (unknown) token to be kept as a whole-word keyword
 * match term. Shorter tokens are dropped from the keyword path to avoid noise —
 * EXCEPT known acronyms (see {@link isKnownAcronym}), which are kept because their
 * expansion carries the real signal.
 */
export const MIN_KEYWORD_TOKEN_LENGTH = 4;

/** True when `token` (case-insensitive, trimmed) is a known, expandable acronym. */
export function isKnownAcronym(token: string): boolean {
  return Object.prototype.hasOwnProperty.call(ACRONYM_EXPANSIONS, token.trim().toLowerCase());
}

/**
 * Expand a list of terms with known acronym phrases. Originals are always
 * preserved; for any token that is a known acronym the canonical phrase is
 * appended. Result is de-duplicated case-insensitively and order-stable.
 */
export function expandTerms(terms: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const term of terms) {
    if (typeof term !== 'string') continue;
    push(term);
    const expansion = ACRONYM_EXPANSIONS[term.trim().toLowerCase()];
    if (expansion) push(expansion);
  }
  return out;
}
