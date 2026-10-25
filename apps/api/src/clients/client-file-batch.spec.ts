import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HttpException } from '@nestjs/common';
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('./client-ordered-owner.access.js', () => ({
  requireOwnerActor: jest.fn(async () => undefined),
  requireOwnerClient: jest.fn(async () => undefined),
}));
import { requireOwnerActor, requireOwnerClient } from './client-ordered-owner.access.js';
import { ClientFileBatchService } from './client-file-batch.service.js';
import { fileBatchDigest, parseFileBatchMove } from './client-file-batch.types.js';
const tenant = '11111111-1111-4111-8111-111111111111',
  client = '22222222-2222-4222-8222-222222222222',
  actor = '33333333-3333-4333-8333-333333333333';
const first = '44444444-4444-4444-8444-444444444444',
  second = '55555555-5555-4555-8555-555555555555';
const ctx = {
  tenantId: tenant,
  userId: actor,
  clerkUserId: 'synthetic-actor',
  role: 'standard_user' as const,
  tenantSlug: 'synthetic',
};
const command = () => ({
  schemaVersion: 1 as const,
  requestId: '66666666-6666-4666-8666-666666666666',
  clientId: client,
  folder: 'Reviewed',
  files: [
    { id: first, expectedRevision: 0 },
    { id: second, expectedRevision: 0 },
  ],
});
async function failureOf(pending: Promise<unknown>): Promise<HttpException> {
  try {
    await pending;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    return error as HttpException;
  }
  throw new Error('Expected a request refusal');
}
function fixture() {
  let rows = [first, second].map((id) => ({
    id,
    folder: null as string | null,
    revision: 0,
    viewerMode: 'all',
    viewerUserIds: [] as string[],
    uploadedByUserId: null as string | null,
    sourceEntityType: null as string | null,
    sourceEntityId: null as string | null,
  }));
  let receipts: Array<Record<string, unknown>> = [];
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  let failUpdate: string | undefined;
  let afterRollback: (() => Promise<void>) | undefined;
  let failReceiptRead = false;
  let failReceiptWrite = false;
  const tx = {
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.reduce(
        (text, part, i) =>
          text + part + (i < values.length ? ((values[i] as { sql?: string })?.sql ?? '?') : ''),
        '',
      );
      statements.push({ sql, values });
      if (sql.includes('pg_advisory')) throw new Error('Prisma cannot deserialize void');
      if (sql.includes('FROM legiwatch_record_document')) return [];
      if (sql.includes('FROM client_file_batch_move_receipts')) {
        if (failReceiptRead) throw new Error('synthetic unknown receipt read');
        return receipts;
      }
      if (sql.includes('FROM engagement_attachments')) return structuredClone(rows);
      if (sql.includes('UPDATE engagement_attachments')) {
        const id = values[3] as string;
        if (id === failUpdate) throw new Error('synthetic second-file failure');
        const file = rows.find((row) => row.id === id)!;
        if (file.folder !== values[0]) file.revision++;
        file.folder = values[0] as string;
        return [{ revision: file.revision }];
      }
      if (sql.includes('clock_timestamp')) return [{ at: new Date('2026-10-23T00:00:00.000Z') }];
      throw new Error('Unexpected query');
    }),
    $executeRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      statements.push({ sql, values });
      if (sql.includes('pg_advisory') || sql.includes('set_config')) return 1;
      if (!sql.includes('INSERT INTO client_file_batch_move_receipts'))
        throw new Error('Unexpected write');
      if (failReceiptWrite) throw new Error('synthetic unknown receipt write');
      receipts.push({
        clientId: values[1],
        payloadDigest: values[4],
        command: JSON.parse(values[5] as string),
        receipt: JSON.parse(values[6] as string),
      });
      return 1;
    }),
  };
  const prisma = {
    withTenant: async (_tenant: string, run: (tx: unknown) => unknown) => {
      const before = structuredClone({ rows, receipts });
      try {
        return await run(tx);
      } catch (error) {
        rows = before.rows;
        receipts = before.receipts;
        const callback = afterRollback;
        afterRollback = undefined;
        await callback?.();
        throw error;
      }
    },
  };
  const service = new ClientFileBatchService(prisma as never);
  return {
    service,
    tx,
    statements,
    get rows() {
      return rows;
    },
    get receipts() {
      return receipts;
    },
    failOn: (id: string) => {
      failUpdate = id;
    },
    afterRollback: (callback: () => Promise<void>) => {
      afterRollback = callback;
    },
    failReceiptRead: () => {
      failReceiptRead = true;
    },
    failReceiptWrite: () => {
      failReceiptWrite = true;
    },
  };
}
beforeEach(() => {
  jest.mocked(requireOwnerActor).mockReset().mockResolvedValue(undefined);
  jest
    .mocked(requireOwnerClient)
    .mockReset()
    .mockResolvedValue(undefined as never);
});

