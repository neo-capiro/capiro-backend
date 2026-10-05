jest.mock('./meri-case46-authority.js', () => ({
  ...jest.requireActual('./meri-case46-authority.js'),
  assertCase46CurrentActorInTx: jest.fn(async () => undefined),
}));
import { MERI_CASE46 as f } from '@capiro/meriv2-core';
import {
  assertCase46RemediationInTx,
  CASE46_REMEDIATION_PROOF,
  CASE46_REMEDIATION_PROOF_2,
  CASE46_RETIRED_SETUP_KEY,
  CASE46_RETIRED_SETUP_KEY_2,
} from './meri-case46-remediation.js';
import { case46BudgetHash } from './meri-case46-provider-budget.js';
import { planCase46Setup, executeCase46Setup } from './meri-case46-setup-owner.js';

// Preserved evidence of the second failed run (journal40): the post-deadline
// conversation readback and the setup receipt whose hash completed the claim.
const native = require('../../../../docs/meri/releases/2026-10-04/c2-case46-recovery-outcome/native-post-deadline.json');
const setup = require('../../../../docs/meri/releases/2026-10-04/c2-case46-recovery-outcome/native-setup.json');
const firstClaim = {
  version: 1,
  caseId: '46',
  captureRunId: 'e9ac5e1a-6562-49b6-b59b-139bd7ba8325',
  recipeSha256: '51c9f2b6e560fcf2ee436953abe1d747488c088f0cca0b71e34f5959afb32d69',
  planSha256: '854cbf058f7290fc128b0ab0b596a8f0bed635538edecc200941a7fa8d79b382',
  status: 'COMPLETE',
  receiptSha256: '4075cf232dffc125225ffa3af21810b814508768c5083eca9a6c6dba1f6c716d',
};
const retiredFirst = {
  priorClaim: firstClaim,
  failedConversationId: '3da337f0-975d-4787-822b-961f7bee37a1',
  terminalProofSha256: CASE46_REMEDIATION_PROOF,
  conservativeCostMicros: 3000000,
  actualCostMicros: null,
  acceptanceAuthority: false,
};
const claim = {
  version: 1,
  caseId: '46',
  captureRunId: '3a5b5609-c689-4cfd-bfd9-234b9607848c',
  recipeSha256: '079a6f2055f5f95738e417a6b96a30e1eba018b06a6a8eb084c0aecf30c0ba7f',
  planSha256: setup.receipt.planSha256,
  status: 'COMPLETE',
  receiptSha256: case46BudgetHash(setup.receipt),
};
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
  captureRunId: '6c0f4b2e-5d61-4f0e-9a0a-2b4f9c1d7e35',
  ctx,
  remediationProofSha256: CASE46_REMEDIATION_PROOF_2,
  rateEvidence: {
    version: 1,
    caseId: '46',
    expiresAt: '2026-10-05T06:52:10.103Z',
    priceKind: 'qualified_text_token_upper_bound',
    maxAttempts: 16,
    maxTokens: 500000,
    // Declared accounting expectation above the former $3 cap: no longer capped.
    maxCostMicros: 15000000,
    rates: native.conversation.metadata.governedArtifactProviderBudget.qualification.rates,
  },
};
beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-05T05:30:00Z')));
afterEach(() => jest.useRealTimers());
function fixture() {
  return {
    fixtureNamespace: f.namespace,
    unrelated: 'preserved',
    [CASE46_RETIRED_SETUP_KEY]: structuredClone(retiredFirst),
    case46ExecutionSetup: structuredClone(claim),
  };
}
function ports() {
  let settings = { unrelatedSetting: true, meriFoundationFixture: fixture() };
  const metadata = structuredClone(native.conversation.metadata);
  const counts = { messages: 1n, original: 1n, proposals: 0n, artifacts: 0n };
  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{ settings: structuredClone(settings) }]),
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql.join('');
      if (text.includes('SELECT metadata_jsonb')) {
        // Only the second failure's conversation may be read for this proof.
        expect(values[0]).toBe('1f4bc759-1186-4584-8886-1d47a3c183fb');
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
test('the generation-2 binding reproduces the preserved second failure exactly', () => {
  expect(native.conversation.id).toBe('1f4bc759-1186-4584-8886-1d47a3c183fb');
  expect(native.messages).toEqual([
    {
      id: 'd8262711-8275-4f8e-aed7-825957484c2f',
      role: 'user',
      body: 'Export that briefing and give me the file.',
    },
  ]);
  expect(setup.receipt.captureRunId).toBe(claim.captureRunId);
  expect(setup.receipt.binding.expiresAt).toBe(Date.parse('2026-10-05T03:40:14.876Z'));
  expect(case46BudgetHash(claim)).toBe(
    'd8137fa4999ba29936bcc946d93f3f2c9c6977a9088ea9debe6d0e21e8a5037f',
  );
  expect(case46BudgetHash(native.conversation.metadata.governedArtifactProviderBudget)).toBe(
    'a59aca054b9404da543cb81f0f92efd5a961afd4a815342353e0e6c72bb82841',
  );
  expect(case46BudgetHash(retiredFirst)).toBe(
    'f61c82f5b748684000dc26bef3e4e6131cf059ddf21cc25df39a8e1ecdb25a7e',
  );
  expect(case46BudgetHash(firstClaim)).toBe(
    '0de12eb3226c0f24b7330d3c1b2847263eaabd4ddad2c14de63f6b5cdac1bed3',
  );
});
test('allows only the exact reconciled second failure and makes no writes', async () => {
  const p = ports();
  await assertCase46RemediationInTx(p.tx as never, ctx as never, fixture(), input);
  expect(p.tx.$executeRaw).not.toHaveBeenCalled();
  expect(p.tx.$queryRaw).toHaveBeenCalledTimes(2);
});
test.each([
  'proof',
  'first-proof',
  'first-run',
  'second-run',
  'missing-first-retirement',
  'changed-first-retirement',
  'already-retired',
  'tenant',
  'actor',
  'role',
  'namespace',
  'claim',
  'deadline',
  'budget',
  'messages',
  'original',
  'proposals',
  'artifacts',
])('rejects changed %s before any write', async (kind) => {
  const p = ports(),
    fxt: any = fixture(),
    actor: any = { ...ctx },
    recipe = { ...input };
  if (kind === 'proof') recipe.remediationProofSha256 = '0'.repeat(64);
  if (kind === 'first-proof') recipe.remediationProofSha256 = CASE46_REMEDIATION_PROOF;
  if (kind === 'first-run') recipe.captureRunId = firstClaim.captureRunId;
  if (kind === 'second-run') recipe.captureRunId = claim.captureRunId;
  if (kind === 'missing-first-retirement') delete fxt[CASE46_RETIRED_SETUP_KEY];
  if (kind === 'changed-first-retirement') fxt[CASE46_RETIRED_SETUP_KEY].conservativeCostMicros = 1;
  if (kind === 'already-retired') fxt[CASE46_RETIRED_SETUP_KEY_2] = {};
  if (kind === 'tenant') actor.tenantId = 'foreign';
  if (kind === 'actor') actor.userId = 'foreign';
  if (kind === 'role') actor.role = 'admin';
  if (kind === 'namespace') fxt.fixtureNamespace = 'foreign';
  if (kind === 'claim') fxt.case46ExecutionSetup.status = 'STARTED';
  if (kind === 'deadline') jest.setSystemTime(new Date('2026-10-05T03:40:14.876Z'));
  if (kind === 'budget') p.metadata.governedArtifactProviderBudget.ledger.chargedAttempts = 1;
  if (kind === 'messages') p.counts.messages = 2n;
  if (kind === 'original') p.counts.original = 0n;
  if (kind === 'proposals') p.counts.proposals = 1n;
  if (kind === 'artifacts') p.counts.artifacts = 1n;
  await expect(assertCase46RemediationInTx(p.tx as never, actor, fxt, recipe)).rejects.toThrow(
    'remediation_not_eligible',
  );
  expect(p.tx.$executeRaw).not.toHaveBeenCalled();
});
test('the real setup owner retires the second failure beside the first before any new source effect and rejects replay', async () => {
  const p = ports();
  const plan = await planCase46Setup(p.runtime as never, input);
  expect(p.tx.$executeRaw).not.toHaveBeenCalled();
  await expect(
    executeCase46Setup(p.runtime as never, input, plan.planSha256, () => {}),
  ).rejects.toThrow('reconciliation_required');
  expect(p.settings().meriFoundationFixture).toMatchObject({
    unrelated: 'preserved',
    [CASE46_RETIRED_SETUP_KEY]: retiredFirst,
    [CASE46_RETIRED_SETUP_KEY_2]: {
      priorClaim: claim,
      failedConversationId: '1f4bc759-1186-4584-8886-1d47a3c183fb',
      terminalProofSha256: CASE46_REMEDIATION_PROOF_2,
      conservativeCostMicros: 3000000,
      actualCostMicros: null,
      acceptanceAuthority: false,
    },
    case46ExecutionSetup: { captureRunId: input.captureRunId, status: 'STARTED' },
  });
  expect(p.metadata).toEqual(native.conversation.metadata);
  expect(p.runtime.createSource).toHaveBeenCalledTimes(1);
  expect(p.runtime.createConversation).not.toHaveBeenCalled();
  await expect(
    executeCase46Setup(p.runtime as never, input, plan.planSha256, () => {}),
  ).rejects.toThrow('reconciliation_required');
  expect(p.tx.$executeRaw).toHaveBeenCalledTimes(1);
  expect(p.runtime.createSource).toHaveBeenCalledTimes(1);
});
test('ordinary setup still rejects the existing claim without a reconciled proof', async () => {
  const p = ports();
  const { remediationProofSha256: _proof, ...ordinary } = input;
  await expect(planCase46Setup(p.runtime as never, ordinary)).rejects.toThrow(
    'existing_claim_requires_reconciliation',
  );
  expect(p.tx.$executeRaw).not.toHaveBeenCalled();
});
