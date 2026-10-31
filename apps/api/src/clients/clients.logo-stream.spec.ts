import { NotFoundException } from '@nestjs/common';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ClientsService } from './clients.service.js';

jest.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const ctx = {
  tenantId: TENANT,
  userId: USER,
  clerkUserId: 'user_synthetic',
  role: 'standard_user',
} as never;

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Drives the real authorization chain of `get`: current membership, the client
 * lock, the account-owner projection, the memory wall and archival state.
 */
function fixture(options: {
  client?: Record<string, unknown> | null;
  member?: { role: string } | null;
  allowed?: boolean;
  object?: unknown;
} = {}) {
  const ownerRows = [{ version: 1, primary: null }];
  const memberRows = [options.member === undefined ? { role: 'standard_user' } : options.member];
  let raw = 0;
  const tx = {
    tenantMembership: {
      findFirst: jest.fn(async () =>
        options.member === null ? null : { role: 'standard_user' },
      ),
    },
    $queryRaw: jest.fn(async () => {
      raw += 1;
      if (raw === 1) return ownerRows;
      if (raw === 2) return memberRows;
      return [];
    }),
    $queryRawUnsafe: jest.fn(async () => [{ allowed: options.allowed !== false }]),
    client: {
      findFirst: jest.fn(async () =>
        options.client === undefined
          ? {
              id: CLIENT,
              tenantId: TENANT,
              name: 'Synthetic Client',
              logoS3Key: `tenants/${TENANT}/clients/${CLIENT}/logos/logo.png`,
              logoContentType: 'image/png',
            }
          : options.client,
      ),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, run: (tx: unknown) => unknown) => run(tx)),
    withTenantRetry: jest.fn(async (_tenant: string, run: (tx: unknown) => unknown) => run(tx)),
  };
  const config = {
    get: jest.fn((key: string) => (key === 'ASSETS_BUCKET' ? 'assets-bucket' : undefined)),
  };
  const service = new ClientsService(
    prisma as never,
    config as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const send = jest.fn<Promise<unknown>, [GetObjectCommand]>(async () =>
    options.object === undefined
      ? { ContentType: 'image/png', Body: { transformToByteArray: async () => png } }
      : options.object,
  );

  (service as unknown as { s3: { send: typeof send } }).s3 = { send };
  return { service, tx, send };
}

describe('ClientsService.readLogo — M1 stable client logos', () => {
  test('streams the stored bytes with the whitelisted content type for a current tenant caller', async () => {
    const h = fixture();

    const result = await h.service.readLogo(ctx, CLIENT);

    expect(result.contentType).toBe('image/png');
    expect(result.body.equals(png)).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
    const command = (h.send.mock.calls[0] as unknown as [GetObjectCommand])[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'assets-bucket',
      Key: `tenants/${TENANT}/clients/${CLIENT}/logos/logo.png`,
    });
    // A logo read never derives or returns a presigned address.
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  test('404s when the client has no stored logo', async () => {
    const h = fixture({ client: { id: CLIENT, logoS3Key: null, logoContentType: null } });

    await expect(h.service.readLogo(ctx, CLIENT)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.send).not.toHaveBeenCalled();
  });

  test('refuses a client outside the caller wall before touching S3', async () => {
    const h = fixture({ allowed: false });

    await expect(h.service.readLogo(ctx, CLIENT)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.client.findFirst).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  test('refuses an inactive member before touching S3', async () => {
    const h = fixture({ member: null });

    await expect(h.service.readLogo(ctx, CLIENT)).rejects.toThrow(
      'Account owner access denied',
    );
    expect(h.send).not.toHaveBeenCalled();
  });

  test('never serves a stored type outside the logo whitelist', async () => {
    const h = fixture({
      client: {
        id: CLIENT,
        logoS3Key: 'tenants/x/clients/y/logos/logo.svg',
        logoContentType: 'text/html',
      },
    });

    await expect(h.service.readLogo(ctx, CLIENT)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.send).not.toHaveBeenCalled();
  });

  test('404s when the stored object cannot be read', async () => {
    const h = fixture({ object: null });

    await expect(h.service.readLogo(ctx, CLIENT)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('tenant client reads expose a stable logo path, never a credential', () => {
  test('get() returns the app-relative path and no signed token', async () => {
    const h = fixture();

    const client = await h.service.get(ctx, CLIENT);

    expect(client.logoUrl).toBe(`/api/client-logo/${CLIENT}`);
    expect(JSON.stringify(client)).not.toContain('X-Amz-Security-Token');
    expect(JSON.stringify(client)).not.toContain('https://');
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  test('a client without a logo keeps logoUrl null', async () => {
    const h = fixture({
      client: { id: CLIENT, tenantId: TENANT, name: 'No logo', logoS3Key: null },
    });

    const client = await h.service.get(ctx, CLIENT);

    expect(client.logoUrl).toBeNull();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
