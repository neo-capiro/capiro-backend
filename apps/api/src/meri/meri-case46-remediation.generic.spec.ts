jest.mock('./meri-case46-authority.js', () => ({
  ...jest.requireActual('./meri-case46-authority.js'),
  assertCase46CurrentActorInTx: jest.fn(async () => undefined),
}));
import { MERI_CASE46 as f } from '@capiro/meriv2-core';
import {
  assertCase46RemediationInTx,
  case46RetiredKey,
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

// Preserved evidence of the fifth failed run (journal49) and the earlier ones.
const dir = '../../../../docs/meri/releases/2026-10-05/';
const native = require(dir + 'c2-case46-gen5-outcome/native-terminal-read.json');
const setup = require(dir + 'c2-case46-gen5-outcome/native-setup.json');
const planned = require(dir + 'c2-case46-gen5-outcome/native-plan.json');
const setup4 = require(dir + 'c2-case46-gen4-outcome/native-setup.json');
const planned4 = require(dir + 'c2-case46-gen4-outcome/native-plan.json');
const setup3 = require(dir + 'c2-case46-gen3-outcome/native-setup.json');
const planned3 = require(dir + 'c2-case46-gen3-outcome/native-plan.json');
// sha256 of the operator's native close proof for the fifth run (close-proof.json).
const PROOF_5 = '3f0678327c8e8fc027e818cdfecb96bb16bfd1581ffc903c68a6d7f83604b9ad';
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
const retiredRecords = {
  [CASE46_RETIRED_SETUP_KEY]: retired(
    firstClaim,
    '3da337f0-975d-4787-822b-961f7bee37a1',
    CASE46_REMEDIATION_PROOF,
    null,
  ),
  [CASE46_RETIRED_SETUP_KEY_2]: retired(
    secondClaim,
    '1f4bc759-1186-4584-8886-1d47a3c183fb',
    CASE46_REMEDIATION_PROOF_2,
    null,
  ),
  [CASE46_RETIRED_SETUP_KEY_3]: retired(
    claimOf(setup3, planned3),
    'f95c54d4-31a7-489f-87cf-22d0898358c0',
    CASE46_REMEDIATION_PROOF_3,
    1187250,
  ),
  [CASE46_RETIRED_SETUP_KEY_4]: retired(
    claimOf(setup4, planned4),
    'f10c4bed-c807-4713-917e-527a9eba6b58',
    CASE46_REMEDIATION_PROOF_4,
    3603300,
  ),
};
const claim = claimOf(setup, planned);
const ledger = native.conversation.metadata.governedArtifactProviderBudget.ledger;
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
  captureRunId: '6c1d3e5f-2a4b-4c8d-9e0f-1a2b3c4d5e6f',
  ctx,
  remediationProofSha256: PROOF_5,
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
const fifth = {
  priorClaim: claim,
  failedConversationId: native.conversation.id,
  terminalProofSha256: PROOF_5,
  conservativeCostMicros: 2867130,
  actualCostMicros: 2867130,
  ledgerSha256: case46BudgetHash(ledger),
  acceptanceAuthority: false,
};
beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-05T12:40:00Z')));
afterEach(() => jest.useRealTimers());
function fixture(): Record<string, any> {
  return {
    fixtureNamespace: f.namespace,
    unrelated: 'preserved',
    ...structuredClone(retiredRecords),
    case46ExecutionSetup: structuredClone(claim),
  };
}
function ports(fxt: Record<string, unknown> = fixture()) {
  let settings = { unrelatedSetting: true, meriFoundationFixture: fxt };
  const metadata = structuredClone(native.conversation.metadata);
  const conversation = { id: native.conversation.id, run: claim.captureRunId };
  const counts = {
    messages: 2n,
    original: 1n,
    assistants: 1n,
    proposals: 0n,
    artifacts: 0n,
  };
  let conversations = 1;
  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{ settings: structuredClone(settings) }]),
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql.join('');
      if (text.includes('AS sources')) return [{ sources: 0n, conversations: 0n }];
      if (text.includes('AND title=')) {
        expect(values).toContain(`${f.namespace} case46 ${conversation.run}`);
        return Array.from({ length: conversations }, () => ({
          id: conversation.id,
          metadata: structuredClone(metadata),
        }));
      }
      if (text.includes('AS messages')) return [counts];
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
  const noConversation = () => {
    conversations = 0;
  };
  return { tx, metadata, counts, conversation, runtime, noConversation, settings: () => settings };
}

