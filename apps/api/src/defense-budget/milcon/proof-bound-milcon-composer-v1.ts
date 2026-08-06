/**
 * Proof-bound MILCON family composer.
 *
 * The original Phase 5 composer predates the account-complete identity
 * supplement and used location/installation as the final natural-key segment.
 * This wrapper gives the legacy pure composer a deterministic account-specific
 * discriminator, then restores the true manifest-owned native key in the
 * report. It prevents C-1/DD1391 comparison or certification across accounts.
 */
import type {
  BudgetComponentV1,
  BudgetLineIdentityV1,
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
} from '../contracts/extraction-artifact-v1.js';
import type { JsonValue } from '../contracts/canonical-json.js';
import { sha256CanonicalJson } from '../contracts/canonical-json.js';
import { buildPhase5MilconNativeIdentityV1 } from '../non-rdte/milcon-native-identity-supplement-v1.js';
import {
  composeMilconFamily,
  type MilconCompositionInput,
  type MilconFamilyReport,
} from './milcon-composer-v1.js';

export interface ProofBoundMilconCompositionInput extends MilconCompositionInput {
  accountByDocumentKey: ReadonlyMap<string, string>;
}

export class ProofBoundMilconCompositionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ProofBoundMilconCompositionError';
  }
}

type ConcreteBudgetComponentV1 = Exclude<BudgetComponentV1, 'OTHER' | 'UNKNOWN'>;

function requireConcreteMilconComponent(component: BudgetComponentV1): ConcreteBudgetComponentV1 {
  if (component === 'OTHER' || component === 'UNKNOWN') {
    throw new ProofBoundMilconCompositionError(
      `MILCON identity requires a concrete component, received ${component}`,
      'milcon_component_ambiguous',
    );
  }
  return component;
}

function milconIdentityOf(
  assertion: DefenseBudgetAssertionV1,
): Extract<BudgetLineIdentityV1, { lineKind: 'MILCON_PROJECT' }> | null {
  switch (assertion.assertionKind) {
    case 'milcon_project':
      return assertion.identity;
    case 'funding':
    case 'quantity':
    case 'unit_cost':
    case 'narrative':
      return assertion.identity.lineKind === 'MILCON_PROJECT' ? assertion.identity : null;
    default:
      return null;
  }
}

function discriminatorLocation(location: string | undefined, account: string): string {
  const loc = location?.trim().toUpperCase() || 'NO_LOC';
  return `${loc}__ACCT_${sha256CanonicalJson(account as JsonValue)
    .slice(0, 16)
    .toUpperCase()}`;
}

function legacyKey(identity: {
  component: string;
  projectCode: string;
  location?: string;
}): string {
  const loc = identity.location?.trim().toUpperCase() || 'NO_LOC';
  return `MILCON_PROJECT:${identity.component}:${identity.projectCode.trim().toUpperCase()}:${loc}:${loc}`;
}

function replaceStrings<T>(value: T, replacements: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') {
    let result: string = value;
    for (const [from, to] of replacements) result = result.split(from).join(to);
    return result as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceStrings(item, replacements)) as unknown as T;
  }
  if (value != null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = replaceStrings(child, replacements);
    }
    return out as unknown as T;
  }
  return value;
}

function normalizeArtifact(input: {
  artifact: DefenseBudgetExtractionArtifactV1;
  accountByDocumentKey: ReadonlyMap<string, string>;
  normalizedToActual: Map<string, string>;
  actualToNormalized: Map<string, string>;
}): DefenseBudgetExtractionArtifactV1 {
  const artifact = structuredClone(input.artifact);
  const account = input.accountByDocumentKey.get(artifact.source.manifestDocumentKey)?.trim();
  if (!account) {
    throw new ProofBoundMilconCompositionError(
      `MILCON document ${artifact.source.manifestDocumentKey} has no manifest account`,
      'milcon_account_missing',
    );
  }

  for (const assertion of artifact.assertions) {
    const identity = milconIdentityOf(assertion);
    if (identity == null) continue;
    const actual = buildPhase5MilconNativeIdentityV1({
      lineKind: 'MILCON_PROJECT',
      projectCode: identity.projectCode,
      component: requireConcreteMilconComponent(identity.component),
      account,
      ...(identity.location != null ? { location: identity.location } : {}),
    }).naturalKey;
    const encoded = discriminatorLocation(identity.location, account);
    const normalized = legacyKey({ ...identity, location: encoded });
    const prior = input.normalizedToActual.get(normalized);
    if (prior != null && prior !== actual) {
      throw new ProofBoundMilconCompositionError(
        `MILCON identity discriminator collision for ${normalized}`,
        'milcon_identity_collision',
      );
    }
    input.normalizedToActual.set(normalized, actual);
    input.actualToNormalized.set(actual, normalized);
  }

  artifact.assertions = artifact.assertions.map((assertion) => {
    const identity = milconIdentityOf(assertion);
    if (identity == null) {
      if (assertion.assertionKind !== 'document_fact') return assertion;
      const raw = assertion.metadata?.identityNaturalKey;
      if (typeof raw !== 'string') return assertion;
      return {
        ...assertion,
        metadata: {
          ...(assertion.metadata ?? {}),
          account,
          identityNaturalKey: replaceStrings(raw, input.actualToNormalized),
        },
      };
    }
    const encoded = discriminatorLocation(identity.location, account);
    const normalizedIdentity: typeof identity = { ...identity, location: encoded };
    if (assertion.assertionKind === 'milcon_project') {
      return {
        ...assertion,
        identity: normalizedIdentity,
        metadata: {
          ...(assertion.metadata ?? {}),
          account,
          installation: encoded,
        },
      };
    }
    if (
      assertion.assertionKind === 'funding' ||
      assertion.assertionKind === 'quantity' ||
      assertion.assertionKind === 'unit_cost' ||
      assertion.assertionKind === 'narrative'
    ) {
      return {
        ...assertion,
        identity: normalizedIdentity,
        metadata: { ...(assertion.metadata ?? {}), account },
      };
    }
    return assertion;
  });

  artifact.warnings = artifact.warnings.map((warning) => ({
    ...warning,
    message: replaceStrings(warning.message, input.actualToNormalized),
  }));
  return artifact;
}

export function composeProofBoundMilconFamily(
  input: ProofBoundMilconCompositionInput,
): MilconFamilyReport {
  const normalizedToActual = new Map<string, string>();
  const actualToNormalized = new Map<string, string>();
  const c1Artifacts = input.artifacts.c1Artifacts.map((artifact) =>
    normalizeArtifact({
      artifact,
      accountByDocumentKey: input.accountByDocumentKey,
      normalizedToActual,
      actualToNormalized,
    }),
  );
  const dd1391Artifacts = input.artifacts.dd1391Artifacts.map((artifact) =>
    normalizeArtifact({
      artifact,
      accountByDocumentKey: input.accountByDocumentKey,
      normalizedToActual,
      actualToNormalized,
    }),
  );
  const report = composeMilconFamily({
    artifacts: { c1Artifacts, dd1391Artifacts },
    requiredIdentityKeys: input.requiredIdentityKeys.map((key) =>
      replaceStrings(key, actualToNormalized),
    ),
    dd1391Required: input.dd1391Required,
    requiredNarrativeSections: input.requiredNarrativeSections,
  });
  return replaceStrings(report, normalizedToActual);
}
