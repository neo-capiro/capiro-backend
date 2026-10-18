import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
import { MemoryCandidateService } from './memory-candidate.service.js';
import { MemoryController } from './memory.controller.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const WALLED = '44444444-4444-4444-8444-444444444444';
const GRANTED = '55555555-5555-4555-8555-555555555555';
const ITEM = '66666666-6666-4666-8666-666666666666';

const ctx: TenantContext = {
  tenantId: TENANT,
  userId: OWNER,
  tenantSlug: 'test',
  clerkUserId: 'test',
  role: 'standard_user',
};

function candidateId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

async function harness() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, memory_wall boolean NOT NULL);
    CREATE TABLE client_memory_access (tenant_id uuid NOT NULL, client_id uuid NOT NULL, user_id uuid NOT NULL);
    CREATE TABLE memory_candidate (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, proposed_by uuid NOT NULL,
      source_kind text NOT NULL, source_type text NOT NULL, scope text NOT NULL,
      client_id uuid, payload_jsonb jsonb NOT NULL, status text NOT NULL,
      created_at timestamptz NOT NULL, decided_at timestamptz,
      committed_memory_id uuid, committed_memory_item_id uuid
    );
  `);
  await db.query(
    'INSERT INTO clients (id,tenant_id,memory_wall) VALUES ($1,$3,true),($2,$3,true)',
    [WALLED, GRANTED, TENANT],
  );
  await db.query(
    'INSERT INTO client_memory_access (tenant_id,client_id,user_id) VALUES ($1,$2,$3)',
    [TENANT, GRANTED, OWNER],
  );

  const queryRaw = jest.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
    const sql = strings.reduce(
      (result, part, index) => result + part + (index < params.length ? `$${index + 1}` : ''),
      '',
    );
    const result = await db.query<Record<string, unknown>>(sql, params);
    return result.rows.map((row) => ({
      ...row,
      ...(row.createdAt ? { createdAt: new Date(String(row.createdAt)) } : {}),
      ...(row.decidedAt ? { decidedAt: new Date(String(row.decidedAt)) } : {}),
    }));
  });
  const prisma = {
    withTenantUser: jest.fn(
      async (
        tenantId: string,
        userId: string,
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) => {
        expect([tenantId, userId]).toEqual([TENANT, OWNER]);
        return fn({ $queryRaw: queryRaw } as unknown as Prisma.TransactionClient);
      },
    ),
  } as unknown as PrismaService;
  const service = new MemoryCandidateService(
    prisma,
    {} as MemoryIngestService,
    { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>,
  );
  const insert = async (
    index: number,
    options: {
      createdAt?: string;
      proposedBy?: string;
      ownerUserId?: string;
      clientId?: string | null;
      payloadClientId?: string | null;
      status?: string;
      key?: unknown;
      value?: unknown;
      scope?: string;
      decidedAt?: string | null;
      committedMemoryItemId?: string | null;
    } = {},
  ) => {
    const id = candidateId(index);
    const payload = {
      scope: options.scope ?? 'user_private',
      ownerUserId: options.ownerUserId ?? OWNER,
      clientId: options.payloadClientId ?? null,
      ...(options.key !== undefined ? { key: options.key } : { key: `key-${index}` }),
      value: options.value ?? `value-${index}`,
    };
    await db.query(
      `
      INSERT INTO memory_candidate
        (id,tenant_id,proposed_by,source_kind,source_type,scope,client_id,payload_jsonb,status,
         created_at,decided_at,committed_memory_item_id)
      VALUES ($1,$2,$3,'explicit_user','meri','personal',$4,$5::jsonb,$6,$7,$8,$9)
    `,
      [
        id,
        TENANT,
        options.proposedBy ?? OWNER,
        options.clientId ?? null,
        JSON.stringify(payload),
        options.status ?? 'pending',
        options.createdAt ?? '2026-10-18T12:00:00.123456Z',
        options.decidedAt ?? null,
        options.committedMemoryItemId ?? null,
      ],
    );
    return id;
  };
  return { db, service, insert, queryRaw };
}

describe('owner personal candidate inbox (ephemeral PostgreSQL)', () => {
  it('pages past 100 with exact timestamp/id ties, filtering malformed and walled rows before LIMIT', async () => {
    const h = await harness();
    try {
      const expected: string[] = [];
      for (let index = 1; index <= 110; index++) expected.push(await h.insert(index));
      const allowedClient = await h.insert(200, { clientId: GRANTED, payloadClientId: GRANTED });
      expected.push(allowedClient);
      await h.insert(201, { clientId: WALLED });
      await h.insert(202, { clientId: WALLED, payloadClientId: WALLED });
      await h.insert(203, { proposedBy: OTHER });
      await h.insert(204, { ownerUserId: OTHER });
      await h.insert(205, { key: 5 });
      await h.insert(206, { value: 6 });
      await h.insert(207, { scope: 'firm' });
      await h.insert(208, { payloadClientId: WALLED });
      await h.insert(211, { clientId: GRANTED });
      expected.push(await h.insert(209, { createdAt: '2026-10-18T12:00:00.123457Z' }));
      expected.push(await h.insert(210, { createdAt: '2026-10-18T12:00:00.123455Z' }));

      const received: string[] = [];
      let cursor: string | null = null;
      for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
        const page = await h.service.pageOwnPersonalPending(ctx, { limit: '50', cursor });
        expect(page.version).toBe(1);
        expect(page.candidates).toHaveLength(pageNumber < 2 ? 50 : pageNumber === 2 ? 13 : 0);
        received.push(...page.candidates.map((candidate) => candidate.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(received).toHaveLength(113);
      expect(new Set(received).size).toBe(113);
      expect(new Set(received)).toEqual(new Set(expected));
      expect(received[0]).toBe(candidateId(209));
      expect(received.at(-1)).toBe(candidateId(210));
      expect(
        h.queryRaw.mock.calls.some(([sql]) =>
          sql.join('?').includes('ORDER BY mc.created_at DESC, mc.id DESC'),
        ),
      ).toBe(true);
    } finally {
      await h.db.close();
    }
  });

  it('returns exact terminal history only to the payload owner with current client access', async () => {
    const h = await harness();
    try {
      const approved = await h.insert(1, {
        status: 'approved',
        decidedAt: '2026-10-18T12:01:00Z',
        committedMemoryItemId: ITEM,
      });
      const pending = await h.insert(2);
      const walled = await h.insert(3, { status: 'rejected', clientId: WALLED });
      const foreign = await h.insert(4, { status: 'rejected', ownerUserId: OTHER });
      const allowed = await h.insert(5, {
        status: 'withdrawn',
        clientId: GRANTED,
        payloadClientId: GRANTED,
      });
      const mismatched = await h.insert(6, { status: 'approved', clientId: GRANTED });
      const rejected = await h.insert(7, { status: 'rejected' });
      const committedInline = await h.insert(8, { status: 'auto_committed' });
      const superseded = await h.insert(9, { status: 'superseded' });
      const changesNeeded = await h.insert(10, { status: 'changes_needed' });
      await expect(h.service.ownPersonalCandidateStatus(ctx, approved)).resolves.toEqual({
        version: 1,
        id: approved,
        status: 'approved',
        terminal: true,
        decidedAt: '2026-10-18T12:01:00.000Z',
        committedMemoryId: null,
        committedMemoryItemId: ITEM,
      });
      await expect(h.service.ownPersonalCandidateStatus(ctx, pending)).resolves.toMatchObject({
        status: 'pending',
        terminal: false,
        decidedAt: null,
      });
      await expect(h.service.ownPersonalCandidateStatus(ctx, allowed)).resolves.toMatchObject({
        status: 'withdrawn',
        terminal: true,
      });
      for (const id of [rejected, committedInline, superseded]) {
        await expect(h.service.ownPersonalCandidateStatus(ctx, id)).resolves.toMatchObject({
          terminal: true,
        });
      }
      await expect(h.service.ownPersonalCandidateStatus(ctx, changesNeeded)).resolves.toMatchObject(
        {
          terminal: false,
        },
      );
      for (const id of [walled, foreign, mismatched, candidateId(99), 'not-a-uuid']) {
        await expect(h.service.ownPersonalCandidateStatus(ctx, id)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      }
    } finally {
      await h.db.close();
    }
  });

  it('rejects invalid page size and cursors bound to a different actor', async () => {
    const h = await harness();
    try {
      for (const limit of ['0', '101', '1e2', 'NaN']) {
        await expect(h.service.pageOwnPersonalPending(ctx, { limit })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      await h.insert(1);
      await h.insert(2);
      const page = await h.service.pageOwnPersonalPending(ctx, { limit: '1' });
      expect(page.nextCursor).toEqual(expect.any(String));
      await expect(
        h.service.pageOwnPersonalPending(
          { ...ctx, userId: OTHER },
          {
            cursor: page.nextCursor,
          },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        h.service.pageOwnPersonalPending(ctx, { cursor: 'junk' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      await h.db.close();
    }
  });

  it('controller delegates the versioned page and exact status routes', async () => {
    const page = jest.fn(async () => ({ version: 1, candidates: [], nextCursor: null }));
    const status = jest.fn(async () => ({
      version: 1,
      id: candidateId(1),
      status: 'pending',
      terminal: false,
      decidedAt: null,
      committedMemoryId: null,
      committedMemoryItemId: null,
    }));
    const controller = new MemoryController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        pageOwnPersonalPending: page,
        ownPersonalCandidateStatus: status,
      } as unknown as MemoryCandidateService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(controller.listOwnCandidates(ctx, '50', 'cursor')).resolves.toHaveProperty(
      'version',
      1,
    );
    await expect(controller.ownCandidateStatus(ctx, candidateId(1))).resolves.toHaveProperty(
      'terminal',
      false,
    );
    expect(page).toHaveBeenCalledWith(ctx, { limit: '50', cursor: 'cursor' });
    expect(status).toHaveBeenCalledWith(ctx, candidateId(1));
    expect(Reflect.getMetadata('path', MemoryController.prototype.listOwnCandidates)).toBe(
      'candidates/mine',
    );
    expect(Reflect.getMetadata('path', MemoryController.prototype.ownCandidateStatus)).toBe(
      'candidates/mine/:id/status',
    );
  });
});
