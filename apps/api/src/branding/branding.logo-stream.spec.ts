import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock(
  '@aws-sdk/client-s3',
  () => ({
    S3Client: class {
      send = jest.fn();
    },
    GetObjectCommand: class {
      constructor(public input: unknown) {}
    },
    HeadObjectCommand: class {
      constructor(public input: unknown) {}
    },
  }),
  { virtual: true },
);
jest.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: jest.fn() }), {
  virtual: true,
});
jest.mock(
  '@aws-sdk/s3-request-presigner',
  () => ({ getSignedUrl: jest.fn(async () => 'https://signed.invalid') }),
  { virtual: true },
);

import { NotFoundException } from '@nestjs/common';
import { BrandingService } from './branding.service.js';
import { BrandingController } from './branding.controller.js';

/**
 * M1 (firm half): the firm logo is served as bytes to the signed-in session, using the same
 * ownership rule the branding read already applies. These cases drive the real service path —
 * tenant read, owned-key validation, content-type whitelist, S3 fetch.
 */
const ctx = {
  tenantId: 'tenant-a',
  tenantSlug: 'a',
  userId: 'actor',
  clerkUserId: 'clerk-a',
  role: 'standard_user' as const,
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CURRENT_KEY =
  'tenants/tenant-a/branding/logo-1730000000000-0b6d1f2e-1c3a-4f5b-8a9d-0d1c2b3a4f50.png';

function fixture(
  row: { logoS3Key: string | null; logoContentType: string | null } = {
    logoS3Key: CURRENT_KEY,
    logoContentType: 'image/png',
  },
) {
  const tx = {
    tenant: { findUnique: jest.fn(async () => row) },
  };
  const service = new BrandingService(
    { withTenant: async (_tenant: string, read: any) => read(tx) } as never,
    { get: (key: string) => (key === 'ASSETS_BUCKET' ? 'assets-test' : 'us-east-1') } as never,
  );
  const send: any = (service as any).s3.send;
  send.mockResolvedValue({
    Body: Readable.from([PNG]),
    ContentType: row.logoContentType,
    ContentLength: PNG.length,
  });
  return { service, tx, send };
}

describe('firm logo stream — M1 stable, session-authenticated bytes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the stored bytes and the validated content type for the tenant’s own logo', async () => {
    const { service, send } = fixture();

    const logo = await service.readLogo(ctx as never);

    expect(logo.contentType).toBe('image/png');
    expect(logo.body).toEqual(PNG);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0]![0] as any).input).toEqual({
      Bucket: 'assets-test',
      Key: CURRENT_KEY,
    });
  });

  it('still reads a legacy logo.<ext> key written before the timestamped names', async () => {
    const { service } = fixture({
      logoS3Key: 'tenants/tenant-a/branding/logo.svg',
      logoContentType: 'image/svg+xml',
    });

    const logo = await service.readLogo(ctx as never);

    expect(logo.contentType).toBe('image/svg+xml');
  });

  it('404s when the tenant has no logo, without touching S3', async () => {
    const { service, send } = fixture({ logoS3Key: null, logoContentType: null });

    await expect(service.readLogo(ctx as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(send).not.toHaveBeenCalled();
  });

  it('404s for a persisted key this tenant’s upload flow could not have written', async () => {
    // Another tenant's prefix and an arbitrary object key are both untrusted metadata.
    for (const logoS3Key of [
      'tenants/tenant-b/branding/logo-1730000000000-0b6d1f2e-1c3a-4f5b-8a9d-0d1c2b3a4f50.png',
      'tenants/tenant-a/branding/../../secrets.png',
      'some-other-bucket-key.png',
    ]) {
      const { service, send } = fixture({ logoS3Key, logoContentType: 'image/png' });
      await expect(service.readLogo(ctx as never)).rejects.toBeInstanceOf(NotFoundException);
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('404s for a content type outside the image whitelist', async () => {
    const { service, send } = fixture({
      logoS3Key: CURRENT_KEY,
      logoContentType: 'text/html',
    });

    await expect(service.readLogo(ctx as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(send).not.toHaveBeenCalled();
  });

  it('404s when the object cannot be read, and never leaks the storage error', async () => {
    const { service, send } = fixture();
    send.mockResolvedValue({});
    await expect(service.readLogo(ctx as never)).rejects.toBeInstanceOf(NotFoundException);

    const failing = fixture();
    failing.send.mockRejectedValue(new Error('AccessDenied'));
    await expect(failing.service.readLogo(ctx as never)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps the branding payload’s own behaviour: the DTO switch is a separate change', async () => {
    const { service } = fixture();
    const branding = await service.getBranding(ctx as never);
    // Until the accepted DTO switch ships, `getBranding` still reports a signed URL and the
    // new bytes route is additive, so a release can deploy this endpoint in either order.
    expect(branding?.logoUrl).toBe('https://signed.invalid');
  });

  it.each([
    ['empty', [], 0, 'image/png'],
    ['truncated', [PNG], PNG.length + 1, 'image/png'],
    ['oversize metadata', [PNG], 2 * 1024 * 1024 + 1, 'image/png'],
    ['oversize stream', [Buffer.alloc(2 * 1024 * 1024), PNG], 2 * 1024 * 1024, 'image/png'],
    ['wrong type', [PNG], PNG.length, 'text/html'],
    ['missing length', [PNG], undefined, 'image/png'],
  ])('refuses %s and disposes the object body', async (_name, chunks, length, type) => {
    const { service, send } = fixture();
    const body = Readable.from(chunks as Buffer[]);
    send.mockResolvedValue({ Body: body, ContentType: type, ContentLength: length });
    await expect(service.readLogo(ctx as never)).rejects.toThrow('Firm logo not found');
    expect(body.destroyed).toBe(true);
  });

  it('maps a partial stream read failure to an opaque404 and releases it', async () => {
    const { service, send } = fixture();
    const body = Readable.from(
      (async function* () {
        yield PNG;
        throw new Error('private storage detail');
      })(),
    );
    send.mockResolvedValue({ Body: body, ContentType: 'image/png', ContentLength: PNG.length * 2 });
    await expect(service.readLogo(ctx as never)).rejects.toThrow('Firm logo not found');
    expect(body.destroyed).toBe(true);
  });

  it('discards a non-Node body instead of trying an unbounded convenience read', async () => {
    const { service, send } = fixture();
    const cancel = jest.fn(async () => undefined);
    send.mockResolvedValue({ Body: { transformToWebStream: () => ({ cancel }) } });
    await expect(service.readLogo(ctx as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not disguise a database failure as a missing object', async () => {
    const { service, tx, send } = fixture();
    tx.tenant.findUnique.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.readLogo(ctx as never)).rejects.toThrow('database unavailable');
    expect(send).not.toHaveBeenCalled();
  });

  it('serves benign SVG bytes with an inert no-store response policy', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
    );
    const service = {
      readLogo: jest.fn(async () => ({ contentType: 'image/svg+xml', body: svg })),
    };
    const controller = new BrandingController(service as never);
    const headers = new Map<string, string>();
    const res = {
      setHeader: (name: string, value: string) => headers.set(name, value),
      send: jest.fn(),
    };
    await controller.logo(ctx as never, res as never);
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(headers.get('Content-Security-Policy')).toBe(
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'",
    );
    expect(headers.get('Content-Type')).toBe('image/svg+xml');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.send).toHaveBeenCalledWith(svg);
  });
});
