import { harness, ctx } from '../mailbox-oauth.a1-fixture.js';
import { GoogleOAuthService } from './google-oauth.service.js';
import { MAILBOX_CALL_TIMEOUT_MS } from '../mailbox-provider-transport.js';

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test.each([200, 400, 503])(
  'disconnect deletes locally and reports actual revocation receipt (%s)',
  async (status) => {
    const h = harness('google_workspace');
    h.service.revokeGoogleGrant = (GoogleOAuthService.prototype as any).revokeGoogleGrant;
    h.rows.get('connection-A').syncState.syncClaim = {
      token: 'old',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      expect(h.rows.get('connection-A').status).toBe('disabled');
      expect(h.rows.get('connection-A').syncState.syncClaim).toBeUndefined();
      return new Response('synthetic secret must not be logged', { status });
    });
    await expect(h.service.disconnect(ctx, 'connection-A')).resolves.toMatchObject({
      disconnected: true,
      providerRevocation: status === 200 ? 'confirmed' : 'unconfirmed',
    });
    expect(h.rows.has('connection-A')).toBe(false);
    expect(JSON.stringify(h.service.logger.warn.mock.calls)).not.toContain('synthetic secret');
    await expect(h.service.disconnect(ctx, 'connection-A')).resolves.toMatchObject({
      providerRevocation: 'not_attempted',
    });
  },
);

test('hung revoke is bounded and does not strand local disconnect', async () => {
  jest.useFakeTimers();
  const h = harness('google_workspace');
  h.service.revokeGoogleGrant = (GoogleOAuthService.prototype as any).revokeGoogleGrant;
  jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
  const result = h.service.disconnect(ctx, 'connection-A');
  await jest.advanceTimersByTimeAsync(MAILBOX_CALL_TIMEOUT_MS);
  await expect(result).resolves.toMatchObject({ providerRevocation: 'unconfirmed' });
  expect(h.rows.has('connection-A')).toBe(false);
});

test('unreadable stored token still permits local disconnect with unconfirmed revocation', async () => {
  const h = harness('google_workspace');
  h.crypto.decrypt = () => {
    throw new Error('synthetic key unavailable');
  };
  await expect(h.service.disconnect(ctx, 'connection-A')).resolves.toMatchObject({
    providerRevocation: 'unconfirmed',
  });
  expect(h.rows.has('connection-A')).toBe(false);
});
