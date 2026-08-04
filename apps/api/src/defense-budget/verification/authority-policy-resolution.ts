/**
 * R8.3 — Authority-aware verification policy selection.
 *
 * Several committee documents intentionally share the same family/exhibit
 * vocabulary. Selecting by family + exhibit alone can therefore apply the
 * wrong chamber's required funding fields. This resolver uses the manifest
 * document authority to select the exact registry entry and fails closed on
 * ambiguity.
 */
import type { BudgetCycleManifestDocumentV1 } from '../contracts/budget-cycle-manifest-v1.js';
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

export class AmbiguousVerificationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousVerificationPolicyError';
  }
}

/**
 * Resolve the exact policy for one manifest document.
 *
 * Authority-specific committee/conference/public-law entries are selected by
 * their explicit registry key. Other documents must have exactly one matching
 * family/exhibit entry; multiple matches are an invalid registry state.
 */
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
    if (
      entry.policy.family !== document.family ||
      entry.policy.exhibit !== document.exhibit
    ) {
      throw new AmbiguousVerificationPolicyError(
        `authority policy ${authorityKey} does not match manifest ` +
          `family=${document.family} exhibit=${document.exhibit} ` +
          `(documentKey=${document.documentKey})`,
      );
    }
    return entry.policy;
  }

  const matches = entries.filter(
    (entry) =>
      entry.policy.family === document.family && entry.policy.exhibit === document.exhibit,
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
  return matches[0]!.policy;
}
