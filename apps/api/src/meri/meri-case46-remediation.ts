import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { MERI_CASE46 } from '@capiro/meriv2-core';
import { case46BudgetHash } from './meri-case46-provider-budget.js';

// Each reconciled, expired zero-dispatch failure gets exactly one retained-
// history recovery, bound to that failure's run, conversation, turn, claim,
// ledger and expiry. Its full $3 ceiling stays charged conservatively in the
// native journal. No public route accepts a proof; the fixed fixture operator
// must also reserve a fresh run. A later generation requires every earlier
// retirement record to be present and unchanged.
export const CASE46_REMEDIATION_PROOF =
  'df90662b3136f3a6aab7fe6d94e8b57fc93727004106cd9129735a8cb19255e5';
export const CASE46_RETIRED_SETUP_KEY = 'case46RetiredExecutionSetup';
/** Second failure (journal40): run 3a5b5609 rejected the provider reservation
 * on the former $3 capture ceiling before dispatch; one user turn retained. */
export const CASE46_REMEDIATION_PROOF_2 =
  '0d7ecf1e7768161398d995d3de1549a6d022e18bbaaa1306cd67d5aef9bf0795';
export const CASE46_RETIRED_SETUP_KEY_2 = 'case46RetiredExecutionSetup2';
/** Third failure (journal43): run 53ce0db1 dispatched the model once, but the
 * capture exposed no document read; the inexact export was refused and no
 * proposal was created. Its server-settled cost is known and retained. */
export const CASE46_REMEDIATION_PROOF_3 =
  'db04f809d08a7dd545a2430b506ac0cd7e7259cb427fa343ba2fe628478acbf6';
export const CASE46_RETIRED_SETUP_KEY_3 = 'case46RetiredExecutionSetup3';
/** Fourth failure (journal46): run 97c6fd26 reached the model; its export was
 * refused for a trailing-newline mismatch and its follow-up document read was
 * refused by the executor, so no proposal was created. Settled cost retained. */
export const CASE46_REMEDIATION_PROOF_4 =
  '0969ad8c8873ce43dd842b226e626b7f373c2ddb4917661743691b210be6f4dc';
export const CASE46_RETIRED_SETUP_KEY_4 = 'case46RetiredExecutionSetup4';

