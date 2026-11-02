import { describe, expect, jest, test } from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { OutreachCampaignService } from './outreach-campaign.service.js';
import type { OutreachCampaignState } from './outreach-campaign.contract.js';
import type { GatewayEnrichmentInput } from './generation/generation-gateway.service.js';
const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
} as TenantContext;
const requestKey = '00000000-0000-4000-8000-000000000003';
const jobId = '00000000-0000-4000-8000-000000000004';
const itemId = '00000000-0000-4000-8000-000000000005';
const conversationId = '00000000-0000-4000-8000-000000000006';
const state: OutreachCampaignState = {
  title: 'Synthetic outreach',
  direction: 'on-behalf',
  clientId: null,
  templateId: null,
  mainIdea: 'Arrange a meeting',
  tone: 'professional',
  length: 'standard',
  recipients: [
    { id: 'one', kind: 'individual', role: 'to', name: 'One', email: 'one@example.test' },
    { id: 'two', kind: 'individual', role: 'to', name: 'Two', email: 'two@example.test' },
  ],
  contextItems: [
    {
      id: 'note1',
      kind: 'note',
      scope: 'individual:one',
      customNoteText: 'For One',
      noteUse: 'instruction',
    },
    {
      id: 'note2',
      kind: 'note',
      scope: 'individual:two',
      customNoteText: 'For Two',
      noteUse: 'fact',
    },
  ],
  styleSamples: [],
  attachmentIds: [],
  sender: { connectionId: null, signature: '' },
  lastStep: 4,
};
function fixture() {
  let row: any;
  const tx = {
    outreachJob: { updateMany: jest.fn(async () => ({ count: 0 })) },
    client: { findFirst: jest.fn(async () => null) },
    $queryRaw: jest.fn(async () => []),
    outreachRecord: {
      findFirst: jest.fn(async () => row ?? null),
      upsert: jest.fn(async ({ create }: any) => {
        row ??= { ...create, updatedAt: new Date() };
        return row;
      }),
      update: jest.fn(async ({ data }: any) => {
        row = { ...row, ...data, updatedAt: new Date() };
        return row;
      }),
    },
  };
  const prisma = { withTenant: async (_t: string, fn: (tx: any) => unknown) => fn(tx) };
  const engagement = {
    getOutreachRecord: jest.fn(async () => {
      if (!row) throw new NotFoundException();
      return row;
    }),
    prepareOutreachSdkInput: jest.fn(async (_ctx: unknown, input: any) => ({
      request: { ...input, items: input.contextItems },
      enrichment: { channels: [], auditLedger: [] },
    })),
  };
  const jobs = {
    getSdkUnit: jest.fn<any>(),
    beginSdkCompletion: jest.fn(async () => true),
    finishSdkUnit: jest.fn(async () => {}),
  };
  const gateway = { executeSdk: jest.fn<any>() };
  const drafts = { getVersion: jest.fn<any>() };
  const context = { resolveMany: jest.fn<any>() };
  const service = new OutreachCampaignService(
    prisma as never,
    engagement as never,
    jobs as never,
    gateway as never,
    drafts as never,
    {} as never,
    context as never,
    {} as never,
  );
  return { service, tx, engagement, jobs, gateway, context, row: () => row };
}
describe('saved Outreach campaign owner', () => {
  test.each(['individual:one', 'list:separate:one', 'group:shared'])(
    'carries only applicable saved context into SDK preparation for %s',
    async (generationKey) => {
      const f = fixture();
      const manual = (id: string, text: string, scope: any, contextClass: any) => ({
        locator: { source: 'manual' as const, id, title: text, text, sourceLabel: null },
        contextClass,
        scope,
      });
      const campaignContext = manual(requestKey, 'CAMPAIGN_CONTEXT', { kind: 'campaign' }, 'campaign_fact');
      const ownContext = manual(jobId, 'ONE_PRIVATE_CONTEXT', { kind: 'target', targetKey: 'one' }, 'target_specific');
      const otherContext = manual(itemId, 'TWO_PRIVATE_CONTEXT', { kind: 'target', targetKey: 'two' }, 'target_specific');
      const groupContext = manual(conversationId, 'GROUP_CONTEXT', { kind: 'group', groupRef: 'shared' }, 'group_safe');
      const campaign = await f.service.create(ctx, { requestKey, state: {
        ...state,
        recipients: [...state.recipients,
          { id: 'separate', kind: 'list', role: 'to', name: 'Separate', members: state.recipients.map(({ kind: _kind, ...member }) => member) },
          { id: 'shared', kind: 'group', role: 'to', name: 'Shared', members: state.recipients.map(({ kind: _kind, ...member }) => member) },
        ],
        contextSelections: [campaignContext, ownContext, otherContext, groupContext],
      } });
      f.context.resolveMany.mockImplementation(async (_ctx: unknown, selections: any[]) => selections.map(selection => ({
        ...selection, contextKey: selection.locator.id, snapshotHash: 'same',
        title: selection.locator.title, summary: selection.locator.text,
        usableAsEvidence: true, verificationClass: 'user_supplied', clientId: null,
        sourceSnapshot: { lastVerifiedAt: null },
      })));
      f.jobs.getSdkUnit.mockResolvedValue({
        job: { id: jobId, outreachRecordId: campaign.id, params: { revision: 1, state: campaign.state } },
        item: { id: itemId, recipientKey: generationKey, status: 'sdk_pending', payload: {} },
      });
      f.gateway.executeSdk.mockRejectedValue(new Error('stop after preparation input'));
      await expect(f.service.claim(ctx, { generationJobId: jobId, itemId })).rejects.toThrow('stop after');
      const expected = generationKey === 'group:shared' ? groupContext : ownContext;
      expect(f.context.resolveMany).toHaveBeenCalledWith(ctx, [campaignContext, expected]);
      const enrichment = f.gateway.executeSdk.mock.calls[0]![2] as GatewayEnrichmentInput;
      const evidence = await Promise.all(enrichment.channels.map((channel: any) => channel.load()));
      expect(evidence.sort()).toEqual([campaignContext.locator.text, expected.locator.text].sort());
      expect(enrichment.auditLedger.map((entry: any) => entry.serialized).sort()).toEqual(evidence);
    },
  );
  test('a denied native parent cannot fall through to an older session snapshot', async () => {
    const f = fixture();
    const campaign = await f.service.create(ctx, { requestKey, state });
    f.engagement.getOutreachRecord.mockRejectedValue(new NotFoundException());
    const legacy = jest.spyOn(f.service as any, 'readSession');
    await expect(f.service.get(ctx, campaign.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(legacy).not.toHaveBeenCalled();
  });
  test('an unimported legacy artifact root retains the session spec and native recorded status', async () => {
    const f = fixture();
    const campaign = await f.service.create(ctx, { requestKey, state });
    Object.assign(f.row(), { type: 'outreach_v3', metadata: {}, status: 'sent' });
    f.engagement.getOutreachRecord.mockRejectedValue(new NotFoundException());
    jest.spyOn(f.service as any, 'readSession').mockResolvedValue({
      ...campaign,
      revision: 0,
      state: { ...state, mainIdea: 'Actual session decisions' },
    });
    expect(await f.service.get(ctx, campaign.id)).toMatchObject({
      status: 'sent',
      revision: 0,
      state: { mainIdea: 'Actual session decisions', recipients: state.recipients },
    });
  });
  test('import converts a reserved root to the canonical campaign type without exposing it through ordinary reads', async () => {
    const f = fixture();
    const campaign = await f.service.create(ctx, { requestKey, state });
    Object.assign(f.row(), { type: 'outreach_v3', metadata: {} });
    f.engagement.getOutreachRecord.mockImplementation(async () => {
      if (f.row().type === 'outreach_v3') throw new NotFoundException();
      return f.row();
    });
    jest.spyOn(f.service as any, 'readSession').mockResolvedValue({ ...campaign, revision: 0 });
    const saved = await f.service.save(ctx, campaign.id, { expectedRevision: 0, state });
    expect(saved).toMatchObject({ type: 'campaign', hasWorkflow: true, revision: 1, state });
  });
  test.each(['foreign owner', 'deleted', 'client denied'])(
    'a reserved root with %s cannot fall through to its session',
    async (reason) => {
      const f = fixture();
      const campaign = await f.service.create(ctx, { requestKey, state });
      Object.assign(f.row(), {
        type: 'outreach_v3',
        metadata: {},
        ...(reason === 'foreign owner' ? { createdByUserId: requestKey } : {}),
        ...(reason === 'deleted' ? { deletedAt: new Date() } : {}),
        ...(reason === 'client denied' ? { clientId: requestKey } : {}),
      });
      f.engagement.getOutreachRecord.mockRejectedValue(new NotFoundException());
      const legacy = jest.spyOn(f.service as any, 'readSession');
      await expect(f.service.get(ctx, campaign.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(legacy).not.toHaveBeenCalled();
    },
  );
  test('rechecks a reserved root client changed after session read inside the save transaction', async () => {
    const f = fixture();
    const campaign = await f.service.create(ctx, { requestKey, state });
    Object.assign(f.row(), { type: 'outreach_v3', metadata: {} });
    f.engagement.getOutreachRecord.mockRejectedValue(new NotFoundException());
    jest.spyOn(f.service as any, 'readSession').mockImplementation(async () => {
      f.row().clientId = requestKey;
      return { ...campaign, revision: 0 };
    });
    await expect(
      f.service.save(ctx, campaign.id, { expectedRevision: 0, state }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.outreachRecord.update).not.toHaveBeenCalled();
  });
  test('opening an ordinary saved record as a campaign preserves its type and authored message', async () => {
    const f = fixture();
    const campaign = await f.service.create(ctx, { requestKey, state });
    Object.assign(f.row(), {
      type: 'follow_up',
      subject: 'Authored subject',
      body: 'Authored body',
    });
    await f.service.save(ctx, campaign.id, {
      expectedRevision: 1,
      state: { ...state, mainIdea: 'Add context' },
    });
    expect(f.row()).toMatchObject({
      type: 'follow_up',
      subject: 'Authored subject',
      body: 'Authored body',
    });
    const recovered = await f.service.list(ctx, { requestKey });
    expect(Array.isArray(recovered)).toBe(true);
    expect(recovered).toEqual([expect.objectContaining({ id: campaign.id, revision: 2 })]);
  });
  test('structured decisions round-trip and reach the existing SDK preparation input', async () => {
    const f = fixture();
    const decisions = {
      goal: 'Meet staff',
      objective: 'Explain evidence',
      topic: 'Research',
      whyNow: 'Upcoming hearing',
      campaignAngle: 'Local impact',
    };
    const campaign = await f.service.create(ctx, { requestKey, state: { ...state, decisions } });
    expect((await f.service.get(ctx, campaign.id)).state.decisions).toEqual(decisions);
    f.jobs.getSdkUnit.mockResolvedValue({
      job: {
        id: jobId,
        outreachRecordId: campaign.id,
        params: { revision: 1, state: campaign.state },
      },
      item: { id: itemId, recipientKey: 'individual:one', status: 'sdk_pending', payload: {} },
    });
    f.gateway.executeSdk.mockRejectedValue(new Error('stop after preparation input'));
    await expect(f.service.claim(ctx, { generationJobId: jobId, itemId })).rejects.toThrow(
      'stop after',
    );
    const input = f.engagement.prepareOutreachSdkInput.mock.calls[0]![1];
    expect(input.mainIdea).toBe(state.mainIdea);
    expect(f.gateway.executeSdk.mock.calls[0]![1]).toMatchObject({
      mainIdea: state.mainIdea,
      campaignDecisions: decisions,
    });
  });

  test.each(['outbound_campaign', 'campaign'])(
    'rich metadata cannot enter or overwrite an ordinary %s campaign',
    async (type) => {
      const f = fixture();
      const campaign = await f.service.create(ctx, { requestKey, state });
      Object.assign(f.row(), {
        type,
        metadata: { ...f.row().metadata, newsletterStageId: requestKey, newsletterRevision: 1 },
      });
      await expect(f.service.get(ctx, campaign.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        f.service.save(ctx, campaign.id, { expectedRevision: 1, state }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(f.tx.outreachRecord.update).not.toHaveBeenCalled();
      expect(f.row().type).toBe(type);
    },
  );

  test('create replay, exact save/reload, and stale revision conflict preserve the complete state', async () => {
    const f = fixture();
    const first = await f.service.create(ctx, { requestKey, state });
    expect(first.revision).toBe(1);
    expect(first.state).toEqual(state);
    expect((await f.service.create(ctx, { requestKey, state })).id).toBe(first.id);
    const next = { ...state, mainIdea: 'Updated main idea', lastStep: 5 };
    expect(
      (await f.service.save(ctx, first.id, { expectedRevision: 1, state: next })).state,
    ).toEqual(next);
    expect((await f.service.get(ctx, first.id)).revision).toBe(2);
    await expect(
      f.service.save(ctx, first.id, { expectedRevision: 1, state }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.tx.outreachRecord.upsert).toHaveBeenCalledTimes(1);
  });
  test('terminal and changed-revision units cannot start another native conversation', async () => {
    const f = fixture();
    const campaign = await f.service.create(ctx, { requestKey, state });
    const unit = {
      job: { id: jobId, outreachRecordId: campaign.id, params: { revision: 1, state } },
      item: { id: itemId, recipientKey: 'individual:one', status: 'unknown', payload: {} },
    };
    f.jobs.getSdkUnit.mockResolvedValue(unit);
    await expect(f.service.claim(ctx, { generationJobId: jobId, itemId })).rejects.toThrow(
      'terminal',
    );
    unit.job.params.revision = 0;
    await expect(f.service.claim(ctx, { generationJobId: jobId, itemId })).rejects.toThrow(
      'changed',
    );
    expect(f.gateway.executeSdk).not.toHaveBeenCalled();
  });
  test('completion rejects wrong binding and retains unknown after an ambiguous persistence failure', async () => {
    const f = fixture();
    const campaign = await f.service.create(ctx, { requestKey, state });
    const unit = {
      job: {
        id: jobId,
        outreachRecordId: campaign.id,
        params: { revision: 1, state, mode: 'generate' },
      },
      item: {
        id: itemId,
        recipientKey: 'individual:one',
        status: 'sdk_running',
        payload: {
          baseVersion: 0,
          sdk: { conversationId, requestId: itemId, packetId: requestKey },
        },
      },
    };
    f.jobs.getSdkUnit.mockResolvedValue(unit);
    const input = {
      generationJobId: jobId,
      itemId,
      conversationId,
      requestId: itemId,
      output: { plan: {}, draft: {} },
      model: 'synthetic-sdk-model',
    };
    await expect(f.service.complete(ctx, { ...input, requestId: requestKey })).rejects.toThrow(
      'binding',
    );
    f.gateway.executeSdk.mockRejectedValue(new Error('ambiguous completion'));
    await expect(f.service.complete(ctx, input)).rejects.toThrow('ambiguous');
    expect(f.jobs.finishSdkUnit).toHaveBeenCalledWith(
      ctx,
      jobId,
      itemId,
      'unknown',
      null,
      expect.any(String),
    );
    expect(f.engagement.prepareOutreachSdkInput).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        recipients: [expect.objectContaining({ email: 'one@example.test' })],
        contextItems: [state.contextItems[0]],
      }),
      undefined,
    );
  });
});
