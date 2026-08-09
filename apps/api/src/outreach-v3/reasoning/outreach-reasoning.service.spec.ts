import type { TenantContext } from '@capiro/shared';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { OutreachReasoningService } from './outreach-reasoning.service.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  clerkUserId: 'user_test',
  tenantSlug: 'test',
  role: 'standard_user',
} as TenantContext;

const conversation = {
  id: '00000000-0000-4000-8000-000000000010',
  tenantId: ctx.tenantId,
  sessionId: '00000000-0000-4000-8000-000000000011',
  createdByUserId: ctx.userId,
  provider: 'openai' as const,
  stateMode: 'capiro_managed' as const,
  model: 'gpt-5.6',
  reasoningEffort: 'medium' as const,
  lastResponseId: null,
  status: 'active' as const,
  createdAt: new Date('2026-08-08T00:00:00Z'),
  lastUsedAt: new Date('2026-08-08T00:00:00Z'),
  archivedAt: null,
};

function providerResult(commands: unknown[] = []) {
  return {
    assistantMessage: 'Visible answer',
    proposedCommands: commands,
    openQuestions: [],
    referencedToolResults: [],
    providerResponseRef: 'resp_1',
    usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 15 },
  };
}

function harness(result = providerResult()) {
  const tx = { id: 'tx' };
  const prisma = {
    withTenantUser: jest.fn(async (_tenantId: string, _userId: string, fn: (value: unknown) => unknown) =>
      fn(tx),
    ),
  };
  const credentials = {
    resolveProviderForOutreachReasoning: jest.fn(async () => ({
      provider: 'openai',
      apiKey: 'secret',
      model: 'gpt-5.6',
      usedTenantKey: false,
      modelOverridden: false,
    })),
  };
  const repository = {
    createConversation: jest.fn(async () => conversation),
    getOwnedConversation: jest.fn(async () => conversation),
    recentTranscript: jest.fn(async () => []),
    appendSucceededTurn: jest.fn(async () => ({ id: 'turn' })),
    appendFailedTurn: jest.fn(async () => undefined),
    updateAfterTurn: jest.fn(async () => undefined),
    archiveConversation: jest.fn(async () => undefined),
  };
  const claims = {
    claim: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
  };
  const campaignContext = {
    loadCampaignContext: jest.fn(async () => ({
      sessionId: conversation.sessionId,
      currentStateVersion: 7,
      specHash: 'a'.repeat(64),
      spec: {
        schemaVersion: 'outreach_campaign_spec_v1',
        sponsor: { kind: 'none', label: null, clientRefs: [] },
      },
      readiness: { blockers: [] },
      pendingProposalCount: 0,
    })),
    capabilityContext: jest.fn(() => ({ tenantId: ctx.tenantId })),
    providerTools: jest.fn(() => []),
    executeReadTool: jest.fn(),
    buildInstructions: jest.fn(() => 'rules'),
  };
  const provider = { respond: jest.fn(async () => result) };
  const proposals = {
    createModelProposalWithinTx: jest.fn(async () => ({
      id: '00000000-0000-4000-8000-000000000020',
    })),
  };

  return {
    service: new OutreachReasoningService(
      prisma as never,
      credentials as never,
      repository as never,
      claims as never,
      campaignContext as never,
      provider as never,
      proposals as never,
    ),
    tx,
    prisma,
    credentials,
    repository,
    claims,
    campaignContext,
    provider,
    proposals,
  };
}

const setGoal = {
  type: 'SET_GOAL' as const,
  schemaVersion: 1 as const,
  payload: { value: 'Protect the program' },
};

