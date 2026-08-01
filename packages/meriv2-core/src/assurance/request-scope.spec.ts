import { assuranceReleaseArmedFor } from './risk-gate';
import { runWithAssuranceRequestScope } from './request-scope';

describe('assurance request scope', () => {
  it('retains the strict all-tenant rule without an authenticated request scope', () => {
    expect(assuranceReleaseArmedFor('strategy', 'strategy', 'enforce', 'tenant-a')).toBe(false);
    expect(assuranceReleaseArmedFor('strategy', 'strategy', 'enforce', 'all')).toBe(true);
  });

  it('arms the exact authenticated tenant and actual artifact surface', async () => {
    await runWithAssuranceRequestScope('Tenant-A', 'outreach', async () => {
      await Promise.resolve();
      // The legacy call site still passes `strategy`, but the server-owned request
      // scope carries the actual outreach destination.
      expect(assuranceReleaseArmedFor('outreach', 'strategy', 'enforce', 'tenant-a')).toBe(true);
      expect(assuranceReleaseArmedFor('strategy', 'strategy', 'enforce', 'tenant-a')).toBe(false);
      expect(assuranceReleaseArmedFor('outreach', 'strategy', 'enforce', 'tenant-b')).toBe(false);
    });
  });

  it('keeps concurrent tenant/surface requests isolated', async () => {
    const [strategy, outreach] = await Promise.all([
      runWithAssuranceRequestScope('tenant-a', 'strategy', async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return assuranceReleaseArmedFor('strategy', 'strategy', 'enforce', 'tenant-a');
      }),
      runWithAssuranceRequestScope('tenant-b', 'outreach', async () => {
        await Promise.resolve();
        return assuranceReleaseArmedFor('strategy', 'strategy', 'enforce', 'tenant-a');
      }),
    ]);
    expect(strategy).toBe(true);
    expect(outreach).toBe(false);
  });
});
