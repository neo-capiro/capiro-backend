import { assertPublicCaptureCredential } from './public-capture-credentials.js';

describe('public capture credential boundary', () => {
  it('accepts a platform-owned shared capture key', () => {
    expect(
      assertPublicCaptureCredential({
        apiKey: 'dg-platform-key',
        source: 'PLATFORM_SECRET',
        billingMode: 'PLATFORM_SHARED_PUBLIC_CAPTURE',
      }),
    ).toEqual(expect.objectContaining({ source: 'PLATFORM_SECRET' }));
  });

  it('rejects a tenant-scoped BYOK credential', () => {
    expect(() =>
      assertPublicCaptureCredential({
        apiKey: 'dg-tenant-key',
        source: 'PLATFORM_SECRET',
        billingMode: 'PLATFORM_SHARED_PUBLIC_CAPTURE',
        tenantId: 'tenant-1',
      } as never),
    ).toThrow(/Tenant-scoped identity/);
  });
});
