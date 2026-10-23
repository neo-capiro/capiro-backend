import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';
import { MicrosoftCallbacksController } from './microsoft/microsoft-callbacks.controller.js';
import { GoogleCallbacksController } from './google/google-callbacks.controller.js';

jest.mock('./microsoft/microsoft-oauth.service.js', () => ({ MicrosoftOAuthService: class {} }));
jest.mock('./microsoft/microsoft-graph-sync.service.js', () => ({ MicrosoftGraphSyncService: class {} }));
jest.mock('./google/google-oauth.service.js', () => ({ GoogleOAuthService: class {} }));

const destination = 'https://app.invalid/settings/integrations';
const connectionId = '00000000-0000-4000-8000-000000000003';
const privateDetail = 'synthetic-provider-secret&connected=1&code=synthetic-code';

describe.each(['microsoft_365', 'google_workspace'] as const)('ML11 active %s callback', (provider) => {
  function fixture() {
    const oauth = {
      getSuccessRedirect: () => destination,
      handleCallback: jest.fn(async (_input: { code: string; state: string }) => ({
        tenantId: 'synthetic-tenant', connectionId,
      })),
    };
    const res = { redirect: jest.fn() };
    const microsoft = new MicrosoftCallbacksController(oauth as never, {} as never);
    const google = new GoogleCallbacksController(oauth as never);
    const callback = ({ code = 'synthetic-code', state = 'synthetic-state', error, description, adminConsent, tenant }: {
      code?: string | null; state?: string | null; error?: string; description?: string;
      adminConsent?: string; tenant?: string;
    } = {}) => provider === 'microsoft_365'
      ? microsoft.callback(code ?? undefined, state ?? undefined, error, description, adminConsent, tenant, res as unknown as Response)
      : google.callback(code ?? undefined, state ?? undefined, error, res as unknown as Response);
    const expectFailure = (reason = 'connection_failed') => {
      expect(res.redirect).toHaveBeenCalledTimes(1);
      expect(res.redirect).toHaveBeenCalledWith(302, `${destination}?provider=${provider}&error=${reason}`);
      const target = new URL(res.redirect.mock.calls[0][1]);
      expect([...target.searchParams.keys()].sort()).toEqual(['error', 'provider']);
      expect(target.href).not.toContain(privateDetail);
      expect(target.searchParams.has('connected')).toBe(false);
      expect(target.searchParams.has('connectionId')).toBe(false);
    };
    return { oauth, res, callback, expectFailure };
  }

  test('returns the configured destination and exact connection only after service success', async () => {
    const h = fixture();
    await h.callback();
    expect(h.oauth.handleCallback).toHaveBeenCalledWith({ code: 'synthetic-code', state: 'synthetic-state' });
    expect(h.res.redirect).toHaveBeenCalledTimes(1);
    expect(h.res.redirect).toHaveBeenCalledWith(302, `${destination}?provider=${provider}&connectionId=${connectionId}&connected=1`);
  });

  test.each([
    ['access_denied', 'access_denied'],
    ['cancelled', 'cancelled'],
    ['user_cancelled', 'cancelled'],
    [privateDetail, 'connection_failed'],
    ['https://attacker.invalid/collect', 'connection_failed'],
    ['<script>synthetic-secret</script>', 'connection_failed'],
    ['access_denied\r\nLocation: https://attacker.invalid', 'connection_failed'],
  ])('maps provider hint %s without reflecting its text or error description', async (error, reason) => {
    const h = fixture();
    await h.callback({ error, description: privateDetail });
    h.expectFailure(reason);
    expect(h.oauth.handleCallback).not.toHaveBeenCalled();
  });

  test.each([
    new Error(privateDetail),
    new BadRequestException(privateDetail),
    new ForbiddenException(privateDetail),
    { message: privateDetail, access_token: privateDetail },
  ])('returns a fixed failure for any service rejection without leaking its content', async (error) => {
    const h = fixture();
    h.oauth.handleCallback.mockRejectedValueOnce(error);
    await h.callback();
    h.expectFailure();
    expect(h.oauth.handleCallback).toHaveBeenCalledTimes(1);
  });

  test('waits for asynchronous settlement and never emits success on late refusal', async () => {
    const h = fixture();
    let refuse!: (cause: unknown) => void;
    h.oauth.handleCallback.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    const pending = h.callback();
    expect(h.res.redirect).not.toHaveBeenCalled();
    refuse(new Error(privateDetail));
    await pending;
    h.expectFailure();
  });

  test.each([{ code: null }, { state: null }, { code: null, state: null }])('keeps missing code/state a definite 400 without dispatch', async (input) => {
    const h = fixture();
    await expect(h.callback(input)).rejects.toMatchObject({ status: 400, message: 'Missing code or state' });
    expect(h.res.redirect).not.toHaveBeenCalled();
    expect(h.oauth.handleCallback).not.toHaveBeenCalled();
  });

  if (provider === 'microsoft_365') {
    test.each([['True', '1'], ['true', '1'], ['False', '0'], [privateDetail, '0']])('keeps admin consent %s separate from mailbox success', async (adminConsent, expected) => {
      const h = fixture();
      await h.callback({ code: null, state: null, adminConsent, tenant: 'synthetic-provider-tenant' });
      expect(h.res.redirect).toHaveBeenCalledWith(302, `${destination}?provider=${provider}&admin_consent=${expected}`);
      expect(h.oauth.handleCallback).not.toHaveBeenCalled();
    });
  }
});
