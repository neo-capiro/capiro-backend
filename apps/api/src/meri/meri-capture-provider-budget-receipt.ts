import {
  completeMeriCaptureEvidenceReceipt,
  signMeriCaptureEvidenceReceipt,
  type MeriServerReadonlyCapturePolicy,
  type SignedMeriCaptureEvidenceReceipt,
} from '@capiro/meriv2-core';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { captureProviderBudgetOwner } from './meri-capture-provider-budget-owner.js';
import {
  captureBudgetHash,
  captureBudgetRequired,
  captureProviderBudgetCoverage,
} from './meri-capture-provider-budget.js';

/** Compose only an actual current owner readback, never an orchestrator claim. */
export async function bindCaptureProviderBudgetReceipt(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy;
  envelope: SignedMeriCaptureEvidenceReceipt;
}): Promise<SignedMeriCaptureEvidenceReceipt> {
  if (!captureBudgetRequired(args.policy)) return args.envelope;
  const { state } = await captureProviderBudgetOwner({ ...args, operation: { kind: 'read' } });
  const budget = state.ledger;
  const providerBudget = {
    version: 1 as const,
    boundary: captureProviderBudgetCoverage(args.policy.caseId),
    status:
      budget.attempts.length &&
      budget.attempts.every((attempt) => ['settled', 'rejected'].includes(attempt.status))
        ? ('SETTLED' as const)
        : ('UNSETTLED' as const),
    admissionId: state.admissionId,
    turnId: args.policy.turnId!,
    ledgerSha256: captureBudgetHash(state),
    qualificationSha256: state.qualificationSha256,
    attempts: budget.chargedAttempts,
    chargedTokens: budget.chargedTokens,
    chargedCostMicros: budget.chargedCostMicros,
    maxCostMicros: budget.limits.maxCostMicros,
    // Exact case-specific API plan/tool guards prevent unaccounted native
    // dispatch. Titan/NVIDIA ingress shares the pre-context ledger.
    unaccountedBoundaries: [] as const,
  };
  const receipt = completeMeriCaptureEvidenceReceipt({
    ...args.envelope.receipt,
    providerBudget,
    effects: {
      ...args.envelope.receipt.effects,
      writes: [
        ...args.envelope.receipt.effects.writes,
        {
          logicalWriteId: `${args.policy.requestId}:provider-budget-ledger`,
          kind: 'provider_budget_ledger',
          phase: 'during',
          status: 'observed',
          recordId: args.policy.conversationId,
        },
      ],
      logicalEffects: [
        ...args.envelope.receipt.effects.logicalEffects,
        {
          logicalEffectId: `${args.policy.requestId}:provider-budget-ledger`,
          operationId: state.admissionId,
          receiptId: providerBudget.ledgerSha256,
          status: 'observed',
        },
      ],
    },
  });
  return signMeriCaptureEvidenceReceipt(receipt, process.env.INTERNAL_SERVICE_SECRET);
}
