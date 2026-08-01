/**
 * Contact-use guardrail policy (pure, no DB / no NestJS).
 *
 * Encodes the plan §17 compliance guardrails plus the FAR-derived hard rule that
 * procurement officials are NEVER treated as lobbying contacts. `classifyContactUse`
 * is deterministic and pure: given a role's signals it returns a `ContactUse`
 * classification used to gate whether a person may appear as a lobbying/outreach
 * audience in action recommendations.
 *
 * IMPORTANT: this policy NEVER auto-promotes anyone to `'lobbying_contact'`. That
 * value is only ever set by an explicit human / relationship decision elsewhere in
 * the system. The most permissive thing `classifyContactUse` will ever return for an
 * accepted, non-procurement role is `'program_ownership_context'` — context, not an
 * invitation to lobby.
 */

export type ContactUse =
  | 'lobbying_contact'
  | 'program_ownership_context'
  | 'official_procurement_poc'
  | 'internal_owner'
  | 'relationship_owner'
  | 'do_not_contact_procurement_sensitive'
  | 'candidate'
  | 'quarantined';

export type RoleType =
  | 'peo'
  | 'pm'
  | 'deputy'
  | 'chief_engineer'
  | 'contracting_officer'
  | 'staff'
  | 'other';

export interface ContactUseInput {
  roleType: RoleType | string;
  /** e.g. 'sam_gov', 'peo_roster', 'dod_orgchart', 'manual' */
  source: string;
  reviewStatus: 'accepted' | 'candidate' | 'quarantined' | string;
  /**
   * True if the only signals linking this person are source-selection-adjacent
   * (e.g. evaluation board, SSEB, source selection authority).
   */
  sourceSelectionAdjacent?: boolean;
}

/**
 * Classify a role's compliance contact-use. Rules are applied in strict priority
 * order — the first matching rule wins.
 *
 *   1. quarantined review status                          -> 'quarantined'
 *   2. HARD FAR rule: contracting_officer OR sam_gov source
 *      (these people are NEVER lobbying contacts)         -> 'official_procurement_poc'
 *   3. source-selection-adjacent signals only             -> 'do_not_contact_procurement_sensitive'
 *   4. candidate review status (not yet usable)           -> 'candidate'
 *   5. otherwise (accepted, non-procurement) conservative
 *      default (context, not an invitation to lobby)      -> 'program_ownership_context'
 */
export function classifyContactUse(input: ContactUseInput): ContactUse {
  // 1. Quarantine short-circuits everything.
  if (input.reviewStatus === 'quarantined') {
    return 'quarantined';
  }

  // 2. HARD FAR rule — highest substantive priority, applies even before review
  //    gating. Contracting officers and SAM.gov-sourced people are procurement
  //    officials and are NEVER lobbying contacts.
  if (input.roleType === 'contracting_officer' || input.source === 'sam_gov') {
    return 'official_procurement_poc';
  }

  // 3. Source-selection exclusion.
  if (input.sourceSelectionAdjacent === true) {
    return 'do_not_contact_procurement_sensitive';
  }

  // 4. Not yet reviewed -> not usable as a contact.
  if (input.reviewStatus === 'candidate') {
    return 'candidate';
  }

  // 5. Conservative default: accepted, non-procurement role -> context only.
  return 'program_ownership_context';
}

/**
 * True ONLY for `'lobbying_contact'`. Note that `classifyContactUse` never returns
 * `'lobbying_contact'` — the policy never auto-promotes anyone to a lobbying contact;
 * that classification is only ever applied by an explicit human / relationship
 * decision elsewhere.
 */
export function isLobbyingEligible(contactUse: ContactUse): boolean {
  return contactUse === 'lobbying_contact';
}

/**
 * True when a contact-use must NEVER appear as a lobbying / outreach audience in
 * action recommendations. Such people may still be shown as CONTEXT with a badge,
 * but never recommended as a target.
 */
export function isExcludedFromRecommendations(contactUse: ContactUse): boolean {
  return (
    contactUse === 'official_procurement_poc' ||
    contactUse === 'do_not_contact_procurement_sensitive' ||
    contactUse === 'quarantined' ||
    contactUse === 'candidate'
  );
}

/**
 * True when CRM linking from a PE page must be refused for this contact-use.
 * Blocks procurement POC / procurement-sensitive / candidate / quarantined.
 * Allows program ownership / internal / relationship context and explicit
 * lobbying_contact — WITHOUT promoting context roles to lobbying-eligible.
 */
export function isCrmLinkBlocked(contactUse: ContactUse | string): boolean {
  return (
    contactUse === 'official_procurement_poc' ||
    contactUse === 'do_not_contact_procurement_sensitive' ||
    contactUse === 'candidate' ||
    contactUse === 'quarantined'
  );
}

/** Accessible reason string for disabled CRM link UI (no PII). */
export function crmLinkBlockedReason(contactUse: ContactUse | string): string {
  switch (contactUse) {
    case 'official_procurement_poc':
      return 'CRM linking is blocked: official procurement point of contact (FAR).';
    case 'do_not_contact_procurement_sensitive':
      return 'CRM linking is blocked: procurement-sensitive / source-selection role.';
    case 'candidate':
      return 'CRM linking is blocked: role is still a candidate and requires review.';
    case 'quarantined':
      return 'CRM linking is blocked: role is quarantined.';
    default:
      return 'CRM linking is blocked for this role.';
  }
}

/** Human-readable labels for each contact-use classification. */
export const CONTACT_USE_LABELS: Record<ContactUse, string> = {
  lobbying_contact: 'Lobbying contact',
  program_ownership_context: 'Program ownership context',
  official_procurement_poc: 'Official procurement POC',
  internal_owner: 'Internal owner',
  relationship_owner: 'Relationship owner',
  do_not_contact_procurement_sensitive: 'Do not contact (procurement-sensitive)',
  candidate: 'Candidate — requires review',
  quarantined: 'Quarantined',
};
