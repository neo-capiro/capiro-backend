import { createClerkClient } from '@clerk/backend';
import type { TenantContext } from '@capiro/shared';
import type { ClerkService } from '../auth/clerk.service.js';
import type { TenantAdminService } from '../tenant-admin/tenant-admin.service.js';
import { NewsletterAccountProvider } from './newsletter-account-provider.js';

describe('NewsletterAccountProvider transport', () => {
  afterEach(() => jest.restoreAllMocks());

  function fixture() {
    const backend = createClerkClient({ secretKey: 'sk_test_newsletter_transport_fixture' });
    const updateMemberRole = jest.fn().mockResolvedValue({ role: 'user_admin' });
    const provider = new NewsletterAccountProvider(
      { backend } as ClerkService,
      { updateMemberRole } as unknown as TenantAdminService,
    );
    return { provider, updateMemberRole };
  }

  it('makes one create request on a provider 503 and sends only authoritative invitation fields', async () => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ errors: [{ code: 'service_unavailable', message: 'Fixture outage' }] }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        ),
      );
    const { provider } = fixture();
    await expect(
      provider.create(
        'org_fixture',
        'user_author',
        'join@example.org',
        'org:admin',
        'https://app.example.org/sign-up',
        'tenant_fixture',
        'request_fixture',
      ),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0]!;
    expect(String(url)).toContain('/organizations/org_fixture/invitations');
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({
      email_address: 'join@example.org',
      role: 'org:admin',
      inviter_user_id: 'user_author',
      redirect_url: 'https://app.example.org/sign-up',
      public_metadata: {
        capiro_tenant_id: 'tenant_fixture',
        capiro_newsletter_invitation_id: 'request_fixture',
      },
    });
  });

  it('does not retry a create request after a lost transport response', async () => {
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('Fixture connection lost'));
    const { provider } = fixture();
    await expect(
      provider.create(
        'org_fixture',
        'user_author',
        'join@example.org',
        'org:member',
        'https://app.example.org/sign-up',
        'tenant_fixture',
        'request_fixture',
      ),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the existing firm role operation to promote an active member', async () => {
    const { provider, updateMemberRole } = fixture();
    const ctx = { tenantId: 'tenant_fixture', userId: 'user_author' } as TenantContext;
    await provider.promote(ctx, 'user_existing');
    expect(updateMemberRole).toHaveBeenCalledWith(ctx, 'user_existing', 'user_admin');
  });
});
