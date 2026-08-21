/**
 * FY / track / chamber / committee / stage / source-family classifier.
 *
 * Fail-closed by construction. Every classification returns a decision of
 * `accept` or `review`; there is no third option that quietly advances a cycle.
 * Ambiguity that a human must resolve — most importantly an omnibus/consolidated
 * appropriations vehicle whose defence division is not proven, or a document
 * whose fiscal year is only implied — resolves to `review`, never a guess.
 *
 * Classification is DETECTION METADATA. It decides which cycle/track/stage an
 * observation belongs to. It never produces funding amounts.
 */

import {
  STAGE_TRACK,
  type AuthorityTrack,
  type BudgetComponent,
  type Chamber,
  type LifecycleStage,
  type SourceFamily,
} from './types.js';
// Imported by path rather than through the discovery barrel: the barrel also
// exports candidate resolution, which imports this file, and going through it
// would create an import cycle.
import {
  exhibitFamilyFromTitle,
  resolvePublisherNativeKind,
} from './discovery/publisher-native-kinds.js';

export type ClassificationDecision = 'accept' | 'review';

export interface LifecycleSourceCandidate {
  /** Official URL the bytes were retrieved from. */
  readonly url: string;
  /**
   * Official package/document identifier when the publisher exposes one
   * (GovInfo `CRPT-118hrpt125`, `PLAW-118publ31`, `BILLS-118hr2670rh`).
   */
  readonly packageId?: string | null;
  /** Publisher-supplied title. */
  readonly title?: string | null;
  /** Publisher-declared fiscal year, when the adapter can read one. */
  readonly declaredFiscalYear?: number | null;
  /**
   * Text rendition of the document itself, used to CORROBORATE the metadata
   * classification. Where a publisher offers one (GovInfo serves `.htm`
   * renditions for CRPT/BILLS/PLAW packages) this is real fetched text.
   */
  readonly contentExcerpt?: string | null;
  /**
   * Set `false` ONLY when the publisher offers no text rendition at all — which
   * is the real situation for GovInfo `BUDGET-*` packages and for every
   * comptroller/service exhibit, all of which are PDF-only.
   *
   * Extracting text from those PDFs is the deterministic parser's job, and the
   * watcher must not run the very pipeline it exists to queue. So corroboration
   * is DEFERRED rather than failed: the classification still routes the document
   * to a cycle and stage, the outcome is flagged, and Phase 2 verification —
   * which no provider output can bypass — remains the gate on the facts.
   *
   * Omitting this field is NOT the same as setting it false: an absent excerpt
   * with no explicit declaration is treated as missing corroboration and caps
   * confidence, so the lenient path cannot be reached by accident.
   */
  readonly contentExcerptAvailable?: boolean;
  /** Division/title evidence for omnibus vehicles, e.g. 'Division A — Defense'. */
  readonly divisionEvidence?: string | null;
  /** Adapter that discovered the candidate. */
  readonly adapterId?: string | null;
}

export interface LifecycleClassification {
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly stage: LifecycleStage;
  readonly sourceFamily: SourceFamily;
  readonly chamber: Chamber;
  readonly committee: string | null;
  readonly component: BudgetComponent;
  /** 0..1. Metadata-only evidence is capped below the accept threshold. */
  readonly confidence: number;
}

export interface LifecycleClassificationResult {
  readonly decision: ClassificationDecision;
  readonly classification: LifecycleClassification | null;
  readonly reasons: readonly string[];
  /**
   * True when the publisher offers no text rendition, so corroboration of an
   * otherwise-accepted classification happens downstream in deterministic
   * parsing and Phase 2 verification rather than here.
   */
  readonly corroborationDeferred: boolean;
}

export const CLASSIFICATION_ACCEPT_THRESHOLD = 0.8;

const NDAA_PATTERN = /national\s+defen[cs]e\s+authorization/i;
const DEFENSE_APPROPRIATIONS_PATTERN =
  /(department\s+of\s+defen[cs]e\s+appropriation|defen[cs]e\s+appropriations?\s+(act|bill))/i;
