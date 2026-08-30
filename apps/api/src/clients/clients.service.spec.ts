import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ClientsService } from './clients.service.js';

jest.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

describe('ClientsService.list — archived filtering', () => {
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as never;

  const makeService = () => {
    const tenantTx = {
      client: { findMany: jest.fn(async () => [] as unknown[]) },
    };
    const prisma = {
      withTenant: jest.fn(
        async (_tenantId: string, run: (tx: unknown) => Promise<unknown>) =>
          run(tenantTx),
      ),
    };
    // No ASSETS_BUCKET configured → logo signing is skipped (clients list is empty).
    const config = { get: jest.fn(() => undefined) };
    // resolve-on-create dependencies; unused by the list() paths under test.
    const entityResolution = {
      resolveClient: jest.fn(async () => ({
        created: 0,
        autoConfirmed: 0,
        needsReview: 0,
      })),
    };
    const prepopulation = {
      prepopulate: jest.fn(async () => ({
        ldaClientIds: [],
        issueCodesAdded: 0,
      })),
    };
    const samEntity = {
      enrichGovIds: jest.fn(async () => ({ filled: [], matched: false })),
    };
    const clientKb = { indexClientProfileFireAndForget: jest.fn() };
    const service = new ClientsService(
      prisma as never,
      config as never,
      entityResolution as never,
      prepopulation as never,
      samEntity as never,
      clientKb as never,
    );
    return { service, tenantTx };
  };

  test('excludes soft-archived ("deleted") clients by default', async () => {
    const { service, tenantTx } = makeService();

    await service.list(ctx);

    expect(tenantTx.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-1', status: { not: 'archived' } },
      }),
    );
  });

  test('includes archived clients only when includeArchived is set', async () => {
    const { service, tenantTx } = makeService();

    await service.list(ctx, { includeArchived: true });

    // No status filter is added → only the always-on tenant scope remains (the
    // app role bypasses RLS, so list() puts tenantId in every where clause).
    expect(tenantTx.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'tenant-1' } }),
    );
  });

  test('keeps profileStatus/sectorTag filters alongside the archived exclusion', async () => {
    const { service, tenantTx } = makeService();

    await service.list(ctx, { profileStatus: 'ACTIVE', sectorTag: 'defense' });

    expect(tenantTx.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          profileStatus: 'ACTIVE',
          sectorTag: 'defense',
          status: { not: 'archived' },
        },
      }),
    );
  });
});

