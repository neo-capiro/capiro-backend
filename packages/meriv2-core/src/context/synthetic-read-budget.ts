/** Accounting identity only. This is not fixture, citation, or capture authority. */
export interface MeriSyntheticReadBudgetBinding {
  version: 1;
  kind: 'synthetic_read_budget_only';
  caseId: '01' | '02' | '03' | '04' | '05';
  captureRunId: string;
  aggregateReservationId: string;
  qualificationSha256: string;
}

export function validateMeriSyntheticReadBudgetGuard(policy: {
  syntheticReadBudget?: MeriSyntheticReadBudgetBinding;
  caseId: string | null;
  captureRunId: string | null;
  fixtureVersion: string | null;
  physicalMapSha256: string | null;
  resetReceiptId: string | null;
  seedReceiptId: string | null;
  expectedCaptureWrites: readonly (string | undefined)[];
}): void {
  const b = policy.syntheticReadBudget;
  if (b === undefined) return;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (
    !b ||
    b.version !== 1 ||
    b.kind !== 'synthetic_read_budget_only' ||
    !['01', '02', '03', '04', '05'].includes(b.caseId) ||
    !uuid.test(b.captureRunId) ||
    !uuid.test(b.aggregateReservationId) ||
    !/^[a-f0-9]{64}$/.test(b.qualificationSha256) ||
    Object.keys(b).sort().join(',') !==
      'aggregateReservationId,captureRunId,caseId,kind,qualificationSha256,version' ||
    [
      policy.caseId,
      policy.captureRunId,
      policy.fixtureVersion,
      policy.physicalMapSha256,
      policy.resetReceiptId,
      policy.seedReceiptId,
    ].some((v) => v !== null) ||
    policy.expectedCaptureWrites.join(',') !==
      'context_packet_and_evidence,conversation_user_message,conversation_assistant_message,provider_budget_ledger'
  )
    throw new Error('meri_synthetic_read_budget_guard_invalid');
}
