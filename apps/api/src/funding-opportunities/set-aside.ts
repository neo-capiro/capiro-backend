/**
 * Set-aside eligibility — four DIFFERENT facts, kept apart on purpose.
 *
 * The pre-existing code conflated them into one `string[]` on the client and one
 * exact-code comparison, and the conflation produced a false claim: a client
 * whose profile recorded the string 'SBA' was reported `eligible` for a Total
 * Small Business Set-Aside. 'SBA' is not a certification anyone holds — it is
 * SAM's code for a RESTRICTION ON THE SOLICITATION — so the profile field was
 * being read as evidence of something it cannot evidence.
 *
 * The four facts:
 *
 *   1. DURABLE SOCIOECONOMIC CERTIFICATION — a status the company holds, issued
 *      by SBA/VA, valid until it lapses: 8(a), SDVOSB, VOSB, WOSB, EDWOSB,
 *      HUBZone. This is the only one that belongs on a client profile, because
 *      it is a property of the COMPANY.
 *
 *   2. SOLICITATION RESTRICTION CODE — a property of the NOTICE
 *      (`typeOfSetAside`): 'SBA', 'SBP', '8AN', 'SDVOSBC', 'HZS', … Several of
 *      these encode a competition method rather than a status ('8AN' = 8(a)
 *      competed, 'SDVOSBS' = SDVOSB SOLE SOURCE), and a sole-source notice is
 *      one the government has already decided to direct at a named firm.
 *      Storing 'SDVOSBS' as a company certification is a category error.
 *
 *   3. GENERAL SMALL-BUSINESS STATUS — self-reported, unverified, and not a
 *      certification: 'we consider ourselves a small business'.
 *
 *   4. NAICS-SPECIFIC SIZE DETERMINATION — whether the company is under the SBA
 *      size standard for THIS notice's NAICS code. Capiro holds no size data at
 *      all, so this fact is always absent.
 *
 * ── Why a matching certification still returns `needs_review` ────────────────
 *
 * Every socioeconomic set-aside is conjunctive: to bid an 8(a) set-aside a firm
 * must be an active 8(a) participant AND small for the notice's NAICS AND
 * (for a sole-source award) the one the contracting officer selected. Capiro can
 * evidence at most the first. Reporting `eligible` from one of three required
 * facts tells a user they may bid on something they may not, which costs a bid
 * team real money — so `needs_review` with a specific list of what is still
 * unknown is the honest ceiling, and it is what this module returns.
 */

/**
 * Durable socioeconomic certifications a client may record.
 *
 * Deliberately NOT SAM's `typeOfSetAside` vocabulary. These are the statuses a
 * company holds; SAM's codes describe what a solicitation restricts itself to,
 * and the mapping between the two is many-to-many (see
 * {@link CERTIFICATION_SATISFIES}).
 */
export const DURABLE_SET_ASIDE_CERTIFICATIONS = [
  '8A',
  'SDVOSB',
  'VOSB',
  'WOSB',
  'EDWOSB',
  'HUBZONE',
] as const;
export type DurableSetAsideCertification = (typeof DURABLE_SET_ASIDE_CERTIFICATIONS)[number];

/**
 * Values that were accepted as "certifications" before this module existed, and
 * must not be any more, mapped to the durable certification they were probably
 * meant to express (or `null` where there is nothing to migrate them to).
 *
 * Consumed by `repair-set-aside-certifications.ts`. `SBA`/`SBP` map to null on
 * purpose: the honest destination for "we are a small business" is the
 * `applicantTypes` self-report, not a certification the client does not hold.
 */
export const LEGACY_SET_ASIDE_VALUE_MIGRATION: Readonly<Record<string, DurableSetAsideCertification | null>> =
  Object.freeze({
    // General small-business RESTRICTION codes — never company certifications.
    SBA: null,
    SBP: null,
    // 8(a): both the competed and sole-source restriction codes imply the same
    // durable status.
    '8A': '8A',
    '8AN': '8A',
    // SDVOSB: 'C' = set-aside (competed), 'S' = sole source.
    SDVOSBC: 'SDVOSB',
    SDVOSBS: 'SDVOSB',
    SDVOSB: 'SDVOSB',
    VOSB: 'VOSB',
    // WOSB / EDWOSB: 'SS' suffix = sole source.
    WOSB: 'WOSB',
    WOSBSS: 'WOSB',
    EDWOSB: 'EDWOSB',
    EDWOSBSS: 'EDWOSB',
    // HUBZone: 'C' = set-aside, 'S' = sole source.
    HZC: 'HUBZONE',
    HZS: 'HUBZONE',
    HUBZONE: 'HUBZONE',
    HUBZ: 'HUBZONE',
  });

