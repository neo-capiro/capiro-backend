import { NotFoundException } from '@nestjs/common';
import { MeriHermesBrokerService, type MeriHermesBrokerAuth } from './meri-hermes-broker.service.js';
import * as documentExtraction from '../meri-attachment-document.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const OTHER_ACTOR = '33333333-3333-4333-8333-333333333333';
const accuracyKeys = [
  'MERI_EVIDENCE_ACCURACY_MODE',
  'MERI_EVIDENCE_ACCURACY_TENANTS',
  'MERI_EVIDENCE_ACCURACY_SURFACES',
] as const;

function setAccuracyMode(mode: 'off' | 'enforce') {
  process.env.MERI_EVIDENCE_ACCURACY_MODE = mode;
  process.env.MERI_EVIDENCE_ACCURACY_TENANTS = TENANT;
  process.env.MERI_EVIDENCE_ACCURACY_SURFACES = 'chat';
}

function attachment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'attachment-1',
    tenantId: TENANT,
    userId: ACTOR,
    filename: 'brief.txt',
    kind: 'text',
    status: 'parsed',
    mediaType: 'text/plain',
    byteSize: 5,
    pages: null,
    textContent: 'hello',
    reason: null,
    data: Buffer.from('hello'),
    ...overrides,
  };
}

function buildBroker(initialRow = attachment()) {
  let row = initialRow;
  const findFirst = jest.fn(async ({ where }: { where: { id: string; tenantId: string; userId: string } }) =>
    row.id === where.id && row.tenantId === where.tenantId && row.userId === where.userId ? row : null);
  const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
    row = { ...row, ...data };
    return row;
  });
  const tx = {
    clioAttachment: { findFirst, update },
    tenantMembership: { findFirst: jest.fn(async () => ({ role: 'standard_user' })) },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, callback: (value: typeof tx) => unknown) => callback(tx)),
  };
  const run = {
    runId: 'run-1',
    status: 'running',
    brokerCalls: 0,
    envelope: {
      tenantId: TENANT,
      actorId: ACTOR,
      authorizationVersion: 'v1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      toolPolicy: { allow: ['meri_fetch_attachment'], deny: [], readOnly: true },
      budget: { maxToolCalls: 10 },
    },
  };
  const runs = {
    reserveBrokerCall: jest.fn(async () => ({ admitted: true, brokerCalls: ++run.brokerCalls })),
    get: jest.fn(async () => run),
    append: jest.fn(async () => ({})),
  };
  const broker = new MeriHermesBrokerService(
    prisma as never,
    runs as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  broker.dbGovernor = { guard: jest.fn(async (_tool: string, operation: () => unknown) => operation()) } as never;
  const auth = { run, claims: {}, membershipRole: 'standard_user' } as unknown as MeriHermesBrokerAuth;
  return { broker, auth, findFirst, update };
}

describe('MeriHermesBrokerService.getAttachment', () => {
  const previousEnv = Object.fromEntries(accuracyKeys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of accuracyKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('off deep-equals the pre-content-state attachment object', async () => {
    setAccuracyMode('off');
    const { broker, auth } = buildBroker();

    await expect(broker.getAttachment(auth, 'attachment-1')).resolves.toEqual({
      id: 'attachment-1',
      filename: 'brief.txt',
      kind: 'text',
      status: 'parsed',
      mediaType: 'text/plain',
      byteSize: 5,
      pages: null,
      textContent: 'hello',
      dataBase64: Buffer.from('hello').toString('base64'),
    });
  });

  test('enforce adds readable content metadata without an instruction', async () => {
    setAccuracyMode('enforce');
    const { broker, auth } = buildBroker();

    const result = await broker.getAttachment(auth, 'attachment-1');

    expect(result).toMatchObject({
      contentState: 'ready',
      readable: true,
      extractedChars: 5,
      limitation: null,
    });
    expect(result).not.toHaveProperty('instruction');
  });

  test('enforce gives unreadable content the exact safety instruction', async () => {
    setAccuracyMode('enforce');
    const reason = 'The PDF is encrypted.';
    const { broker, auth } = buildBroker(attachment({ status: 'failed', textContent: null, reason }));

    await expect(broker.getAttachment(auth, 'attachment-1')).resolves.toMatchObject({
      contentState: 'failed',
      readable: false,
      extractedChars: 0,
      limitation: reason,
      instruction: `This document could not be read (${reason}). Do not describe, summarize, or quote its contents; say exactly what could not be read.`,
    });
  });

  test('retryExtraction=true returns retry_requires_reconciler without extraction or budget', async () => {
    setAccuracyMode('enforce');
    const extract = jest.spyOn(documentExtraction, 'extractMeriDocument');
    const { broker, auth } = buildBroker(attachment({
      status: 'failed',
      textContent: null,
      reason: 'initial failure',
    }));

    const result = await broker.getAttachment(auth, 'attachment-1', true);

    expect(result).toEqual({
      kind: 'retry_requires_reconciler',
      tool: 'meri_fetch_attachment',
      reason: 'extraction_saga_not_available',
    });
    expect(extract).not.toHaveBeenCalled();
  });

  test('retryExtraction=true returns retry_requires_reconciler even in off mode', async () => {
    setAccuracyMode('off');
    const { broker, auth } = buildBroker();

    const result = await broker.getAttachment(auth, 'attachment-1', true);

    expect(result).toEqual({
      kind: 'retry_requires_reconciler',
      tool: 'meri_fetch_attachment',
      reason: 'extraction_saga_not_available',
    });
  });

  test.each(['off', 'enforce'] as const)('%s scopes attachment reads to the run actor', async (mode) => {
    setAccuracyMode(mode);
    const { broker, auth, findFirst } = buildBroker(attachment({ userId: OTHER_ACTOR }));

    await expect(broker.getAttachment(auth, 'attachment-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: TENANT, userId: ACTOR }),
    }));
  });
});
