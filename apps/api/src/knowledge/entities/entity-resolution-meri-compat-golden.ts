import type { ResolveEntityInput } from './entity-resolution.types.js';
import type { EntityResolutionStage } from './entity-resolution-stage-policy.js';

export interface MeriCompatibleEntityResolutionCase {
  id: string;
  description: string;
  input: ResolveEntityInput;
  expectedStatus: 'resolved' | 'ambiguous' | 'unresolved';
  expectedSelectedCanonicalName?: string | null;
  requiredCandidateCanonicalNames?: readonly string[];
  requiredAttemptedStages: readonly EntityResolutionStage[];
}

/**
 * Supplemental Phase 5 closeout corpus derived from the shared Knowledge Plane
 * compatibility contract. These are identity tests, not Meri retrieval tests.
 */
export const MERI_COMPATIBLE_ENTITY_RESOLUTION_CASES: readonly MeriCompatibleEntityResolutionCase[] = [
  {
    id: 'external_company_exact_official_domain',
    description:
      'A non-client external company can resolve through a unique verified official domain.',
    input: {
      query: 'kindeticindustries.inc',
      entityTypeHint: 'organization',
      identifiers: [
        { type: 'official_domain', value: 'kindeticindustries.inc' },
      ],
    },
    expectedStatus: 'resolved',
    expectedSelectedCanonicalName: 'Kinetic Industries, Inc.',
    // Query AND an identifier are both present, so the production
    // AuthoritativeFirstUniversalEntityResolutionOrchestratorService runs its
    // identifiers-first preflight with the query blanked (see that class's
    // own docstring): existing_canonical's deterministic input depends only on
    // a non-empty query, so it is correctly never attempted on that pass, and
    // this identifier-only result already resolves before any name-only pass
    // would run.
    requiredAttemptedStages: ['email_domain'],
  },
  {
    id: 'external_company_public_web_candidate_only',
    description:
      'An external company absent from internal sources triggers public lookup automatically, but public-web evidence alone remains candidate-only.',
    input: {
      query: 'Victory Six',
      entityTypeHint: 'organization',
    },
    expectedStatus: 'ambiguous',
    requiredCandidateCanonicalNames: ['Victory Six, Inc.'],
    requiredAttemptedStages: ['existing_canonical', 'public_web'],
  },
  {
    id: 'external_company_misspelled_candidate_reconciliation',
    description:
      'A misspelled external company reaches public lookup and model-assisted candidate reconciliation without silently creating or merging identity.',
    input: {
      query: 'Kindetic Industries',
      entityTypeHint: 'organization',
    },
    expectedStatus: 'ambiguous',
    requiredCandidateCanonicalNames: ['Kinetic Industries, Inc.'],
    requiredAttemptedStages: [
      'existing_canonical',
      'public_web',
      'model_candidate_reconciliation',
    ],
  },
] as const;
