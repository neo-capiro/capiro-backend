/**
 * P0-07: alert evidence is WRITTEN in per-writer shapes (the bill-change detector
 * writes a flat object; the hearing and PE rails write nested ones) and READ by the
 * web as a nested, discriminated contract. Rather than teach every frontend consumer
 * every historical writer shape, normalize ONCE here, on read.
 *
 * READ-TIME ONLY. The stored JSON is frozen — writeShadowAlert's 14-day dedup queries
 * it by JSON path (bill-change-detector.service.ts:994-1001, `cutoffType`). Re-shaping
 * what is WRITTEN would re-fire every suppressed state-deadline alert.
 *
 * ADDITIVE on the wire: the `bill` / `hearing` / `programElement` / `link` keys the web
 * already reads keep their exact names and shapes, so no consumer breaks; `type`,
 * `schemaVersion`, `match`, and `provenance` are new.
 *
 * Pure — no I/O, no Date, no throw. A malformed `evidence` yields a valid object.
 */
import type { TermMatch } from '../watchlist/term-routing.js';

export const ALERT_EVIDENCE_SCHEMA_VERSION = 1;

export type NormalizedEvidenceType =
  | 'bill'
  | 'state_bill'
  | 'hearing'
  | 'combined'
  | 'regulation'
  | 'program_element'
  | 'unknown';

export interface NormalizedBill {
  billId: string;
  displayNum: string;
  title: string | null;
  url: string | null;
  stage: string;
  actionText: string | null;
  actionDate: string | null;
  jurisdiction?: string;
}
/**
 * §4.5 (Gate C phase d): the rule-change detector writes its regulation facts FLAT
 * (ruleTitle / agency / ruleType / commentEndDate alongside stage / actionText /
 * actionDate), exactly as the bill-change detector does. Synthesizing them into one
 * nested block is what lets a regulation memo be grounded in real facts instead of
 * digging them out of `extra` untyped.
 */
export interface NormalizedRegulation {
  ruleTitle: string | null;
  agency: string | null;
  ruleType: string | null;
  commentEndDate: string | null;
  stage: string;
  actionText: string | null;
  actionDate: string | null;
  url: string | null;
  jurisdiction?: string;
}
export interface NormalizedMatch {
  matchedTags: string[];
  termId: string | null;
  topicLabel: string | null;
  why: string | null;
  /**
   * Populated from Gate B's TermMatch when the writer recorded it; [] on a
   * row from before any writer did (Gate K, HP-01, made this non-empty for
   * the first time — bill-change-detector.service.ts's writeShadowAlert).
   * Widened to the full TermMatch shape (was missing termId/topicId) since
   * that is exactly what is now stored.
   */
  details: TermMatch[];
}
export interface NormalizedProvenance {
  /** The official source URL (congress.gov / LegiScan / Federal Register / committee). */
  sourceUrl: string | null;
  triggerKey: string | null;
  tone: string | null;
  band: string | null;
  jurisdiction: string;
  /** Which writer shape this row came from — for observability, never for UI branching. */
  writerShape: 'flat_bill' | 'nested' | 'mixed' | 'empty';
}
export interface NormalizedAlertEvidence {
  schemaVersion: number;
  type: NormalizedEvidenceType;
  bill?: NormalizedBill;
  hearing?: unknown; // passed through verbatim (already nested + decrypted)
  programElement?: unknown; // passed through verbatim (already nested)
  /** Nested verbatim when the writer nested it; synthesized from the flat rule writer otherwise. */
  regulation?: NormalizedRegulation | unknown;
  link?: unknown; // passed through verbatim
  match: NormalizedMatch;
  provenance: NormalizedProvenance;
  /** Every key from the stored object that this normalizer did not claim. Preserves
   *  event-specific `ev.extra` fields (tally, party splits, cosponsor names, cbo url,
   *  cutoffType, relatedBillKey, …) so nothing the writer recorded is lost on read. */
  extra: Record<string, unknown>;
}

export interface NormalizeInput {
  sourceType: string;
  sourceRef: string;
  title: string;
  whyItMatters: string | null;
  termId: string | null;
  evidence: unknown;
  /** Resolved topic label for termId, from FeedService's batched lookup. */
  topicLabel?: string | null;
}

