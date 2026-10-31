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
