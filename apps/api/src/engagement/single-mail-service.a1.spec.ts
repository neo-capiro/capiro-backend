// Exercise the actual service boundary. Unrelated document/AI/provider constructors
// are mocked; current admission and the send orchestration remain production code.
jest.doMock('@nestjs/throttler', () => ({ Throttle: () => () => {} }), { virtual: true });
for (const module of [
  '../ai-credentials/ai-credential-resolver.service.js',
  './attachment-pdf-vision.js',
  './generation/generation-gateway.service.js',
  './generation/outreach-truth.service.js',
  './generation/evidence-source.service.js',
  './attachment-content.service.js',
  './attachment-scanner.service.js',
  './outreach-draft.service.js',
  '../quality-telemetry/quality-telemetry-capture.service.js',
  '../directory/directory.service.js',
  '../lobby-intel/lobby-intel.service.js',
  '../federal-spending/federal-spending.service.js',
  './client-association.service.js',
  './engagement-ai.service.js',
  './meeting-notes-crypto.service.js',
  '../embeddings/client-kb.service.js',
  './generation/alert-packet-client.service.js',
  '../prisma/prisma.service.js',
  './xlsx-extract.js',
  './pptx-extract.js',
  './meeting-prep-pdf.js',
  './attachment-context-extract.js',
  './meeting-prep-job.service.js',
  './outreach-job.service.js',
  './notetaker/notetaker.service.js',
  './outreach-send-intent.service.js',
])
  jest.doMock(module, () => new Proxy({}, { get: () => class {} }));
for (const module of [
  '@aws-sdk/client-s3',
  '@aws-sdk/s3-presigned-post',
  '@aws-sdk/s3-request-presigner',
  '@capiro/meriv2-core',
  'mammoth',
]) {
  jest.doMock(module, () => new Proxy({}, { get: () => class {} }), { virtual: true });
}
jest.doMock('./mail-sender.service.js', () => ({
  EngagementMailSender: class {},
  sendProviderSlug: () => 'gmail',
}));
jest.doMock('../common/sanitize-signature.js', () => ({
  sanitizeSignatureHtml: (value: string) => value,
}));

const ledger = {
  validateKey: jest.fn((key) => key),
  read: jest.fn(),
  assertRequest: jest.fn(),
  begin: jest.fn(),
  claim: jest.fn(),
  rejectPending: jest.fn(),
  outcome: jest.fn(),
  receipt: jest.fn(),
  view: jest.fn(),
  acceptedInTx: jest.fn(),
  receiptInTx: jest.fn(),
};
jest.doMock('./single-mail-ledger.js', () => ({
  SingleMailLedger: Object.assign(jest.fn(() => ledger), {
    acceptedInTx: (...args: unknown[]) => ledger.acceptedInTx(...args),
    receiptInTx: (...args: unknown[]) => ledger.receiptInTx(...args),
  }),
  singleMailHash: () => 'hash',
}));
const { EngagementService } =
  require('./engagement.service.js') as typeof import('./engagement.service.js');
const { EngagementController } = require('./engagement.controller.js');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');

