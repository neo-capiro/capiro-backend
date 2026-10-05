import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { MERI_CASE46 } from '@capiro/meriv2-core';
import { case46BudgetHash } from './meri-case46-provider-budget.js';

// This one failed capture was reconciled after expiry in native journal37.
// Its full $3 ceiling remains charged conservatively. No public route accepts
// this proof; the fixed fixture operator must also reserve a fresh run.
export const CASE46_REMEDIATION_PROOF =
  'df90662b3136f3a6aab7fe6d94e8b57fc93727004106cd9129735a8cb19255e5';
export const CASE46_RETIRED_SETUP_KEY = 'case46RetiredExecutionSetup';
const FAILED_RUN = 'e9ac5e1a-6562-49b6-b59b-139bd7ba8325';
const FAILED_CONVERSATION = '3da337f0-975d-4787-822b-961f7bee37a1';
const FAILED_TURN = '37f19804-9462-45c3-b51f-78a9ffe64a4b';
const FAILED_CLAIM_SHA = '0de12eb3226c0f24b7330d3c1b2847263eaabd4ddad2c14de63f6b5cdac1bed3';
const FAILED_BUDGET_SHA = 'c1c674509fa9909798960f2cf80d9279b5e83398c7f158debd24d026bd2c1bf2';
const EXPIRED_AT = Date.parse('2026-10-05T01:25:09.429Z');
const fail = (): never => {
  throw new Error('meri_case46_setup_remediation_not_eligible');
};

/** Read-only eligibility is repeated under the tenant claim lock at execution.
 * The old conversation, source, messages, binding and budget are never changed. */
export async function assertCase46RemediationInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  fixture: Record<string, unknown>,
  input: { captureRunId: string; remediationProofSha256?: string },
): Promise<void> {
  if (
    input.remediationProofSha256 !== CASE46_REMEDIATION_PROOF ||
    input.captureRunId === FAILED_RUN ||
    ctx.tenantId !== MERI_CASE46.tenantId ||
    ctx.userId !== MERI_CASE46.actorUserId ||
    ctx.role !== 'standard_user' ||
    fixture.fixtureNamespace !== MERI_CASE46.namespace ||
    fixture[CASE46_RETIRED_SETUP_KEY] !== undefined ||
    !fixture.case46ExecutionSetup ||
    case46BudgetHash(fixture.case46ExecutionSetup) !== FAILED_CLAIM_SHA ||
    Date.now() <= EXPIRED_AT
  )
    fail();
  const rows = await tx.$queryRaw<Array<{ metadata: Record<string, unknown> }>>`
    SELECT metadata_jsonb AS metadata FROM clio_conversations
    WHERE id=${FAILED_CONVERSATION}::uuid AND tenant_id=${ctx.tenantId}::uuid
      AND user_id=${ctx.userId}::uuid AND client_id=${MERI_CASE46.clientId}::uuid
      AND archived_at IS NULL AND status='active' FOR SHARE`;
  const budget = rows[0]?.metadata?.governedArtifactProviderBudget;
  if (rows.length !== 1 || !budget || case46BudgetHash(budget) !== FAILED_BUDGET_SHA) fail();
  const counts = await tx.$queryRaw<
    Array<{ messages: bigint; original: bigint; proposals: bigint; artifacts: bigint }>
  >`
    SELECT
      (SELECT count(*) FROM clio_messages WHERE tenant_id=${ctx.tenantId}::uuid AND conversation_id=${FAILED_CONVERSATION}::uuid) AS messages,
      (SELECT count(*) FROM clio_messages WHERE tenant_id=${ctx.tenantId}::uuid AND conversation_id=${FAILED_CONVERSATION}::uuid
        AND user_id=${ctx.userId}::uuid AND id=${FAILED_TURN}::uuid AND role='user'
        AND body='Export that briefing and give me the file.') AS original,
      (SELECT count(*) FROM meri_action_proposals WHERE tenant_id=${ctx.tenantId}::uuid AND conversation_id=${FAILED_CONVERSATION}::uuid) AS proposals,
      (SELECT count(*) FROM clio_artifacts WHERE tenant_id=${ctx.tenantId}::uuid AND conversation_id=${FAILED_CONVERSATION}::uuid) AS artifacts`;
  if (
    counts.length !== 1 ||
    counts[0]!.messages !== 1n ||
    counts[0]!.original !== 1n ||
    counts[0]!.proposals !== 0n ||
    counts[0]!.artifacts !== 0n
  )
    fail();
}

export function case46RetiredSetup(fixture: Record<string, unknown>) {
  return {
    priorClaim: fixture.case46ExecutionSetup,
    failedConversationId: FAILED_CONVERSATION,
    terminalProofSha256: CASE46_REMEDIATION_PROOF,
    conservativeCostMicros: 3_000_000,
    actualCostMicros: null,
    acceptanceAuthority: false,
  };
}
