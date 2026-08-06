/** R8.3 — Authority-aware verification policy selection. */
import type { BudgetCycleManifestDocumentV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type { FundingFieldV1 } from '../contracts/extraction-artifact-v1.js';
import type { VerificationPolicyV1 } from './verification-policy-v1.js';
import { getAllPolicies } from './verification-policy-registry.js';

const AUTHORITY_POLICY_KEYS: Readonly<Record<string, string>> = {
  hasc: 'HASC',
  sasc: 'SASC',
  hac_d: 'HAC-D',
  sac_d: 'SAC-D',
  ndaa_conference: 'NDAA_CONFERENCE',
  appropriations_conference: 'APPROPRIATIONS_CONFERENCE',
  public_law: 'PUBLIC_LAW',
};

const PHASE6_AUTHORITY_MARK_FIELDS: Readonly<
  Partial<Record<string, Extract<FundingFieldV1, 'hascMark' | 'sascMark' | 'ndaaConference'>>>
> = {
  hasc: 'hascMark',
  sasc: 'sascMark',
  ndaa_conference: 'ndaaConference',
};

export class AmbiguousVerificationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousVerificationPolicyError';
  }
}

function phase6AuthorityOverrides(
  authority: string,
  policy: VerificationPolicyV1,
): VerificationPolicyV1 {
  const ownedField = PHASE6_AUTHORITY_MARK_FIELDS[authority];
  if (ownedField == null) return policy;
  if (authority === 'ndaa_conference') {
    return {
      ...policy,
      requiredDataCategories: ['funding'],
      requiredFundingFields: ['ndaaConference'],
      requiredLineKinds: ['RDTE_PE', 'PROCUREMENT_BLIN', 'OM_SAG', 'MILCON_PROJECT'],
      requiredComparisonRules: ['ndaa_conference_chamber_reference'],
      arithmeticRules: ['ndaa_conference_arithmetic'],
    };
  }
  return {
    ...policy,
    requiredDataCategories: ['funding'],
    requiredFundingFields: [ownedField],
    requiredLineKinds: ['RDTE_PE', 'PROCUREMENT_BLIN', 'OM_SAG', 'MILCON_PROJECT'],
    requiredComparisonRules: ['committee_request_reference'],
    arithmeticRules: ['committee_adjustment'],
  };
}

export function lookupPolicyForManifestDocument(
  document: Pick<
    BudgetCycleManifestDocumentV1,
    'family' | 'exhibit' | 'authority' | 'documentType' | 'documentKey'
  >,
): VerificationPolicyV1 | null {
  const entries = getAllPolicies();
  const authorityKey = AUTHORITY_POLICY_KEYS[document.authority];

  if (authorityKey) {
    const entry = entries.find((candidate) => candidate.key === authorityKey);
    if (!entry) {
      throw new AmbiguousVerificationPolicyError(
        `verification policy registry has no entry for authority=${document.authority} ` +
          `(documentKey=${document.documentKey})`,
      );
    }
    if (entry.policy.family !== document.family || entry.policy.exhibit !== document.exhibit) {
      throw new AmbiguousVerificationPolicyError(
        `authority policy ${authorityKey} does not match manifest ` +
          `family=${document.family} exhibit=${document.exhibit} ` +
          `(documentKey=${document.documentKey})`,
      );
    }
    return entry.supported ? phase6AuthorityOverrides(document.authority, entry.policy) : null;
  }

  const matches = entries.filter(
    (entry) => entry.policy.family === document.family && entry.policy.exhibit === document.exhibit,
  );

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new AmbiguousVerificationPolicyError(
      `ambiguous verification policy for family=${document.family} ` +
        `exhibit=${document.exhibit} authority=${document.authority} ` +
        `documentType=${document.documentType} documentKey=${document.documentKey}; ` +
        `matches=${matches.map((entry) => entry.key).join(',')}`,
    );
  }
  return matches[0]!.supported ? matches[0]!.policy : null;
}
