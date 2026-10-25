import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { TenantGuard } from '../auth/tenant.guard.js';
import { HillDayContextService } from './hillday-context.service.js';
import { HillDayController } from './hillday.controller.js';
import { HillDayDocumentService, encodeCursor } from './hillday-document.service.js';
import { HillDayExportService } from './hillday-export.service.js';
import { HillDayGenerationService } from './hillday-generation.service.js';
import { HillDayResolutionService } from './hillday-resolution.service.js';

/**
 * WS-06 library query. The double below evaluates the exact operators the
 * service emits (equality, `in`, `lt`, `not`, `contains`, `AND`, `OR`) with the
 * same `(updatedAt desc, id desc)` ordering the real queries use, and throws on
 * anything else — a silently-passing fake would prove nothing.
 */
type Row = Record<string, unknown> & { id: string; updatedAt: Date };

function matches(row: Row, where: unknown): boolean {
  if (!where || typeof where !== 'object') return true;
  return Object.entries(where as Record<string, unknown>).every(([key, cond]) => {
    if (key === 'AND') return (cond as unknown[]).every((c) => matches(row, c));
    if (key === 'OR') return (cond as unknown[]).some((c) => matches(row, c));
    const value = row[key];
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (cond && typeof cond === 'object') {
      const c = cond as Record<string, unknown>;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('lt' in c) {
        const bound = c.lt;
        return value instanceof Date && bound instanceof Date
          ? value.getTime() < bound.getTime()
          : String(value) < String(bound);
      }
      if ('not' in c) return value !== c.not;
      if ('contains' in c)
        return String(value ?? '')
          .toLowerCase()
          .includes(String(c.contains).toLowerCase());
      throw new Error(`unsupported where condition: ${JSON.stringify(c)}`);
    }
    return value === cond;
  });
}

function select(rows: Row[], args: { where?: unknown; take?: number }): Row[] {
  const sorted = rows
    .filter((row) => matches(row, args.where))
    .sort((a, b) =>
      a.updatedAt.getTime() === b.updatedAt.getTime()
        ? a.id < b.id
          ? 1
          : a.id > b.id
            ? -1
            : 0
        : a.updatedAt.getTime() < b.updatedAt.getTime()
          ? 1
          : -1,
    );
  return args.take ? sorted.slice(0, args.take) : sorted;
}

const TENANT = 'tenant';
const ACTOR = 'actor';
const CLIENT = '11111111-1111-4111-8111-111111111111';

function draftRow(id: string, docTitle: string, iso: string, over: Partial<Row> = {}): Row {
  return {
    id,
    docTitle,
    product: null,
    client: null,
    clientId: null,
    status: 'draft',
    ownerId: ACTOR,
    prospectId: null,
    tenantId: TENANT,
    updatedAt: new Date(iso),
    ...over,
  };
}

function hillRow(id: string, name: string, iso: string, over: Partial<Row> = {}): Row {
  return {
    id,
    name,
    clientId: CLIENT,
    clientName: 'Kela Systems',
    status: 'generated',
    ownerId: ACTOR,
    tenantId: TENANT,
    updatedAt: new Date(iso),
    ...over,
  };
}

