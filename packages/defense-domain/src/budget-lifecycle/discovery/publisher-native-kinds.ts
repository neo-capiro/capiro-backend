/**
 * Phase 8 Session 8 — publisher-native document kinds.
 *
 * The Session 7 classifier resolves document kind from the official GovInfo
 * package id, and returns `review` when there is none:
 *
 *   "official document kind could not be determined from package id \"<none>\""
 *
 * That is correct for GovInfo, and fatal for everything else. Nine of the
 * fourteen registered adapters publish on their own websites, where there is no
 * package id at all — a HASC chairman mark, an Army R-1 exhibit, a DD-1415
 * reprogramming action. Under the package-id rule alone none of them can ever
 * resolve to an expected source, so live discovery would be GovInfo-only.
 *
 * The missing evidence is not in the document. It is **who published it**.
 *
 * The governed cycle template already binds each mark to exactly one adapter:
 *
 *   adapterId 'hasc'                 -> authorization / hasc_mark  / HASC / house
 *   adapterId 'house-appropriations' -> appropriations / hac_d_mark / HAC-D / house
 *
 * So reading the stage from the adapter is not inference on top of the template —
 * it is the template's own binding, read from the other direction. A document
 * fetched from `armedservices.house.gov` by the `hasc` adapter, which the registry
 * already proved is that adapter's official host, is a House Armed Services
 * document. That is evidence, not a guess.
 *
 * Four rules keep it honest:
 *
 *  1. **Only when there is no official package id.** A GovInfo document is
 *     classified exactly as Session 7 classified it; nothing here can reach it.
 *  2. **Only for adapters listed below.** An unrecognised adapter changes nothing.
 *  3. **The document's own title must still match the publisher's document
 *     pattern.** Publisher identity narrows the kind; it does not excuse the
 *     document from looking like what it claims to be. A press release on a
 *     committee site does not become a chairman mark.
 *  4. **Confidence is capped below the accept threshold.** A document with no
 *     official package id can be routed, but it can never auto-accept: the
 *     decision is `review`, so a human resolves it and no stage advances on
 *     publisher identity alone. This is the same posture as the pre-existing
 *     conference-report inference, which also caps confidence when it infers a
 *     stage without a package id.
 */

import type {
  AuthorityTrack,
  BudgetComponent,
  Chamber,
  LifecycleStage,
  SourceFamily,
} from '../types.js';

export interface PublisherNativeKind {
  readonly authorityTrack: AuthorityTrack;
  readonly stage: LifecycleStage;
  readonly sourceFamily: SourceFamily;
  readonly chamber: Chamber;
  readonly committee: string | null;
  readonly component: BudgetComponent;
  readonly confidence: number;
  /** Why this kind was chosen, for the audit trail. */
  readonly reason: string;
}

/**
 * Ceiling for any kind resolved from publisher identity rather than an official
 * package id. Deliberately below `CLASSIFICATION_ACCEPT_THRESHOLD` (0.8).
 */
export const PUBLISHER_NATIVE_CONFIDENCE_CEILING = 0.7;

