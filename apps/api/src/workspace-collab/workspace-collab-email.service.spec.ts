import { SESv2Client } from '@aws-sdk/client-sesv2';
import { WorkspaceCollabEmailService } from './workspace-collab-email.service.js';
import type { TenantContext } from '@capiro/shared';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
const mockSend = jest.fn();
const mockDestroy = jest.fn();
jest.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: jest.fn().mockImplementation(() => ({ send: mockSend, destroy: mockDestroy })),
  SendEmailCommand: class { constructor(public input: unknown) {} },
}));
const tenantId = '11111111-1111-4111-8111-111111111111';
const dto = { draftId: '22222222-2222-4222-8222-222222222222', invitationId: '33333333-3333-4333-8333-333333333333' };
const ctx = { tenantId, clerkUserId: 'owner', userId: 'user', role: 'standard_user' } as TenantContext;
const instances: WorkspaceCollabEmailService[] = [];
const originalFetch = global.fetch;
afterEach(() => { instances.splice(0).forEach(s => s.onModuleDestroy()); global.fetch = originalFetch; jest.clearAllMocks(); });

/** Memory transport stub only. SQL uniqueness/RLS/transactions are covered by
 * the separately runnable real-Prisma PG fixture, not claimed by these tests. */
function fixture() {
  let row: any = null;
  const state = { enabled: true, ownerAllowed: true, invitationPresent: true, stale: false, failReceipt: false,
    claimFails: false, beforeSending: undefined as (() => void) | undefined,
    invitation: { recipientId: 'recipient', email: 'recipient@example.test', recipientName: '<Recipient>', authorName: 'Author\r\n<script>',
      title: 'Private <title>', role: 'editor', updatedAt: '2026-10-26T00:00:00.000Z', clientId: null, prospectId: null } as any };
  const tx = {
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...values: any[]) => {
      const text = sql.join('?');
      if (text.includes('INSERT INTO')) {
        if (row || !state.invitationPresent || state.claimFails) return [];
        row = { id: dto.invitationId, tenantId, draftId: dto.draftId, requestedBy: 'owner', status: 'claimed', updatedAt: new Date(), messageId: null, errorCode: null };
        return [{ id: dto.invitationId }];
      }
      return row && values.includes(row.tenantId) ? [{ ...row }] : [];
    }),
    $executeRaw: jest.fn(async (sql: TemplateStringsArray, ...values: any[]) => {
      const text = sql.join('?');
      if (text.includes("interval '10 minutes'")) {
        if (state.stale && row && ['claimed', 'sending'].includes(row.status)) Object.assign(row, { status: 'outcome_unknown', errorCode: 'RequestInterrupted', updatedAt: new Date() });
        return 0;
      }
      if (text.includes('INSERT INTO')) {
        if (row) return 0;
        row = { id: dto.invitationId, tenantId, draftId: dto.draftId, requestedBy: 'owner', status: 'cancelled', updatedAt: new Date(), messageId: null, errorCode: 'CancelledByRequester' };
        return 1;
      }
      if (text.includes('FROM ws_collaborator')) {
        state.beforeSending?.();
        if (!row || row.status !== 'claimed' || !state.invitationPresent) return 0;
        Object.assign(row, { status: 'sending', updatedAt: new Date() }); return 1;
      }
      if (text.includes("SET status='cancelled'")) {
        if (!row || row.status !== 'claimed') return 0;
        Object.assign(row, { status: 'cancelled', errorCode: 'CancelledByRequester', updatedAt: new Date() }); return 1;
      }
      const [status, messageId, errorCode] = values;
      if (!row || row.status !== values.at(-1)) return 0;
      if (state.failReceipt && status === 'accepted') throw new Error('injected receipt failure');
      Object.assign(row, { status, messageId, errorCode, updatedAt: new Date() }); return 1;
    }),
  };
  const prisma = { withTenant: jest.fn(async (_tenant, operation) => operation(tx)) };
  const settings: Record<string, any> = { AWS_REGION_DEFAULT: 'us-east-1', WORKSPACE_API_BASE_URL: 'http://workspace.test',
    INTERNAL_SERVICE_SECRET: 'synthetic-service-secret', NEWSLETTER_REVIEW_APP_URL: 'https://app.example.test', WORKSPACE_INVITE_EMAIL_FROM: 'mail@example.test' };
  const config = { get: (key: string) => key === 'WORKSPACE_INVITE_EMAIL_ENABLED' ? state.enabled : settings[key] };
  const fetchMock = jest.fn(async (_url: unknown, options: any) => {
    const body = JSON.parse(options.body);
    if (!state.ownerAllowed || body.tenantId !== tenantId || body.actorId !== 'owner') return { ok: false, status: 404 } as Response;
    return { ok: true, status: 200, json: async () => ({ ...body, invitation: state.invitationPresent ? { ...state.invitation } : null, reason: 'InvitationUnavailable' }) } as Response;
  });
  global.fetch = fetchMock as any;
  mockSend.mockResolvedValue({ MessageId: 'ses-accepted' });
  const service = new WorkspaceCollabEmailService(prisma as never, config as never); instances.push(service);
  return { service, state, prisma, tx, fetchMock, settings, row: () => row };
}