const OMNIBUS_PATTERN = /(consolidated|omnibus|further\s+consolidated)\s+appropriations/i;
// GovInfo interjects a bookmark note between the division label and its title,
// e.g. "DIVISION A-- NOTE: Department of Defense Appropriations Act, 2024", so
// the optional NOTE segment is part of the real published shape.
const DEFENSE_DIVISION_PATTERN =
  /division\s+[a-z]{1,2}\s*[—–-]{0,2}\s*(?:note:\s*)?(?:department\s+of\s+)?defen[cs]e/i;
const CONTINUING_RESOLUTION_PATTERN = /continuing\s+(appropriations|resolution)/i;
const RECONCILIATION_PATTERN = /reconciliation/i;
const SUPPLEMENTAL_PATTERN = /supplemental\s+appropriations?/i;
const EMERGENCY_PATTERN = /emergency|security\s+supplemental/i;
const RESCISSION_PATTERN = /rescission/i;
const JES_PATTERN = /joint\s+explanatory\s+statement|explanatory\s+statement\s+accompanying/i;
const CONFERENCE_PATTERN = /conference\s+report|committee\s+of\s+conference/i;

/**
 * Explicit fiscal-year statements, in the phrasings official publishers actually
 * use. Every pattern below was taken from a real GovInfo document rather than
 * invented:
 *
 *   - `fiscal year 2024`                       BILLS-118hr2670rh long title
 *   - `fiscal year ending September 30, 2024`  CRPT-118srpt81 (SAC-D report)
 *   - `DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024`
 *                                              CRPT-118hrpt121 (HAC-D report),
 *     which states no "fiscal year" phrase anywhere in its front matter
 *   - `FY2024` / `FY 24`                       service exhibit titles
 */