/** sourceType is the AUTHORITATIVE column — the type is never inferred from the shape. */
const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'bill',
  'state_bill',
  'hearing',
  'combined',
  'regulation',
  'program_element',
]);

/**
 * Keys this normalizer always lifts out of the stored object. The flat bill-ish keys
 * (stage/actionText/actionDate/billTitle/displayNum) are NOT here: they are only
 * "consumed" when they were actually used to synthesize `bill`. When a nested
 * `ev.bill` wins over present flat keys (§4 edge case 2) the flat keys therefore land
 * in `extra` rather than being silently dropped — never merged field-by-field.
 */
const ALWAYS_CONSUMED: ReadonlySet<string> = new Set([
  'bill',
  'hearing',
  'programElement',
  'regulation',
  'link',
  'url',
  'sourceUrl',
  'why',
  'matchedTags',
  'matchDetails',
  'tone',
  'band',
  'triggerKey',
  'jurisdiction',
]);
const FLAT_BILL_KEYS = ['stage', 'actionText', 'actionDate', 'billTitle', 'displayNum'] as const;
/** The rule-change detector's own flat keys (rule-change-detector.service.ts:152-169). */
const FLAT_REGULATION_KEYS = ['ruleTitle', 'agency', 'ruleType', 'commentEndDate'] as const;

/** True only for a PLAIN object. Rejecting arrays and strings matters: Object.keys('ab')
 *  is ['0','1'], which would pollute `extra` for a malformed row (a-2.9). */
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** Type-narrowing helpers: return undefined on a type mismatch, never throw. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function arrOfStr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}
function arrOfObj<T>(v: unknown): T[] | undefined {
  return Array.isArray(v) ? (v.filter((x) => isObj(x)) as unknown as T[]) : undefined;
}