const ctx = { tenantId: 'tenant', userId: 'actor', role: 'standard_user' } as never;
const input = {
  requestKey: '11111111-1111-4111-8111-111111111111',
  clientId: '22222222-2222-4222-8222-222222222222',
  senderConnectionId: '33333333-3333-4333-8333-333333333333',
  to: [{ email: 'target@example.test' }],
  subject: 'Private',
  bodyHtml: '<p>Private</p>',
};
function fixture() {
  const tx = {
    tenantMembership: { findFirst: jest.fn().mockResolvedValue({ id: 'membership' }) },
    integrationConnection: { findFirst: jest.fn().mockResolvedValue({ id: 'mailbox' }) },
    client: { findFirst: jest.fn().mockResolvedValue({ id: 'client' }) },
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
  };
  const service = Object.create(EngagementService.prototype) as any;
  service.prisma = { withTenant: async (_: string, run: any) => run(tx) };
  service.findCampaignSendConnection = jest.fn().mockResolvedValue({
    id: 'mailbox',
    provider: 'google_workspace',
    accountEmail: 'sender@example.test',
  });
  service.resolveSenderSignatureHtml = jest.fn().mockResolvedValue({ signatureHtml: null });
  service.loadGraphAttachments = jest.fn().mockResolvedValue(undefined);
  service.mailSender = { sendMail: jest.fn().mockRejectedValue(new Error('socket closed')) };
  ledger.read.mockResolvedValue(null);
  ledger.begin.mockResolvedValue({ created: true, intent: { id: 'intent' } });
  const sendingTransition = jest.fn();
  ledger.claim.mockImplementation(
    async (_ctx: unknown, _intent: unknown, authorize: (tx: unknown) => Promise<void>) => {
      await authorize(tx);
      sendingTransition();
      return true;
    },
  );
  ledger.outcome.mockResolvedValue(undefined);
  ledger.rejectPending.mockResolvedValue(true);
  return { tx, service, sendingTransition };
}
async function api(service: unknown) {
  const dependencies: unknown[] = Reflect.getMetadata('design:paramtypes', EngagementController);
  const mod = await Test.createTestingModule({
    controllers: [EngagementController],
    providers: dependencies.map((provide, index) => ({
      provide,
      useValue: index === 0 ? service : {},
    })),
  }).compile();
  const app = mod.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );
  // Auth middleware is outside this harness; retain real controller, DTO and RolesGuard.
  app.use((req: any, _res: any, next: () => void) => {
    req.tenantContext = ctx;
    next();
  });
  await app.listen(0, '127.0.0.1');
  return { app, base: await app.getUrl() };
}
beforeEach(() => {
  jest.clearAllMocks();
  ledger.validateKey.mockImplementation((key) => key);
});
describe('single mail direct service boundary', () => {
  function graphReceiptFixture(syncFirst: boolean, loseCommit = false) {
    const h = fixture();
    const intentId = '44444444-4444-4444-8444-444444444444';
    const identity = { intentId, immutableId: 'Immutable-A', conversationId: 'conversation', observed: syncFirst };
    const connection = { id: 'mailbox', provider: 'microsoft_365', accountEmail: 'sender@example.test',
      status: 'connected', createdByUserId: 'actor' };
    const thread = { id: 'stable-thread', tenantId: 'tenant', connectionId: 'mailbox', source: 'outlook', externalId: 'conversation' };
    const providerMessage = { id: 'stable-message', connectionId: 'mailbox', threadId: thread.id, thread,
      source: 'outlook', externalId: 'default-sent', bodyText: 'Authoritative full body',
      metadata: { folder: 'sentitems', bodyCompleteness: 'full', mailboxSyncMode: 'incremental', graphMailIdentity: identity } };
    const accepted = { ok: true, provider: 'microsoft_graph', providerImmutableMessageId: identity.immutableId,
      providerConversationId: identity.conversationId, correlationId: intentId };
    const intent: any = { id: intentId, state: 'accepted', actor_id: 'actor', connection_id: 'mailbox',
      client_id: input.clientId, request_key: input.requestKey, snapshot: { senderEmail: 'sender@example.test' },
      provider_evidence: accepted, receipt: null };
    const tx: any = h.tx;
    tx.$queryRaw = jest.fn().mockResolvedValue([{ id: 'mailbox' }]);
    tx.$executeRaw = jest.fn().mockResolvedValue(1);
    tx.integrationConnection.findFirst.mockResolvedValue(connection);
    tx.mailThread = { upsert: jest.fn().mockResolvedValue(thread) };
    tx.mailMessage = {
      findMany: jest.fn().mockResolvedValue(syncFirst ? [providerMessage] : []),
      upsert: jest.fn(async ({ create }: any) => ({ id: 'stable-message', ...create })),
      update: jest.fn(async ({ data }: any) => ({ ...providerMessage, ...data })),
    };
    tx.engagementAttachment = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    h.service.findCampaignSendConnection.mockResolvedValue(connection);
    h.service.mailSender.sendMail.mockResolvedValue(accepted);
    h.service.assertSingleMailAttachmentsInTx = jest.fn().mockResolvedValue(undefined);
    h.service.loadGraphAttachments.mockResolvedValue([{ name: 'f.txt', contentType: 'text/plain', contentBytes: 'Zg==' }]);
    ledger.begin.mockResolvedValue({ created: true, intent });
    ledger.acceptedInTx.mockResolvedValue(intent);
    ledger.read.mockResolvedValueOnce(null).mockImplementation(async () => intent);
    ledger.view.mockImplementation((row) => ({ state: row.state, retryable: false, ...row.receipt }));
    let inside = false;
    ledger.receiptInTx.mockImplementation(async (actualTx, _tenant, _intent, receipt) => {
      expect(inside).toBe(true); expect(actualTx).toBe(tx); intent.receipt = receipt;
    });
    h.service.prisma.withTenant = async (_tenant: string, run: any) => {
      inside = true; const before = intent.receipt;
      try {
        const out = await run(tx);
        if (loseCommit && intent.receipt !== before) throw Error('Commit unavailable');
        return out;
      } catch (error) { intent.receipt = before; throw error; }
      finally { inside = false; }
    };
    return { ...h, tx, intent, providerMessage };
  }
  test.each([false, true])('ML-04 receipt transaction retains stable message/files when syncFirst=%s', async (syncFirst) => {
    const h = graphReceiptFixture(syncFirst);
    const sent = await h.service.sendSingleMail(ctx, { ...input, attachmentIds: ['file-id'] });
    expect(sent).toMatchObject({ state: 'accepted', messageId: 'stable-message', threadId: 'stable-thread',
      mailboxConfirmation: syncFirst ? 'confirmed' : 'pending', retryable: false });
    expect(h.tx.engagementAttachment.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant', id: { in: ['file-id'] }, mailMessageId: null }, data: { mailMessageId: 'stable-message' },
    });
    expect(ledger.receipt).not.toHaveBeenCalled();
    expect(ledger.receiptInTx).toHaveBeenCalledTimes(1);
    expect(h.service.mailSender.sendMail).toHaveBeenCalledTimes(1);
    if (syncFirst) {
      expect(h.tx.mailMessage.upsert).not.toHaveBeenCalled();
      expect(h.tx.mailThread.upsert).not.toHaveBeenCalled();
      expect(h.tx.mailMessage.update).toHaveBeenCalledWith({ where: { id: 'stable-message', connectionId: 'mailbox' }, data: { hasAttachments: true } });
      expect(h.providerMessage.bodyText).toBe('Authoritative full body');
      expect(h.providerMessage.metadata).toMatchObject({ mailboxSyncMode: 'incremental', bodyCompleteness: 'full' });
    }
  });
  test('ML-04 lost receipt transaction retains provider acceptance without publishing confirmation', async () => {
    const h = graphReceiptFixture(true, true);
    await expect(h.service.sendSingleMail(ctx, { ...input, attachmentIds: ['file-id'] }))
      .rejects.toMatchObject({ response: { error: 'MAIL_SEND_RECEIPT_UNAVAILABLE', retryable: false } });
    expect(h.intent.receipt).toBeNull();
    expect(ledger.outcome).toHaveBeenCalledWith(ctx, h.intent, 'accepted', expect.anything());
    expect(h.service.mailSender.sendMail).toHaveBeenCalledTimes(1);
    expect(ledger.receipt).not.toHaveBeenCalled();
  });
  test('ML-21 HTTP aggregate refusal is durable and actionable before sending transition or provider', async () => {
    const h = fixture();
    h.service.findCampaignSendConnection.mockResolvedValue({
      id: 'mailbox',
      provider: 'microsoft_365',
      accountEmail: 'sender@example.test',
    });
    h.service.loadGraphAttachments.mockResolvedValue(
      ['first.pdf', 'second.pdf'].map((name) => ({
        name,
        contentType: 'application/pdf',
        contentBytes: Buffer.alloc(1_500_000).toString('base64'),
      })),
    );
    const { app, base } = await api(h.service);
    try {
      const response = await fetch(`${base}/engagement/mail/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'MAIL_SEND_REJECTED',
        code: 'MAIL_PAYLOAD_TOO_LARGE',
        requestKey: input.requestKey,
        intentId: 'intent',
        state: 'failed',
        retryable: false,
        message: expect.stringContaining('Reduce the message or attachments'),
      });
      expect(ledger.begin).toHaveBeenCalledTimes(1);
      expect(ledger.rejectPending).toHaveBeenCalledWith(ctx, { id: 'intent' });
      expect(h.sendingTransition).not.toHaveBeenCalled();
      expect(ledger.outcome).not.toHaveBeenCalled();
      expect(h.service.mailSender.sendMail).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  test('ML-21 includes the rendered Unicode signature before the sending transition', async () => {
    const h = fixture();
    h.service.findCampaignSendConnection.mockResolvedValue({
      id: 'mailbox',
      provider: 'microsoft_365',
      accountEmail: 'sender@example.test',
    });
    h.service.resolveSenderSignatureHtml.mockResolvedValue({
      signatureHtml: `<p>${'é'.repeat(2_000)}</p>`,
    });
    h.service.loadGraphAttachments.mockResolvedValue([
      {
        name: 'report.pdf',
        contentType: 'application/pdf',
        contentBytes: Buffer.alloc(2_999_000).toString('base64'),
      },
    ]);
    await expect(h.service.sendSingleMail(ctx, input)).rejects.toMatchObject({
      response: {
        code: 'MAIL_PAYLOAD_TOO_LARGE',
        error: 'MAIL_SEND_REJECTED',
        intentId: 'intent',
        state: 'failed',
        requestKey: input.requestKey,
      },
    });
    expect(ledger.begin).toHaveBeenCalledTimes(1);
    expect(ledger.rejectPending).toHaveBeenCalledWith(ctx, { id: 'intent' });
    expect(h.sendingTransition).not.toHaveBeenCalled();
    expect(h.service.mailSender.sendMail).not.toHaveBeenCalled();
  });
  test.each(['sending', 'oversized'] as const)(
    'ML-21 concurrent same-key signature change preserves the %s winner',
    async (winner) => {
      const h = fixture();
      h.service.findCampaignSendConnection.mockResolvedValue({
        id: 'mailbox', provider: 'microsoft_365', accountEmail: 'sender@example.test',
      });
      h.service.loadGraphAttachments.mockResolvedValue([{
        name: 'report.pdf', contentType: 'application/pdf',
        contentBytes: Buffer.alloc(2_999_000).toString('base64'),
      }]);
      let releaseReads!: () => void;
      const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
      let reads = 0;
      ledger.read.mockImplementation(async () => {
        if (++reads === 2) releaseReads();
        await bothRead;
        return null;
      });
      let releaseSecond!: () => void;
      const ownerReached = new Promise<void>((resolve) => { releaseSecond = resolve; });
      const largeSignature = `<p>${'é'.repeat(2_000)}</p>`;
      h.service.resolveSenderSignatureHtml
        .mockResolvedValueOnce({ signatureHtml: winner === 'oversized' ? largeSignature : null })
        .mockImplementationOnce(async () => {
          await ownerReached;
          return { signatureHtml: winner === 'sending' ? largeSignature : null };
        });
      let state = 'pending';
      // Model the existing unique-key winner: only the creator may reach claim.
      ledger.begin
        .mockResolvedValueOnce({ created: true, intent: { id: 'intent' } })
        .mockImplementation(async () => ({ created: false, intent: { id: 'intent', state } }));
      ledger.rejectPending.mockImplementation(async () => {
        state = 'failed';
        return true;
      });
      let finishProvider: ((error: Error) => void) | undefined;
      h.service.mailSender.sendMail.mockImplementation(() => {
        state = 'sending';
        releaseSecond();
        if (winner === 'oversized') return Promise.reject(new Error('unexpected dispatch'));
        return new Promise((_resolve, reject) => { finishProvider = reject; });
      });
      h.service.getSingleMailIntent = jest.fn(async () => ({
        state, intentId: 'intent', requestKey: input.requestKey, retryable: false,
      }));
      const sameInput = { ...input, appendSignature: true };
      const first = h.service.sendSingleMail(ctx, sameInput)
        .catch((error: unknown) => error)
        .finally(releaseSecond);
      const duplicate = await h.service.sendSingleMail(ctx, sameInput)
        .catch((error: unknown) => error);
      finishProvider?.(new Error('synthetic provider acknowledgement lost'));
      const firstResult = await first;
      expect(ledger.begin).toHaveBeenCalledTimes(2);
      expect(ledger.claim).toHaveBeenCalledTimes(1);
      if (winner === 'sending') {
        expect(duplicate).toMatchObject({ state: 'sending', requestKey: input.requestKey });
        expect(ledger.rejectPending).not.toHaveBeenCalled();
        expect(h.sendingTransition).toHaveBeenCalledTimes(1);
        expect(h.service.mailSender.sendMail).toHaveBeenCalledTimes(1);
        expect(ledger.outcome).toHaveBeenCalledWith(ctx, { id: 'intent' }, 'unknown', expect.anything());
        expect(firstResult).toMatchObject({ response: { error: 'MAIL_SEND_OUTCOME_UNKNOWN' } });
      } else {
        expect(firstResult).toMatchObject({ response: {
          error: 'MAIL_SEND_REJECTED', code: 'MAIL_PAYLOAD_TOO_LARGE',
          state: 'failed', intentId: 'intent', requestKey: input.requestKey,
        } });
        expect(duplicate).toMatchObject({ state: 'failed', requestKey: input.requestKey });
        expect(ledger.rejectPending).toHaveBeenCalledTimes(1);
        expect(h.sendingTransition).not.toHaveBeenCalled();
        expect(h.service.mailSender.sendMail).not.toHaveBeenCalled();
      }
    },
  );
  test.each(['lost CAS', 'lost rejection commit'])(
    'ML-21 %s cannot turn size refusal into definite non-delivery',
    async (phase) => {
      const h = fixture();
      h.service.findCampaignSendConnection.mockResolvedValue({
        id: 'mailbox', provider: 'microsoft_365', accountEmail: 'sender@example.test',
      });
      h.service.loadGraphAttachments.mockResolvedValue([
        { name: 'report.pdf', contentType: 'application/pdf', contentBytes: Buffer.alloc(3_000_000).toString('base64') },
      ]);
      if (phase === 'lost CAS') ledger.rejectPending.mockResolvedValue(false);
      else ledger.rejectPending.mockRejectedValue(new Error('rejection commit outcome lost'));
      const failure = await h.service.sendSingleMail(ctx, input).catch((error: unknown) => error);
      expect(ledger.rejectPending).toHaveBeenCalledTimes(1);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.response?.error).not.toBe('MAIL_SEND_REJECTED');
      expect(failure.response?.phase).not.toBe('preflight');
      expect(h.sendingTransition).not.toHaveBeenCalled();
      expect(h.service.mailSender.sendMail).not.toHaveBeenCalled();
    },
  );
  test('ML-21 accepted mail preserves the canonical rendered body and signature', async () => {
    const h = fixture();
    h.service.resolveSenderSignatureHtml.mockResolvedValue({ signatureHtml: '<p>Signature é</p>' });
    h.service.mailSender.sendMail.mockResolvedValue({
      ok: true,
      provider: 'gmail',
      providerMessageId: 'remote',
      providerThreadId: 'remote-thread',
      correlationId: 'intent',
    });
    Object.assign(h.tx, {
      mailThread: {
        upsert: jest.fn().mockResolvedValue({ id: 'thread', connectionId: 'mailbox' }),
      },
      mailMessage: {
        upsert: jest
          .fn()
          .mockResolvedValue({ id: 'message', threadId: 'thread', connectionId: 'mailbox' }),
      },
    });
    h.service.getSingleMailIntent = jest.fn().mockResolvedValue({ state: 'accepted' });
    await expect(
      h.service.sendSingleMail(ctx, { ...input, bodyHtml: '<p>你好</p><script>unsafe()</script>' }),
    ).resolves.toMatchObject({ state: 'accepted' });
    const expected = '<p>你好</p><br><br><p>Signature é</p>';
    expect(h.service.mailSender.sendMail).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      expect.objectContaining({
        body: expected,
        bodyContentType: 'HTML',
        correlationId: 'intent',
      }),
    );
    expect(ledger.begin).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ snapshot: expect.objectContaining({ body: expected }) }),
    );
    expect(ledger.outcome).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      'accepted',
      expect.anything(),
    );
  });
  test('ML-21 actual oversized bytes still fail the canonical attachment loader before claim', async () => {
    const h = fixture();
    delete h.service.loadGraphAttachments;
    Object.assign(h.tx, {
      engagementAttachment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'file',
            clientId: input.clientId,
            fileName: 'changed.pdf',
            contentType: 'application/pdf',
            byteSize: 1,
            s3Key: 'synthetic-key',
          },
        ]),
      },
    });
    h.service.validateAttachmentParents = jest.fn().mockResolvedValue(undefined);
    h.service.assertAttachmentUsable = jest.fn();
    h.service.readAttachmentBytes = jest.fn().mockResolvedValue(Buffer.alloc(3 * 1024 * 1024 + 1));
    await expect(
      h.service.sendSingleMail(ctx, { ...input, attachmentIds: ['file'] }),
    ).rejects.toMatchObject({
      response: { error: 'ATTACHMENT_TOO_LARGE' },
    });
    expect(h.service.readAttachmentBytes).toHaveBeenCalledTimes(1);
    expect(ledger.begin).not.toHaveBeenCalled();
    expect(ledger.claim).not.toHaveBeenCalled();
    expect(h.service.mailSender.sendMail).not.toHaveBeenCalled();
  });
  test('ML-21 defensive post-claim size refusal preserves actionable details and durable identity', async () => {
    const h = fixture();
    const { BadRequestException } = require('@nestjs/common');
    const { definiteMailSendRejection } = require('./mail-send-result.js');
    const message = 'Reduce the message or attachments and review the email again.';
    h.service.mailSender.sendMail.mockRejectedValue(
      definiteMailSendRejection(
        new BadRequestException({
          code: 'MAIL_PAYLOAD_TOO_LARGE',
          provider: 'gmail',
          maxBytes: 36_700_160,
          message,
        }),
      ),
    );
    await expect(h.service.sendSingleMail(ctx, input)).rejects.toMatchObject({
      response: {
        error: 'MAIL_SEND_REJECTED',
        code: 'MAIL_PAYLOAD_TOO_LARGE',
        state: 'failed',
        requestKey: input.requestKey,
        intentId: 'intent',
        retryable: false,
        message,
      },
    });
    expect(ledger.outcome).toHaveBeenCalledWith(ctx, expect.anything(), 'failed', {
      code: 'MAIL_PAYLOAD_TOO_LARGE',
    });
    expect(h.service.mailSender.sendMail).toHaveBeenCalledTimes(1);
  });
  test('direct HTTP send without a durable request identity is refused before provider work', async () => {
    const h = fixture();
    const { app, base } = await api(h.service);
    try {
      const { requestKey: _key, ...withoutKey } = input;
      const response = await fetch(`${base}/engagement/mail/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withoutKey),
      });
      expect(response.status).toBe(400);
      expect(h.service.mailSender.sendMail).not.toHaveBeenCalled();
      expect(ledger.begin).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  test.each(['client', 'member', 'mailbox'])(
    'direct HTTP send and recovery reject inaccessible %s without attachments or provider calls',
    async (kind) => {
      const h = fixture();
      if (kind === 'client') h.tx.client.findFirst.mockResolvedValue(null);
      if (kind === 'member') h.tx.tenantMembership.findFirst.mockResolvedValue(null);
      if (kind === 'mailbox') h.tx.integrationConnection.findFirst.mockResolvedValue(null);
      const { app, base } = await api(h.service);
      try {
        const sent = await fetch(`${base}/engagement/mail/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        expect(sent.status).toBe(kind === 'member' ? 403 : 404);
        ledger.read.mockResolvedValue({
          client_id: input.clientId,
          connection_id: input.senderConnectionId,
          snapshot: {},
        });
        const recovered = await fetch(`${base}/engagement/mail/send-intents/${input.requestKey}`);
        expect(recovered.status).toBe(kind === 'member' ? 403 : 404);
      } finally {
        await app.close();
      }
      expect(h.service.mailSender.sendMail).not.toHaveBeenCalled();
      expect(ledger.begin).not.toHaveBeenCalled();
    },
  );
  test('revocation during attachment fetch is rechecked before claim/send', async () => {
    const h = fixture();
    h.service.loadGraphAttachments.mockImplementation(async () => {
      h.tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
      return undefined;
    });
    await expect(h.service.sendSingleMail(ctx, input)).rejects.toMatchObject({
      response: {
        error: 'MAIL_SEND_REJECTED',
        state: 'failed',
        requestKey: input.requestKey,
        retryable: false,
      },
    });
    expect(ledger.rejectPending).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ id: 'intent' }),
    );
    expect(h.service.mailSender.sendMail).not.toHaveBeenCalled();
  });
  test('an attachment removed during byte loading cannot cross the provider boundary', async () => {
    const h = fixture();
    Object.assign(h.tx, { engagementAttachment: { findMany: jest.fn().mockResolvedValue([]) } });
    h.service.loadGraphAttachments.mockResolvedValue([
      { name: 'private.txt', contentType: 'text/plain', contentBytes: 'cHJpdmF0ZQ==' },
    ]);
    await expect(
      h.service.sendSingleMail(ctx, {
        ...input,
        attachmentIds: ['44444444-4444-4444-8444-444444444444'],
      }),
    ).rejects.toMatchObject({
      response: {
        error: 'MAIL_SEND_REJECTED',
        state: 'failed',
        requestKey: input.requestKey,
        retryable: false,
      },
    });
    expect(ledger.rejectPending).toHaveBeenCalledTimes(1);
    expect(h.service.mailSender.sendMail).not.toHaveBeenCalled();
  });
  test('a duplicate existing intent returns owned status without a second provider call', async () => {
    const h = fixture();
    ledger.read.mockResolvedValue({ request_key: input.requestKey });
    h.service.getSingleMailIntent = jest
      .fn()
      .mockResolvedValue({ state: 'unknown', requestKey: input.requestKey });
    await expect(h.service.sendSingleMail(ctx, input)).resolves.toMatchObject({ state: 'unknown' });
    expect(h.service.mailSender.sendMail).not.toHaveBeenCalled();
    expect(ledger.begin).not.toHaveBeenCalled();
    expect(h.service.loadGraphAttachments).not.toHaveBeenCalled();
  });
  test.each(['member', 'mailbox'])(
    'final %s refusal records a committed safe rejection without dispatch',
    async (kind) => {
      const h = fixture();
      h.service.loadGraphAttachments.mockImplementation(async () => {
        if (kind === 'member') h.tx.tenantMembership.findFirst.mockResolvedValue(null);
        else
          h.tx.integrationConnection.findFirst
            .mockResolvedValueOnce({ id: 'mailbox' })
            .mockResolvedValue(null);
      });
      await expect(h.service.sendSingleMail(ctx, input)).rejects.toMatchObject({
        response: { error: 'MAIL_SEND_REJECTED', state: 'failed', requestKey: input.requestKey },
      });
      expect(ledger.rejectPending).toHaveBeenCalledTimes(1);
      expect(h.service.mailSender.sendMail).not.toHaveBeenCalled();
    },
  );
  test.each(['unavailable', 'claim commit', 'typed claim commit'])(
    '%s uncertainty cannot be classified as a final preflight rejection',
    async (phase) => {
      const h = fixture();
      const { NotFoundException } = require('@nestjs/common');
      const failure =
        phase === 'typed claim commit'
          ? new NotFoundException('commit outcome lost')
          : new Error('unavailable');
      if (phase === 'unavailable')
        h.service.loadGraphAttachments.mockImplementation(async () => {
          h.tx.client.findFirst.mockRejectedValue(failure);
        });
      else
        ledger.claim.mockImplementation(async (_ctx, _intent, authorize) => {
          await authorize(h.tx);
          throw failure;
        });
      await expect(h.service.sendSingleMail(ctx, input)).rejects.toBe(failure);
      expect(ledger.rejectPending).not.toHaveBeenCalled();
      expect(h.service.mailSender.sendMail).not.toHaveBeenCalled();
    },
  );
  test.each(['lost CAS', 'lost rejection commit'])(
    '%s cannot return a safe-failure receipt',
    async (phase) => {
      const h = fixture();
      h.service.loadGraphAttachments.mockImplementation(async () => {
        h.tx.client.findFirst.mockResolvedValue(null);
      });
      if (phase === 'lost CAS') ledger.rejectPending.mockResolvedValue(false);
      else ledger.rejectPending.mockRejectedValue(new Error('rejection commit outcome lost'));
      const failure = await h.service.sendSingleMail(ctx, input).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.response?.error).not.toBe('MAIL_SEND_REJECTED');
      expect(h.service.mailSender.sendMail).not.toHaveBeenCalled();
    },
  );
  test('dispatch failure records unknown and never retries the provider', async () => {
    const h = fixture();
    await expect(h.service.sendSingleMail(ctx, input)).rejects.toThrow();
    expect(h.service.mailSender.sendMail).toHaveBeenCalledTimes(1);
    expect(ledger.rejectPending).not.toHaveBeenCalled();
    expect(ledger.outcome).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ id: 'intent' }),
      'unknown',
      expect.any(Object),
    );
  });
  test('a definite provider rejection records a failed receipt without a retry', async () => {
    const h = fixture();
    const { definiteMailSendRejection } = require('./mail-send-result.js');
    h.service.mailSender.sendMail.mockRejectedValue(
      definiteMailSendRejection(new Error('HTTP 429 refused')),
    );
    await expect(h.service.sendSingleMail(ctx, input)).rejects.toMatchObject({
      response: {
        error: 'MAIL_SEND_REJECTED',
        state: 'failed',
        requestKey: input.requestKey,
        retryable: false,
      },
    });
    expect(ledger.outcome).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      'failed',
      expect.anything(),
    );
    expect(h.service.mailSender.sendMail).toHaveBeenCalledTimes(1);
  });
  test('provider acceptance is saved even when client access is revoked during dispatch, and details are withheld', async () => {
    const h = fixture();
    h.service.mailSender.sendMail.mockImplementation(async () => {
      h.tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
      return {
        ok: true,
        provider: 'gmail',
        providerMessageId: 'remote',
        providerThreadId: 'remote-thread',
        correlationId: 'intent',
      };
    });
    Object.assign(h.tx, {
      mailThread: {
        upsert: jest.fn().mockResolvedValue({ id: 'thread', connectionId: 'mailbox' }),
      },
      mailMessage: {
        upsert: jest
          .fn()
          .mockResolvedValue({ id: 'message', threadId: 'thread', connectionId: 'mailbox' }),
      },
    });
    ledger.read.mockResolvedValueOnce(null).mockResolvedValue({
      id: 'intent',
      client_id: 'client',
      connection_id: 'mailbox',
      snapshot: {},
    });
    await expect(h.service.sendSingleMail(ctx, input)).rejects.toThrow('Client not found');
    expect(h.service.mailSender.sendMail).toHaveBeenCalledTimes(1);
    expect(ledger.outcome).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      'accepted',
      expect.objectContaining({ providerMessageId: 'remote' }),
    );
    expect(ledger.receipt).toHaveBeenCalled();
  });
});