describe('batch file move owner (synthetic transaction, no database)', () => {
  it('normalizes the label, orders selection and rejects missing revisions/duplicates/authority injection', () => {
    expect(
      parseFileBatchMove(client, {
        ...command(),
        folder: '  Reviewed  ',
        files: [...command().files].reverse(),
      }),
    ).toEqual(command());
    for (const bad of [
      { ...command(), tenantId: tenant },
      { ...command(), files: [{ id: first }] },
      { ...command(), files: [command().files[0], command().files[0]] },
      { ...command(), files: Array(101).fill(command().files[0]) },
      { ...command(), requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
      {
        ...command(),
        files: [{ id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', expectedRevision: 0 }],
      },
    ])
      expect(() => parseFileBatchMove(client, bad)).toThrow();
    expect(() => parseFileBatchMove(actor, command())).toThrow();
  });
  it('locks current client and every selected row before writes, then returns a bound complete receipt', async () => {
    const h = fixture(),
      result = await h.service.move(ctx, client, command());
    expect(requireOwnerClient).toHaveBeenCalledWith(h.tx, ctx, client, false, false, 'share');
    expect(
      h.statements.find(
        (row) => row.sql.includes('FROM engagement_attachments') && row.sql.includes('FOR UPDATE'),
      ),
    ).toMatchObject({
      sql: expect.stringContaining('ORDER BY id FOR UPDATE'),
      values: [tenant, client, `${first},${second}`, expect.anything()],
    });
    expect(result).toMatchObject({
      requestId: command().requestId,
      clientId: client,
      payloadDigest: fileBatchDigest(command()),
      files: [
        { id: first, previousRevision: 0, revision: 1, folder: 'Reviewed' },
        { id: second, previousRevision: 0, revision: 1, folder: 'Reviewed' },
      ],
    });
    expect(h.receipts).toHaveLength(1);
  });
  it('checks all revisions and permissions before touching any row; denial reveals no denied ID', async () => {
    for (const failure of ['stale', 'acl', 'missing', 'hearing', 'unknown-mode']) {
      const h = fixture();
      if (failure === 'stale') h.rows[1]!.revision = 1;
      if (failure === 'acl') h.rows[1]!.viewerMode = 'restricted';
      if (failure === 'missing') h.rows.pop();
      if (failure === 'hearing') h.rows[1]!.sourceEntityType = 'hearing_record_brief';
      if (failure === 'unknown-mode') {
        h.rows[1]!.viewerMode = 'unknown';
        h.rows[1]!.viewerUserIds = [actor];
      }
      await expect(h.service.move(ctx, client, command())).rejects.toThrow(
        failure === 'hearing' ? 'ACCESS_OR_VERSION_CHANGED' : 'refused',
      );
      expect(h.statements.some((row) => row.sql.startsWith('\n          UPDATE'))).toBe(false);
      expect(h.receipts).toHaveLength(failure === 'hearing' ? 0 : 1);
      if (failure !== 'hearing')
        expect(h.receipts[0]!.receipt).toMatchObject({ code: 'FILE_BATCH_MOVE_REFUSED' });
      expect(h.rows[0]!.folder).toBeNull();
    }
  });

  it('stores one terminal refusal and replays it after file availability/revisions change, without requiring those files', async () => {
    const h = fixture();
    h.rows[1]!.revision = 1;
    const firstFailure = await failureOf(h.service.move(ctx, client, command()));
    expect(firstFailure.getResponse()).toEqual({
      schemaVersion: 1,
      code: 'FILE_BATCH_MOVE_REFUSED',
      requestId: command().requestId,
      clientId: client,
      payloadDigest: fileBatchDigest(command()),
      status: 409,
      message: 'The batch move was refused. Review current files before creating a new move.',
    });
    h.rows[1]!.revision = 0;
    await expect(h.service.move(ctx, client, command())).rejects.toMatchObject({
      response: firstFailure.getResponse(),
    });
    h.rows.splice(0);
    const before = h.statements.length;
    await expect(h.service.receipt(ctx, client, command().requestId)).rejects.toMatchObject({
      response: firstFailure.getResponse(),
    });
    expect(
      h.statements.slice(before).some((row) => row.sql.includes('engagement_attachments')),
    ).toBe(false);
    expect(requireOwnerClient).toHaveBeenCalledWith(h.tx, ctx, client, false, false, 'share');
    expect(h.receipts).toHaveLength(1);
    expect(h.statements.some((row) => row.sql.includes('UPDATE engagement_attachments'))).toBe(
      false,
    );
  });

  it('returns the original moved outcome if another exact attempt commits between rollback and terminalization', async () => {
    const h = fixture();
    h.rows[1]!.revision = 1;
    let winner: unknown;
    h.afterRollback(async () => {
      h.rows[1]!.revision = 0;
      winner = await h.service.move(ctx, client, command());
    });
    expect(await h.service.move(ctx, client, command())).toEqual(winner);
    expect(h.receipts).toHaveLength(1);
    expect(h.receipts[0]!.receipt).toMatchObject({ outcome: 'moved' });
  });

  it('never relabels an existing receipt or request collision as a no-write refusal', async () => {
    const h = fixture();
    await h.service.move(ctx, client, command());
    h.rows[1]!.viewerMode = 'restricted';
    const failure = await failureOf(h.service.move(ctx, client, command()));
    expect(failure.getStatus()).toBe(404);
    expect(failure.getResponse()).not.toHaveProperty('code', 'FILE_BATCH_MOVE_REFUSED');
    const conflict = await failureOf(
      h.service.move(ctx, client, { ...command(), folder: 'Other' }),
    );
    expect(conflict.getStatus()).toBe(409);
    expect(conflict.getResponse()).not.toHaveProperty('code', 'FILE_BATCH_MOVE_REFUSED');
    expect(h.receipts).toHaveLength(1);
    expect(h.receipts[0]!.receipt).toMatchObject({ outcome: 'moved' });
  });

  it.each(['read', 'write'])(
    'unknown terminal receipt %s failure never reports refusal',
    async (kind) => {
      const h = fixture();
      h.rows[1]!.revision = 1;
      if (kind === 'read') h.failReceiptRead();
      else h.failReceiptWrite();
      await expect(h.service.move(ctx, client, command())).rejects.toThrow(
        `unknown receipt ${kind}`,
      );
      expect(h.receipts).toHaveLength(0);
      expect(h.rows.map((row) => row.folder)).toEqual([null, null]);
    },
  );

  it('refused receipt still requires current actor and client, and rejects damaged durable identity', async () => {
    const h = fixture();
    h.rows[1]!.revision = 1;
    await expect(h.service.move(ctx, client, command())).rejects.toThrow('refused');
    jest.mocked(requireOwnerClient).mockRejectedValueOnce(new Error('synthetic wall denied'));
    await expect(h.service.receipt(ctx, client, command().requestId)).rejects.toThrow(
      'wall denied',
    );
    jest.mocked(requireOwnerActor).mockRejectedValueOnce(new Error('synthetic actor denied'));
    await expect(h.service.receipt(ctx, client, command().requestId)).rejects.toThrow(
      'actor denied',
    );
    (h.receipts[0]!.receipt as { payloadDigest: string }).payloadDigest = 'f'.repeat(64);
    await expect(h.service.receipt(ctx, client, command().requestId)).rejects.toThrow(
      'could not be verified',
    );
  });
  it('does not enter the file owner after current membership or client wall denial', async () => {
    const h = fixture();
    jest.mocked(requireOwnerActor).mockRejectedValueOnce(new Error('synthetic access denied'));
    await expect(h.service.move(ctx, client, command())).rejects.toThrow('access denied');
    expect(h.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('has one transaction boundary for all updates and receipt, including mid-batch failure', async () => {
    const h = fixture();
    h.failOn(second);
    await expect(h.service.move(ctx, client, command())).rejects.toThrow('second-file failure');
    expect(h.rows.map((file) => [file.folder, file.revision])).toEqual([
      [null, 0],
      [null, 0],
    ]);
    expect(h.receipts).toHaveLength(0);
  });
  it('replays only the original complete receipt and rejects request ID reuse with another digest', async () => {
    const h = fixture(),
      receipt = await h.service.move(ctx, client, command());
    h.rows[0]!.folder = 'Later';
    h.rows[0]!.revision = 2;
    expect(await h.service.move(ctx, client, command())).toEqual(receipt);
    expect(await h.service.receipt(ctx, client, command().requestId)).toEqual(receipt);
    expect(h.statements.filter((row) => row.sql.includes('INSERT INTO'))).toHaveLength(1);
    await expect(h.service.move(ctx, client, { ...command(), folder: 'Other' })).rejects.toThrow(
      'request ID',
    );
    expect(h.rows[0]!.folder).toBe('Later');
  });
  it('does not let historical replay bypass current file access or accept a damaged receipt', async () => {
    const h = fixture();
    await h.service.move(ctx, client, command());
    h.rows[1]!.viewerMode = 'restricted';
    await expect(h.service.move(ctx, client, command())).rejects.toThrow('unavailable');
    await expect(h.service.receipt(ctx, client, command().requestId)).rejects.toThrow(
      'unavailable',
    );
    h.rows[1]!.viewerMode = 'all';
    (h.receipts[0]!.receipt as { files: unknown[] }).files.pop();
    await expect(h.service.receipt(ctx, client, command().requestId)).rejects.toThrow(
      'could not be verified',
    );
  });
});
