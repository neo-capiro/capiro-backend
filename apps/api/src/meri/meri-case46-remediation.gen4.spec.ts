jest.mock('./meri-case46-authority.js', () => ({
  ...jest.requireActual('./meri-case46-authority.js'),
  assertCase46CurrentActorInTx: jest.fn(async () => undefined),
}));
import { MERI_CASE46 as f } from '@capiro/meriv2-core';
import {
  assertCase46RemediationInTx,
  CASE46_REMEDIATION_PROOF,
  CASE46_REMEDIATION_PROOF_2,
  CASE46_REMEDIATION_PROOF_3,
  CASE46_REMEDIATION_PROOF_4,
  CASE46_RETIRED_SETUP_KEY,
  CASE46_RETIRED_SETUP_KEY_2,
  CASE46_RETIRED_SETUP_KEY_3,
  CASE46_RETIRED_SETUP_KEY_4,
} from './meri-case46-remediation.js';
import { case46BudgetHash } from './meri-case46-provider-budget.js';
import { planCase46Setup, executeCase46Setup } from './meri-case46-setup-owner.js';

// Preserved evidence of the fourth failed run (journal46) and the earlier ones.
const dir = '../../../../docs/meri/releases/2026-10-05/';
const native = require(dir + 'c2-case46-gen4-outcome/native-terminal-read.json');
const setup = require(dir + 'c2-case46-gen4-outcome/native-setup.json');
const planned = require(dir + 'c2-case46-gen4-outcome/native-plan.json');
const setup3 = require(dir + 'c2-case46-gen3-outcome/native-setup.json');
const planned3 = require(dir + 'c2-case46-gen3-outcome/native-plan.json');
const claimOf = (s: any, p: any) => ({
  version: 1,
  caseId: '46',
  captureRunId: s.receipt.captureRunId,
  recipeSha256: p.plan.recipeSha256,
  planSha256: s.receipt.planSha256,
  status: 'COMPLETE',
  receiptSha256: case46BudgetHash(s.receipt),
});
const retired = (
  priorClaim: unknown,
  failedConversationId: string,
  terminalProofSha256: string,
  cost: number | null,
) => ({
  priorClaim,
  failedConversationId,
  terminalProofSha256,
  conservativeCostMicros: cost ?? 3000000,
  actualCostMicros: cost,
  acceptanceAuthority: false,
});
const firstClaim = {
  version: 1,
  caseId: '46',
  captureRunId: 'e9ac5e1a-6562-49b6-b59b-139bd7ba8325',
  recipeSha256: '51c9f2b6e560fcf2ee436953abe1d747488c088f0cca0b71e34f5959afb32d69',
  planSha256: '854cbf058f7290fc128b0ab0b596a8f0bed635538edecc200941a7fa8d79b382',
  status: 'COMPLETE',
  receiptSha256: '4075cf232dffc125225ffa3af21810b814508768c5083eca9a6c6dba1f6c716d',
};
const secondClaim = {
  version: 1,
  caseId: '46',
  captureRunId: '3a5b5609-c689-4cfd-bfd9-234b9607848c',
  recipeSha256: '079a6f2055f5f95738e417a6b96a30e1eba018b06a6a8eb084c0aecf30c0ba7f',
  planSha256: '31d339ba671b0e74a5b819f31ddc7acfc19d7977122145304f25f9e5e4530e57',
  status: 'COMPLETE',
  receiptSha256: '2db74f7c58a6ff3018d22ea1120a70d63e2961c5bd035a737ca4c975237ee8ef',
};
const retiredFirst = retired(firstClaim, '3da337f0-975d-4787-822b-961f7bee37a1', CASE46_REMEDIATION_PROOF, null);
const retiredSecond = retired(secondClaim, '1f4bc759-1186-4584-8886-1d47a3c183fb', CASE46_REMEDIATION_PROOF_2, null);
const retiredThird = retired(claimOf(setup3, planned3), 'f95c54d4-31a7-489f-87cf-22d0898358c0', CASE46_REMEDIATION_PROOF_3, 1187250);
const claim = claimOf(setup, planned);
const ctx = {
  tenantId: f.tenantId,
  tenantSlug: f.tenantSlug,
  userId: f.actorUserId,
  role: 'standard_user',
  clerkUserId: 'user_owned_test',
} as const;
const input = {
  version: 1,
  caseId: '46',
  fixtureNamespace: f.namespace,
  captureRunId: '5d2b0f4e-91c3-4e7a-8b6f-0a2c9e7d4f11',
  ctx,
  remediationProofSha256: CASE46_REMEDIATION_PROOF_4,
  rateEvidence: {
    version: 1,
    caseId: '46',
    expiresAt: '2026-10-05T18:00:00.000Z',
    priceKind: 'qualified_text_token_upper_bound',
    maxAttempts: 16,
    maxTokens: 500000,
    maxCostMicros: 4000000,
    rates: native.conversation.metadata.governedArtifactProviderBudget.qualification.rates,
  },
};
beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-05T12:30:00Z')));
afterEach(() => jest.useRealTimers());
function fixture() {
  return {
    fixtureNamespace: f.namespace,
    unrelated: 'preserved',
    [CASE46_RETIRED_SETUP_KEY]: structuredClone(retiredFirst),
    [CASE46_RETIRED_SETUP_KEY_2]: structuredClone(retiredSecond),
    [CASE46_RETIRED_SETUP_KEY_3]: structuredClone(retiredThird),
    case46ExecutionSetup: structuredClone(claim),
  };
}
function ports() {
  let settings = { unrelatedSetting: true, meriFoundationFixture: fixture() };
  const metadata = structuredClone(native.conversation.metadata);
  const counts = { messages: 2n, original: 1n, proposals: 0n, artifacts: 0n };
  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{ settings: structuredClone(settings) }]),
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql.join('');
      if (text.includes('SELECT metadata_jsonb')) {
        expect(values[0]).toBe(native.conversation.id);
        return [{ metadata }];
      }
      if (text.includes('AS messages')) return [counts];
      if (text.includes('AS sources')) return [{ sources: 0n, conversations: 0n }];
      throw new Error('unexpected SQL');
    }),
    $executeRaw: jest.fn(
      async (_sql: TemplateStringsArray, next: string, _tenant: string, prior: string) => {
        if (JSON.stringify(settings) !== prior) return 0;
        settings = JSON.parse(next);
        return 1;
      },
    ),
  };
  const runtime = {
    deps: { prisma: { withTenantUser: async (_t: string, _u: string, fn: any) => fn(tx) } },
    createSource: jest.fn(async () => {
      throw new Error('stop after claim');
    }),
    createConversation: jest.fn(),
  };
  return { tx, metadata, counts, runtime, settings: () => settings };
}
test('the generation-4 binding reproduces the preserved fourth failure exactly', () => {
  expect(native.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
  expect(native.messages[0].body).toBe(f.prompt);
  expect(native.proposals).toBe(0);
  expect(native.artifacts).toBe(0);
  expect(case46BudgetHash(claim)).toBe('c4c40d5e5fe17ac5288dfcecf64c662837f82345ff69da08eb82f94be290d1e9');
  expect(case46BudgetHash(native.conversation.metadata.governedArtifactProviderBudget)).toBe('87ad55df8686c249ca8b5aaa624eaf0c93f3947c93a2c63fc7694be266edfb7f');
  expect(case46BudgetHash(retiredThird)).toBe('90a162713b27f443ec8aa05f5a36123340edfa351450d7d9d4efd0bd93af2914');
});
test('allows only the exact reconciled fourth failure and makes no writes', async () => {
  const p = ports();
  await assertCase46RemediationInTx(p.tx as never, ctx as never, fixture(), input);
  expect(p.tx.$executeRaw).not.toHaveBeenCalled();
});
test.each(['earlier-proof', 'prior-run', 'missing-third-retirement', 'already-retired', 'deadline', 'messages', 'proposals'])(
  'rejects changed %s before any write',
  async (kind) => {
    const p = ports(),
      fxt: any = fixture(),
      recipe = { ...input };
    if (kind === 'earlier-proof') recipe.remediationProofSha256 = CASE46_REMEDIATION_PROOF_3;
    if (kind === 'prior-run') recipe.captureRunId = claim.captureRunId;
    if (kind === 'missing-third-retirement') delete fxt[CASE46_RETIRED_SETUP_KEY_3];
    if (kind === 'already-retired') fxt[CASE46_RETIRED_SETUP_KEY_4] = {};
    if (kind === 'deadline') jest.setSystemTime(new Date(setup.receipt.binding.expiresAt));
    if (kind === 'messages') p.counts.messages = 1n;
    if (kind === 'proposals') p.counts.proposals = 1n;
    await expect(assertCase46RemediationInTx(p.tx as never, ctx as never, fxt, recipe)).rejects.toThrow(
      'remediation_not_eligible',
    );
    expect(p.tx.$executeRaw).not.toHaveBeenCalled();
  },
);
test('the real setup owner retires the fourth failure beside the first three', async () => {
  const p = ports();
  const plan = await planCase46Setup(p.runtime as never, input);
  await expect(
    executeCase46Setup(p.runtime as never, input, plan.planSha256, () => {}),
  ).rejects.toThrow('reconciliation_required');
  expect(p.settings().meriFoundationFixture).toMatchObject({
    unrelated: 'preserved',
    [CASE46_RETIRED_SETUP_KEY]: retiredFirst,
    [CASE46_RETIRED_SETUP_KEY_2]: retiredSecond,
    [CASE46_RETIRED_SETUP_KEY_3]: retiredThird,
    [CASE46_RETIRED_SETUP_KEY_4]: {
      priorClaim: claim,
      failedConversationId: native.conversation.id,
      terminalProofSha256: CASE46_REMEDIATION_PROOF_4,
      conservativeCostMicros: 3603300,
      actualCostMicros: 3603300,
      acceptanceAuthority: false,
    },
    case46ExecutionSetup: { captureRunId: input.captureRunId, status: 'STARTED' },
  });
  expect(p.tx.$executeRaw).toHaveBeenCalledTimes(1);
});