/** Uppercase alphanumerics only — matches sam-opportunity-relevance's normCode. */
export function normalizeSetAsideCode(value: string | null | undefined): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isDurableSetAsideCertification(
  value: string | null | undefined,
): value is DurableSetAsideCertification {
  return (DURABLE_SET_ASIDE_CERTIFICATIONS as readonly string[]).includes(normalizeSetAsideCode(value));
}

/**
 * SOLE-SOURCE solicitation restriction codes.
 *
 * A sole-source notice is published because the government intends to award to a
 * specific firm without competition. Holding the matching certification does not
 * make another firm a candidate, so these never justify an eligibility upgrade —
 * and they must never be storable as a company certification.
 */
export const SOLE_SOURCE_RESTRICTION_CODES: ReadonlySet<string> = new Set([
  '8AN',
  'SDVOSBS',
  'WOSBSS',
  'EDWOSBSS',
  'HZS',
]);

export function isSoleSourceRestriction(setAsideCode: string | null | undefined): boolean {
  return SOLE_SOURCE_RESTRICTION_CODES.has(normalizeSetAsideCode(setAsideCode));
}

/**
 * GENERAL small-business restriction codes — a size restriction, not a
 * socioeconomic program. No certification exists to hold.
 */
export const GENERAL_SMALL_BUSINESS_RESTRICTION_CODES: ReadonlySet<string> = new Set(['SBA', 'SBP']);

export function isGeneralSmallBusinessRestriction(setAsideCode: string | null | undefined): boolean {
  return GENERAL_SMALL_BUSINESS_RESTRICTION_CODES.has(normalizeSetAsideCode(setAsideCode));
}

/**
 * Which solicitation restriction codes each durable certification can speak to.
 *
 * Note 8(a): a firm's 8(a) status speaks to both '8A' and '8AN', but '8AN' being
 * sole-source means {@link isSoleSourceRestriction} still blocks the upgrade.
 * The two tests answer different questions — "is my status relevant here" and
 * "is this competition open to anyone" — and both must pass.
 */
export const CERTIFICATION_SATISFIES: Readonly<Record<DurableSetAsideCertification, readonly string[]>> =
  Object.freeze({
    '8A': ['8A', '8AN'],
    SDVOSB: ['SDVOSBC', 'SDVOSBS'],
    // A VOSB is not an SDVOSB. VA set-asides distinguish them and the SDVOSB
    // codes are the only ones SAM publishes, so VOSB deliberately satisfies
    // nothing in SAM's contract vocabulary — it is recorded because VA
    // solicitations outside SAM use it.
    VOSB: [],
    WOSB: ['WOSB', 'WOSBSS'],
    // EDWOSB is a strict subset of WOSB: an EDWOSB qualifies for a general WOSB
    // set-aside, not the reverse.
    EDWOSB: ['EDWOSB', 'EDWOSBSS', 'WOSB', 'WOSBSS'],
    HUBZONE: ['HZC', 'HZS'],
  });

export interface SetAsideEligibilityInput {
  /** Durable certifications recorded on the client profile. */
  certifications: readonly string[];
  /** Does the client self-report as a small business? A report, never a determination. */
  selfReportsSmallBusiness: boolean;
  /** The notice's `typeOfSetAside` code. */
  setAsideCode: string | null | undefined;
  /** The notice's human-readable set-aside description. */
  setAsideLabel: string | null | undefined;
  /** The notice's NAICS code — the size standard that would apply. */
  naicsCode: string | null | undefined;
  /**
   * Whether a NAICS-specific size determination is on file. Always false today:
   * Capiro stores no employee-count or receipts data. Wired as a parameter so
   * that when it does exist, the one place that decides eligibility learns about
   * it rather than the fact being bolted on at a call site.
   */
  hasNaicsSizeDetermination?: boolean;
}

