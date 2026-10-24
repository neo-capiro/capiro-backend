import type { Response } from 'express';
import { MicrosoftCallbacksController } from './microsoft/microsoft-callbacks.controller.js';
import { GoogleCallbacksController } from './google/google-callbacks.controller.js';
import { harness } from './mailbox-oauth.a1-fixture.js';

jest.mock('@azure/msal-node', () => ({ ConfidentialClientApplication: jest.fn() }));

const destination = 'https://app.invalid/integrations';
describe.each(['microsoft_365', 'google_workspace'] as const)('ML11 %s active controller and real admission', (provider) => {
  function fixture() {
    const h = harness(provider);
    h.service.getSuccessRedirect = () => destination;
    const res = { redirect: jest.fn() };
    const microsoft = new MicrosoftCallbacksController(h.service, {} as never);
    const google = new GoogleCallbacksController(h.service);
    const callback = (state: string) => provider === 'microsoft_365'
      ? microsoft.callback('synthetic-code', state, undefined, undefined, undefined, undefined, res as unknown as Response)
      : google.callback('synthetic-code', state, undefined, res as unknown as Response);
    const expectRefused = (exchangeCalls = 0) => {
      expect(res.redirect).toHaveBeenLastCalledWith(302, `${destination}?provider=${provider}&error=connection_failed`);
      expect(h.exchange).toHaveBeenCalledTimes(exchangeCalls);
      expect(h.tx.integrationConnectionToken.upsert).not.toHaveBeenCalled();
      expect(h.tx.integrationConnectionToken.update).not.toHaveBeenCalled();
    };
    return { ...h, res, callback, expectRefused };
  }

  test('redirects success only after exact existing admission and token persistence', async () => {
    const h = fixture();
    const attempt = await h.start();
    await h.callback(attempt.state);
    expect(h.res.redirect).toHaveBeenCalledTimes(1);
    expect(h.res.redirect).toHaveBeenCalledWith(302, `${destination}?provider=${provider}&connectionId=connection-A&connected=1`);
    expect(h.exchange).toHaveBeenCalledTimes(1);
    expect(h.tx.integrationConnectionToken.upsert).toHaveBeenCalledTimes(1);
    expect(h.rows.get('connection-A').token.homeAccountId).toBe('account-A');
  });

  test.each(['tampered', 'expired', 'wrong-provider', 'suffix'] as const)('refuses %s state before exchange without exposing state', async (kind) => {
    const h = fixture();
    const attempt = await h.start();
    const payload = JSON.parse(Buffer.from(attempt.state.split('.')[0], 'base64url').toString());
    const state = kind === 'tampered' ? `x${attempt.state}`
      : kind === 'suffix' ? `${attempt.state}.extra`
      : h.service.signState({ ...payload, ...(kind === 'expired' ? { e: 0 } : { p: 'other-provider' }) });
    await h.callback(state);
    h.expectRefused();
    expect(h.tx.integrationConnection.update).toHaveBeenCalledTimes(1); // /start only
  });

  test.each(['wrong-owner', 'wrong-tenant', 'wrong-provider', 'revoked-member', 'deleted'] as const)('refuses %s before exchange and token writes', async (kind) => {
    const h = fixture();
    const attempt = await h.start();
    const row = h.rows.get('connection-A');
    if (kind === 'wrong-owner') row.createdByUserId = 'another-owner';
    if (kind === 'wrong-tenant') row.tenantId = 'another-tenant';
    if (kind === 'wrong-provider') row.provider = 'another-provider';
    if (kind === 'revoked-member') h.setActive(false);
    if (kind === 'deleted') h.rows.delete('connection-A');
    await h.callback(attempt.state);
    h.expectRefused();
    expect(h.tx.integrationConnection.update).toHaveBeenCalledTimes(1);
  });

  test('older nonce refuses after replacement without exchanging either attempt', async () => {
    const h = fixture();
    const first = await h.start();
    await h.start();
    await h.callback(first.state);
    h.expectRefused();
  });

  test.each(['revoked-member', 'replaced-attempt', 'wrong-account'] as const)('refuses %s after exchange without token persistence', async (kind) => {
    const h = fixture();
    const attempt = await h.start();
    if (kind === 'revoked-member') h.afterExchange(() => h.setActive(false));
    if (kind === 'replaced-attempt') h.afterExchange(async () => { await h.start(); });
    if (kind === 'wrong-account') h.setReturned({ id: 'account-B', email: 'a@example.invalid', refresh: 'synthetic-refresh' });
    await h.callback(attempt.state);
    h.expectRefused(1);
  });

  test('provider rejection returns fixed failure without retry or token persistence', async () => {
    const h = fixture();
    const attempt = await h.start();
    h.afterExchange(() => { throw new Error('synthetic-token-response-and-secret'); });
    await h.callback(attempt.state);
    h.expectRefused(1);
    expect(h.res.redirect).toHaveBeenCalledTimes(1);
  });

  test('duplicate callback is a failure hint and cannot exchange or write twice', async () => {
    const h = fixture();
    const attempt = await h.start();
    await h.callback(attempt.state);
    h.res.redirect.mockClear();
    h.tx.integrationConnectionToken.upsert.mockClear();
    await h.callback(attempt.state);
    h.expectRefused(1);
    expect(h.res.redirect).toHaveBeenCalledTimes(1);
  });
});