test('the preserved fifth failure is over, fully settled and unbound to any fixed generation', () => {
  expect(native.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
  expect(native.messages[0].body).toBe(f.prompt);
  expect(native.proposals).toBe(0);
  expect(native.artifacts).toBe(0);
  expect(native.conversation.id).toBe(setup.receipt.conversationId);
  expect(ledger.limits.deadlineAt).toBe(new Date(setup.receipt.binding.expiresAt).toISOString());
  expect(ledger.attempts.map((a: { status: string }) => a.status)).toEqual([
    'settled',
    'settled',
    'settled',
  ]);
  expect(ledger.chargedCostMicros).toBe(2867130);
});

test('derives the fifth retirement from retained state alone and makes no writes', async () => {
  const p = ports();
  await expect(
    assertCase46RemediationInTx(p.tx as never, ctx as never, fixture(), input),
  ).resolves.toEqual({ [case46RetiredKey(5)]: fifth });
  expect(p.tx.$executeRaw).not.toHaveBeenCalled();
});

test.each([
  'deadline',
  'unsettled',
  'charged',
  'other-run-budget',
  'no-conversation',
  'missing-fourth',
  'changed-third',
  'gap',
  'proof-reused',
  'claim-started',
  'same-run',
  'retired-run',
  'original',
  'assistants',
  'extra-message',
  'proposals',
  'artifacts',
])('rejects changed %s before any write', async (kind) => {
  const fxt = fixture(),
    p = ports(fxt),
    recipe = { ...input };
  const budget = p.metadata.governedArtifactProviderBudget;
  if (kind === 'deadline') jest.setSystemTime(new Date(setup.receipt.binding.expiresAt));
  if (kind === 'unsettled') budget.ledger.attempts[2].status = 'reserved';
  if (kind === 'charged') budget.ledger.chargedCostMicros += 1;
  if (kind === 'other-run-budget') budget.qualification.captureRunId = input.captureRunId;
  if (kind === 'no-conversation') p.noConversation();
  if (kind === 'missing-fourth') delete fxt[CASE46_RETIRED_SETUP_KEY_4];
  if (kind === 'changed-third') fxt[CASE46_RETIRED_SETUP_KEY_3].actualCostMicros = 1;
  if (kind === 'gap') fxt[case46RetiredKey(6)] = structuredClone(fifth);
  if (kind === 'proof-reused')
    fxt[case46RetiredKey(5)] = { ...structuredClone(fifth), priorClaim: firstClaim };
  if (kind === 'claim-started') fxt.case46ExecutionSetup.status = 'STARTED';
  if (kind === 'same-run') recipe.captureRunId = claim.captureRunId;
  if (kind === 'retired-run') recipe.captureRunId = secondClaim.captureRunId;
  if (kind === 'original') p.counts.original = 0n;
  if (kind === 'assistants') Object.assign(p.counts, { messages: 3n, assistants: 2n });
  if (kind === 'extra-message') p.counts.messages = 3n;
  if (kind === 'proposals') p.counts.proposals = 1n;
  if (kind === 'artifacts') p.counts.artifacts = 1n;
  await expect(
    assertCase46RemediationInTx(p.tx as never, ctx as never, fxt, recipe),
  ).rejects.toThrow('remediation_not_eligible');
  expect(p.tx.$executeRaw).not.toHaveBeenCalled();
});

test('the real setup owner retires the fifth failure beside the fixed four', async () => {
  const p = ports();
  const plan = await planCase46Setup(p.runtime as never, input);
  expect(plan.retirement).toEqual({ [case46RetiredKey(5)]: fifth });
  await expect(
    executeCase46Setup(p.runtime as never, input, plan.planSha256, () => {}),
  ).rejects.toThrow('reconciliation_required');
  expect(p.settings().meriFoundationFixture).toEqual({
    ...fixture(),
    [case46RetiredKey(5)]: fifth,
    case46ExecutionSetup: {
      version: 1,
      caseId: '46',
      captureRunId: input.captureRunId,
      recipeSha256: plan.recipeSha256,
      planSha256: plan.planSha256,
      status: 'STARTED',
    },
  });
  expect(p.tx.$executeRaw).toHaveBeenCalledTimes(1);
});

test('a later failure retires as the sixth generation with no new release', async () => {
  const sixthRun = input.captureRunId;
  const priorClaim = { ...claim, captureRunId: sixthRun, receiptSha256: 'f'.repeat(64) };
  const fxt = {
    ...fixture(),
    [case46RetiredKey(5)]: structuredClone(fifth),
    case46ExecutionSetup: priorClaim,
  };
  const p = ports(fxt);
  p.conversation.run = sixthRun;
  p.metadata.governedArtifactProviderBudget.qualification.captureRunId = sixthRun;
  const next = {
    ...input,
    captureRunId: '7d2e4f60-3b5c-4d9e-8f10-2b3c4d5e6f70',
    remediationProofSha256: 'a'.repeat(64),
  };
  await expect(
    assertCase46RemediationInTx(p.tx as never, ctx as never, fxt, next),
  ).resolves.toEqual({
    [case46RetiredKey(6)]: { ...fifth, priorClaim, terminalProofSha256: 'a'.repeat(64) },
  });
  await expect(
    assertCase46RemediationInTx(p.tx as never, ctx as never, fxt, {
      ...next,
      remediationProofSha256: PROOF_5,
    }),
  ).rejects.toThrow('remediation_not_eligible');
  expect(p.tx.$executeRaw).not.toHaveBeenCalled();
});