interface Case46RemediationGeneration {
  proof: string;
  retiredKey: string;
  failedRun: string;
  failedConversation: string;
  failedTurn: string;
  failedClaimSha: string;
  failedBudgetSha: string;
  expiredAt: number;
  /** Messages the failed conversation holds: the original turn, plus the
   * saved failure answer when the model was dispatched. */
  messages: bigint;
  /** Server-settled provider cost, or null when the run never dispatched. */
  knownCostMicros: number | null;
  /** Earlier retirements that must still be present, byte-for-byte. */
  priorRetired: ReadonlyArray<{ key: string; sha256: string }>;
}
const GENERATIONS: readonly Case46RemediationGeneration[] = [
  {
    proof: CASE46_REMEDIATION_PROOF,
    retiredKey: CASE46_RETIRED_SETUP_KEY,
    failedRun: 'e9ac5e1a-6562-49b6-b59b-139bd7ba8325',
    failedConversation: '3da337f0-975d-4787-822b-961f7bee37a1',
    failedTurn: '37f19804-9462-45c3-b51f-78a9ffe64a4b',
    failedClaimSha: '0de12eb3226c0f24b7330d3c1b2847263eaabd4ddad2c14de63f6b5cdac1bed3',
    failedBudgetSha: 'c1c674509fa9909798960f2cf80d9279b5e83398c7f158debd24d026bd2c1bf2',
    expiredAt: Date.parse('2026-10-05T01:25:09.429Z'),
    messages: 1n,
    knownCostMicros: null,
    priorRetired: [],
  },
  {
    proof: CASE46_REMEDIATION_PROOF_2,
    retiredKey: CASE46_RETIRED_SETUP_KEY_2,
    failedRun: '3a5b5609-c689-4cfd-bfd9-234b9607848c',
    failedConversation: '1f4bc759-1186-4584-8886-1d47a3c183fb',
    failedTurn: 'd8262711-8275-4f8e-aed7-825957484c2f',
    failedClaimSha: 'd8137fa4999ba29936bcc946d93f3f2c9c6977a9088ea9debe6d0e21e8a5037f',
    failedBudgetSha: 'a59aca054b9404da543cb81f0f92efd5a961afd4a815342353e0e6c72bb82841',
    expiredAt: Date.parse('2026-10-05T03:40:14.876Z'),
    messages: 1n,
    knownCostMicros: null,
    priorRetired: [
      {
        key: CASE46_RETIRED_SETUP_KEY,
        sha256: 'f61c82f5b748684000dc26bef3e4e6131cf059ddf21cc25df39a8e1ecdb25a7e',
      },
    ],
  },
  {
    proof: CASE46_REMEDIATION_PROOF_3,
    retiredKey: CASE46_RETIRED_SETUP_KEY_3,
    failedRun: '53ce0db1-c4f2-448f-a71a-47b45ee96bb4',
    failedConversation: 'f95c54d4-31a7-489f-87cf-22d0898358c0',
    failedTurn: 'a946a29c-b131-4db8-a41f-fd6d424fc1ef',
    failedClaimSha: '44e4459e1bc8fa4466a8f9bf1806870f984749760d38331791cc824c4556c5c0',
    failedBudgetSha: '803aa81ec5c538664b68a614816bab570f875bef1ffe0f6405277e2adc5e181c',
    expiredAt: Date.parse('2026-10-05T10:52:35.312Z'),
    messages: 2n,
    knownCostMicros: 1_187_250,
    priorRetired: [
      {
        key: CASE46_RETIRED_SETUP_KEY,
        sha256: 'f61c82f5b748684000dc26bef3e4e6131cf059ddf21cc25df39a8e1ecdb25a7e',
      },
      {
        key: CASE46_RETIRED_SETUP_KEY_2,
        sha256: '848e21925ae24107f860ee5760081a632e7f0a98f19f3eb9abf11a732f671cc5',
      },
    ],
  },
  {
    proof: CASE46_REMEDIATION_PROOF_4,
    retiredKey: CASE46_RETIRED_SETUP_KEY_4,
    failedRun: '97c6fd26-641a-431f-8798-31f3323feb8a',
    failedConversation: 'f10c4bed-c807-4713-917e-527a9eba6b58',
    failedTurn: 'b5ec602a-4575-44a9-8581-c13516e0bc7e',
    failedClaimSha: 'c4c40d5e5fe17ac5288dfcecf64c662837f82345ff69da08eb82f94be290d1e9',
    failedBudgetSha: '87ad55df8686c249ca8b5aaa624eaf0c93f3947c93a2c63fc7694be266edfb7f',
    expiredAt: Date.parse('2026-10-05T11:49:04.112Z'),
    messages: 2n,
    knownCostMicros: 3603300,
    priorRetired: [
      {
        key: CASE46_RETIRED_SETUP_KEY,
        sha256: 'f61c82f5b748684000dc26bef3e4e6131cf059ddf21cc25df39a8e1ecdb25a7e',
      },
      {
        key: CASE46_RETIRED_SETUP_KEY_2,
        sha256: '848e21925ae24107f860ee5760081a632e7f0a98f19f3eb9abf11a732f671cc5',
      },
      {
        key: CASE46_RETIRED_SETUP_KEY_3,
        sha256: '90a162713b27f443ec8aa05f5a36123340edfa351450d7d9d4efd0bd93af2914',
      },
    ],
  },
];
export const CASE46_REMEDIATION_PROOFS = GENERATIONS.map((g) => g.proof);
const fail = (): never => {
  throw new Error('meri_case46_setup_remediation_not_eligible');
};
function generation(proof: unknown): Case46RemediationGeneration {
  return GENERATIONS.find((g) => g.proof === proof) ?? fail();
}