describe('OutreachReasoningService', () => {
  it('does not create or apply campaign mutations when the model returns no commands', async () => {
    const h = harness(providerResult([]));

    await expect(
      h.service.respond(ctx, conversation.id, { message: 'What should I think about?' }),
    ).resolves.toMatchObject({
      assistantMessage: 'Visible answer',
      proposalIds: [],
      stateVersion: 7,
    });

    expect(h.proposals.createModelProposalWithinTx).not.toHaveBeenCalled();
    expect(h.repository.appendSucceededTurn).toHaveBeenCalledTimes(1);
    expect(h.claims.release).toHaveBeenCalledTimes(1);
  });

  it('creates exactly one pending model proposal at the state version inspected by the model', async () => {
    const h = harness(providerResult([setGoal]));

    const result = await h.service.respond(ctx, conversation.id, {
      message: 'Set our goal to protect the program.',
    });

    expect(h.proposals.createModelProposalWithinTx).toHaveBeenCalledWith(
      h.tx,
      ctx,
      conversation.sessionId,
      { expectedStateVersion: 7, commands: [setGoal] },
    );
    expect(result.proposalIds).toEqual(['00000000-0000-4000-8000-000000000020']);
    expect(h.repository.appendSucceededTurn).toHaveBeenCalledWith(
      h.tx,
      ctx,
      conversation,
      expect.objectContaining({
        stateVersion: 7,
        proposalIds: ['00000000-0000-4000-8000-000000000020'],
      }),
    );

    // The service has no Apply dependency at all; mutation authority stays with
    // the later explicit-user Phase 2 proposal Apply route.
    expect('applyProposal' in h.proposals).toBe(false);
  });

  it('rejects future-phase commands before any proposal is persisted', async () => {
    const h = harness(
      providerResult([
        {
          type: 'REQUEST_FULL_GENERATION',
          schemaVersion: 1,
          payload: {},
        },
      ]),
    );

    await expect(
      h.service.respond(ctx, conversation.id, { message: 'Generate the whole campaign.' }),
    ).rejects.toMatchObject({
      code: 'OUTREACH_REASONING_OUTPUT_INVALID',
      httpStatus: 502,
    });
    expect(h.proposals.createModelProposalWithinTx).not.toHaveBeenCalled();
    expect(h.repository.appendSucceededTurn).not.toHaveBeenCalled();
    expect(h.repository.appendFailedTurn).toHaveBeenCalledTimes(1);
  });

  it('turns campaign drift during proposal persistence into a retryable 409 with no success audit', async () => {
    const h = harness(providerResult([setGoal]));
    h.proposals.createModelProposalWithinTx.mockRejectedValueOnce(
      new OutreachCommandError(
        'OUTREACH_STATE_CONFLICT',
        'state moved',
        409,
        { currentStateVersion: 8 },
      ),
    );

    await expect(
      h.service.respond(ctx, conversation.id, { message: 'Set the goal.' }),
    ).rejects.toMatchObject({
      code: 'OUTREACH_REASONING_OUTPUT_INVALID',
      httpStatus: 409,
      retryable: true,
      safeMetadata: { currentStateVersion: 8 },
    });
    expect(h.repository.appendSucceededTurn).not.toHaveBeenCalled();
    expect(h.repository.appendFailedTurn).toHaveBeenCalledTimes(1);
  });

  it('stores visible transcript only in Capiro-managed mode', async () => {
    const h = harness(providerResult());
    await h.service.respond(ctx, conversation.id, { message: 'Visible user message' });
    expect(h.repository.appendSucceededTurn).toHaveBeenCalledWith(
      h.tx,
      ctx,
      conversation,
      expect.objectContaining({
        userMessageText: 'Visible user message',
        assistantMessageText: 'Visible answer',
      }),
    );
  });

  it('serializes turns with a claim and always releases the lease', async () => {
    const h = harness(providerResult());
    await h.service.respond(ctx, conversation.id, { message: 'One turn' });
    expect(h.claims.claim).toHaveBeenCalledTimes(1);
    expect(h.claims.release).toHaveBeenCalledTimes(1);
    expect(h.claims.release.mock.calls[0]?.[0]).toBe(ctx);
    expect(h.claims.release.mock.calls[0]?.[1]).toBe(conversation.id);
  });
});