/** A committee document has to look like a mark, not like a press release. */
const MARK_PATTERN = /\b(?:chairman'?s?\s+mark|chairman\s+mark|subcommittee\s+mark|full\s+committee\s+mark|mark[-\s]?up|markup|committee\s+print)\b/i;

/** DD-1415 prior-approval reprogramming and transfer actions. */
const REPROGRAMMING_PATTERN = /\b(?:reprogramming|DD[-\s]?1415)\b/i;
const TRANSFER_PATTERN = /\b(?:transfer\s+authority|general\s+transfer\s+authority|\bGTA\b)/i;

/** DoD contract announcements. */
const CONTRACT_AWARD_PATTERN = /\bcontracts?\b/i;

/**
 * Standard President's Budget exhibit designators, most specific first.
 *
 * `R-2A` must be tested before `R-2`, and `OP-5` before `P-1`-style matches, or
 * a shorter designator swallows a longer one.
 */
const EXHIBIT_FAMILIES: readonly { readonly pattern: RegExp; readonly family: SourceFamily }[] =
  Object.freeze([
    { pattern: /\bR[-\s]?2A\b/i, family: 'pb_r2a' },
    { pattern: /\bR[-\s]?1\b/i, family: 'pb_r1' },
    { pattern: /\bR[-\s]?2\b/i, family: 'pb_r2' },
    { pattern: /\bR[-\s]?3\b/i, family: 'pb_r3' },
    { pattern: /\bR[-\s]?4\b/i, family: 'pb_r4' },
    { pattern: /\bOP[-\s]?5\b/i, family: 'pb_op5' },
    { pattern: /\bO[-\s]?1\b/i, family: 'pb_o1' },
    { pattern: /\bP[-\s]?1\b/i, family: 'pb_p1' },
    { pattern: /\bDD[-\s]?1391\b/i, family: 'pb_dd1391' },
    { pattern: /\bC[-\s]?1\b/i, family: 'pb_milcon_c1' },
    // P-5/P-40/P-3A and friends are the procurement justification series.
    { pattern: /\bP[-\s]?(?:3A?|5A?|21|40)\b/i, family: 'pb_p_series' },
  ]);

/** Wording the service comptrollers actually use for budget-exhibit releases. */
const BUDGET_EXHIBIT_PATTERN =
  /\b(?:budget\s+(?:estimates?|justification|materials?|request|book)|justification\s+book|exhibit)\b/i;

interface PublisherProfile {
  readonly authorityTrack: AuthorityTrack;
  readonly stage: LifecycleStage;
  readonly chamber: Chamber;
  readonly committee: string | null;
  /** Component the publisher is authoritative for, when it publishes for one. */
  readonly component: BudgetComponent;
  /** `true` when the publisher releases President's Budget exhibits. */
  readonly exhibitPublisher?: boolean;
  readonly sourceFamily?: SourceFamily;
  readonly titlePattern: RegExp;
  readonly reason: string;
}

/**
 * Adapter → the kind of document that publisher issues.
 *
 * Committee entries mirror the governed template's own adapter binding exactly.
 */
const PUBLISHER_PROFILES: Readonly<Record<string, PublisherProfile>> = Object.freeze({
  hasc: {
    authorityTrack: 'authorization',
    stage: 'hasc_mark',
    sourceFamily: 'auth_committee_mark',
    chamber: 'house',
    committee: 'HASC',
    component: null,
    titlePattern: MARK_PATTERN,
    reason: 'House Armed Services committee mark, from the publishing committee',
  },
  sasc: {
    authorityTrack: 'authorization',
    stage: 'sasc_mark',
    sourceFamily: 'auth_committee_mark',
    chamber: 'senate',
    committee: 'SASC',
    component: null,
    titlePattern: MARK_PATTERN,
    reason: 'Senate Armed Services committee mark, from the publishing committee',
  },
  'house-appropriations': {
    authorityTrack: 'appropriations',
    stage: 'hac_d_mark',
    sourceFamily: 'appr_committee_mark',
    chamber: 'house',
    committee: 'HAC-D',
    component: null,
    titlePattern: MARK_PATTERN,
    reason: 'House Appropriations defence subcommittee mark, from the publishing committee',
  },
  'senate-appropriations': {
    authorityTrack: 'appropriations',
    stage: 'sac_d_mark',
    sourceFamily: 'appr_committee_mark',
    chamber: 'senate',
    committee: 'SAC-D',
    component: null,
    titlePattern: MARK_PATTERN,
    reason: 'Senate Appropriations defence subcommittee mark, from the publishing committee',
  },
  'dod-comptroller-reprogramming': {
    authorityTrack: 'alternative_funding',
    // Refined to transfer vs reprogramming below; both are registered families.
    stage: 'reprogramming',
    sourceFamily: 'alt_reprogramming',
    chamber: null,
    committee: null,
    component: null,
    titlePattern: new RegExp(`${REPROGRAMMING_PATTERN.source}|${TRANSFER_PATTERN.source}`, 'i'),
    reason: 'DoD Comptroller reprogramming/transfer action',
  },
  'dod-comptroller': {
    authorityTrack: 'request',
    stage: 'president_budget_request',
    chamber: null,
    committee: null,
    // The comptroller publishes the defence-wide volumes.
    component: 'DW',
    exhibitPublisher: true,
    titlePattern: BUDGET_EXHIBIT_PATTERN,
    reason: "DoD Comptroller President's Budget material",
  },
  'army-budget': {
    authorityTrack: 'request',
    stage: 'president_budget_request',
    chamber: null,
    committee: null,
    component: 'ARMY',
    exhibitPublisher: true,
    titlePattern: BUDGET_EXHIBIT_PATTERN,
    reason: 'Army budget exhibit, from the publishing service comptroller',
  },
  'navy-budget': {
    authorityTrack: 'request',
    stage: 'president_budget_request',
    chamber: null,
    committee: null,
    component: 'NAVY',
    exhibitPublisher: true,
    titlePattern: BUDGET_EXHIBIT_PATTERN,
    reason: 'Navy/Marine Corps budget exhibit, from the publishing service comptroller',
  },
  'saf-fm-budget': {
    authorityTrack: 'request',
    stage: 'president_budget_request',
    chamber: null,
    committee: null,
    component: 'AF',
    exhibitPublisher: true,
    titlePattern: BUDGET_EXHIBIT_PATTERN,
    reason: 'Air Force/Space Force budget exhibit, from the publishing service comptroller',
  },
  'dod-contract-announcements': {
    authorityTrack: 'execution',
    stage: 'award',
    sourceFamily: 'exec_award',
    chamber: null,
    committee: null,
    component: null,
    titlePattern: CONTRACT_AWARD_PATTERN,
    reason: 'DoD contract announcement; an award reference, never a funding assertion',
  },
});

/** Exhibit family named in a service-comptroller title, if any. */
export function exhibitFamilyFromTitle(text: string): SourceFamily | null {
  for (const { pattern, family } of EXHIBIT_FAMILIES) {
    if (pattern.test(text)) return family;
  }
  return null;
}

/**
 * A publisher that serves more than one component may name which one — but only
 * where the governed template actually registers that component.
 *
 * Measured against `DEFENSE_BUDGET_CYCLE_TEMPLATE_V1` for FY2027: it registers
 * `ARMY`, `NAVY`, `AF`, `SF` and `DW` with 11 exhibit families each, and **zero**
 * `USMC` entries. So SAF/FM's Space Force volumes are a distinct component and
 * must be narrowed, while the Navy comptroller's Marine Corps volumes are
 * deliberately folded into `NAVY`.
 *
 * Narrowing to `USMC` would mint a dedup key no bootstrapped cycle expects,
 * turning a real, registered Navy exhibit into an unresolved candidate. The
 * template is the authority on which components exist, not the document title.
 */
function refineComponent(profile: PublisherProfile, text: string): BudgetComponent {
  if (profile.component === 'AF' && /\bspace\s*force\b/i.test(text)) return 'SF';
  return profile.component;
}

/**
 * Resolve the document kind from the publishing adapter.
 *
 * Returns `null` — meaning "unchanged, stay fail-closed" — when the adapter is
 * not a publisher-native one, or when the document does not look like what that
 * publisher issues.
 */
export function resolvePublisherNativeKind(input: {
  adapterId: string | null | undefined;
  /** Title plus any content excerpt, exactly as the classifier composes it. */
  text: string;
}): PublisherNativeKind | null {
  if (!input.adapterId) return null;
  const profile = PUBLISHER_PROFILES[input.adapterId];
  if (!profile) return null;

  // Publisher identity narrows the kind; it does not excuse the document from
  // looking like what that publisher issues.
  if (!profile.titlePattern.test(input.text)) return null;

  let stage = profile.stage;
  let sourceFamily = profile.sourceFamily ?? null;
  let component = refineComponent(profile, input.text);
  let reason = profile.reason;

  if (input.adapterId === 'dod-comptroller-reprogramming') {
    // Both are registered expected-source families; the wording decides.
    const isTransfer = TRANSFER_PATTERN.test(input.text) && !REPROGRAMMING_PATTERN.test(input.text);
    stage = isTransfer ? 'transfer' : 'reprogramming';
    sourceFamily = isTransfer ? 'alt_transfer' : 'alt_reprogramming';
    reason = isTransfer
      ? 'DoD Comptroller transfer action'
      : 'DoD Comptroller reprogramming action';
  }

  if (profile.exhibitPublisher === true) {
    const family = exhibitFamilyFromTitle(input.text);
    if (family === null) {
      // A budget release from this publisher that names no exhibit designator is
      // the overview volume, which is registered without a component.
      sourceFamily = 'pb_overview';
      component = null;
      reason = `${profile.reason} (overview volume; no exhibit designator in the title)`;
    } else {
      sourceFamily = family;
      reason = `${profile.reason} (exhibit ${family})`;
    }
  }

  if (sourceFamily === null) return null;

  return Object.freeze({
    authorityTrack: profile.authorityTrack,
    stage,
    sourceFamily,
    chamber: profile.chamber,
    committee: profile.committee,
    component,
    confidence: PUBLISHER_NATIVE_CONFIDENCE_CEILING,
    reason: `${reason}; resolved from the publishing adapter because the document carries no official package id`,
  });
}

/** Adapters whose documents can be resolved without an official package id. */
export const PUBLISHER_NATIVE_ADAPTER_IDS: readonly string[] = Object.freeze(
  Object.keys(PUBLISHER_PROFILES).sort(),
);