function harness(options: {
  hill?: Row[];
  drafts?: Row[];
  shared?: string[];
  deniedDrafts?: string[];
  wallAllowed?: boolean;
  clients?: Map<string, { name: string; wallAllowed: boolean }>;
}) {
  const hill = options.hill ?? [];
  const drafts = options.drafts ?? [];
  const denied = new Set(options.deniedDrafts ?? []);
  const calls = { hill: [] as any[], drafts: [] as any[] };
  const prisma = {
    wsHillDayDocument: {
      findMany: jest.fn(async (args: any) => {
        calls.hill.push(args);
        return select(hill, args);
      }),
      findFirst: jest.fn(async (args: any) => select(hill, { where: args.where })[0] ?? null),
    },
    wsCollaborator: {
      findMany: jest.fn(async () => (options.shared ?? []).map((draftId) => ({ draftId }))),
    },
    wsDraft: {
      findMany: jest.fn(async (args: any) => {
        calls.drafts.push(args);
        return select(drafts, args);
      }),
      findFirst: jest.fn(async (args: any) => select(drafts, { where: args.where })[0] ?? null),
    },
  };
  const source = {
    resolveUserId: jest.fn(async () => 'core-actor'),
    getClient: jest.fn(
      async (_tenantId: string, _userId: string, clientId: string) =>
        options.clients?.get(clientId) ?? {
          name: 'Kela Systems',
          wallAllowed: options.wallAllowed ?? true,
        },
    ),
    requireClient: jest.fn(async (_tenantId: string, _actorId: string, clientId: string) => {
      const client = options.clients?.get(clientId) ?? {
        name: 'Kela Systems',
        wallAllowed: options.wallAllowed ?? true,
      };
      if (!client.wallAllowed) throw new NotFoundException('Client not found');
      return client;
    }),
    userDisplays: jest.fn(async () => new Map()),
  };
  const collaborators = {
    sourceAccess: jest.fn(async (_tenantId: string, draftId: string) => !denied.has(draftId)),
  };
  const service = new HillDayDocumentService(
    prisma as never,
    source as never,
    {} as never,
    collaborators as never,
  );
  return { service, prisma, source, collaborators, calls };
}

