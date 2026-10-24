import { beforeEach, expect, it, jest } from '@jest/globals';
jest.mock('@capiro/shared', () => ({ prospectResourceScope: jest.fn() }));
jest.mock('../clients/client-ordered-owner.access.js', () => ({ requireOwnerClient: jest.fn() }));
import { prospectResourceScope } from '@capiro/shared';
import { requireOwnerClient } from '../clients/client-ordered-owner.access.js';
import {
  commitProspectConversion,
  readProspectConversion,
} from './prospect-conversion-receipts.js';
import { parseProspectConversion, prospectConversionDigest } from './prospect-conversion.types.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'synthetic-actor',
  role: 'standard_user' as const,
  tenantSlug: 'synthetic',
};
const prospectId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const at = '2026-10-23T00:00:00.000Z';
const command = () =>
  parseProspectConversion(prospectId, {
    schemaVersion: 1,
    requestId,
    prospectId,
    mode: 'existing_client',
    clientId,
    expectedUpdatedAt: at,
  });
beforeEach(() => {
  jest.mocked(requireOwnerClient).mockReset();
  jest.mocked(prospectResourceScope).mockReset().mockResolvedValue({
    tenantId: ctx.tenantId,
    prospectId,
    userId: ctx.userId,
    clerkUserId: ctx.clerkUserId,
    linkedClientId: null,
  });
});
function fixture(capacityLock?: () => Promise<void>) {
  const current = {
    updatedAt: new Date(at),
    linkedClientId: null as string | null,
    convertedAt: null as Date | null,
    displayName: 'Synthetic new client',
  };
  let stored: { command: unknown; payloadDigest: string; receipt: unknown } | undefined;
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const tx = {
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      statements.push({ sql, values });
      if (sql.includes('FROM business_development_prospects')) return [{ ...current }];
      if (sql.includes('FROM prospect_conversion_receipts')) return stored ? [stored] : [];
      if (sql.includes('clock_timestamp')) return [{ at: new Date('2026-10-23T00:00:01.000Z') }];
      if (sql.includes('pg_advisory')) throw new Error('Prisma cannot deserialize void');
      throw new Error('Unexpected fixture query: ' + sql);
    }),
    $executeRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      statements.push({ sql, values });
      if (sql.includes('pg_advisory')) {
        if (values[0] === `client-capacity:${ctx.tenantId}`) await capacityLock?.();
        return 1;
      }
      if (!sql.includes('INSERT INTO prospect_conversion_receipts'))
        throw new Error('Unexpected fixture write');
      stored = {
        payloadDigest: String(values[5]),
        command: JSON.parse(String(values[6])),
        receipt: JSON.parse(String(values[7])),
      };
      return 1;
    }),
  };
  const convert = jest.fn(async () => {
    current.linkedClientId = clientId;
    current.convertedAt = new Date('2026-10-23T00:00:00.500Z');
    current.updatedAt = current.convertedAt;
    return { clientId, created: false };
  });
  return { tx: tx as never, convert, current, statements, stored: () => stored };
}
it('strictly binds the canonical command and rejects new-client, transfer and malformed scope input', () => {
  const value = command();
  if (value.mode !== 'existing_client') throw new Error('Expected existing-client fixture');
  expect(prospectConversionDigest(value)).toMatch(/^[a-f0-9]{64}$/);
  for (const change of [
    { mode: 'new_client' },
    { transferFiles: true },
    { schemaVersion: 2 },
    { prospectId: clientId },
    { expectedUpdatedAt: '2026-10-23' },
    { requestId: 'bad' },
  ])
    expect(() => parseProspectConversion(prospectId, { ...value, ...change })).toThrow();
  expect(prospectConversionDigest({ ...value, clientId: prospectId })).not.toBe(
    prospectConversionDigest(value),
  );
});
it('returns the exact historical receipt on replay and readback without a second conversion', async () => {
  const h = fixture(),
    c = command();
  const receipt = await commitProspectConversion(h.tx, ctx, c, h.convert);
  expect(receipt).toEqual({
    schemaVersion: 1,
    requestId,
    prospectId,
    clientId,
    payloadDigest: prospectConversionDigest(c),
    outcome: 'linked',
    expectedUpdatedAt: at,
    prospectUpdatedAt: '2026-10-23T00:00:00.500Z',
    committedAt: '2026-10-23T00:00:01.000Z',
  });
  expect(await commitProspectConversion(h.tx, ctx, c, h.convert)).toEqual(receipt);
  expect(await readProspectConversion(h.tx, ctx, prospectId, requestId)).toEqual(receipt);
  expect(h.convert).toHaveBeenCalledTimes(1);
  expect(h.statements.filter((s) => s.sql.includes('INSERT INTO'))).toHaveLength(1);
  expect(h.stored()?.command).toEqual(c);
});
it('rejects stale version and a prior conversion without a receipt before calling the owner', async () => {
  const h = fixture();
  h.current.updatedAt = new Date('2026-10-23T00:00:02.000Z');
  await expect(commitProspectConversion(h.tx, ctx, command(), h.convert)).rejects.toThrow(
    'changed',
  );
  h.current.updatedAt = new Date(at);
  h.current.linkedClientId = clientId;
  await expect(commitProspectConversion(h.tx, ctx, command(), h.convert)).rejects.toThrow(
    'changed',
  );
  expect(h.convert).not.toHaveBeenCalled();
});
it('refuses a different converted target before acquiring any client or membership locks', async () => {
  const h = fixture();
  h.current.linkedClientId = prospectId;
  await expect(commitProspectConversion(h.tx, ctx, command(), h.convert)).rejects.toThrow(
    'unavailable',
  );
  expect(requireOwnerClient).not.toHaveBeenCalled();
  expect(prospectResourceScope).not.toHaveBeenCalled();
  expect(h.convert).not.toHaveBeenCalled();
});
it('rejects request-ID reuse for a different digest', async () => {
  const h = fixture();
  await commitProspectConversion(h.tx, ctx, command(), h.convert);
  await expect(
    commitProspectConversion(
      h.tx,
      ctx,
      { ...command(), expectedUpdatedAt: '2026-10-23T00:00:01.000Z' },
      h.convert,
    ),
  ).rejects.toThrow('another conversion');
  expect(h.convert).toHaveBeenCalledTimes(1);
});
it('rechecks current actor and client policy for a retained receipt', async () => {
  const h = fixture();
  await commitProspectConversion(h.tx, ctx, command(), h.convert);
  jest.mocked(prospectResourceScope).mockResolvedValueOnce(null);
  await expect(readProspectConversion(h.tx, ctx, prospectId, requestId)).rejects.toThrow(
    'unavailable',
  );
  jest.mocked(requireOwnerClient).mockRejectedValueOnce(new Error('Synthetic wall revoked'));
  await expect(commitProspectConversion(h.tx, ctx, command(), h.convert)).rejects.toThrow(
    'Synthetic wall revoked',
  );
  expect(h.convert).toHaveBeenCalledTimes(1);
});
it('refuses a writable-scope loss before conversion and propagates the existing owner rejection', async () => {
  const h = fixture();
  jest
    .mocked(prospectResourceScope)
    .mockResolvedValueOnce({
      tenantId: ctx.tenantId,
      prospectId,
      userId: ctx.userId,
      clerkUserId: ctx.clerkUserId,
      linkedClientId: null,
    })
    .mockResolvedValueOnce(null);
  await expect(commitProspectConversion(h.tx, ctx, command(), h.convert)).rejects.toThrow(
    'unavailable',
  );
  expect(h.convert).not.toHaveBeenCalled();
  h.convert.mockRejectedValueOnce(new Error('Canonical identity conflict'));
  await expect(commitProspectConversion(h.tx, ctx, command(), h.convert)).rejects.toThrow(
    'Canonical identity conflict',
  );
  expect(h.stored()).toBeUndefined();
});
it('rejects an owner result that creates or links a different client', async () => {
  for (const outcome of [
    { clientId, created: true },
    { clientId: prospectId, created: false },
  ]) {
    const h = fixture();
    h.convert.mockResolvedValueOnce(outcome);
    await expect(commitProspectConversion(h.tx, ctx, command(), h.convert)).rejects.toThrow(
      'reviewed existing client',
    );
    expect(h.stored()).toBeUndefined();
  }
});
it('refuses missing, changed-target and corrupt receipts', async () => {
  const h = fixture();
  await expect(readProspectConversion(h.tx, ctx, prospectId, requestId)).rejects.toThrow(
    'unavailable',
  );
  await commitProspectConversion(h.tx, ctx, command(), h.convert);
  h.current.linkedClientId = prospectId;
  await expect(readProspectConversion(h.tx, ctx, prospectId, requestId)).rejects.toThrow(
    'unavailable',
  );
  h.current.linkedClientId = clientId;
  (h.stored()!.receipt as { clientId: string }).clientId = prospectId;
  await expect(readProspectConversion(h.tx, ctx, prospectId, requestId)).rejects.toThrow(
    'cannot be verified',
  );
});

