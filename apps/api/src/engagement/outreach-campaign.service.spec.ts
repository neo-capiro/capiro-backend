import { describe, expect, jest, test } from '@jest/globals';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { OutreachCampaignService } from './outreach-campaign.service.js';
import type { OutreachCampaignState } from './outreach-campaign.contract.js';
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
  const service = new OutreachCampaignService(
    prisma as never,
    engagement as never,
    jobs as never,
    gateway as never,
    drafts as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, tx, engagement, jobs, gateway, row: () => row };
}
describe('saved Outreach campaign owner', () => {
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