describe('ClientsService.updateProfileNotes — targeted intakeData merge', () => {
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as never;

  const makeService = (row: Record<string, unknown> | null) => {
    const tenantTx = {
      client: {
        findUnique: jest.fn(async () => row),
        update: jest.fn(
          async ({ data }: { data: Record<string, unknown> }) => ({
            ...row,
            ...data,
          }),
        ),
      },
    };
    const prisma = {
      withTenant: jest.fn(
        async (_tenantId: string, run: (tx: unknown) => Promise<unknown>) =>
          run(tenantTx),
      ),
    };
    const config = { get: jest.fn(() => undefined) };
    const entityResolution = { resolveClient: jest.fn() };
    const prepopulation = { prepopulate: jest.fn() };
    const samEntity = { enrichGovIds: jest.fn() };
    const clientKb = { indexClientProfileFireAndForget: jest.fn() };
    const service = new ClientsService(
      prisma as never,
      config as never,
      entityResolution as never,
      prepopulation as never,
      samEntity as never,
      clientKb as never,
    );
    return { service, tenantTx };
  };

  test('merges profileNotes without clobbering sibling intakeData keys', async () => {
    const { service, tenantTx } = makeService({
      id: 'client-1',
      intakeData: {
        profileNotes: 'old notes',
        ldaSignals: { totalSpend: 5 },
        custom: 'kept',
      },
      logoS3Key: null,
    });

    await service.updateProfileNotes(ctx, 'client-1', 'new notes');

    expect(tenantTx.client.update).toHaveBeenCalledWith({
      where: { id: 'client-1' },
      data: {
        intakeData: {
          profileNotes: 'new notes',
          ldaSignals: { totalSpend: 5 },
          custom: 'kept',
        },
      },
    });
  });

  test('allows clearing notes with an empty string and tolerates null intakeData', async () => {
    const { service, tenantTx } = makeService({
      id: 'client-1',
      intakeData: null,
      logoS3Key: null,
    });

    await service.updateProfileNotes(ctx, 'client-1', '');

    expect(tenantTx.client.update).toHaveBeenCalledWith({
      where: { id: 'client-1' },
      data: { intakeData: { profileNotes: '' } },
    });
  });

  test('throws NotFound for an unknown client (no write attempted)', async () => {
    const { service, tenantTx } = makeService(null);

    await expect(
      service.updateProfileNotes(ctx, 'missing', 'x'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tenantTx.client.update).not.toHaveBeenCalled();
  });
});

describe('ClientsService client logos — tenant and object validation', () => {
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as never;
  const maxLogoBytes = 2 * 1024 * 1024;
  const uploadId = '00000000-0000-4000-8000-000000000001';
  const pngKey = `tenants/client-logo-uploads/tenant-1/client-1/${uploadId}.png`;
  const jpegKey = `tenants/client-logo-uploads/tenant-1/client-1/${uploadId}.jpeg`;
  const svgKey = `tenants/client-logo-uploads/tenant-1/client-1/${uploadId}.svg`;
  const webpKey = `tenants/client-logo-uploads/tenant-1/client-1/${uploadId}.webp`;
  const previousPngKey = 'tenants/tenant-1/clients/client-1/logo.png';
  const validSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#1a2b3c"/></svg>',
  );
  const validWebp = buildWebp({ width: 10, height: 10 });
  const validPng = removePngChunk(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURRI0Vv///1EAcnUAAAABYktHRAH/Ai3eAAAAB3RJTUUH6ggeERon835/3gAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=',
      'base64',
    ),
    'tIME',
  );
  const validPngObject = () => ({
    ContentType: 'image/png',
    ContentLength: validPng.length,
    Body: { transformToByteArray: jest.fn(async () => validPng) },
  });
  const mockedCreatePresignedPost = createPresignedPost as jest.MockedFunction<
    typeof createPresignedPost
  >;
  const mockedGetSignedUrl = getSignedUrl as jest.MockedFunction<
    typeof getSignedUrl
  >;

  const makeService = () => {
    const tenantTx = {
      client: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
      $queryRaw: jest.fn(),
    };
    const prisma = {
      withTenant: jest.fn(
        async (_tenantId: string, run: (tx: unknown) => Promise<unknown>) =>
          run(tenantTx),
      ),
    };
    const configValues: Record<string, unknown> = {
      ASSETS_BUCKET: 'assets-bucket',
      AWS_REGION_DEFAULT: 'us-east-1',
      BILLING_ENFORCED: false,
    };
    const config = { get: jest.fn((key: string) => configValues[key]) };
    const entityResolution = { resolveClient: jest.fn() };
    const prepopulation = { prepopulate: jest.fn() };
    const samEntity = { enrichGovIds: jest.fn() };
    const clientKb = { indexClientProfileFireAndForget: jest.fn() };
    const service = new ClientsService(
      prisma as never,
      config as never,
      entityResolution as never,
      prepopulation as never,
      samEntity as never,
      clientKb as never,
    );
    const s3Send = jest.fn();
    (service as unknown as { s3: { send: jest.Mock } }).s3.send = s3Send;
    return { service, tenantTx, prisma, s3Send };
  };

  beforeEach(() => {
    mockedCreatePresignedPost.mockReset();
    mockedGetSignedUrl.mockReset();
  });

  test('creates an exact-key upload policy only for a client owned by the tenant', async () => {
    const { service, tenantTx } = makeService();
    tenantTx.client.findFirst.mockResolvedValue({ id: 'client-1' });
    mockedCreatePresignedPost.mockImplementation(async (_s3, input) => ({
      url: 'https://uploads.example.test',
      fields: { key: String(input.Key) },
    }));

    const result = await service.createLogoUploadUrl(
      ctx,
      'client-1',
      'image/png',
      1024,
    );
    expect(result).toEqual({
      url: 'https://uploads.example.test',
      fields: { key: result.s3Key },
      s3Key: expect.stringMatching(
        /^tenants\/client-logo-uploads\/tenant-1\/client-1\/[0-9a-f-]{36}\.png$/,
      ),
    });

    expect(tenantTx.client.findFirst).toHaveBeenCalledWith({
      where: { id: 'client-1', tenantId: 'tenant-1' },
      select: { id: true },
    });
    expect(mockedCreatePresignedPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        Bucket: 'assets-bucket',
        Key: result.s3Key,
        Fields: {
          'Content-Type': 'image/png',
        },
        Conditions: expect.arrayContaining([
          ['content-length-range', 1, maxLogoBytes],
          ['eq', '$Content-Type', 'image/png'],
          ['eq', '$key', result.s3Key],
        ]),
      }),
    );
  });

  test('does not issue an upload policy for a missing or other-tenant client', async () => {
    const { service, tenantTx } = makeService();
    tenantTx.client.findFirst.mockResolvedValue(null);

    await expect(
      service.createLogoUploadUrl(ctx, 'client-1', 'image/png', 1024),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(mockedCreatePresignedPost).not.toHaveBeenCalled();
  });

  test.each([0, -1, maxLogoBytes + 1, 1.5, Number.NaN])(
    'rejects invalid declared upload length %p before querying the client',
    async (contentLength) => {
      const { service, tenantTx } = makeService();

      await expect(
        service.createLogoUploadUrl(
          ctx,
          'client-1',
          'image/png',
          contentLength,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tenantTx.client.findFirst).not.toHaveBeenCalled();
      expect(mockedCreatePresignedPost).not.toHaveBeenCalled();
    },
  );

  test('requires the canonical tenant/client/type-derived key', async () => {
    const { service, tenantTx, s3Send } = makeService();

    await expect(
      service.confirmLogoUpload(
        ctx,
        'client-1',
        'tenants/tenant-1/clients/client-1/unrelated.png',
        'image/png',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantTx.client.findFirst).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
  });

  test('checks tenant ownership before probing S3', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst.mockResolvedValue(null);

    await expect(
      service.confirmLogoUpload(ctx, 'client-1', pngKey, 'image/png'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tenantTx.client.findFirst).toHaveBeenCalledWith({
      where: { id: 'client-1', tenantId: 'tenant-1' },
      select: { id: true, logoS3Key: true },
    });
    expect(s3Send).not.toHaveBeenCalled();
  });

  test('rejects an uploaded object whose stored content type differs', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst.mockResolvedValue({ id: 'client-1' });
    s3Send.mockResolvedValue({
      ContentType: 'image/jpeg',
      ContentLength: 1024,
    });

    await expect(
      service.confirmLogoUpload(ctx, 'client-1', pngKey, 'image/png'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantTx.client.updateMany).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', undefined],
    ['empty', 0],
    ['oversized', maxLogoBytes + 1],
    ['non-integral', 1.5],
  ])(
    'rejects an uploaded object with %s content length',
    async (_label, contentLength) => {
      const { service, tenantTx, s3Send } = makeService();
      tenantTx.client.findFirst.mockResolvedValue({ id: 'client-1' });
      s3Send.mockResolvedValue({
        ContentType: 'image/png',
        ContentLength: contentLength,
      });

      await expect(
        service.confirmLogoUpload(ctx, 'client-1', pngKey, 'image/png'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tenantTx.client.updateMany).not.toHaveBeenCalled();
    },
  );

  test('rejects an object whose bytes do not match its declared image type', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst.mockResolvedValue({
      id: 'client-1',
      logoS3Key: previousPngKey,
    });
    const invalid = Buffer.from('not a png');
    s3Send.mockResolvedValue({
      ContentType: 'image/png',
      ContentLength: invalid.length,
      Body: { transformToByteArray: jest.fn(async () => invalid) },
    });

    await expect(
      service.confirmLogoUpload(ctx, 'client-1', pngKey, 'image/png'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantTx.client.updateMany).not.toHaveBeenCalled();
    expect(s3Send).toHaveBeenCalledTimes(1);
  });

  test('rejects a JPEG that has dimensions but no decodable scan data', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst.mockResolvedValue({
      id: 'client-1',
      logoS3Key: previousPngKey,
    });
    const invalid = Buffer.from(
      'ffd8ffc0000b080001000101011100ffda0008010100003f00ffd9',
      'hex',
    );
    const jpegKey = `tenants/client-logo-uploads/tenant-1/client-1/${uploadId}.jpeg`;
    s3Send.mockResolvedValue({
      ContentType: 'image/jpeg',
      ContentLength: invalid.length,
      Body: { transformToByteArray: jest.fn(async () => invalid) },
    });

    await expect(
      service.confirmLogoUpload(ctx, 'client-1', jpegKey, 'image/jpeg'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantTx.client.updateMany).not.toHaveBeenCalled();
    expect(s3Send).toHaveBeenCalledTimes(1);
  });

  test('rejects a sub-2 MB JPEG metadata-segment flood', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst.mockResolvedValue({
      id: 'client-1',
      logoS3Key: previousPngKey,
    });
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRQBAwQEBQQFCQUFCRQNCw0UFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFP/AABEIAAEAAQMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APiSvvT4o//Z',
      'base64',
    );
    const flooded = prependEmptyJpegSegments(jpeg, 500_000);
    expect(flooded.length).toBeLessThanOrEqual(maxLogoBytes);
    s3Send.mockResolvedValue({
      ContentType: 'image/jpeg',
      ContentLength: flooded.length,
      Body: { transformToByteArray: jest.fn(async () => flooded) },
    });

    await expect(
      service.confirmLogoUpload(ctx, 'client-1', jpegKey, 'image/jpeg'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantTx.client.updateMany).not.toHaveBeenCalled();
    expect(s3Send).toHaveBeenCalledTimes(1);
  });

  test('rejects an excessive-pixel image even when the compressed file is small', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst.mockResolvedValue({ id: 'client-1' });
    const excessive = Buffer.from(validPng);
    excessive.writeUInt32BE(5_000, 16);
    excessive.writeUInt32BE(4_000, 20);
    s3Send.mockResolvedValue({
      ContentType: 'image/png',
      ContentLength: excessive.length,
      Body: { transformToByteArray: jest.fn(async () => excessive) },
    });

    await expect(
      service.confirmLogoUpload(ctx, 'client-1', pngKey, 'image/png'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantTx.client.updateMany).not.toHaveBeenCalled();
  });

  test('rejects an indexed PNG whose required palette is missing', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst.mockResolvedValue({
      id: 'client-1',
      logoS3Key: previousPngKey,
    });
    const invalid = removePngChunk(validPng, 'PLTE');
    s3Send.mockResolvedValue({
      ContentType: 'image/png',
      ContentLength: invalid.length,
      Body: { transformToByteArray: jest.fn(async () => invalid) },
    });

    await expect(
      service.confirmLogoUpload(ctx, 'client-1', pngKey, 'image/png'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantTx.client.updateMany).not.toHaveBeenCalled();
    expect(s3Send).toHaveBeenCalledTimes(1);
  });

  test('strips compressed PNG metadata before persistence', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst
      .mockResolvedValueOnce({ id: 'client-1', logoS3Key: previousPngKey })
      .mockImplementationOnce(async () => ({
        id: 'client-1',
        tenantId: 'tenant-1',
        logoS3Key:
          tenantTx.client.updateMany.mock.calls[0]?.[0]?.data.logoS3Key,
        logoContentType: 'image/png',
      }));
    tenantTx.client.updateMany.mockResolvedValue({ count: 1 });
    const unsafe = insertPngChunk(
      validPng,
      'iCCP',
      Buffer.from('profile\0\0compressed-payload'),
    );
    s3Send.mockResolvedValue({
      ContentType: 'image/png',
      ContentLength: unsafe.length,
      Body: { transformToByteArray: jest.fn(async () => unsafe) },
    });
    mockedGetSignedUrl.mockResolvedValue(
      'https://downloads.example.test/logo.png',
    );

    await service.confirmLogoUpload(ctx, 'client-1', pngKey, 'image/png');

    expect(s3Send.mock.calls[1]?.[0]?.input).toEqual(
      expect.objectContaining({
        Body: validPng,
        ContentType: 'image/png',
        IfNoneMatch: '*',
      }),
    );
  });

  test('canonicalizes CMYK JPEG color metadata before persistence', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst
      .mockResolvedValueOnce({ id: 'client-1', logoS3Key: previousPngKey })
      .mockImplementationOnce(async () => ({
        id: 'client-1',
        tenantId: 'tenant-1',
        logoS3Key:
          tenantTx.client.updateMany.mock.calls[0]?.[0]?.data.logoS3Key,
        logoContentType: 'image/jpeg',
      }));
    tenantTx.client.updateMany.mockResolvedValue({ count: 1 });
    const cmykJpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAAAAAAD/7gAOQWRvYmUAZAAAAAAC/9sAQwADAgICAgIDAgICAwMDAwQGBAQEBAQIBgYFBgkICgoJCAkJCgwPDAoLDgsJCQ0RDQ4PEBAREAoMEhMSEBMPEBAQ/9sAQwEDAwMEAwQIBAQIEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/8AAFAgACgAKBAERAAIRAQMRAQQRAP/EABYAAQEBAAAAAAAAAAAAAAAAAAAFB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAACP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAOBAEAAhEDEQQAAD8AlJKU6w8AAAB//9k=',
      'base64',
    );
    const duplicateWithFlags = insertJpegSegment(
      cmykJpeg,
      0xee,
      Buffer.from([
        0x41, 0x64, 0x6f, 0x62, 0x65, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0x02,
      ]),
    );
    s3Send.mockResolvedValue({
      ContentType: 'image/jpeg',
      ContentLength: duplicateWithFlags.length,
      Body: { transformToByteArray: jest.fn(async () => duplicateWithFlags) },
    });
    mockedGetSignedUrl.mockResolvedValue(
      'https://downloads.example.test/logo.jpeg',
    );

    await service.confirmLogoUpload(ctx, 'client-1', jpegKey, 'image/jpeg');

    const persisted = s3Send.mock.calls[1]?.[0]?.input.Body as Buffer;
    const canonicalMarker = Buffer.from([
      0xff, 0xee, 0x00, 0x0e, 0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00,
      0x00, 0x00, 0x00, 0x02,
    ]);
    expect(countOccurrences(persisted, Buffer.from('Adobe'))).toBe(1);
    expect(persisted.includes(canonicalMarker)).toBe(true);
    expect(persisted.includes(Buffer.from([0x12, 0x34, 0x56, 0x78]))).toBe(
      false,
    );
  });

  test.each([
    [
      'an embedded script tag',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ],
    [
      'an event-handler attribute',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>',
    ],
    [
      'a foreignObject element',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><script>alert(1)</script></foreignObject></svg>',
    ],
    [
      'a DOCTYPE with an external entity declaration',
      '<?xml version="1.0"?><!DOCTYPE svg [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]><svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>',
    ],
    [
      'a fill referencing an external url()',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="url(https://evil.example/track.svg#g)"/></svg>',
    ],
  ])('rejects an SVG with %s', async (_label, markup) => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst.mockResolvedValue({
      id: 'client-1',
      logoS3Key: previousPngKey,
    });
    const malicious = Buffer.from(markup);
    s3Send.mockResolvedValue({
      ContentType: 'image/svg+xml',
      ContentLength: malicious.length,
      Body: { transformToByteArray: jest.fn(async () => malicious) },
    });

    await expect(
      service.confirmLogoUpload(ctx, 'client-1', svgKey, 'image/svg+xml'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantTx.client.updateMany).not.toHaveBeenCalled();
  });

  test('persists a validated SVG logo through a tenant-scoped update', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst
      .mockResolvedValueOnce({ id: 'client-1', logoS3Key: previousPngKey })
      .mockImplementationOnce(async () => ({
        id: 'client-1',
        tenantId: 'tenant-1',
        logoS3Key:
          tenantTx.client.updateMany.mock.calls[0]?.[0]?.data.logoS3Key,
        logoContentType: 'image/svg+xml',
      }));
    tenantTx.client.updateMany.mockResolvedValue({ count: 1 });
    s3Send.mockResolvedValue({
      ContentType: 'image/svg+xml',
      ContentLength: validSvg.length,
      Body: { transformToByteArray: jest.fn(async () => validSvg) },
    });
    mockedGetSignedUrl.mockResolvedValue(
      'https://downloads.example.test/logo.svg',
    );

    await service.confirmLogoUpload(ctx, 'client-1', svgKey, 'image/svg+xml');

    const persisted = s3Send.mock.calls[1]?.[0]?.input.Body as Buffer;
    // xmlMode parsing expands self-closing tags to explicit open/close pairs;
    // that reformatting is expected and harmless, so assert on content, not
    // byte-for-byte equality with the self-closed input fixture.
    expect(persisted.toString('utf8')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
        '<rect width="10" height="10" fill="#1a2b3c"></rect></svg>',
    );
  });

  test('rejects an oversized/decompression-bomb WEBP', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst.mockResolvedValue({
      id: 'client-1',
      logoS3Key: previousPngKey,
    });
    // Declared dimensions alone exceed the pixel/side budget while the file
    // itself stays a few dozen bytes (VP8L's 14-bit dimension fields cap out
    // at 16384, so 5000x5000 is the largest a single VP8L image can declare
    // without needing VP8X — it is still 25M pixels against a 1M-pixel cap).
    const bomb = buildWebp({ width: 5_000, height: 5_000 });
    s3Send.mockResolvedValue({
      ContentType: 'image/webp',
      ContentLength: bomb.length,
      Body: { transformToByteArray: jest.fn(async () => bomb) },
    });

    await expect(
      service.confirmLogoUpload(ctx, 'client-1', webpKey, 'image/webp'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantTx.client.updateMany).not.toHaveBeenCalled();
  });

  test('rejects an animated WEBP', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst.mockResolvedValue({
      id: 'client-1',
      logoS3Key: previousPngKey,
    });
    const animated = buildWebp({
      width: 10,
      height: 10,
      useVp8x: true,
      animated: true,
    });
    s3Send.mockResolvedValue({
      ContentType: 'image/webp',
      ContentLength: animated.length,
      Body: { transformToByteArray: jest.fn(async () => animated) },
    });

    await expect(
      service.confirmLogoUpload(ctx, 'client-1', webpKey, 'image/webp'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantTx.client.updateMany).not.toHaveBeenCalled();
  });

  test('strips WEBP metadata before persistence', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst
      .mockResolvedValueOnce({ id: 'client-1', logoS3Key: previousPngKey })
      .mockImplementationOnce(async () => ({
        id: 'client-1',
        tenantId: 'tenant-1',
        logoS3Key:
          tenantTx.client.updateMany.mock.calls[0]?.[0]?.data.logoS3Key,
        logoContentType: 'image/webp',
      }));
    tenantTx.client.updateMany.mockResolvedValue({ count: 1 });
    const withMetadata = buildWebp({
      width: 10,
      height: 10,
      useVp8x: true,
      extraChunks: [
        { fourCc: 'ICCP', data: Buffer.from('fake-icc-profile-payload') },
        { fourCc: 'EXIF', data: Buffer.from('fake-exif-payload') },
      ],
    });
    // The VP8X flag byte announces ICC + EXIF presence, matching real encoders.
    withMetadata[20] = withMetadata[20]! | 0x50;
    s3Send.mockResolvedValue({
      ContentType: 'image/webp',
      ContentLength: withMetadata.length,
      Body: { transformToByteArray: jest.fn(async () => withMetadata) },
    });
    mockedGetSignedUrl.mockResolvedValue(
      'https://downloads.example.test/logo.webp',
    );

    await service.confirmLogoUpload(ctx, 'client-1', webpKey, 'image/webp');

    const persisted = s3Send.mock.calls[1]?.[0]?.input.Body as Buffer;
    expect(persisted.includes(Buffer.from('fake-icc-profile-payload'))).toBe(
      false,
    );
    expect(persisted.includes(Buffer.from('fake-exif-payload'))).toBe(false);
    expect(persisted[20]! & 0x58).toBe(0);
  });

  test('persists a validated WEBP logo through a tenant-scoped update', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst
      .mockResolvedValueOnce({ id: 'client-1', logoS3Key: previousPngKey })
      .mockImplementationOnce(async () => ({
        id: 'client-1',
        tenantId: 'tenant-1',
        logoS3Key:
          tenantTx.client.updateMany.mock.calls[0]?.[0]?.data.logoS3Key,
        logoContentType: 'image/webp',
      }));
    tenantTx.client.updateMany.mockResolvedValue({ count: 1 });
    s3Send.mockResolvedValue({
      ContentType: 'image/webp',
      ContentLength: validWebp.length,
      Body: { transformToByteArray: jest.fn(async () => validWebp) },
    });
    mockedGetSignedUrl.mockResolvedValue(
      'https://downloads.example.test/logo.webp',
    );

    await service.confirmLogoUpload(ctx, 'client-1', webpKey, 'image/webp');

    const persisted = s3Send.mock.calls[1]?.[0]?.input.Body as Buffer;
    expect(persisted).toEqual(validWebp);
  });

  test('bounds confirmations before downloading logo bodies', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst.mockResolvedValue({
      id: 'client-1',
      tenantId: 'tenant-1',
      logoS3Key: null,
      logoContentType: 'image/png',
    });
    tenantTx.client.updateMany.mockResolvedValue({ count: 1 });
    mockedGetSignedUrl.mockResolvedValue(
      'https://downloads.example.test/logo.png',
    );

    let releaseDownload!: () => void;
    const downloadBarrier = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    s3Send.mockImplementation(async (command) => {
      if (command instanceof GetObjectCommand) {
        return {
          ContentType: 'image/png',
          ContentLength: validPng.length,
          Body: {
            transformToByteArray: jest.fn(async () => {
              await downloadBarrier;
              return validPng;
            }),
          },
        };
      }
      return {};
    });

    const attempts = Array.from({ length: 5 }, () =>
      service.confirmLogoUpload(ctx, 'client-1', pngKey, 'image/png'),
    );
    const fifthResult = attempts[4]!.then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(fifthResult).resolves.toMatchObject({ status: 429 });
    expect(
      s3Send.mock.calls.filter(
        ([command]) => command instanceof GetObjectCommand,
      ),
    ).toHaveLength(1);

    releaseDownload();
    const settled = await Promise.allSettled(attempts.slice(0, 4));
    expect(settled.every(({ status }) => status === 'fulfilled')).toBe(true);
  });

  test('reconciles a lost successful PUT response by verifying the immutable bytes', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst
      .mockResolvedValueOnce({ id: 'client-1', logoS3Key: previousPngKey })
      .mockImplementationOnce(async () => ({
        id: 'client-1',
        tenantId: 'tenant-1',
        logoS3Key:
          tenantTx.client.updateMany.mock.calls[0]?.[0]?.data.logoS3Key,
        logoContentType: 'image/png',
      }));
    tenantTx.client.updateMany.mockResolvedValue({ count: 1 });
    s3Send
      .mockResolvedValueOnce(validPngObject())
      .mockRejectedValueOnce(new Error('put response lost'))
      .mockResolvedValueOnce(validPngObject())
      .mockResolvedValue({});
    mockedGetSignedUrl.mockResolvedValue(
      'https://downloads.example.test/logo.png',
    );

    await service.confirmLogoUpload(ctx, 'client-1', pngKey, 'image/png');

    const promotedKey = s3Send.mock.calls[1]?.[0]?.input.Key;
    expect(s3Send.mock.calls[2]?.[0]?.input).toEqual({
      Bucket: 'assets-bucket',
      Key: promotedKey,
    });
    expect(tenantTx.client.updateMany).toHaveBeenCalledTimes(1);
  });

  test('retries a concurrent pointer swap and retains the object actually superseded', async () => {
    const { service, tenantTx, s3Send } = makeService();
    const concurrentKey =
      'tenants/tenant-1/clients/client-1/logos/00000000-0000-4000-8000-000000000099.png';
    tenantTx.client.findFirst
      .mockResolvedValueOnce({ id: 'client-1', logoS3Key: previousPngKey })
      .mockResolvedValueOnce({ logoS3Key: concurrentKey })
      .mockImplementationOnce(async () => ({
        id: 'client-1',
        tenantId: 'tenant-1',
        logoS3Key:
          tenantTx.client.updateMany.mock.calls[1]?.[0]?.data.logoS3Key,
        logoContentType: 'image/png',
      }));
    tenantTx.client.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    s3Send.mockResolvedValue(validPngObject());
    mockedGetSignedUrl.mockResolvedValue(
      'https://downloads.example.test/logo.png',
    );

    await service.confirmLogoUpload(ctx, 'client-1', pngKey, 'image/png');

    expect(
      tenantTx.client.updateMany.mock.calls.map(([input]) => input.where),
    ).toEqual([
      {
        id: 'client-1',
        tenantId: 'tenant-1',
        logoS3Key: previousPngKey,
      },
      {
        id: 'client-1',
        tenantId: 'tenant-1',
        logoS3Key: concurrentKey,
      },
    ]);
    expect(
      s3Send.mock.calls.slice(2).map(([command]) => command.input),
    ).toEqual([{ Bucket: 'assets-bucket', Key: pngKey }]);
    expect(
      s3Send.mock.calls.some(
        ([command]) => command.input?.Key === concurrentKey,
      ),
    ).toBe(false);
  });

  test('retains a promoted object when the database pointer transaction fails', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst.mockResolvedValue({
      id: 'client-1',
      logoS3Key: previousPngKey,
    });
    tenantTx.client.updateMany.mockRejectedValue(
      new Error('database unavailable'),
    );
    s3Send.mockResolvedValue(validPngObject());

    await expect(
      service.confirmLogoUpload(ctx, 'client-1', pngKey, 'image/png'),
    ).rejects.toThrow('database unavailable');

    const promotedKey = s3Send.mock.calls[1]?.[0]?.input.Key as string;
    expect(promotedKey).toMatch(
      /^tenants\/tenant-1\/clients\/client-1\/logos\/[0-9a-f-]{36}\.png$/,
    );
    expect(s3Send).toHaveBeenCalledTimes(2);
  });

  test('retains a promoted object when a failed commit acknowledgement may have advanced the pointer', async () => {
    const { service, tenantTx, prisma, s3Send } = makeService();
    tenantTx.client.findFirst
      .mockResolvedValueOnce({ id: 'client-1', logoS3Key: previousPngKey })
      .mockImplementation(async () => ({
        id: 'client-1',
        logoS3Key:
          tenantTx.client.updateMany.mock.calls[0]?.[0]?.data.logoS3Key,
      }));
    tenantTx.client.updateMany.mockResolvedValue({ count: 1 });
    let tenantTransaction = 0;
    prisma.withTenant.mockImplementation(
      async (_tenantId: string, run: (tx: unknown) => Promise<unknown>) => {
        tenantTransaction += 1;
        const result = await run(tenantTx);
        if (tenantTransaction === 2) {
          throw new Error('commit acknowledgement lost');
        }
        return result;
      },
    );
    s3Send.mockResolvedValue(validPngObject());

    await expect(
      service.confirmLogoUpload(ctx, 'client-1', pngKey, 'image/png'),
    ).rejects.toThrow('commit acknowledgement lost');

    expect(s3Send).toHaveBeenCalledTimes(2);
    expect(s3Send.mock.calls[1]?.[0]?.input.Key).toMatch(
      /^tenants\/tenant-1\/clients\/client-1\/logos\/[0-9a-f-]{36}\.png$/,
    );
  });

  test('persists a validated logo through a tenant-scoped update', async () => {
    const { service, tenantTx, s3Send } = makeService();
    tenantTx.client.findFirst
      .mockResolvedValueOnce({ id: 'client-1', logoS3Key: previousPngKey })
      .mockImplementationOnce(async () => ({
        id: 'client-1',
        tenantId: 'tenant-1',
        logoS3Key:
          tenantTx.client.updateMany.mock.calls[0]?.[0]?.data.logoS3Key,
        logoContentType: 'image/png',
      }));
    tenantTx.client.updateMany.mockResolvedValue({ count: 1 });
    s3Send.mockResolvedValue(validPngObject());
    mockedGetSignedUrl.mockResolvedValue(
      'https://downloads.example.test/logo.png',
    );

    const result = await service.confirmLogoUpload(
      ctx,
      'client-1',
      pngKey,
      'image/png',
    );
    const finalKey = tenantTx.client.updateMany.mock.calls[0]?.[0]?.data
      .logoS3Key as string;

    expect(result).toEqual(
      expect.objectContaining({
        id: 'client-1',
        logoS3Key: finalKey,
        logoUrl: 'https://downloads.example.test/logo.png',
      }),
    );
    expect(finalKey).toMatch(
      /^tenants\/tenant-1\/clients\/client-1\/logos\/[0-9a-f-]{36}\.png$/,
    );
    expect(finalKey).not.toBe(
      `tenants/tenant-1/clients/client-1/logos/${uploadId}.png`,
    );

    expect(s3Send.mock.calls[0]?.[0]?.input).toEqual({
      Bucket: 'assets-bucket',
      Key: pngKey,
    });
    expect(s3Send.mock.calls[1]?.[0]?.input).toEqual({
      Bucket: 'assets-bucket',
      Key: finalKey,
      Body: validPng,
      ContentType: 'image/png',
      IfNoneMatch: '*',
    });
    expect(
      s3Send.mock.calls.slice(2).map(([command]) => command.input),
    ).toEqual([{ Bucket: 'assets-bucket', Key: pngKey }]);
    expect(tenantTx.client.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'client-1',
        tenantId: 'tenant-1',
        logoS3Key: previousPngKey,
      },
      data: {
        logoS3Key: finalKey,
        logoContentType: 'image/png',
        logoUploadedAt: expect.any(Date),
      },
    });
  });
});