const newCommand = () =>
  parseProspectConversion(prospectId, {
    schemaVersion: 1,
    requestId,
    prospectId,
    expectedUpdatedAt: at,
    mode: 'new_client',
    clientName: 'Synthetic new client',
    clientWebsite: 'https://example.test',
    clientDescription: null,
  });
it('new-client command returns and recovers the exact created client without creating twice', async () => {
  const h = fixture(),
    c = newCommand();
  h.convert.mockImplementation(async () => {
    h.current.linkedClientId = clientId;
    h.current.convertedAt = new Date('2026-10-23T00:00:00.500Z');
    h.current.updatedAt = h.current.convertedAt;
    return { clientId, created: true };
  });
  const receipt = await commitProspectConversion(h.tx, ctx, c, h.convert);
  expect(receipt).toMatchObject({
    outcome: 'created',
    clientId,
    requestId,
    payloadDigest: prospectConversionDigest(c),
  });
  expect(await commitProspectConversion(h.tx, ctx, c, h.convert)).toEqual(receipt);
  expect(await readProspectConversion(h.tx, ctx, prospectId, requestId)).toEqual(receipt);
  expect(h.convert).toHaveBeenCalledTimes(1);
  expect(requireOwnerClient).toHaveBeenCalledWith(h.tx, ctx, clientId);
  expect(
    h.statements.filter((statement) => statement.values[0] === `client-capacity:${ctx.tenantId}`),
  ).toHaveLength(1);
});
it('does not acquire authorization row locks while a new-client admission is waiting for capacity', async () => {
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = fixture(async () => {
    entered();
    await gate;
  });
  const result = commitProspectConversion(h.tx, ctx, newCommand(), h.convert).catch(
    (error: unknown) => error,
  );
  await waiting;
  try {
    expect(prospectResourceScope).not.toHaveBeenCalled();
    expect(requireOwnerClient).not.toHaveBeenCalled();
    expect(h.convert).not.toHaveBeenCalled();
  } finally {
    release();
  }
  expect(await result).toBeInstanceOf(Error);
  expect(prospectResourceScope).toHaveBeenCalled();
  expect(h.convert).toHaveBeenCalledTimes(1);
});
it('a reviewed new client cannot silently become an existing-client link', async () => {
  const h = fixture();
  await expect(commitProspectConversion(h.tx, ctx, newCommand(), h.convert)).rejects.toThrow(
    'matching client already exists',
  );
  expect(h.stored()).toBeUndefined();
});
it('capacity refusal leaves no conversion receipt and propagates the canonical refusal', async () => {
  const h = fixture();
  h.convert.mockRejectedValueOnce(new Error('Canonical capacity exhausted'));
  await expect(commitProspectConversion(h.tx, ctx, newCommand(), h.convert)).rejects.toThrow(
    'capacity exhausted',
  );
  expect(h.stored()).toBeUndefined();
  expect(h.current.linkedClientId).toBeNull();
});
it('new-client name and original prospect version must still match', async () => {
  const h = fixture();
  h.current.displayName = 'Changed name';
  await expect(commitProspectConversion(h.tx, ctx, newCommand(), h.convert)).rejects.toThrow(
    'name changed',
  );
  expect(h.convert).not.toHaveBeenCalled();
});
it('new-client intake rejects transfer payloads, unsafe websites and unreviewed names', () => {
  const c = newCommand();
  for (const change of [
    { clientWebsite: 'javascript:alert(1)' },
    { clientWebsite: 'https://name:secret@example.test' },
    { clientName: ' ' },
    { clientDescription: 'x'.repeat(601) },
    { transferFiles: true },
    { clientId },
  ])
    expect(() => parseProspectConversion(prospectId, { ...c, ...change })).toThrow();
});