describe('Workspace library query filters', () => {
  it('searches the whole library in SQL, so a hit on the third unfiltered page is found on page one', async () => {
    // Seven rows newest → oldest; the match is the 6th, i.e. page 3 at limit 2.
    const rows = [
      draftRow('d1', 'Budget memo', '2026-09-14T12:00:00Z'),
      draftRow('d2', 'Appropriations memo', '2026-09-14T11:00:00Z'),
      draftRow('d3', 'Committee brief', '2026-09-14T10:00:00Z'),
      draftRow('d4', 'Staffer brief', '2026-09-14T09:00:00Z'),
      draftRow('d5', 'Travel memo', '2026-09-14T08:00:00Z'),
      draftRow('d6', 'Zebra transition brief', '2026-09-14T07:00:00Z'),
      draftRow('d7', 'Annual report', '2026-09-14T06:00:00Z'),
    ];
    const { service, calls } = harness({ drafts: rows });

    const page1 = await service.listDocuments(TENANT, ACTOR, { limit: '2' });
    const page2 = await service.listDocuments(TENANT, ACTOR, {
      cursor: page1.nextCursor!,
      limit: '2',
    });
    const page3 = await service.listDocuments(TENANT, ACTOR, {
      cursor: page2.nextCursor!,
      limit: '2',
    });
    expect(page3.items.map((row) => row.id)).toEqual(['d5', 'd6']);

    const found = await service.listDocuments(TENANT, ACTOR, { q: 'zebra', limit: '2' });
    expect(found.items.map((row) => row.id)).toEqual(['d6']);
    expect(calls.drafts.at(-1)?.where).toMatchObject({
      tenantId: TENANT,
      docTitle: { contains: 'zebra', mode: 'insensitive' },
    });
  });

  it('searches Hill Day packets by name too, case-insensitively', async () => {
    const { service, calls } = harness({
      hill: [
        hillRow(
          '11111111-1111-4111-8111-111111111111',
          'Zebra week schedule',
          '2026-09-14T10:00:00Z',
        ),
        hillRow(
          '22222222-2222-4222-8222-222222222222',
          'Other week schedule',
          '2026-09-14T09:00:00Z',
        ),
      ],
    });
    const page = await service.listDocuments(TENANT, ACTOR, { q: 'ZEBRA' });
    expect(page.items.map((row) => row.id)).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(calls.hill.at(-1)?.where).toMatchObject({
      name: { contains: 'ZEBRA', mode: 'insensitive' },
    });
  });

  it('returns duplicate names in a stable order and pages over both', async () => {
    const { service } = harness({
      drafts: [
        draftRow('newer', 'Q3 Brief', '2026-09-14T10:00:00Z'),
        draftRow('older', 'Q3 Brief', '2026-09-14T09:00:00Z'),
      ],
    });
    const first = await service.listDocuments(TENANT, ACTOR, { q: 'q3 brief', limit: '1' });
    expect(first.items.map((row) => row.id)).toEqual(['newer']);
    const second = await service.listDocuments(TENANT, ACTOR, {
      q: 'q3 brief',
      limit: '1',
      cursor: first.nextCursor!,
    });
    expect(second.items.map((row) => row.id)).toEqual(['older']);
    expect(second.nextCursor).toBeNull();
  });

  it('returns an empty authorized page with a usable nextCursor and continues past denied rows', async () => {
    const { service } = harness({
      drafts: [
        draftRow('denied-1', 'One', '2026-09-14T12:00:00Z'),
        draftRow('denied-2', 'Two', '2026-09-14T11:00:00Z'),
        draftRow('visible-3', 'Three', '2026-09-14T10:00:00Z'),
      ],
      deniedDrafts: ['denied-1', 'denied-2'],
    });
    const first = await service.listDocuments(TENANT, ACTOR, { limit: '2' });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();

    const second = await service.listDocuments(TENANT, ACTOR, {
      limit: '2',
      cursor: first.nextCursor!,
    });
    expect(second.items.map((row) => row.id)).toEqual(['visible-3']);
    expect(second.nextCursor).toBeNull();
  });

  it('keeps mixed-kind rows with identical timestamps in one deterministic order across pages', async () => {
    const at = '2026-09-14T10:00:00Z';
    const { service } = harness({
      hill: [hillRow('11111111-1111-4111-8111-111111111111', 'Hill Day packet', at)],
      drafts: [draftRow('22222222-2222-4222-8222-222222222222', 'Draft doc', at)],
    });
    const first = await service.listDocuments(TENANT, ACTOR, { limit: '1' });
    expect(first.items.map((row) => [row.kind, row.id])).toEqual([
      ['draft', '22222222-2222-4222-8222-222222222222'],
    ]);
    const second = await service.listDocuments(TENANT, ACTOR, {
      limit: '1',
      cursor: first.nextCursor!,
    });
    expect(second.items.map((row) => [row.kind, row.id])).toEqual([
      ['hillday', '11111111-1111-4111-8111-111111111111'],
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('restarts at page one when a cursor is replayed under different filters', async () => {
    const { service, calls } = harness({
      drafts: [
        draftRow('mine-new', 'Mine newest', '2026-09-14T12:00:00Z'),
        draftRow('mine-old', 'Mine older', '2026-09-14T11:00:00Z'),
        draftRow('shared-new', 'Shared newest', '2026-09-14T10:00:00Z', { ownerId: 'other' }),
        draftRow('shared-old', 'Shared older', '2026-09-14T09:00:00Z', { ownerId: 'other' }),
      ],
      shared: ['shared-new', 'shared-old'],
    });
    const mine = await service.listDocuments(TENANT, ACTOR, { scope: 'mine', limit: '1' });
    expect(mine.items.map((row) => row.id)).toEqual(['mine-new']);

    // The same token under `scope=shared` must not skip the newer shared row.
    const replayed = await service.listDocuments(TENANT, ACTOR, {
      scope: 'shared',
      limit: '1',
      cursor: mine.nextCursor!,
    });
    expect(replayed.items.map((row) => row.id)).toEqual(['shared-new']);
    expect(calls.drafts.at(-1)?.where.OR).toBeUndefined();

    // Under its own filters the same token still continues.
    const continued = await service.listDocuments(TENANT, ACTOR, {
      scope: 'mine',
      limit: '1',
      cursor: mine.nextCursor!,
    });
    expect(continued.items.map((row) => row.id)).toEqual(['mine-old']);
    expect(calls.drafts.at(-1)?.where.OR).toBeDefined();
  });

  it('seals the page token, so a page that skips denied rows discloses nothing', async () => {
    const deniedAt = '2026-09-14T12:00:00Z';
    const secondDeniedAt = '2026-09-14T11:00:00Z';
    const { service } = harness({
      drafts: [
        draftRow('denied-newest', 'Hidden newest', deniedAt),
        draftRow('denied-second', 'Hidden second', secondDeniedAt),
        draftRow('visible-oldest', 'Visible oldest', '2026-09-14T10:00:00Z'),
      ],
      deniedDrafts: ['denied-newest', 'denied-second'],
    });
    const first = await service.listDocuments(TENANT, ACTOR, { limit: '2' });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toEqual(expect.any(String));

    // The empty page still continues to the next authorized row...
    const token = first.nextCursor!;
    const second = await service.listDocuments(TENANT, ACTOR, { limit: '2', cursor: token });
    expect(second.items.map((row) => row.id)).toEqual(['visible-oldest']);
    expect(second.nextCursor).toBeNull();

    // ...while the rows it skipped stay private: neither the token nor its
    // decoded bytes carry their ids or update timestamps.
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    for (const value of [
      'denied-newest',
      'denied-second',
      new Date(deniedAt).toISOString(),
      new Date(secondDeniedAt).toISOString(),
    ]) {
      expect(token).not.toContain(value);
      expect(decoded).not.toContain(value);
    }
  });

  it('binds a sealed token to the caller that was issued it', async () => {
    const { service, calls } = harness({
      drafts: [
        draftRow('newest', 'Newest', '2026-09-14T12:00:00Z'),
        draftRow('older', 'Older', '2026-09-14T11:00:00Z'),
      ],
    });
    const mine = await service.listDocuments(TENANT, ACTOR, { limit: '1' });
    await service.listDocuments(TENANT, ACTOR, { limit: '1', cursor: mine.nextCursor! });
    expect(calls.drafts.at(-1)?.where.OR).toBeDefined();

    await service.listDocuments(TENANT, 'other-actor', { limit: '1', cursor: mine.nextCursor! });
    expect(calls.drafts.at(-1)?.where.OR).toBeUndefined();
  });

  it('ignores tampered, unsealed, malformed and incomplete cursors instead of failing or skipping rows', async () => {
    const { service, calls } = harness({
      drafts: [
        draftRow('newest', 'Newest', '2026-09-14T12:00:00Z'),
        draftRow('older', 'Older', '2026-09-14T11:00:00Z'),
      ],
    });
    const issued = (await service.listDocuments(TENANT, ACTOR, { limit: '1' })).nextCursor!;
    const tampered = `${issued.slice(0, 5)}${issued[5] === 'A' ? 'B' : 'A'}${issued.slice(6)}`;
    for (const cursor of [
      'not-base64!!',
      tampered,
      // The pre-correction readable format is not accepted either.
      encodeCursor({ u: 'not-a-date', i: 'newest' }),
      encodeCursor({ u: '2026-09-14T12:00:00.000Z' }),
      encodeCursor({ u: '2026-09-14T12:00:00.000Z', i: 'newest', f: 'stale' }),
    ]) {
      const page = await service.listDocuments(TENANT, ACTOR, { cursor, limit: '1' });
      expect(page.items.map((row) => row.id)).toEqual(['newest']);
      expect(calls.drafts.at(-1)?.where.OR).toBeUndefined();
    }
  });

  it('narrows by ownership scope and kind without widening the visible set', async () => {
    const { service, calls } = harness({
      hill: [
        hillRow('11111111-1111-4111-8111-111111111111', 'Hill Day packet', '2026-09-14T10:00:00Z'),
      ],
      drafts: [draftRow('owned', 'Owned', '2026-09-14T09:00:00Z')],
      shared: ['shared-draft'],
    });

    await service.listDocuments(TENANT, ACTOR, { scope: 'mine' });
    expect(calls.drafts.at(-1)?.where.AND).toEqual([{ ownerId: ACTOR }]);

    await service.listDocuments(TENANT, ACTOR, { scope: 'shared' });
    expect(calls.drafts.at(-1)?.where.AND).toEqual([
      { ownerId: { not: ACTOR }, id: { in: ['shared-draft'] } },
    ]);
    // Hill Day packets are owner-private: a shared scope can never match one.
    expect(calls.hill.at(-1)?.where).toMatchObject({ ownerId: ACTOR, tenantId: TENANT });
    const sharedPage = await service.listDocuments(TENANT, ACTOR, {
      scope: 'shared',
      kind: 'draft',
    });
    expect(sharedPage.items).toEqual([]);

    const draftsOnly = await service.listDocuments(TENANT, ACTOR, { kind: 'draft' });
    expect(draftsOnly.items.map((row) => row.id)).toEqual(['owned']);

    await service.listDocuments(TENANT, ACTOR, { kind: 'all' });
    expect(calls.drafts.at(-1)?.where.AND).toEqual([
      { OR: [{ ownerId: ACTOR }, { id: { in: ['shared-draft'] } }] },
    ]);
  });

  it('keeps prospect exclusion, tenant scope and the client wall on filtered reads', async () => {
    const { service } = harness({
      drafts: [
        draftRow('legacy', 'Same name', '2026-09-14T10:00:00Z', {
          clientId: CLIENT,
          client: 'Kela Systems',
        }),
        draftRow('prospect', 'Same name', '2026-09-14T09:30:00Z', {
          clientId: CLIENT,
          client: 'Kela Systems',
          prospectId: '33333333-3333-4333-8333-333333333333',
        }),
        draftRow('foreign', 'Same name', '2026-09-14T09:00:00Z', { tenantId: 'other-tenant' }),
      ],
    });
    const page = await service.listDocuments(TENANT, ACTOR, { q: 'same name', clientId: CLIENT });
    expect(page.items.map((row) => row.id)).toEqual(['legacy']);

    await expect(
      service.listDocuments(TENANT, ACTOR, { clientId: 'not-a-uuid' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a client the actor cannot reach', async () => {
    const { service } = harness({
      clients: new Map([[CLIENT, { name: 'Walled client', wallAllowed: false }]]),
    });
    await expect(service.listDocuments(TENANT, ACTOR, { clientId: CLIENT })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('Workspace library query HTTP boundary', () => {
  let app: INestApplication;
  const ctx = { tenantId: TENANT, clerkUserId: ACTOR };
  const documents = { listDocuments: jest.fn(async () => ({ items: [], nextCursor: null })) };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HillDayController],
      providers: [
        { provide: HillDayDocumentService, useValue: documents },
        { provide: HillDayResolutionService, useValue: {} },
        { provide: HillDayContextService, useValue: {} },
        { provide: HillDayGenerationService, useValue: {} },
        { provide: HillDayExportService, useValue: {} },
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue({
        canActivate: (execution: {
          switchToHttp(): { getRequest(): { headers: Record<string, string> } };
        }) => execution.switchToHttp().getRequest().headers['x-library-test-auth'] === 'yes',
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('workspace-api');
    app.use((req: { tenantContext?: typeof ctx }, _res: unknown, next: () => void) => {
      req.tenantContext = ctx;
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => jest.clearAllMocks());

  it('requires the tenant guard', async () => {
    await request(app.getHttpServer()).get('/workspace-api/hillday/documents').expect(403);
    expect(documents.listDocuments).not.toHaveBeenCalled();
  });

  it('rejects malformed filter values and unknown parameters before the query runs', async () => {
    for (const query of [
      'kind=bogus',
      'scope=bogus',
      `q=${'a'.repeat(201)}`,
      'nope=1',
      'status=' + 'a'.repeat(31),
    ]) {
      await request(app.getHttpServer())
        .get(`/workspace-api/hillday/documents?${query}`)
        .set('x-library-test-auth', 'yes')
        .expect(400);
    }
    expect(documents.listDocuments).not.toHaveBeenCalled();
  });

  it('carries only the validated filters, keeping limit and cursor strings', async () => {
    await request(app.getHttpServer())
      .get(
        `/workspace-api/hillday/documents?clientId=${CLIENT}&status=draft&kind=draft&scope=mine&q=Brief&cursor=abc&limit=500`,
      )
      .set('x-library-test-auth', 'yes')
      .expect(200);
    expect(documents.listDocuments).toHaveBeenCalledWith(TENANT, ACTOR, {
      clientId: CLIENT,
      status: 'draft',
      kind: 'draft',
      scope: 'mine',
      q: 'Brief',
      cursor: 'abc',
      limit: '500',
    });
  });
});
