/**
 * Client organization hierarchy — title inference and structural validation
 * (Client CRM vNext, Figma `906:2790` and `907:3028`).
 *
 * Two rules govern everything here:
 *
 *   1. **Manual placement always wins.** Inference never overwrites a row whose
 *      `placementSource` is `manual`, and clearing a manual placement is an
 *      explicit act, not a side effect of an edited title.
 *   2. **An unmatched title is not level "team".** It is `reviewRequired` with
 *      no level, because guessing the bottom of the org chart for every title
 *      the rule set does not know is indistinguishable from knowing.
 */

export const HIERARCHY_LEVELS = [
  'executive',
  'c_suite',
  'senior_leadership',
  'leadership',
  'management',
  'team',
] as const;
export type HierarchyLevel = (typeof HIERARCHY_LEVELS)[number];

export type PlacementSource = 'auto_title' | 'manual';

export function isHierarchyLevel(value: unknown): value is HierarchyLevel {
  return typeof value === 'string' && (HIERARCHY_LEVELS as readonly string[]).includes(value);
}

/** Rank for ordering and for "reports to someone more senior" sanity checks. */
export function levelRank(level: HierarchyLevel): number {
  return HIERARCHY_LEVELS.indexOf(level);
}

interface LevelRule {
  level: HierarchyLevel;
  /** Matched against the lower-cased title as whole words/phrases. */
  patterns: RegExp[];
  confidence: number;
}

/**
 * "Corporate standard v3" — the default rule set named in the design. Ordered
 * most-senior first so the first match wins; a "VP of Operations, Ops Manager"
 * style compound title resolves to the more senior reading, which is what a
 * human reader does too.
 */
const RULES: LevelRule[] = [
  {
    level: 'executive',
    // `president` must not fire on "Vice President" or "Deputy President" —
    // that near-miss is exactly why EVP/SVP have their own band below.
    patterns: [
      /\bchief executive officer\b/,
      /\bceo\b/,
      /(?<!vice )(?<!deputy )\bpresident\b/,
      /\bfounder\b/,
      /\bco-?founder\b/,
      /\bowner\b/,
      /\bmanaging partner\b/,
    ],
    confidence: 0.95,
  },
  {
    level: 'c_suite',
    patterns: [/\bchief [a-z ]{2,30} officer\b/, /\bcoo\b/, /\bcfo\b/, /\bcto\b/, /\bcio\b/, /\bciso\b/, /\bcmo\b/, /\bcgao\b/, /\bchief of staff\b/],
    confidence: 0.9,
  },
  {
    level: 'senior_leadership',
    patterns: [/\bexecutive vice president\b/, /\bsenior vice president\b/, /\bevp\b/, /\bsvp\b/, /\bgeneral counsel\b/, /\bhead of\b/],
    confidence: 0.85,
  },
  {
    level: 'leadership',
    patterns: [/\bvice president\b/, /\bvp\b/, /\bdirector\b/, /\bpartner\b/, /\bprincipal\b/],
    confidence: 0.8,
  },
  {
    level: 'management',
    patterns: [/\bsenior manager\b/, /\bmanager\b/, /\bsupervisor\b/, /\blead\b/, /\bforeman\b/],
    confidence: 0.75,
  },
  {
    level: 'team',
    patterns: [/\bassociate\b/, /\banalyst\b/, /\bcoordinator\b/, /\bspecialist\b/, /\bengineer\b/, /\bcounsel\b/, /\bconsultant\b/, /\badvisor\b/, /\brepresentative\b/, /\bassistant\b/],
    confidence: 0.7,
  },
];

export interface InferredPlacement {
  level: HierarchyLevel | null;
  confidence: number | null;
  reviewRequired: boolean;
}

/**
 * Infer a level from a title.
 *
 * Returns `reviewRequired` when the title is missing, unmatched, or matches
 * more than one level at materially different seniorities — the "ambiguous
 * title" case the contract names.
 */
export function inferPlacementFromTitle(title: string | null | undefined): InferredPlacement {
  // Periods are DELETED rather than replaced with a space, so "V.P." reads as
  // "vp" and matches the initialism; turning them into spaces produced "v p",
  // which matched nothing.
  const normalized = (title ?? '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[,/&+|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return { level: null, confidence: null, reviewRequired: true };
  }

  const matches = RULES.filter((rule) => rule.patterns.some((pattern) => pattern.test(normalized)));
  const first = matches[0];
  if (!first) {
    // Unknown title: explicitly unplaced and flagged, never silently "team".
    return { level: null, confidence: null, reviewRequired: true };
  }

  // Two matches more than one band apart means the title is genuinely mixed
  // ("VP and Senior Analyst") — take the senior reading but ask for a human.
  const last = matches[matches.length - 1]!;
  const ambiguous = levelRank(last.level) - levelRank(first.level) > 1;

  return {
    level: first.level,
    confidence: ambiguous ? Math.min(first.confidence, 0.5) : first.confidence,
    reviewRequired: ambiguous,
  };
}

export interface HierarchyNode {
  id: string;
  reportsToPersonId: string | null;
}

/**
 * True when setting `personId.reportsTo = managerId` would create a cycle.
 *
 * Walks up from the proposed manager: if the person being edited is anywhere on
 * that chain, the edge closes a loop. Also guards against a pre-existing cycle
 * in the data by bounding the walk to the node count.
 */
export function wouldCreateCycle(
  people: readonly HierarchyNode[],
  personId: string,
  managerId: string | null,
): boolean {
  if (!managerId) return false;
  if (managerId === personId) return true;

  const parentOf = new Map(people.map((person) => [person.id, person.reportsToPersonId]));
  let cursor: string | null = managerId;
  for (let hops = 0; hops <= people.length; hops += 1) {
    if (cursor == null) return false;
    if (cursor === personId) return true;
    cursor = parentOf.get(cursor) ?? null;
  }
  // Ran past the node count — the existing chain already loops. Refuse rather
  // than write another edge into a structure that is already broken.
  return true;
}

/** Ids that are still reachable, so a stale reports-to can be detected. */
export function danglingManagerIds(people: readonly HierarchyNode[]): string[] {
  const ids = new Set(people.map((person) => person.id));
  return [
    ...new Set(
      people
        .map((person) => person.reportsToPersonId)
        .filter((id): id is string => Boolean(id) && !ids.has(id as string)),
    ),
  ];
}
