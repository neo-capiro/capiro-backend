import { SESv2Client } from '@aws-sdk/client-sesv2';
import { defaultNewsletterConfig, governmentAffairsNewsletter } from '@capiro/shared/newsletter';
import { NewsletterInvitationEmailWorker } from './newsletter-invitation-email.worker.js';

const mockSend = jest.fn();
const mockDestroy = jest.fn();
jest.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: jest.fn().mockImplementation(() => ({ send: mockSend, destroy: mockDestroy })),
  SendEmailCommand: class {
    constructor(public input: unknown) {}
  },
}));
const tenantId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const sourceId = '44444444-4444-4444-8444-444444444444';
const workers: NewsletterInvitationEmailWorker[] = [];
afterEach(() => {
  workers.splice(0).forEach((worker) => worker.onModuleDestroy());
  jest.clearAllMocks();
});
function fixture(enabled: boolean | string = true) {
  const records = new Map<string, { status: string; messageId?: string; errorCode?: string }>();
  const state = {
    authorized: true,
    clientAllowed: true,
    stale: false,
    failReceipt: false,
    message: {
      documentId,
      role: 'editor',
      recipientId: 'reviewer',
      userId: id,
      authorUserId: documentId,
      email: 'reviewer@example.com',
      name: 'Policy reviewer',
      authorName: 'Author <img>',
      title: 'Weekly newsletter\r\nInjected',
      message: '<script>bad()</script> Check the bill.',
      design: governmentAffairsNewsletter(),
      config: defaultNewsletterConfig(),
      sourceClientIds: [] as string[],
    },
  };
  const tx = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) => {
      const text = sql.join('?');
      if (text.includes('INSERT INTO')) {
        if (records.has(id)) return [];
        records.set(id, { status: 'claimed' });
        return [{ id, documentId, commentId: documentId }];
      }
      if (text.includes('AS allowed FROM clients')) return [{ allowed: state.clientAllowed }];
      return state.authorized ? [state.message] : [];
    }),
    newsletterInvitationEmailDelivery: {
      updateMany: jest.fn(async ({ where, data }) => {
        const record = records.get(where.id);
        if (
          !record ||
          !(typeof where.status === 'string'
            ? record.status === where.status
            : where.status.in.includes(record.status))
        )
          return { count: 0 };
        if (state.failReceipt && data.status === 'sent') throw new Error('Receipt storage failed');
        Object.assign(record, data);
        return { count: 1 };
      }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, fn) => fn(tx)),
    withSystem: jest.fn(async (fn) =>
      fn({
        $queryRaw: async (sql: TemplateStringsArray) =>
          sql.join('?').includes("status IN ('claimed'")
            ? state.stale
              ? [{ id, tenantId }]
              : []
            : !records.has(id)
              ? [{ id, tenantId }]
              : [],
      }),
    ),
  };
  const config = {
    get: (key: string) =>
      ({
        NEWSLETTER_INVITATION_EMAIL_ENABLED: enabled,
        NEWSLETTER_REVIEW_APP_URL: 'https://app.capiro.ai',
        AWS_REGION_DEFAULT: 'us-east-1',
        WORKSPACE_INVITE_EMAIL_FROM: 'notifications@capiro.ai',
      })[key],
  };
  mockSend.mockResolvedValue({ MessageId: 'provider-1' });
  const worker = new NewsletterInvitationEmailWorker(prisma as never, config as never);
  workers.push(worker);
  return { worker, prisma, tx, state, records };
}
describe('newsletter invitation email delivery', () => {
  it.each([false, 'false'])('does not poll or send when disabled (%s)', async (disabled) => {
    const f = fixture(disabled);
    f.worker.onModuleInit();
    await f.worker.tick();
    expect(f.prisma.withSystem).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
  it('derives an escaped email from authoritative records and sends once with an audited receipt', async () => {
    const f = fixture();
    await f.worker.tick();
    await f.worker.tick();
    expect(SESv2Client).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 1 }));
    expect(mockSend).toHaveBeenCalledTimes(1);
    const input = mockSend.mock.calls[0][0].input;
    expect(input.Destination.ToAddresses).toEqual(['reviewer@example.com']);
    expect(input.Content.Simple.Subject.Data).not.toMatch(/[\r\n]/);
    expect(input.Content.Simple.Body.Html.Data).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(input.Content.Simple.Body.Html.Data).not.toContain('<script>');
    expect(input.Content.Simple.Body.Html.Data).toContain('Author</strong>');
    expect(input.Content.Simple.Body.Html.Data).toContain(
      `https://app.capiro.ai/workspace/newsletters/${documentId}/review`,
    );
    expect(f.records.get(id)).toMatchObject({ status: 'sent', messageId: 'provider-1' });
    expect(f.tx.auditLog.create.mock.calls.map((call) => call[0].data.action)).toEqual([
      'newsletter_invitation_email_claimed',
      'newsletter_invitation_email_sending',
      'newsletter_invitation_email_sent',
    ]);
    expect(f.prisma.withTenant.mock.calls.every((call) => call[0] === tenantId)).toBe(true);
  });
  it('cancels requests when current grant, membership or invitation is unavailable', async () => {
    const f = fixture();
    f.state.authorized = false;
    await f.worker.tick();
    expect(f.records.get(id)).toMatchObject({
      status: 'cancelled',
      errorCode: 'AccessUnavailable',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
  it('retains original client checks after an edit and cancels a revoked client wall', async () => {
    const f = fixture();
    f.state.message.sourceClientIds = [sourceId];
    f.state.clientAllowed = false;
    await f.worker.tick();
    expect(
      f.tx.$queryRaw.mock.calls.some((call) => call[0].join('?').includes('client_memory_access')),
    ).toBe(true);
    expect(f.records.get(id)?.status).toBe('cancelled');
    expect(mockSend).not.toHaveBeenCalled();
  });
  it('does not retry ambiguous provider outcomes or expose provider error details', async () => {
    const f = fixture();
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('Private provider details'), { name: 'TimeoutError' }),
    );
    await f.worker.tick();
    await f.worker.tick();
    expect(f.records.get(id)).toMatchObject({
      status: 'outcome_unknown',
      errorCode: 'TimeoutError',
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.tx.auditLog.create.mock.calls)).not.toContain(
      'Private provider details',
    );
  });
  it('records an explicit provider rejection without an automatic resend', async () => {
    const f = fixture();
    mockSend.mockRejectedValueOnce({ name: 'MessageRejected', $metadata: { httpStatusCode: 400 } });
    await f.worker.tick();
    await f.worker.tick();
    expect(f.records.get(id)).toMatchObject({ status: 'failed', errorCode: 'MessageRejected' });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
  it('recovers interrupted receipt persistence without another provider call', async () => {
    const f = fixture();
    f.state.failReceipt = true;
    await f.worker.tick();
    expect(f.records.get(id)?.status).toBe('sending');
    f.state.failReceipt = false;
    f.state.stale = true;
    await f.worker.tick();
    expect(f.records.get(id)).toMatchObject({
      status: 'outcome_unknown',
      errorCode: 'WorkerInterrupted',
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
  it('prevents overlapping ticks from sending twice', async () => {
    const f = fixture();
    let complete!: (value: { MessageId: string }) => void;
    mockSend.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const first = f.worker.tick();
    while (!complete) await Promise.resolve();
    await f.worker.tick();
    complete({ MessageId: 'accepted' });
    await first;
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
