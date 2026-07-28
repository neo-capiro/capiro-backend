import { shouldRouteMeriV2FullChat } from './meriv2-routing.helpers.js';

describe('shouldRouteMeriV2FullChat', () => {
  const ready = { bearerToken: 'token', configured: true, enabled: true };

  it('routes a normal enabled turn', () => {
    expect(shouldRouteMeriV2FullChat(ready)).toBe(true);
  });

  it.each([
    { label: 'missing bearer', input: { ...ready, bearerToken: null } },
    { label: 'unconfigured orchestrator', input: { ...ready, configured: false } },
    { label: 'disabled tenant flag', input: { ...ready, enabled: false } },
    {
      label: 'impersonation',
      input: { ...ready, impersonateTenantId: '11111111-1111-4111-8111-111111111111' },
    },
  ])('keeps the turn on the contained path for $label', ({ input }) => {
    expect(shouldRouteMeriV2FullChat(input)).toBe(false);
  });
});