function explicitFiscalYears(text: string): number[] {
  const years = new Set<number>();
  for (const match of text.matchAll(/fiscal\s+year\s+ending\s+september\s+30,?\s+(\d{4})/gi)) {
    years.add(Number(match[1]));
  }
  for (const match of text.matchAll(/fiscal\s+year[, ]+(\d{4})/gi)) {
    years.add(Number(match[1]));
  }
  for (const match of text.matchAll(/appropriations\s+(?:bill|act)[, ]+(\d{4})/gi)) {
    years.add(Number(match[1]));
  }
  for (const match of text.matchAll(/authorization\s+act[, ]+(\d{4})/gi)) {
    years.add(Number(match[1]));
  }
  for (const match of text.matchAll(/\bfy\s?'?(\d{4})\b/gi)) {
    years.add(Number(match[1]));
  }
  for (const match of text.matchAll(/\bfy\s?'?(\d{2})\b/gi)) {
    years.add(2000 + Number(match[1]));
  }
  return [...years].filter((year) => year >= 1900 && year <= 2200);
}

interface PackageShape {
  readonly kind:
    | 'committee_report'
    | 'bill'
    | 'public_law'
    | 'presidents_budget'
    | 'congressional_record'
    | 'unknown';
  readonly chamber: Chamber;
  readonly congress: number | null;
  /** GovInfo bill version suffix: rh/rs = reported, eh/es = passed, enr = enrolled. */
  readonly billVersion: string | null;
  readonly budgetYear: number | null;
}

export function parseOfficialPackageId(packageId: string | null | undefined): PackageShape {
  const id = String(packageId ?? '').trim();
  if (!id) return { kind: 'unknown', chamber: null, congress: null, billVersion: null, budgetYear: null };

  let match = /^CRPT-(\d{3})(hrpt|srpt)\d+$/i.exec(id);
  if (match) {
    return {
      kind: 'committee_report',
      chamber: match[2]!.toLowerCase() === 'hrpt' ? 'house' : 'senate',
      congress: Number(match[1]),
      billVersion: null,
      budgetYear: null,
    };
  }

  match = /^BILLS-(\d{3})(hr|s|hjres|sjres|hconres|sconres)(\d+)([a-z]{2,4})$/i.exec(id);
  if (match) {
    const prefix = match[2]!.toLowerCase();
    return {
      kind: 'bill',
      chamber: prefix.startsWith('h') ? 'house' : 'senate',
      congress: Number(match[1]),
      billVersion: match[4]!.toLowerCase(),
      budgetYear: null,
    };
  }

  match = /^PLAW-(\d{3})publ\d+$/i.exec(id);
  if (match) {
    return { kind: 'public_law', chamber: null, congress: Number(match[1]), billVersion: null, budgetYear: null };
  }

  match = /^BUDGET-(\d{4})-([A-Z]+)$/i.exec(id);
  if (match) {
    return {
      kind: 'presidents_budget',
      chamber: null,
      congress: null,
      billVersion: null,
      budgetYear: Number(match[1]),
    };
  }

  if (/^CREC-/i.test(id)) {
    return { kind: 'congressional_record', chamber: null, congress: null, billVersion: null, budgetYear: null };
  }

  return { kind: 'unknown', chamber: null, congress: null, billVersion: null, budgetYear: null };
}

type SubjectTrack =
  | { track: 'authorization'; confidence: number }
  | { track: 'appropriations'; confidence: number }
  | { track: 'alternative_funding'; stage: LifecycleStage; confidence: number }
  | { track: 'request'; confidence: number }
  | { track: 'ambiguous'; reason: string };

/**
 * Decide the authority track from SUBJECT text, never from the package shape.
 * A committee report package id is identical for an NDAA report and a Defense
 * appropriations report; only the subject distinguishes the two tracks.
 */
function detectSubjectTrack(text: string, divisionEvidence: string | null): SubjectTrack {
  // Alternative-funding vehicles are checked first: a supplemental or CR is not
  // a stage of the annual authorisation/appropriations tracks.
  if (RECONCILIATION_PATTERN.test(text)) {
    return { track: 'alternative_funding', stage: 'reconciliation', confidence: 0.9 };
  }
  if (CONTINUING_RESOLUTION_PATTERN.test(text)) {
    return { track: 'alternative_funding', stage: 'continuing_resolution', confidence: 0.9 };
  }
  if (SUPPLEMENTAL_PATTERN.test(text)) {
    return {
      track: 'alternative_funding',
      stage: EMERGENCY_PATTERN.test(text) ? 'emergency_supplemental' : 'supplemental',
      confidence: 0.9,
    };
  }
  if (RESCISSION_PATTERN.test(text)) {
    return { track: 'alternative_funding', stage: 'rescission', confidence: 0.85 };
  }

  if (NDAA_PATTERN.test(text)) return { track: 'authorization', confidence: 0.95 };
  if (DEFENSE_APPROPRIATIONS_PATTERN.test(text)) return { track: 'appropriations', confidence: 0.95 };

  if (OMNIBUS_PATTERN.test(text)) {
    // A consolidated/omnibus vehicle carries many unrelated subject divisions.
    // Without proof that the defence division is the one in hand, this must not
    // be attributed to the defence appropriations track.
    const divisionText = `${divisionEvidence ?? ''} ${text}`;
    if (DEFENSE_DIVISION_PATTERN.test(divisionText)) {
      return { track: 'appropriations', confidence: 0.85 };
    }
    return {
      track: 'ambiguous',
      reason:
        'omnibus/consolidated appropriations vehicle without proven Department of Defense division evidence',
    };
  }

  // President's Budget material, in the wording the publishers actually use.
  // GovInfo titles it "Budget of the United States Government"; the DoD
  // Comptroller titles the defence volume "FY2024 Budget Request Overview".
  if (
    /president'?s?\s+budget|budget\s+of\s+the\s+u\.?s\.?\s+government/i.test(text) ||
    /defen[cs]e\s+budget\s+overview|budget\s+request\s+overview/i.test(text) ||
    /department\s+of\s+defen[cs]e\s+.{0,30}budget\s+request/i.test(text)
  ) {
    return { track: 'request', confidence: 0.9 };
  }

  return { track: 'ambiguous', reason: 'no official defence authorization/appropriations subject match' };
}

function committeeReportStage(
  track: 'authorization' | 'appropriations',
  chamber: Chamber,
  text: string,
): { stage: LifecycleStage; sourceFamily: SourceFamily; committee: string | null } {
  const isConference = CONFERENCE_PATTERN.test(text) || JES_PATTERN.test(text);
  if (track === 'authorization') {
    if (isConference) {
      return { stage: 'auth_conference', sourceFamily: 'auth_conference_report', committee: null };
    }
    return chamber === 'senate'
      ? { stage: 'sasc_report', sourceFamily: 'auth_committee_report', committee: 'SASC' }
      : { stage: 'hasc_report', sourceFamily: 'auth_committee_report', committee: 'HASC' };
  }
  if (isConference) {
    return { stage: 'appr_conference_or_jes', sourceFamily: 'appr_conference_jes', committee: null };
  }
  return chamber === 'senate'
    ? { stage: 'sac_d_report', sourceFamily: 'appr_committee_report', committee: 'SAC-D' }
    : { stage: 'hac_d_report', sourceFamily: 'appr_committee_report', committee: 'HAC-D' };
}

/** GovInfo bill version suffixes we treat as chamber action, and their rank. */
const BILL_VERSION_RANK: Readonly<Record<string, number>> = Object.freeze({
  ih: 1,
  is: 1,
  rh: 2,
  rs: 2,
  eh: 3,
  es: 3,
  eah: 4,
  eas: 4,
  enr: 5,
});

export function billVersionRank(version: string | null | undefined): number | null {
  if (!version) return null;
  const rank = BILL_VERSION_RANK[version.toLowerCase()];
  return typeof rank === 'number' ? rank : null;
}

function detectComponent(text: string): BudgetComponent {
  if (/\bspace\s*force\b/i.test(text)) return 'SF';
  if (/\bair\s*force\b/i.test(text)) return 'AF';
  if (/\bmarine\s*corps\b/i.test(text)) return 'USMC';
  if (/\bnavy\b/i.test(text)) return 'NAVY';
  if (/\barmy\b/i.test(text)) return 'ARMY';
  if (/defen[cs]e[-\s]wide/i.test(text)) return 'DW';
  return null;
}

/**
 * Classify a discovered official source.
 *
 * Contract: an `accept` decision means the FY, track and stage are supported by
 * explicit official evidence. Anything else is `review`, and the caller must not
 * advance the cycle.
 */
export function classifyLifecycleSource(
  candidate: LifecycleSourceCandidate,
): LifecycleClassificationResult {
  const reasons: string[] = [];
  const title = String(candidate.title ?? '');
  const excerpt = String(candidate.contentExcerpt ?? '');
  const combined = `${title}\n${excerpt}`;
  const shape = parseOfficialPackageId(candidate.packageId);

  let officialUrl: URL;
  try {
    officialUrl = new URL(candidate.url);
  } catch {
    return Object.freeze({
      decision: 'review' as const,
      classification: null,
      reasons: Object.freeze([`unparseable source URL: ${candidate.url}`]),
      corroborationDeferred: false,
    });
  }
  if (officialUrl.protocol !== 'https:') {
    reasons.push('source URL is not HTTPS');
  }

  // ── Fiscal year ────────────────────────────────────────────────────────────
  const titleYears = explicitFiscalYears(title);
  const excerptYears = explicitFiscalYears(excerpt);
  let fiscalYear: number | null = null;

  if (shape.kind === 'presidents_budget' && shape.budgetYear) {
    fiscalYear = shape.budgetYear;
  } else if (titleYears.length === 1) {
    fiscalYear = titleYears[0]!;
  } else if (titleYears.length > 1) {
    reasons.push(
      `title declares more than one fiscal year (${titleYears.join(', ')}); refusing to guess`,
    );
  } else if (candidate.declaredFiscalYear) {
    fiscalYear = candidate.declaredFiscalYear;
    reasons.push('fiscal year came from publisher metadata rather than the document title');
  } else {
    reasons.push('no explicit fiscal year in title or publisher metadata');
  }

  if (
    fiscalYear !== null &&
    candidate.declaredFiscalYear &&
    candidate.declaredFiscalYear !== fiscalYear
  ) {
    reasons.push(
      `publisher metadata fiscal year ${candidate.declaredFiscalYear} disagrees with document evidence ${fiscalYear}`,
    );
  }

  // ── Subject track ──────────────────────────────────────────────────────────
  const detected = detectSubjectTrack(combined, candidate.divisionEvidence ?? null);

  // A publisher-native kind is resolved once and reused for the stage below.
  // `null` for every GovInfo adapter, so nothing here can reach a package-id
  // document.
  const publisherKind = resolvePublisherNativeKind({
    adapterId: candidate.adapterId,
    text: combined,
  });

  // Widened locally rather than in the exported `SubjectTrack` union: the
  // execution track has no *textual* detector and never will, because an award
  // announcement is identified by its publisher, not by budget-vehicle wording.
  // Keeping `SubjectTrack` unchanged keeps `detectSubjectTrack` exhaustive.
  let subject:
    | Exclude<SubjectTrack, { track: 'ambiguous' }>
    | { track: 'execution'; confidence: number };
  if (detected.track === 'ambiguous') {
    // Document text alone did not name a track. A service comptroller publishes
    // only President's Budget material and the reprogramming page only
    // reprogramming/transfer actions, so for those publishers the track is a
    // property of the publisher — and the registry has already proved the bytes
    // came from that publisher's own official host.
    //
    // This deliberately cannot rescue the omnibus case: no GovInfo adapter has a
    // publisher-native profile, so an unproven consolidated appropriations
    // vehicle still resolves to review exactly as before.
    if (!publisherKind) {
      reasons.push(detected.reason);
      return Object.freeze({
        decision: 'review' as const,
        classification: null,
        reasons: Object.freeze(reasons),
        corroborationDeferred: false,
      });
    }
    reasons.push(
      `${detected.reason}; track taken from the publishing adapter ${candidate.adapterId} instead`,
    );
    // Built explicitly per track so the alternative-funding variant carries the
    // stage the publisher resolved, exactly as a textual detection would.
    subject =
      publisherKind.authorityTrack === 'alternative_funding'
        ? {
            track: 'alternative_funding',
            stage: publisherKind.stage,
            confidence: publisherKind.confidence,
          }
        : publisherKind.authorityTrack === 'execution'
          ? { track: 'execution', confidence: publisherKind.confidence }
          : publisherKind.authorityTrack === 'request'
            ? { track: 'request', confidence: publisherKind.confidence }
            : {
                track: publisherKind.authorityTrack,
                confidence: publisherKind.confidence,
              };
  } else {
    subject = detected;
  }

  // ── Stage / family ─────────────────────────────────────────────────────────
  let stage: LifecycleStage | null = null;
  let sourceFamily: SourceFamily | null = null;
  let chamber: Chamber = shape.chamber;
  let committee: string | null = null;
  let confidence = 'confidence' in subject ? subject.confidence : 0.5;
  // Set only when the kind came from the publishing adapter, which is
  // authoritative for the component it publishes for (an Army exhibit is ARMY
  // whether or not the title repeats the word).
  let nativeComponent: BudgetComponent = null;

  if (subject.track === 'alternative_funding') {
    stage = subject.stage;
    sourceFamily =
      subject.stage === 'reconciliation'
        ? 'alt_reconciliation'
        : subject.stage === 'continuing_resolution'
          ? 'alt_continuing_resolution'
          : subject.stage === 'rescission'
            ? 'alt_rescission'
            : // Reprogramming and transfer are separately registered families;
              // collapsing them into alt_supplemental produced a dedup key that
              // matched no expected source, so a real DD-1415 action could never
              // be attached to a cycle.
              subject.stage === 'reprogramming'
              ? 'alt_reprogramming'
              : subject.stage === 'transfer'
                ? 'alt_transfer'
                : 'alt_supplemental';
    chamber = null;
  } else if (subject.track === 'request') {
    stage = 'president_budget_request';
    // President's Budget material is registered per EXHIBIT FAMILY, not as one
    // undifferentiated volume: an Army R-2 is `pb_r2`/ARMY, and only the overview
    // volume is `pb_overview`. Defaulting everything to the overview produced a
    // dedup key that no service-comptroller exhibit could ever match.
    sourceFamily = exhibitFamilyFromTitle(combined) ?? 'pb_overview';
    chamber = null;
  } else if (subject.track === 'execution') {
    // Execution-track material (an award announcement) has no official package
    // id and no budget-vehicle wording to key on. It is resolved entirely by the
    // publisher-native branch below, which also caps its confidence.
    chamber = null;
  } else if (shape.kind === 'committee_report') {
    if (!chamber) reasons.push('committee report package id did not resolve a chamber');
    const resolved = committeeReportStage(subject.track, chamber, combined);
    stage = resolved.stage;
    sourceFamily = resolved.sourceFamily;
    committee = resolved.committee;
  } else if (shape.kind === 'public_law') {
    stage = subject.track === 'authorization' ? 'auth_enacted' : 'appr_enacted';
    sourceFamily = subject.track === 'authorization' ? 'auth_public_law' : 'appr_public_law';
    chamber = null;
  } else if (shape.kind === 'bill') {
    const rank = billVersionRank(shape.billVersion);
    if (rank === null) {
      reasons.push(`unrecognised official bill version suffix: ${shape.billVersion ?? '<none>'}`);
    } else if (rank >= BILL_VERSION_RANK.enr!) {
      // An enrolled bill is not yet a public law; it is the final chamber action.
      stage = subject.track === 'authorization' ? 'senate_auth_action' : 'senate_appr_action';
      reasons.push('enrolled bill recorded as final chamber action, not as enacted law');
    }
    if (stage === null) {
      if (chamber === 'senate') {
        stage = subject.track === 'authorization' ? 'senate_auth_action' : 'senate_appr_action';
      } else if (chamber === 'house') {
        stage = subject.track === 'authorization' ? 'house_auth_action' : 'house_appr_action';
      } else {
        reasons.push('bill package id did not resolve a chamber');
      }
    }
    sourceFamily = subject.track === 'authorization' ? 'auth_chamber_action' : 'appr_chamber_action';
  } else if (CONFERENCE_PATTERN.test(combined) || JES_PATTERN.test(combined)) {
    stage = subject.track === 'authorization' ? 'auth_conference' : 'appr_conference_or_jes';
    sourceFamily =
      subject.track === 'authorization' ? 'auth_conference_report' : 'appr_conference_jes';
    chamber = 'joint';
    reasons.push('conference stage inferred from document text without an official package id');
    confidence = Math.min(confidence, 0.7);
  } else {
    reasons.push(
      `official document kind could not be determined from package id "${candidate.packageId ?? '<none>'}"`,
    );
  }

  // ── Publisher-native document kinds ────────────────────────────────────────
  //
  // Nine of the fourteen registered adapters publish on their own websites and
  // issue no official package id at all, so the package-id chain above can never
  // resolve a stage for them. The missing evidence is who published the document:
  // the governed cycle template already binds each mark to exactly one adapter,
  // and the registry has already proved the bytes came from that adapter's own
  // official host.
  //
  // Reached ONLY when the package-id chain resolved nothing, so a GovInfo
  // document's classification is byte-for-byte what Session 7 produced. Confidence
  // is capped below the accept threshold, so publisher identity can route a
  // document but can never advance a stage on its own.
  // A publishing service comptroller is authoritative for the component it
  // publishes for, and for whether a release is an exhibit or the overview
  // volume (the overview is registered without a component). Applied whenever the
  // publisher agrees with the track the document text resolved.
  if (publisherKind && publisherKind.authorityTrack === subject.track) {
    nativeComponent = publisherKind.component;
  }

  if (stage === null || sourceFamily === null) {
    const native = publisherKind;
    if (native) {
      // The publisher's own subject must not contradict the document's text. If
      // the text resolved a track at all, it wins over the publisher default.
      if (subject.track !== native.authorityTrack) {
        reasons.push(
          `publisher ${candidate.adapterId} issues ${native.authorityTrack} documents but the ` +
            `document text resolved ${subject.track}; refusing to override document evidence`,
        );
      } else {
        stage = native.stage;
        sourceFamily = native.sourceFamily;
        chamber = native.chamber;
        committee = native.committee;
        nativeComponent = native.component;
        confidence = Math.min(confidence, native.confidence);
        reasons.push(native.reason);
      }
    }
  }

  if (stage === null || sourceFamily === null || fiscalYear === null) {
    return Object.freeze({
      decision: 'review' as const,
      classification: null,
      reasons: Object.freeze(reasons),
      corroborationDeferred: false,
    });
  }

  // Content corroboration.
  let corroborationDeferred = false;
  if (candidate.contentExcerptAvailable === false) {
    // Publisher offers no text rendition (PDF-only). Deferred, not failed.
    corroborationDeferred = true;
    reasons.push(
      'publisher offers no text rendition; content corroboration deferred to deterministic ' +
        'parsing and Phase 2 verification',
    );
  } else if (!excerpt.trim()) {
    reasons.push('no document content excerpt supplied to corroborate metadata classification');
    confidence = Math.min(confidence, 0.6);
  } else if (!excerptYears.includes(fiscalYear)) {
    reasons.push(
      `document content does not corroborate fiscal year ${fiscalYear} (found: ${
        excerptYears.length ? excerptYears.join(', ') : 'none'
      })`,
    );
    confidence = Math.min(confidence, 0.6);
  }

  const track: AuthorityTrack = subject.track;
  if (STAGE_TRACK[stage] !== track) {
    reasons.push(
      `refusing cross-track classification: stage ${stage} belongs to ${STAGE_TRACK[stage]}, subject resolved ${track}`,
    );
    return Object.freeze({
      decision: 'review' as const,
      classification: null,
      reasons: Object.freeze(reasons),
      corroborationDeferred: false,
    });
  }

  const classification: LifecycleClassification = Object.freeze({
    fiscalYear,
    authorityTrack: track,
    stage,
    sourceFamily,
    chamber,
    committee,
    // The publishing service comptroller is authoritative for its own component;
    // otherwise the component comes from the document text, unchanged.
    component: nativeComponent ?? detectComponent(combined),
    confidence: Number(confidence.toFixed(3)),
  });

  const decision: ClassificationDecision =
    confidence >= CLASSIFICATION_ACCEPT_THRESHOLD ? 'accept' : 'review';

  return Object.freeze({
    decision,
    classification,
    reasons: Object.freeze(reasons),
    corroborationDeferred,
  });
}

/**
 * Independent second check of an accepted classification against the document's
 * own content. Kept separate from `classifyLifecycleSource` so a caller cannot
 * accept a classification without ever looking at the bytes.
 */
export function validateClassificationAgainstContent(
  classification: LifecycleClassification,
  evidence: { readonly contentExcerpt: string },
): { readonly valid: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  const text = evidence.contentExcerpt ?? '';

  if (!text.trim()) {
    reasons.push('empty content evidence');
    return Object.freeze({ valid: false, reasons: Object.freeze(reasons) });
  }
  if (!explicitFiscalYears(text).includes(classification.fiscalYear)) {
    reasons.push(`content does not state fiscal year ${classification.fiscalYear}`);
  }

  const track = classification.authorityTrack;
  if (track === 'authorization' && !NDAA_PATTERN.test(text)) {
    reasons.push('content does not state a national defense authorization subject');
  }
  if (
    track === 'appropriations' &&
    !DEFENSE_APPROPRIATIONS_PATTERN.test(text) &&
    !DEFENSE_DIVISION_PATTERN.test(text)
  ) {
    reasons.push('content does not state a Department of Defense appropriations subject');
  }

  return Object.freeze({ valid: reasons.length === 0, reasons: Object.freeze(reasons) });
}
