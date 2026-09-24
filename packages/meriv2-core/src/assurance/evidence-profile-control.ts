import type { AssuranceSurface } from './risk-gate';
import {
  buildClaimLedgerFromToolResults,
  compareEvidenceClassification,
  type CitationLike,
  type EvidenceClassificationComparison,
} from './tool-ledger-adapter';
import type { DomainEvidencePlan } from './evidence-plan';
import type { ClaimLedger } from './claim-ledger';
import type { LedgerEntry } from '../grounding/auditor';
import {
  resolveEvidenceProfilesMode,
} from '../rollout/evidence-profiles';
import type { CapabilityRolloutEnvironment } from '../rollout/capability-rollout';

export interface EvidenceProfilesShadowEvent extends EvidenceClassificationComparison {
  surface: AssuranceSurface;
  callSite: string;
}

/**
 * Applies the evidence-profile rollout without allowing shadow comparison or
 * logging failures to affect the ledger returned to the caller.
 */
export function buildControlledClaimLedger(input: {
  output: string;
  ledgerEntries: readonly LedgerEntry[];
  citations?: readonly CitationLike[];
  plan?: DomainEvidencePlan;
  env: CapabilityRolloutEnvironment;
  tenantId: string | null | undefined;
  surface: AssuranceSurface;
  callSite: string;
  logShadow?: (event: 'meri.evidence_profiles.shadow', fields: EvidenceProfilesShadowEvent) => void;
}): ClaimLedger {
  const mode = resolveEvidenceProfilesMode(input.env, input.tenantId, input.surface);
  const ledgerInput = {
    output: input.output,
    ledgerEntries: input.ledgerEntries,
    citations: input.citations,
    plan: input.plan,
  };
  const ledger = buildClaimLedgerFromToolResults({
    ...ledgerInput,
    classification: mode === 'enforce' ? 'profiles' : 'legacy',
  });
  if (mode === 'shadow') {
    try {
      input.logShadow?.('meri.evidence_profiles.shadow', {
        surface: input.surface,
        callSite: input.callSite,
        ...compareEvidenceClassification(ledgerInput),
      });
    } catch {
      // Measurement must never affect the released turn.
    }
  }
  return ledger;
}