export function normalizeEvidence(input: NormalizeInput): NormalizedAlertEvidence {
  const ev: Record<string, unknown> = isObj(input.evidence) ? input.evidence : {};

  // Writer-shape detection. `nested` when a discriminated sub-object exists;
  // `flat_bill` when only the bill-change detector's top-level keys do; `mixed` when
  // both; `empty` otherwise (including a null/string/number/array evidence column).
  const hasNested =
    isObj(ev['bill']) || isObj(ev['hearing']) || isObj(ev['programElement']) || isObj(ev['regulation']);
  const hasFlatBill =
    ev['stage'] !== undefined || ev['actionText'] !== undefined || ev['displayNum'] !== undefined;
  const writerShape: NormalizedProvenance['writerShape'] = hasNested
    ? hasFlatBill
      ? 'mixed'
      : 'nested'
    : hasFlatBill
      ? 'flat_bill'
      : 'empty';

  const type: NormalizedEvidenceType = (
    KNOWN_TYPES.has(input.sourceType) ? input.sourceType : 'unknown'
  ) as NormalizedEvidenceType;

  // `bill`: prefer the nested object verbatim (it already matches FeedBillEvidence).
  // Otherwise synthesize from the flat writer — but ONLY for a bill-shaped sourceType,
  // so a hearing/PE alert carrying stray flat keys never gets a bogus bill.billId
  // (§4 edge case 3). billId comes from sourceRef because the flat writer never stores
  // it — sourceRef IS row.billId (bill-change-detector.service.ts:1022).
  let bill: NormalizedBill | undefined;
  let synthesizedBill = false;
  if (isObj(ev['bill'])) {
    bill = ev['bill'] as unknown as NormalizedBill;
  } else if (
    (writerShape === 'flat_bill' || writerShape === 'mixed') &&
    (type === 'bill' || type === 'state_bill' || type === 'combined')
  ) {
    const jurisdiction = str(ev['jurisdiction']);
    bill = {
      billId: input.sourceRef,
      displayNum: str(ev['displayNum']) ?? input.sourceRef,
      title: str(ev['billTitle']) ?? null,
      // `sourceUrl` is the canonical deep link (:1039) and `url` (:1038) is written to
      // the same value today; the preference is future-proofing, not a behavior change.
      url: str(ev['sourceUrl']) ?? str(ev['url']) ?? null,
      stage: str(ev['stage']) ?? '',
      actionText: str(ev['actionText']) ?? null,
      actionDate: str(ev['actionDate']) ?? null,
      ...(jurisdiction ? { jurisdiction } : {}),
    };
    synthesizedBill = true;
  }

  // §4.5: same treatment for the rule writer's flat keys. Nested wins if a writer ever
  // nests it; otherwise synthesize, and ONLY for a regulation sourceType so a bill or
  // hearing alert can never grow a bogus regulation block.
  let regulation: NormalizedRegulation | unknown | undefined;
  let synthesizedRegulation = false;
  if (isObj(ev['regulation'])) {
    regulation = ev['regulation'];
  } else if (type === 'regulation' && writerShape !== 'empty') {
    const jurisdiction = str(ev['jurisdiction']);
    regulation = {
      ruleTitle: str(ev['ruleTitle']) ?? null,
      agency: str(ev['agency']) ?? null,
      ruleType: str(ev['ruleType']) ?? null,
      commentEndDate: str(ev['commentEndDate']) ?? null,
      stage: str(ev['stage']) ?? '',
      actionText: str(ev['actionText']) ?? null,
      actionDate: str(ev['actionDate']) ?? null,
      url: str(ev['sourceUrl']) ?? str(ev['url']) ?? null,
      ...(jurisdiction ? { jurisdiction } : {}),
    } satisfies NormalizedRegulation;
    synthesizedRegulation = true;
  }

  // P1-09: the bill-change detector stores its relevance explanation as
  // `matchedTags` and never sets termId, so this block is the only place a bill
  // alert's match is legible to a consumer. `matchDetails` does not exist yet —
  // Gate D (or later) can start writing Gate B's TermMatch[] there; [] is honest today.
  const match: NormalizedMatch = {
    matchedTags: arrOfStr(ev['matchedTags']) ?? [],
    termId: input.termId,
    topicLabel: input.topicLabel ?? null,
    why: str(ev['why']) ?? input.whyItMatters,
    details: arrOfObj<NormalizedMatch['details'][number]>(ev['matchDetails']) ?? [],
  };

  const provenance: NormalizedProvenance = {
    sourceUrl: str(ev['sourceUrl']) ?? str(ev['url']) ?? null,
    triggerKey: str(ev['triggerKey']) ?? null,
    tone: str(ev['tone']) ?? null,
    band: str(ev['band']) ?? null,
    // 'US' is the established default (bill-change-detector.service.ts:978,
    // intel-alert.service.ts).
    jurisdiction: str(ev['jurisdiction']) ?? 'US',
    writerShape,
  };

  // Anti-data-loss guarantee: every own enumerable key this normalizer did not claim
  // is preserved verbatim under `extra` (tally, partySplit, cosponsorNames, cboUrl,
  // fit, cutoffType, daysUntil, relatedBillKey, linkType, sessionId, …).
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(ev)) {
    if (ALWAYS_CONSUMED.has(key)) continue;
    // The flat keys count as consumed only when they were actually lifted into a nested
    // block — otherwise they stay in `extra` rather than vanishing.
    if (
      (synthesizedBill || synthesizedRegulation) &&
      (FLAT_BILL_KEYS as readonly string[]).includes(key)
    )
      continue;
    if (synthesizedRegulation && (FLAT_REGULATION_KEYS as readonly string[]).includes(key)) continue;
    extra[key] = ev[key];
  }

  return {
    schemaVersion: ALERT_EVIDENCE_SCHEMA_VERSION,
    type,
    ...(bill ? { bill } : {}),
    // Pass-by-reference is load-bearing: decryptQuotes has ALREADY written decrypted
    // text into these mention objects (§2.4.3). Copying here would orphan it.
    ...(ev['hearing'] !== undefined ? { hearing: ev['hearing'] } : {}),
    ...(ev['programElement'] !== undefined ? { programElement: ev['programElement'] } : {}),
    ...(regulation !== undefined ? { regulation } : {}),
    ...(ev['link'] !== undefined ? { link: ev['link'] } : {}),
    match,
    provenance,
    extra,
  };
}