describe('ordinary collaborator email one-attempt receipt', () => {
  it('commits before SES, escapes server content and binds the canonical native route', async () => {
    const f = fixture();
    mockSend.mockImplementation(async () => {
      expect(f.row().status).toBe('sending');
      expect(f.prisma.withTenant).toHaveBeenCalled();
      return { MessageId: 'ses-accepted' };
    });
    const result = await f.service.sendInvite(ctx, { ...dto, toEmail: 'attacker@example.test', link: 'https://evil.test' } as any);
    expect(result).toMatchObject({ status: 'accepted', providerMessageId: 'ses-accepted' });
    expect(result).not.toHaveProperty('sent');
    expect(SESv2Client).toHaveBeenCalledWith({ region: 'us-east-1', maxAttempts: 1 });
    const input = mockSend.mock.calls[0][0].input;
    expect(input.Destination.ToAddresses).toEqual(['recipient@example.test']);
    expect(input.Content.Simple.Subject.Data).not.toMatch(/[\r\n]/);
    expect(input.Content.Simple.Body.Html.Data).toContain('&lt;script&gt;');
    expect(input.Content.Simple.Body.Html.Data).toContain(`/modules/workspace?draftId=${dto.draftId}`);
    expect(JSON.stringify(input)).not.toContain('evil.test');
    expect(mockSend.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal);
    const fetchCall = f.fetchMock.mock.calls[0];
    if (!fetchCall) throw new Error('The invitation authority was not read');
    expect(JSON.parse(fetchCall[1].body)).toEqual({ tenantId, actorId: 'owner', ...dto });
  });

  it('fences simultaneous requests and exact retry after a lost acknowledgement', async () => {
    const f = fixture();
    const results = await Promise.all([f.service.sendInvite(ctx, dto), f.service.sendInvite(ctx, dto)]);
    expect(results.some(result => result.status === 'accepted')).toBe(true);
    expect((await f.service.sendInvite(ctx, dto)).status).toBe('accepted');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ name: 'TimeoutError' }, 'outcome_unknown'],
    [{ name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } }, 'outcome_unknown'],
    [{ name: 'RequestTimeout', $metadata: { httpStatusCode: 408 } }, 'outcome_unknown'],
    [{ name: 'MessageRejected', $metadata: { httpStatusCode: 400 } }, 'failed'],
  ])('never resends after provider result %j', async (error, expected) => {
    const f = fixture(); mockSend.mockRejectedValueOnce(error);
    expect((await f.service.sendInvite(ctx, dto)).status).toBe(expected);
    expect((await f.service.sendInvite(ctx, dto)).status).toBe(expected);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('missing MessageId is unknown, and raw error details never enter the receipt', async () => {
    const f = fixture(); mockSend.mockResolvedValueOnce({});
    expect(await f.service.sendInvite(ctx, dto)).toMatchObject({ status: 'outcome_unknown', errorCode: 'MissingMessageId', providerMessageId: null });
    await f.service.sendInvite(ctx, dto); expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('acceptance followed by receipt failure stays fenced, then reconciles to unknown', async () => {
    const f = fixture(); f.state.failReceipt = true;
    await expect(f.service.sendInvite(ctx, dto)).rejects.toThrow('injected receipt failure');
    expect(f.row().status).toBe('sending');
    expect((await f.service.sendInvite(ctx, dto)).status).toBe('sending');
    f.state.stale = true; f.state.failReceipt = false;
    expect((await f.service.status(ctx, dto)).status).toBe('outcome_unknown');
    expect((await f.service.sendInvite(ctx, dto)).status).toBe('outcome_unknown');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('disabled remains disabled after activation; creating an invitation alone sends nothing', async () => {
    const f = fixture();
    expect(mockSend).not.toHaveBeenCalled(); f.state.enabled = false;
    expect((await f.service.sendInvite(ctx, dto)).status).toBe('disabled');
    f.state.enabled = true;
    expect((await f.service.sendInvite(ctx, dto)).status).toBe('disabled');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rechecks authority after claiming and rejects current revocation without sending', async () => {
    const f = fixture(); const original = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementation(async (...args) => { if (f.row()) f.state.ownerAllowed = false; return original(...args); });
    await expect(f.service.sendInvite(ctx, dto)).rejects.toThrow('Invitation not found');
    expect(f.row().status).toBe('cancelled'); expect(mockSend).not.toHaveBeenCalled();
    await expect(f.service.status(ctx, dto)).rejects.toThrow('Invitation not found');
  });

  it('refuses changed content/recipient and a deleted invitation at the sending fence', async () => {
    const f = fixture(); const original = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementation(async (...args) => { if (f.row()) f.state.invitation.email = 'changed@example.test'; return original(...args); });
    expect((await f.service.sendInvite(ctx, dto)).status).toBe('cancelled'); expect(mockSend).not.toHaveBeenCalled();
    const g = fixture(); g.state.beforeSending = () => { g.state.invitationPresent = false; };
    expect((await g.service.sendInvite(ctx, dto)).status).toBe('cancelled'); expect(mockSend).not.toHaveBeenCalled();
  });

  it('keeps unknown readback after invitation deletion, but current owner revocation still denies it', async () => {
    const f = fixture(); mockSend.mockRejectedValueOnce(new Error('private provider detail'));
    await f.service.sendInvite(ctx, dto); f.state.invitationPresent = false;
    expect((await f.service.status(ctx, dto)).status).toBe('outcome_unknown');
    expect(JSON.stringify(await f.service.sendInvite(ctx, dto))).not.toContain('private provider detail');
    f.state.ownerAllowed = false;
    await expect(f.service.status(ctx, dto)).rejects.toThrow();
    await expect(f.service.cancel(ctx, dto)).rejects.toThrow();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('cancellation before send consumes the key; cancellation cannot recall provider acceptance', async () => {
    const f = fixture();
    expect((await f.service.status(ctx, dto)).status).toBe('not_requested');
    expect((await f.service.cancel(ctx, dto)).status).toBe('cancelled');
    expect((await f.service.sendInvite(ctx, dto)).status).toBe('cancelled'); expect(mockSend).not.toHaveBeenCalled();
    const g = fixture(); await g.service.sendInvite(ctx, dto);
    expect((await g.service.cancel(ctx, dto)).status).toBe('accepted'); expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('cancellation racing the pre-provider access read stops the attempt', async () => {
    const f = fixture(); const original = f.fetchMock.getMockImplementation()!;
    let cancelled = false;
    f.fetchMock.mockImplementation(async (...args) => {
      if (f.row()?.status === 'claimed' && !cancelled) { cancelled = true; await f.service.cancel(ctx, dto); }
      return original(...args);
    });
    expect((await f.service.sendInvite(ctx, dto)).status).toBe('cancelled'); expect(mockSend).not.toHaveBeenCalled();
  });

  it('fails closed for another tenant, malformed owner response, external/unavailable recipient and missing owner configuration', async () => {
    const f = fixture(); await expect(f.service.sendInvite({ ...ctx, tenantId: dto.draftId }, dto)).rejects.toThrow();
    f.fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ tenantId: 'wrong' }) } as Response);
    await expect(f.service.sendInvite(ctx, dto)).rejects.toThrow('Workspace invitation response invalid');
    f.state.invitationPresent = false;
    await expect(f.service.sendInvite(ctx, dto)).rejects.toThrow('Invitation is not eligible');
    delete f.settings.WORKSPACE_API_BASE_URL;
    await expect(f.service.sendInvite(ctx, dto)).rejects.toThrow('Workspace invitation owner unavailable');
    expect(mockSend).not.toHaveBeenCalled(); expect(f.row()).toBeNull();
  });
});
