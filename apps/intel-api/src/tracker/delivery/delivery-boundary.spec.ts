import { DeliveryService } from './delivery.service.js';

describe('retained outbound delivery boundary', () => {
  const ctx = { tenantId: 'tenant-a', clerkUserId: 'owner-a', role: null };
  function setup(run: unknown) {
    const tx = {};
    const folders = { withActor: jest.fn(async (_ctx, fn) => fn(tx)) };
    const access = { run: jest.fn().mockResolvedValue(run), folders };
    const recipients = { resolve: jest.fn() };
    const email = { sendReport: jest.fn() };
    return {
      service: new DeliveryService(access as never, recipients as never, email as never),
      folders,
      recipients,
      email,
    };
  }
  it('rejects a retired bill-report composition before accessing recipients', async () => {
    const { service, recipients } = setup({ audience: 'external', snapshot: { rows: [] } });
    await expect(service.preview(ctx, 'old-report', {})).rejects.toThrow(
      'TYPED_EDITORIAL_RUN_REQUIRED',
    );
    expect(recipients.resolve).not.toHaveBeenCalled();
  });
  it('keeps research drafts internal', async () => {
    const { service, recipients } = setup({
      audience: 'internal',
      snapshot: { mode: 'research_draft' },
    });
    await expect(service.preview(ctx, 'research-a', {})).rejects.toThrow('EXTERNAL_DRAFT_REQUIRED');
    expect(recipients.resolve).not.toHaveBeenCalled();
  });
  it('refuses retired delivery kinds both at enqueue and before dispatch', async () => {
    const { service, folders, email } = setup({});
    await expect(
      service.enqueue(ctx, { kind: 'bill_report' } as never, 'old-intent'),
    ).rejects.toThrow('UNSUPPORTED_DELIVERY_KIND');
    await expect(
      service.checkDispatch({} as never, ctx, { kind: 'bill_report' } as never, {} as never),
    ).rejects.toThrow('UNSUPPORTED_DELIVERY_KIND');
    expect(folders.withActor).not.toHaveBeenCalled();
    expect(email.sendReport).not.toHaveBeenCalled();
  });
});

describe('explicit operational delivery recovery', () => {
  const ctx = { tenantId: 'tenant-a', clerkUserId: 'owner-a', role: null };
  function setup() {
    const row = {
      recipient: {},
      channel: 'email',
      delivery: { kind: 'bill_keyword', contentHash: 'reviewed-hash' },
    };
    const tx = {
      $queryRaw: jest.fn(),
      legiWatchDeliveryRecipient: {
        findFirst: jest.fn().mockResolvedValue(row),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const access = {
      authorize: jest.fn(),
      flags: { isEnabled: jest.fn().mockResolvedValue(true) },
      folders: { withActor: jest.fn(async (_ctx, fn) => fn(tx)) },
    };
    const service = new DeliveryService(access as never, {} as never, {} as never);
    return { service, tx };
  }
  it('rechecks a held delivery before allowing the worker to retry', async () => {
    const { service, tx } = setup();
    const dispatch = jest.spyOn(service, 'checkDispatch').mockResolvedValue(undefined);
    await service.retryHeld(ctx, 'recipient-a', {
      reason: 'Reviewed current source and destination',
      contentHash: 'reviewed-hash',
    });
    expect(dispatch).toHaveBeenCalled();
    expect(tx.legiWatchDeliveryRecipient.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: ctx.tenantId,
          id: 'recipient-a',
          state: 'held',
          delivery: expect.objectContaining({ ownerClerkId: ctx.clerkUserId }),
        }),
      }),
    );
    expect(tx.legiWatchDeliveryRecipient.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: 'queued', dispatchStartedAt: null }),
      }),
    );
  });
  it('requires an explicit outcome and records confirmed acceptance without resending', async () => {
    const { service, tx } = setup();
    await expect(
      service.reconcile(ctx, 'recipient-a', { reason: 'Provider audit' }),
    ).rejects.toThrow('EXPLICIT_RECONCILIATION_REQUIRED');
    expect(tx.legiWatchDeliveryRecipient.updateMany).not.toHaveBeenCalled();
    await service.reconcile(ctx, 'recipient-a', {
      reason: 'Provider audit',
      outcome: 'provider_accepted',
      providerId: 'synthetic-receipt',
    });
    expect(tx.legiWatchDeliveryRecipient.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: ctx.tenantId, id: 'recipient-a', state: 'uncertain' },
        data: expect.objectContaining({
          state: 'provider_accepted',
          providerId: 'synthetic-receipt',
        }),
      }),
    );
  });
});
