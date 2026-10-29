/** Browser-safe request and identity contract for Core's retained brief refresh. */
export interface PrepareBriefRefreshInput {
  proposalId: string;
  expectedVersionNumber: number;
  keepUserEdits: boolean;
}
export interface AcceptBriefRefreshInput {
  proposalId: string;
  proposalHash: string;
}
export interface RetainedBriefRefreshIdentity extends PrepareBriefRefreshInput {
  tenantId: string;
  prospectId: string;
  briefId: string;
  baseVersionId: string;
  createdByUserId: string;
  proposalHash: string;
  sourceHash: string;
  createdAt: string;
}
export function isPrepareBriefRefreshInput(value: unknown): value is PrepareBriefRefreshInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).sort().join() === 'expectedVersionNumber,keepUserEdits,proposalId' &&
    typeof v.proposalId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      v.proposalId,
    ) &&
    Number.isInteger(v.expectedVersionNumber) &&
    Number(v.expectedVersionNumber) >= 1 &&
    Number(v.expectedVersionNumber) <= 100 &&
    typeof v.keepUserEdits === 'boolean'
  );
}
export function isAcceptBriefRefreshInput(value: unknown): value is AcceptBriefRefreshInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).sort().join() === 'proposalHash,proposalId' &&
    isPrepareBriefRefreshInput({
      proposalId: v.proposalId,
      expectedVersionNumber: 1,
      keepUserEdits: true,
    }) &&
    typeof v.proposalHash === 'string' &&
    /^[0-9a-f]{64}$/.test(v.proposalHash)
  );
}
