// Phase f (remaining-items plan §3.f) — defaultScopes must derive from the
// SAME canonical constants the real OAuth flows request (GOOGLE_WORKSPACE_
// SCOPES, MICROSOFT_SCOPES), not a hand-maintained duplicate that can drift.
// This file's prior Google copy was missing the openid/email/profile
// identity scopes, and had previously drifted to the wrong
// calendar.readonly before that (commit 9f685e2b) -- exactly the class of
// bug a single source of truth prevents from recurring.

import { describe, expect, test, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { GOOGLE_WORKSPACE_SCOPES } from '@capiro/shared';
import { EngagementProvider } from '@prisma/client';
import { EngagementService } from './engagement.service.js';
import { MICROSOFT_SCOPES } from './microsoft/microsoft-oauth-constants.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  tenantSlug: 'acme',
  userId: '22222222-2222-2222-2222-222222222222',
  clerkUserId: 'clerk-1',
  role: 'user' as TenantContext['role'],
};

function makeService() {
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  const create = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({});
  patch.prisma = {
    withTenant: (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({ integrationConnection: { create } }),
  };
  return { service, create };
}

describe('EngagementService.createIntegration — scope single source of truth', () => {
  test('google_workspace scopes exactly equal GOOGLE_WORKSPACE_SCOPES, including identity scopes', async () => {
    const { service, create } = makeService();

    await service.createIntegration(ctx, { provider: EngagementProvider.google_workspace });

    const call = create.mock.calls[0]?.[0] as { data: { scopes: string[] } };
    expect(call.data.scopes).toEqual([...GOOGLE_WORKSPACE_SCOPES]);
    expect(call.data.scopes).toContain('openid');
    expect(call.data.scopes).toContain('email');
    expect(call.data.scopes).toContain('profile');
  });

  test('microsoft_365 scopes exactly equal MICROSOFT_SCOPES', async () => {
    const { service, create } = makeService();

    await service.createIntegration(ctx, { provider: EngagementProvider.microsoft_365 });

    const call = create.mock.calls[0]?.[0] as { data: { scopes: string[] } };
    expect(call.data.scopes).toEqual([...MICROSOFT_SCOPES]);
  });

  test('imap_caldav scopes remain unchanged', async () => {
    const { service, create } = makeService();

    await service.createIntegration(ctx, { provider: EngagementProvider.imap_caldav });

    const call = create.mock.calls[0]?.[0] as { data: { scopes: string[] } };
    expect(call.data.scopes).toEqual(['imap.read', 'caldav.read']);
  });

  test('returned scope arrays are copies, not the mutable canonical references', async () => {
    const { service, create } = makeService();

    await service.createIntegration(ctx, { provider: EngagementProvider.google_workspace });
    const googleCall = create.mock.calls[0]?.[0] as { data: { scopes: string[] } };
    expect(googleCall.data.scopes).not.toBe(GOOGLE_WORKSPACE_SCOPES);

    create.mockClear();
    await service.createIntegration(ctx, { provider: EngagementProvider.microsoft_365 });
    const msCall = create.mock.calls[0]?.[0] as { data: { scopes: string[] } };
    expect(msCall.data.scopes).not.toBe(MICROSOFT_SCOPES);

    // Mutating a returned array must never affect the canonical constant.
    googleCall.data.scopes.push('mutated');
    expect(GOOGLE_WORKSPACE_SCOPES).not.toContain('mutated');
  });
});
