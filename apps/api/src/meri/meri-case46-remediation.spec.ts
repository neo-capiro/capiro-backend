jest.mock('./meri-case46-authority.js', () => ({
  ...jest.requireActual('./meri-case46-authority.js'),
  assertCase46CurrentActorInTx: jest.fn(async () => undefined),
}));
import { MERI_CASE46 as f } from '@capiro/meriv2-core';
import {
  assertCase46RemediationInTx,
  CASE46_REMEDIATION_PROOF,
  CASE46_RETIRED_SETUP_KEY,
} from './meri-case46-remediation.js';
import { planCase46Setup, executeCase46Setup } from './meri-case46-setup-owner.js';

const native = require('../../../../docs/meri/releases/2026-10-04/c2-steering-wire-bound/native-terminal-read.json');
const claim = {
  version: 1,
  caseId: '46',
  captureRunId: 'e9ac5e1a-6562-49b6-b59b-139bd7ba8325',
  recipeSha256: '51c9f2b6e560fcf2ee436953abe1d747488c088f0cca0b71e34f5959afb32d69',
  planSha256: '854cbf058f7290fc128b0ab0b596a8f0bed635538edecc200941a7fa8d79b382',
  status: 'COMPLETE',
  receiptSha256: '4075cf232dffc125225ffa3af21810b814508768c5083eca9a6c6dba1f6c716d',
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
  captureRunId: '1196830a-83b4-4530-bcd1-87840bf88b41',
  ctx,
  remediationProofSha256: CASE46_REMEDIATION_PROOF,
  rateEvidence: {
    version: 1,
    caseId: '46',
    expiresAt: '2026-10-05T06:52:10.103Z',
    priceKind: 'qualified_text_token_upper_bound',
    maxAttempts: 16,
    maxTokens: 500000,
    maxCostMicros: 3000000,
    rates: native.conversation.metadata.governedArtifactProviderBudget.qualification.rates,
  },
};
beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-05T02:30:00Z')));
afterEach(() => jest.useRealTimers());
function fixture() {
  return {
    fixtureNamespace: f.namespace,
    unrelated: 'preserved',
    case46ExecutionSetup: structuredClone(claim),
  };
}
function ports() {
  let settings = { unrelatedSetting: true, meriFoundationFixture: fixture() };
  const metadata = structuredClone(native.conversation.metadata);
  const counts = { messages: 1n, original: 1n, proposals: 0n, artifacts: 0n };
  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{ settings: structuredClone(settings) }]),
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) => {
      const text = sql.join('');
      if (text.includes('SELECT metadata_jsonb')) return [{ metadata }];
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
test('allows only the exact reconciled expired zero-dispatch failure and makes no writes', async () => {
  const p = ports();
  await assertCase46RemediationInTx(p.tx as never, ctx as never, fixture(), input);
  expect(p.tx.$executeRaw).not.toHaveBeenCalled();
  expect(p.tx.$queryRaw).toHaveBeenCalledTimes(2);
});
test.each([
  'proof',
  'run',
  'tenant',
  'actor',
  'role',
  'namespace',
  'claim',
  'history',
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
  if (kind === 'run') recipe.captureRunId = claim.captureRunId;
  if (kind === 'tenant') actor.tenantId = 'foreign';
  if (kind === 'actor') actor.userId = 'foreign';
  if (kind === 'role') actor.role = 'admin';
  if (kind === 'namespace') fxt.fixtureNamespace = 'foreign';
  if (kind === 'claim') fxt.case46ExecutionSetup.status = 'STARTED';
  if (kind === 'history') fxt[CASE46_RETIRED_SETUP_KEY] = {};
  if (kind === 'deadline') jest.setSystemTime(new Date('2026-10-05T01:25:09.429Z'));
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
test('the real setup owner retains the old claim before any new source effect and rejects replay', async () => {
  const p = ports();
  const plan = await planCase46Setup(p.runtime as never, input);
  expect(p.tx.$executeRaw).not.toHaveBeenCalled();
  await expect(
    executeCase46Setup(p.runtime as never, input, plan.planSha256, () => {}),
  ).rejects.toThrow('reconciliation_required');
  expect(p.settings().meriFoundationFixture).toMatchObject({
    unrelated: 'preserved',
    [CASE46_RETIRED_SETUP_KEY]: {
      priorClaim: claim,
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
test('ordinary setup still rejects an existing claim without the reconciled proof', async () => {
  const p = ports();
  const { remediationProofSha256: _proof, ...ordinary } = input;
  await expect(planCase46Setup(p.runtime as never, ordinary)).rejects.toThrow(
    'existing_claim_requires_reconciliation',
  );
  expect(p.tx.$executeRaw).not.toHaveBeenCalled();
});
