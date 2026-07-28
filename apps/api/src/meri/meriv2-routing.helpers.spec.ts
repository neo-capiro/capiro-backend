import { shouldRouteMeriV2FullChat } from './meriv2-routing.helpers.js';

describe('shouldRouteMeriV2FullChat', () => {
  const ready = { bearerToken: 'token', configured: true, enabled: true };

  it('routes a normal enabled turn', () => {
    expect(shouldRouteMeriV2FullChat(ready)).toBe(true);
  });

  it.each([
    [{ ...ready, bearerToken: null }, 'missing bearer'],
    [{ ...ready, configured: false }, 'unconfigured orchestrator'],
    [{ ...ready, enabled: false }, 'disabled tenant flag'],
    [{ ...ready, impersonateTenantId: '11111111-1111-4111-8111-111111111111' }, 'impersonation'],
  ] as const)('keeps the turn on the contained path for %s', (input) => {
    expect(shouldRouteMeriV2FullChat(input)).toBe(false);
  });
});