/** Read-only eligibility is repeated under the tenant claim lock at execution.
 * The old conversation, source, messages, binding and budget are never changed. */
export async function assertCase46RemediationInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  fixture: Record<string, unknown>,
  input: { captureRunId: string; remediationProofSha256?: string },
): Promise<void> {
  const g = generation(input.remediationProofSha256);
  if (
    GENERATIONS.some((other) => other.failedRun === input.captureRunId) ||
    ctx.tenantId !== MERI_CASE46.tenantId ||
    ctx.userId !== MERI_CASE46.actorUserId ||
    ctx.role !== 'standard_user' ||
    fixture.fixtureNamespace !== MERI_CASE46.namespace ||
    fixture[g.retiredKey] !== undefined ||
    g.priorRetired.some(
      (prior) =>
        fixture[prior.key] === undefined || case46BudgetHash(fixture[prior.key]) !== prior.sha256,
    ) ||
    !fixture.case46ExecutionSetup ||
    case46BudgetHash(fixture.case46ExecutionSetup) !== g.failedClaimSha ||
    Date.now() <= g.expiredAt
  )
    fail();
  const rows = await tx.$queryRaw<Array<{ metadata: Record<string, unknown> }>>`
    SELECT metadata_jsonb AS metadata FROM clio_conversations
    WHERE id=${g.failedConversation}::uuid AND tenant_id=${ctx.tenantId}::uuid
      AND user_id=${ctx.userId}::uuid AND client_id=${MERI_CASE46.clientId}::uuid
      AND archived_at IS NULL AND status='active' FOR SHARE`;
  const budget = rows[0]?.metadata?.governedArtifactProviderBudget;
  if (rows.length !== 1 || !budget || case46BudgetHash(budget) !== g.failedBudgetSha) fail();
  const counts = await tx.$queryRaw<
    Array<{ messages: bigint; original: bigint; proposals: bigint; artifacts: bigint }>
  >`
    SELECT
      (SELECT count(*) FROM clio_messages WHERE tenant_id=${ctx.tenantId}::uuid AND conversation_id=${g.failedConversation}::uuid) AS messages,
      (SELECT count(*) FROM clio_messages WHERE tenant_id=${ctx.tenantId}::uuid AND conversation_id=${g.failedConversation}::uuid
        AND user_id=${ctx.userId}::uuid AND id=${g.failedTurn}::uuid AND role='user'
        AND body='Export that briefing and give me the file.') AS original,
      (SELECT count(*) FROM meri_action_proposals WHERE tenant_id=${ctx.tenantId}::uuid AND conversation_id=${g.failedConversation}::uuid) AS proposals,
      (SELECT count(*) FROM clio_artifacts WHERE tenant_id=${ctx.tenantId}::uuid AND conversation_id=${g.failedConversation}::uuid) AS artifacts`;
  if (
    counts.length !== 1 ||
    counts[0]!.messages !== g.messages ||
    counts[0]!.original !== 1n ||
    counts[0]!.proposals !== 0n ||
    counts[0]!.artifacts !== 0n
  )
    fail();
}

/** The retirement record written beside the new claim; earlier generations'
 * records are preserved by the caller's fixture spread. */
export function case46RetiredSetup(fixture: Record<string, unknown>, proof?: string) {
  const g = generation(proof ?? CASE46_REMEDIATION_PROOF);
  return {
    priorClaim: fixture.case46ExecutionSetup,
    failedConversationId: g.failedConversation,
    terminalProofSha256: g.proof,
    conservativeCostMicros: g.knownCostMicros ?? 3_000_000,
    actualCostMicros: g.knownCostMicros,
    acceptanceAuthority: false,
  };
}
export function case46RetiredSetupEntry(fixture: Record<string, unknown>, proof: string) {
  return { [generation(proof).retiredKey]: case46RetiredSetup(fixture, proof) };
}