function removePngChunk(png: Buffer, target: string): Buffer {
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (type === target) {
      return Buffer.concat([png.subarray(0, offset), png.subarray(next)]);
    }
    offset = next;
  }
  throw new Error(`PNG fixture does not contain ${target}`);
}

function insertPngChunk(png: Buffer, type: string, data: Buffer): Buffer {
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') break;
    offset += 12 + length;
  }
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(chunk, 4, 8 + data.length), 8 + data.length);
  return Buffer.concat([png.subarray(0, offset), chunk, png.subarray(offset)]);
}

function insertJpegSegment(jpeg: Buffer, marker: number, data: Buffer): Buffer {
  const segment = Buffer.alloc(4 + data.length);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(data.length + 2, 2);
  data.copy(segment, 4);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

function countOccurrences(haystack: Buffer, needle: Buffer): number {
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function prependEmptyJpegSegments(jpeg: Buffer, count: number): Buffer {
  const segments = Buffer.allocUnsafe(count * 4);
  for (let offset = 0; offset < segments.length; offset += 4) {
    segments[offset] = 0xff;
    segments[offset + 1] = 0xe1;
    segments[offset + 2] = 0x00;
    segments[offset + 3] = 0x02;
  }
  return Buffer.concat([jpeg.subarray(0, 2), segments, jpeg.subarray(2)]);
}

function pngCrc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function webpChunk(fourCc: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourCc, 0, 4, 'ascii');
  header.writeUInt32LE(data.length, 4);
  const pad = data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([header, data, pad]);
}

/**
 * Builds a minimal WEBP fixture: an optional VP8X canvas-size chunk followed
 * by a VP8L "lossless" image chunk carrying only the 5-byte signature +
 * packed-dimensions header real decoders read the size from — no actual
 * pixel bitstream, since sanitizeWebpLogo (like the PNG/JPEG paths) only
 * bounds declared dimensions and never decodes pixels for WEBP.
 */
function buildWebp(options: {
  width: number;
  height: number;
  useVp8x?: boolean;
  animated?: boolean;
  extraChunks?: Array<{ fourCc: string; data: Buffer }>;
}): Buffer {
  const { width, height, useVp8x = false, animated = false } = options;
  const parts: Buffer[] = [];

  if (useVp8x) {
    const vp8x = Buffer.alloc(10);
    vp8x[0] = animated ? 0x04 : 0x00;
    const w = width - 1;
    const h = height - 1;
    vp8x[4] = w & 0xff;
    vp8x[5] = (w >> 8) & 0xff;
    vp8x[6] = (w >> 16) & 0xff;
    vp8x[7] = h & 0xff;
    vp8x[8] = (h >> 8) & 0xff;
    vp8x[9] = (h >> 16) & 0xff;
    parts.push(webpChunk('VP8X', vp8x));
  }

  for (const extra of options.extraChunks ?? []) {
    parts.push(webpChunk(extra.fourCc, extra.data));
  }

  const vp8lData = Buffer.alloc(5);
  vp8lData[0] = 0x2f;
  vp8lData.writeUInt32LE((((height - 1) << 14) | (width - 1)) >>> 0, 1);
  parts.push(webpChunk('VP8L', vp8lData));

  const body = Buffer.concat(parts);
  const out = Buffer.alloc(12 + body.length);
  out.write('RIFF', 0, 4, 'ascii');
  out.writeUInt32LE(4 + body.length, 4);
  out.write('WEBP', 8, 4, 'ascii');
  body.copy(out, 12);
  return out;
}
