import { NotFoundException } from '@nestjs/common';
import { EditorialService } from '../src/tracker/editorial/editorial.service.js';
import { phase8Scope } from '../src/tracker/editorial/evidence.service.js';

const ctx = { tenantId: 'tenant', clerkUserId: 'actor', role: null };
describe('editorial history access and continuation', () => {
  const beforeFetch = global.fetch,
    beforeBase = process.env.WORKSPACE_BASE_URL,
    beforeSecret = process.env.INTERNAL_SERVICE_SECRET;
  afterEach(() => {
    global.fetch = beforeFetch;
    if (beforeBase === undefined) delete process.env.WORKSPACE_BASE_URL;
    else process.env.WORKSPACE_BASE_URL = beforeBase;
    if (beforeSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = beforeSecret;
  });
  it('filters original source walls before metadata, advances across hidden rows, and requests actor-scoped draft links', async () => {
    const query = jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      if (sql.includes('SELECT s.id'))
        return [
          {
            id: 'new',
            selectionId: 'new',
            createdAt: new Date('2026-09-14T10:00:00Z'),
            cursorAt: '2026-09-14 10:00:00.000123+00',
            title: 'Private title',
          },
          { id: 'old', selectionId: 'old', createdAt: new Date('2026-09-13T10:00:00Z') },
        ];
      if (sql.includes('SELECT payload'))
        return [
          { payload: { scope: { folderId: values.at(-1) === 'new' ? 'revoked' : 'folder' } } },
        ];
      throw Error('Unexpected query');
    });
    const evidence = {
      run: jest.fn(async (actor, b, _feature, fn) => fn({ $queryRaw: query }, b, phase8Scope(b))),
      context: jest.fn(async (_tx, actor, scope) => {
        if (scope.folderId === 'revoked') throw new NotFoundException();
      }),
    };
    const service = new EditorialService(evidence as never, {} as never, {} as never);
    const page = await service.history(ctx, { folderId: 'folder', limit: 1 });
    expect(page.items).toEqual([]);
    expect(JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString())).toEqual({
      at: '2026-09-14 10:00:00.000123+00',
      id: 'new',
    });
    expect(JSON.stringify(page)).not.toContain('Private title');
    const call = query.mock.calls[0]!;
    expect(call[0].join('?')).toMatch(/s.tenant_id=\? AND s.owner_clerk_id=\?/);
    expect(call.slice(1, 3)).toEqual(['tenant', 'actor']);
    await service.history(ctx, { folderId: 'folder', cursor: page.nextCursor });
    expect(
      query.mock.calls.some((call) => call.some((v) => v === '2026-09-14 10:00:00.000123+00')),
    ).toBe(true);
  });
  it('does not resolve links or expose a configuration absent from the current owner', async () => {
    const query = jest.fn(async () => []);
    const evidence = {
      run: async (_ctx, b, _feature, fn) => fn({ $queryRaw: query }, b, phase8Scope(b)),
    };
    const service = new EditorialService(evidence as never, {} as never, {} as never);
    global.fetch = jest.fn();
    await expect(service.history(ctx, {}, 'foreign-config')).rejects.toThrow(
      'CONFIGURATION_NOT_FOUND',
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(query.mock.calls[0]?.slice(1)).toEqual(['tenant', 'actor', 'foreign-config']);
  });
  it('distinguishes a Workspace outage from no editions and ignores unrequested draft identities', async () => {
    process.env.WORKSPACE_BASE_URL = 'https://workspace.invalid';
    process.env.INTERNAL_SERVICE_SECRET = 'test';
    const query = jest.fn(async (parts: TemplateStringsArray) =>
      parts.join('?').includes('SELECT s.id')
        ? [
            {
              id: 'edition',
              selectionId: 'edition',
              createdAt: new Date('2026-09-14'),
              title: 'Saved edition',
            },
          ]
        : [{ payload: { title: 'Saved edition', scope: { folderId: 'folder' } } }],
    );
    const evidence = {
      run: async (_ctx, b, _feature, fn) => fn({ $queryRaw: query }, b, phase8Scope(b)),
      context: async () => undefined,
    };
    const service = new EditorialService(evidence as never, {} as never, {} as never);
    global.fetch = jest.fn(async () => ({ ok: false }) as Response);
    const outage = await service.history(ctx, { folderId: 'folder' });
    expect(outage.draftLookupState).toBe('unavailable');
    expect(outage.items[0]).toMatchObject({ title: 'Saved edition', draft: null });
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            drafts: [
              {
                selectionId: 'other',
                draftId: '11111111-1111-1111-1111-111111111111',
                title: 'Unrequested',
              },
            ],
          }),
        }) as Response,
    );
    const available = await service.history(ctx, { folderId: 'folder' });
    expect(available.items[0]?.draft).toBeNull();
    expect(JSON.parse(String((global.fetch as jest.Mock).mock.calls[0]?.[1].body))).toEqual({
      tenantId: 'tenant',
      ownerId: 'actor',
      selectionIds: ['edition'],
    });
  });
});
