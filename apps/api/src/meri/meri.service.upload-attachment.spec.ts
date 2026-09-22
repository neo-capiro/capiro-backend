import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service.js';
import * as documentExtraction from './meri-attachment-document.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ctx = { tenantId: TENANT, userId: USER } as TenantContext;
const file = {
  buffer: Buffer.from('attachment text'),
  mimetype: 'text/plain',
  originalname: 'notes.txt',
  size: 15,
};
const accuracyKeys = [
  'MERI_EVIDENCE_ACCURACY_MODE',
  'MERI_EVIDENCE_ACCURACY_TENANTS',
  'MERI_EVIDENCE_ACCURACY_SURFACES',
] as const;

function buildService() {
  let nextId = 0;
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `attachment-${++nextId}`,
    ...data,
  }));
  const tx = {
    clioAttachment: {
      create,
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, callback: (value: typeof tx) => unknown) => callback(tx)),
  };
  const service = new MeriService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { resolveProvider: jest.fn(async () => null) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, create };
}

function setAccuracyMode(mode: 'off' | 'enforce') {
  process.env.MERI_EVIDENCE_ACCURACY_MODE = mode;
  process.env.MERI_EVIDENCE_ACCURACY_TENANTS = TENANT;
  process.env.MERI_EVIDENCE_ACCURACY_SURFACES = 'chat';
}

describe('MeriService.uploadAttachment content-state persistence', () => {
  const previousEnv = Object.fromEntries(accuracyKeys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of accuracyKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test.each([
    ['scanned', 'No text layer was found.', 'metadata_only'],
    ['unsupported', 'No parser is available.', 'unsupported'],
  ] as const)('enforce persists %s extraction with bytes and limitation', async (status, reason, contentState) => {
    setAccuracyMode('enforce');
    jest.spyOn(documentExtraction, 'extractMeriDocument').mockResolvedValue({
      status,
      text: null,
      pages: status === 'scanned' ? 2 : null,
      truncated: false,
      reason,
    });
    const { service, create } = buildService();

    const result = await service.uploadAttachment(ctx, file);

    expect(result).toMatchObject({ id: 'attachment-1', status, contentState, limitation: reason });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status,
        reason,
        textContent: null,
        data: file.buffer,
      }),
    }));
  });

  test('enforce persists extraction failures with bytes and an explicit failed state', async () => {
    setAccuracyMode('enforce');
    jest.spyOn(documentExtraction, 'extractMeriDocument').mockRejectedValue(new Error('encrypted'));
    const { service, create } = buildService();

    const result = await service.uploadAttachment(ctx, file);

    expect(result).toMatchObject({
      id: 'attachment-1',
      status: 'failed',
      contentState: 'failed',
      limitation: expect.stringContaining('Could not read this document'),
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'failed',
        reason: expect.stringContaining('Could not read this document'),
        textContent: null,
        data: file.buffer,
      }),
    }));
  });

  test.each([
    ['scanned result', async () => ({ status: 'scanned' as const, text: null, pages: 2, truncated: false, reason: 'No text layer was found.' })],
    ['unsupported result', async () => ({ status: 'unsupported' as const, text: null, pages: null, truncated: false, reason: 'No parser is available.' })],
    ['thrown extraction', async () => { throw new Error('encrypted'); }],
  ])('off preserves the legacy null-id response and creates no row for a %s', async (_name, extraction) => {
    setAccuracyMode('off');
    jest.spyOn(documentExtraction, 'extractMeriDocument').mockImplementation(extraction);
    const { service, create } = buildService();

    const result = await service.uploadAttachment(ctx, file);

    expect(result.id).toBeNull();
    expect(result).not.toHaveProperty('contentState');
    expect(result).not.toHaveProperty('limitation');
    expect(create).not.toHaveBeenCalled();
  });

  test('readable enforce response is ready while off deep-equals the pre-content-state shape', async () => {
    const extraction = { status: 'parsed' as const, text: 'attachment text', pages: null, truncated: false, reason: null };
    const extract = jest.spyOn(documentExtraction, 'extractMeriDocument').mockResolvedValue(extraction);
    setAccuracyMode('enforce');
    const enforced = await buildService().service.uploadAttachment(ctx, file);
    expect(enforced).toMatchObject({ contentState: 'ready', limitation: null });

    setAccuracyMode('off');
    extract.mockResolvedValue(extraction);
    const legacy = await buildService().service.uploadAttachment(ctx, file);
    expect(legacy).toEqual({
      id: 'attachment-1',
      filename: 'notes.txt',
      kind: 'text',
      status: 'parsed',
      pages: null,
      truncated: false,
      reason: null,
      chars: 15,
    });
  });
});
