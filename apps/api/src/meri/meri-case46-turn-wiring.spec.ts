import { randomUUID } from 'node:crypto';
import { MERI_CASE46 } from '@capiro/meriv2-core';
import { case46BudgetTestFixture } from './meri-case46-provider-budget.spec-helper.js';
import {
  MeriContextPlaneRuntimeService,
  currentMeriGovernedArtifactCapturePolicy,
  currentMeriGovernedRuntime,
  bindCurrentCase46Turn,
} from './meri-context-plane-runtime.js';
import { MeriCaptureProviderBudgetController } from './meri-capture-provider-budget.controller.js';
import {
  encodeMeriGovernedArtifactTransport,
  MERI_GOVERNED_ARTIFACT_HEADER,
  MERI_CAPTURE_POLICY_HEADER,
} from '@capiro/meriv2-core';
import {
  case46ProviderBudgetOwner,
  issueCurrentCase46Policy,
} from './meri-case46-provider-budget-owner.js';
import { captureProviderBudgetOwner } from './meri-capture-provider-budget-owner.js';
import { readSealedCase46Binding } from './meri-case46-authority.js';
import { assertCase46NewTurnInTx, assertCase46OriginalInput } from './meri-case46-turn-owner.js';
import { withCase46ApiProviderScope } from './meri-case46-api-provider-scope.js';
import {
  captureApiProviderScopeActive,
  withCaptureApiProviderScope,
  reserveCaptureApiProviderAttempt,
  settleCaptureApiProviderAttempt,
} from './meri-capture-api-provider-scope.js';
import { captureBudgetTestPolicy } from './meri-capture-provider-budget.spec-helper.js';
jest.mock('./meri-case46-provider-budget-owner.js', () => ({
  case46ProviderBudgetOwner: jest.fn(),
  issueCurrentCase46Policy: jest.fn(),
}));
jest.mock('./meri-capture-provider-budget-owner.js', () => ({
  captureProviderBudgetOwner: jest.fn(),
}));
jest.mock('./meri-case46-authority.js', () => ({ readSealedCase46Binding: jest.fn() }));
jest.mock('./meri-case46-turn-owner.js', () => ({
  ...jest.requireActual('./meri-case46-turn-owner.js'),
  assertCase46NewTurnInTx: jest.fn(),
}));
const owner = jest.mocked(case46ProviderBudgetOwner);
const ctx = {
  tenantId: MERI_CASE46.tenantId,
  tenantSlug: MERI_CASE46.tenantSlug,
  userId: MERI_CASE46.actorUserId,
  role: 'standard_user',
  clerkUserId: 'synthetic-unit',
} as const;
beforeEach(() => jest.clearAllMocks());
test('actual context runtime admits before retrieval, carries source context, then binds one persisted turn', async () => {
  const { p, q } = case46BudgetTestFixture();
  const policy = { ...p, turnId: null };
  jest.mocked(readSealedCase46Binding).mockReturnValue({ policy, qualification: q } as never);
  jest.mocked(issueCurrentCase46Policy).mockResolvedValue(policy);
  const prisma = {
    withTenant: async (_t: string, fn: (tx: unknown) => unknown) =>
      fn({
        clioConversation: {
          findFirst: async () => ({
            id: p.conversationId,
            metadata: {},
            client: { id: p.clientId, name: 'Synthetic Aster' },
          }),
        },
      }),
    withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => unknown) => fn({}),
  };
  const deps = { prisma, engagement: {} } as never;
  const resolveChat = jest.fn(async () => {
    expect(owner.mock.calls[0]?.[1].operation.kind).toBe('admit');
    expect(captureApiProviderScopeActive()).toBe(true);
    expect(assertCase46NewTurnInTx).toHaveBeenCalledTimes(1);
    return {
      prompt: 'existing governed context',
      retrieval: { plan: { subjectScope: 'client' } },
      contextPacket: {},
    };
  });
  const runtime = new MeriContextPlaneRuntimeService(
    prisma as never,
    { resolveChat } as never,
    deps,
  );
  const turnId = randomUUID();
  await runtime.runChatTurn(
    ctx,
    { conversationId: p.conversationId, body: MERI_CASE46.prompt, mode: 'new' },
    async () => {
      expect(currentMeriGovernedArtifactCapturePolicy()?.turnId).toBeNull();
      expect(currentMeriGovernedRuntime()?.context.prompt).toContain(
        JSON.stringify(MERI_CASE46.text),
      );
      bindCurrentCase46Turn(turnId);
      expect(currentMeriGovernedRuntime()?.context.governedArtifactCapturePolicy?.turnId).toBe(
        turnId,
      );
      expect(() => bindCurrentCase46Turn(randomUUID())).toThrow('already_bound');
    },
  );
  expect(currentMeriGovernedArtifactCapturePolicy()).toBeNull();
  expect(captureApiProviderScopeActive()).toBe(false);
  expect(captureProviderBudgetOwner).not.toHaveBeenCalled();
  await expect(
    runtime.runChatTurn(
      ctx,
      { conversationId: p.conversationId, body: 'changed prompt', mode: 'new' },
      async () => {},
    ),
  ).rejects.toThrow('original_turn');
  expect(resolveChat).toHaveBeenCalledTimes(1);
});
test('existing embeddings/rerank hook delegates only the separate current artifact scope and propagates settlement failure', async () => {
  const { p } = case46BudgetTestFixture();
  owner.mockResolvedValue({ dispatchAllowed: true, reservationId: 'reservation' } as never);
  const deps = {} as never;
  await withCase46ApiProviderScope(deps, ctx, { ...p, turnId: null }, async () => {
    const reserved = await reserveCaptureApiProviderAttempt({
      kind: 'bedrock_embeddings',
      provider: 'aws-bedrock',
      model: 'actual-titan',
      inputBytes: 123,
    });
    expect(owner.mock.calls[0]?.[1]).toMatchObject({
      policy: { turnId: null },
      operation: {
        kind: 'reserve',
        binding: { phase: 'api_retrieval', maxInputTokens: 123, maxOutputTokens: 0 },
      },
    });
    owner.mockRejectedValueOnce(new Error('settlement_failed'));
    await expect(settleCaptureApiProviderAttempt(reserved, { kind: 'uncertain' })).rejects.toThrow(
      'settlement_failed',
    );
  });
  expect(captureProviderBudgetOwner).not.toHaveBeenCalled();
  expect(
    await reserveCaptureApiProviderAttempt({
      kind: 'bedrock_embeddings',
      provider: 'aws-bedrock',
      model: 'actual-titan',
      inputBytes: 123,
    }),
  ).toBeNull();
});
test('provider controller keeps separate MAC purposes/actors and never converts artifact authority to readonly', async () => {
  const prior = process.env.INTERNAL_SERVICE_SECRET;
  process.env.INTERNAL_SERVICE_SECRET = 'case46-unit-only';
  try {
    const { p, b } = case46BudgetTestFixture();
    const deps = {} as never;
    const controller = new MeriCaptureProviderBudgetController({} as never, deps);
    owner.mockResolvedValue({
      dispatchAllowed: true,
      reservationId: 'r',
      deadlineAt: new Date(p.expiresAt).toISOString(),
    } as never);
    const token = encodeMeriGovernedArtifactTransport(
      p,
      'provider_budget',
      process.env.INTERNAL_SERVICE_SECRET,
    );
    await controller.reserve(
      ctx,
      { headers: { [MERI_GOVERNED_ARTIFACT_HEADER]: token } } as never,
      b,
    );
    expect(owner).toHaveBeenCalledTimes(1);
    expect(captureProviderBudgetOwner).not.toHaveBeenCalled();
    for (const headers of [
      { [MERI_GOVERNED_ARTIFACT_HEADER]: token, [MERI_CAPTURE_POLICY_HEADER]: 'other' },
      {
        [MERI_GOVERNED_ARTIFACT_HEADER]: encodeMeriGovernedArtifactTransport(
          p,
          'action_proposal',
          process.env.INTERNAL_SERVICE_SECRET,
        ),
      },
      { [MERI_GOVERNED_ARTIFACT_HEADER]: [token] },
    ])
      await expect(controller.reserve(ctx, { headers } as never, b)).rejects.toThrow();
    expect(owner).toHaveBeenCalledTimes(1);
  } finally {
    if (prior === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = prior;
  }
});

test('both active provider capabilities are denied before either owner, while an ordinary scope returns null', async () => {
  const { p } = case46BudgetTestFixture();
  await expect(
    withCase46ApiProviderScope({} as never, ctx, p, () =>
      withCaptureApiProviderScope({} as never, ctx, captureBudgetTestPolicy(), () =>
        reserveCaptureApiProviderAttempt({
          kind: 'bedrock_embeddings',
          provider: 'aws-bedrock',
          model: 'actual-titan',
          inputBytes: 123,
        }),
      ),
    ),
  ).rejects.toThrow('scope_ambiguous');
  expect(owner).not.toHaveBeenCalled();
  expect(captureProviderBudgetOwner).not.toHaveBeenCalled();
});
test('original turn contract rejects regeneration, attachments, impersonation and a prior bound turn', () => {
  const { p } = case46BudgetTestFixture();
  const policy = { ...p, turnId: null };
  const input = { body: MERI_CASE46.prompt, mode: 'new', attachmentIds: [] as string[] };
  expect(() => assertCase46OriginalInput(policy, input)).not.toThrow();
  for (const patch of [
    { mode: 'regenerate' },
    { attachmentIds: ['id'] },
    { impersonateTenantId: p.tenantId },
    { body: 'changed' },
  ])
    expect(() => assertCase46OriginalInput(policy, { ...input, ...patch })).toThrow();
  expect(() => assertCase46OriginalInput(p, input)).toThrow('already_started');
});