export interface SetAsideEligibility {
  /**
   * Never `eligible` and never `ineligible` from structured fields alone. See
   * the module header: eligibility is conjunctive and Capiro holds at most one
   * of the conjuncts.
   */
  state: 'needs_review' | 'unknown';
  reason: string;
  /** The certifications that speak to this notice. Empty is common and not adverse. */
  matchedCertifications: DurableSetAsideCertification[];
  /** Named facts still missing. Drives the reason string and is asserted in tests. */
  missingFacts: Array<'certification' | 'naics_size_determination' | 'sole_source_selection' | 'small_business_status'>;
}

/**
 * Evaluate one notice's set-aside against one client's durable certifications.
 *
 * Returns `unknown` only when the notice records NO set-aside — full-and-open,
 * where the binding constraint is a contracting officer's responsibility
 * determination and not a field Capiro can read.
 */
export function evaluateSetAsideEligibility(input: SetAsideEligibilityInput): SetAsideEligibility {
  const code = normalizeSetAsideCode(input.setAsideCode);
  const label = input.setAsideLabel ?? input.setAsideCode ?? 'a set-aside';

  if (!code && !input.setAsideLabel) {
    return {
      state: 'unknown',
      reason:
        'This notice records no set-aside in the fields Capiro holds. Contract eligibility also depends on a contracting officer’s responsibility determination, which is not published as data, so it is not asserted here.',
      matchedCertifications: [],
      missingFacts: [],
    };
  }

  const held = input.certifications
    .map((c) => normalizeSetAsideCode(c))
    .filter((c): c is DurableSetAsideCertification =>
      (DURABLE_SET_ASIDE_CERTIFICATIONS as readonly string[]).includes(c),
    );
  const matchedCertifications = held.filter((c) =>
    code ? CERTIFICATION_SATISFIES[c].includes(code) : false,
  );

  const missingFacts: SetAsideEligibility['missingFacts'] = [];

  // A general small-business set-aside turns on the size standard, not on a
  // socioeconomic certification — so a matching certification is beside the
  // point and the small-business self-report is the only (weak) evidence.
  if (isGeneralSmallBusinessRestriction(code)) {
    if (!input.selfReportsSmallBusiness) missingFacts.push('small_business_status');
    if (!input.hasNaicsSizeDetermination) missingFacts.push('naics_size_determination');
    return {
      state: 'needs_review',
      reason: input.selfReportsSmallBusiness
        ? `Restricted to ${label}. This client self-reports as a small business, but that is a self-report, not a determination — the SBA size standard for NAICS ${input.naicsCode ?? '(not stated)'} must still be confirmed.`
        : `Restricted to ${label}, and no small-business status is recorded for this client. Confirm size status against the SBA standard for NAICS ${input.naicsCode ?? '(not stated)'} before bidding.`,
      matchedCertifications: [],
      missingFacts,
    };
  }

  if (matchedCertifications.length === 0) {
    missingFacts.push('certification');
    if (!input.hasNaicsSizeDetermination) missingFacts.push('naics_size_determination');
    return {
      state: 'needs_review',
      reason: held.length
        ? `Restricted to ${label}. The certifications recorded for this client (${held.join(', ')}) do not include the program this notice requires; verify whether the profile is complete before treating this as ineligible.`
        : `Restricted to ${label}. No durable set-aside certifications are recorded for this client, so qualification cannot be confirmed from structured fields. An absent record is not evidence the client lacks the certification.`,
      matchedCertifications: [],
      missingFacts,
    };
  }

  // A certification MATCHES. This is the case the old code called `eligible`.
  if (!input.hasNaicsSizeDetermination) missingFacts.push('naics_size_determination');
  if (isSoleSourceRestriction(code)) missingFacts.push('sole_source_selection');

  const outstanding: string[] = [];
  if (missingFacts.includes('naics_size_determination')) {
    outstanding.push(
      `the SBA size standard for NAICS ${input.naicsCode ?? '(not stated)'} is not on file`,
    );
  }
  if (missingFacts.includes('sole_source_selection')) {
    outstanding.push(
      'this is a SOLE-SOURCE notice, so the government has already identified its intended awardee',
    );
  }
  outstanding.push('current certification status must be confirmed against SAM.gov before submission');

  return {
    state: 'needs_review',
    reason:
      `The client profile records ${matchedCertifications.join(', ')}, which speaks to ${label}. ` +
      `This is not a confirmation of eligibility: ${outstanding.join('; ')}.`,
    matchedCertifications,
    missingFacts,
  };
}
