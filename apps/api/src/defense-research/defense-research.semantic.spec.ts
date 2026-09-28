import type { TenantContext } from '@capiro/shared';
import { DefenseResearchService } from './defense-research.service.js';
import { DefenseResearchController } from './defense-research.controller.js';
import { getDefaultEmbeddingProvider } from '../embeddings/embedding-provider.factory.js';
import { buildProgramElementText, sha256 } from '../embeddings/embedder.js';
jest.mock('../embeddings/embedding-provider.factory.js', () => {
  const port = {
    metadata: {
      provider: 'owned-test-port',
      model: 'amazon.titan-embed-text-v2:0',
      modelVersion: 'v2',
      dimensions: 1024,
    },
    embed: jest.fn(),
    embedBatch: jest.fn(),
  };
  return { getDefaultEmbeddingProvider: () => port };
});
const ctx = {
  tenantId: 'ed202609-2800-4000-8000-000000009700',
  userId: 'ed202609-2800-4000-8000-000000009710',
  role: 'standard_user',
} as TenantContext;
const at = new Date('2026-09-01T00:00:00Z');
const proof = () => ({
  id: 'source',
  peCode: '0600000A',
  docType: 'R',
  publisher: 'Owned synthetic source',
  confidence: 0.9,
  pageNumber: 3,
  pageEnd: 4,
  sourceUrl: 'https://example.invalid/owned-public.pdf',
  sourceDocumentId: 'archive',
  observedAt: at,
  sourceDocument: {
    id: 'archive',
    sha256: 'a'.repeat(64),
    sourceKey: 'owned-edition',
    ingestedAt: at,
    archiveBucket: 'owned-synthetic-receipt-bucket',
    archiveS3Key: 'owned-fixture/raw.pdf',
    archiveVersionId: 'owned-fixture-version',
    archivedAt: at,
    retainUntil: new Date('2100-01-01T00:00:00Z'),
    pageCount: 10,
    supersededByDocumentId: null,
  },
});
const pe = () => ({
  peCode: '0600000A',
  title: 'Owned synthetic PE',
  service: 'Army',
  description: 'A synthetic public mission for a bounded semantic acceptance fixture.',
  budgetActivityName: null,
  appropriationType: null,
  programOfRecord: null,
  retiredAt: null,
  sources: [proof()],
});
const hit = (row: any) => ({
  peCode: row.peCode,
  score: 0.8,
  contentText: buildProgramElementText(row),
  contentHash: sha256(buildProgramElementText(row)),
  model: 'amazon.titan-embed-text-v2:0',
  dimensions: 1024,
  tenantId: null,
  clientId: null,
  ownerUserId: null,
  sourceType: 'pe',
  metadata: {},
});
function fixture() {
  const data = { active: true, eligible: true, current: [pe()], hits: [hit(pe())] };
  const tx = {
    tenantMembership: {
      findFirst: jest.fn(async () => (data.active ? { id: 'membership' } : null)),
    },
    $queryRaw: jest.fn(async (query: { sql: string }) =>
      query.sql.includes('AS "indexId"')
        ? data.eligible
          ? [{ indexId: 'owned-index' }]
          : []
        : data.hits,
    ),
    programElement: { findMany: jest.fn(async () => data.current) },
  };
  const empty = () => ({ findMany: jest.fn().mockResolvedValue([]) });
  const prisma = {
    programElement: { findMany: jest.fn().mockResolvedValue([pe()]) },
    program: empty(),
    programElementProject: empty(),
    procurementLine: empty(),
    programOffice: empty(),
    acquisitionRecordRevision: empty(),
    defenseContextDocument: empty(),
    capability: empty(),
    withTenantUser: jest.fn(
      async (_tenant: string, _user: string, fn: (tx: any) => Promise<unknown>) => fn(tx),
    ),
  };
  return { data, tx, prisma, reader: new DefenseResearchService(prisma as never) };
}
const port = () =>
  getDefaultEmbeddingProvider() as unknown as {
    metadata: { provider: string; model: string; modelVersion: string; dimensions: number };
    embed: jest.Mock;
  };
describe('Source-cited opt-in public PE semantic suggestions', () => {
  beforeEach(() => {
    port().metadata.model = 'amazon.titan-embed-text-v2:0';
    port().metadata.modelVersion = 'v2';
    port().metadata.dimensions = 1024;
    port()
      .embed.mockReset()
      .mockResolvedValue(Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)));
  });
  afterEach(() => jest.useRealTimers());
  test('uses the actual existing query-vector port and public index, verifying current text hash plus source SHA/page', async () => {
    const f = fixture(),
      result = await f.reader.search('owned synthetic query', true, ctx);
    expect(result.semantic).toMatchObject({
      status: 'available',
      reason: expect.stringContaining('Partial public PE'),
      items: [
        {
          subject: { type: 'program_element', id: '0600000A' },
          matchKind: 'semantic',
          score: 0.8,
          availability: 'partial',
          evidence: [
            {
              contentHash: 'a'.repeat(64),
              sourceDocumentId: 'archive',
              nativeLocator: { page: 3 },
              availability: 'available',
            },
          ],
        },
      ],
    });
    expect(result.semantic.items[0]?.explanation.matchedFields).toContain(
      'currentNormalizedTextSha256:' + f.data.hits[0]?.contentHash,
    );
    expect(result.semantic.items[0]?.explanation.rationale).toContain(
      'does not establish relevance',
    );
    expect(result.semantic.items[0]?.explanation.rationale).toContain(
      'not attested as exact wording',
    );
    expect(port().embed).toHaveBeenCalledWith('owned synthetic query');
    expect(f.prisma.withTenantUser).toHaveBeenCalledWith(
      ctx.tenantId,
      ctx.userId,
      expect.any(Function),
      expect.any(Object),
    );
    expect(f.tx.tenantMembership.findFirst).toHaveBeenCalledTimes(4);
    const call = f.tx.$queryRaw.mock.calls.find((entry) => entry[0]?.sql.includes('<=>'));
    expect(call).toBeDefined();
    if (!call) throw new Error('Expected actual index port call');
    const sql = (call as unknown as [{ sql: string; values: unknown[] }])[0];
    expect(sql.sql).toMatch(
      /ce\.tenant_id IS NULL AND ce\.client_id IS NULL AND ce\.owner_user_id IS NULL/,
    );
    expect(sql.sql).toContain("ce.source_type='pe'");
    expect(sql.sql).toContain('pe.retired_at IS NULL');
    expect(sql.values).toContain('amazon.titan-embed-text-v2:0');
    expect(sql.values).toContain(100);
    expect(result.exact.items).toHaveLength(1);
  });
  test('default-disabled lane never reads index or invokes provider', async () => {
    const f = fixture();
    expect((await f.reader.search('owned query', false, ctx)).semantic.status).toBe('disabled');
    expect(port().embed).not.toHaveBeenCalled();
    expect(f.prisma.withTenantUser).not.toHaveBeenCalled();
  });
  test('controller supplies authenticated context and never derives it from model inputs', async () => {
    const search = jest.fn().mockResolvedValue({});
    await new DefenseResearchController({ search } as never).search(ctx, 'owned query', 'true');
    expect(search).toHaveBeenCalledWith('owned query', true, ctx);
  });
  test('an absent eligible index abstains before spending a provider call', async () => {
    const f = fixture();
    f.data.eligible = false;
    expect((await f.reader.search('owned query', true, ctx)).semantic).toMatchObject({
      status: 'abstained',
      reason: expect.stringContaining('provider was not invoked'),
    });
    expect(port().embed).not.toHaveBeenCalled();
    expect(f.tx.programElement.findMany).not.toHaveBeenCalled();
  });
  test('missing or revoked membership abstains before provider while preserving exact partial answers', async () => {
    const f = fixture();
    f.data.active = false;
    const missing = await f.reader.search('owned query', true);
    const revoked = await f.reader.search('owned query', true, ctx);
    expect(missing.semantic.status).toBe('abstained');
    expect(revoked.semantic).toMatchObject({
      status: 'abstained',
      reason: expect.stringContaining('membership'),
    });
    expect(revoked.exact.items).toHaveLength(1);
    expect(port().embed).not.toHaveBeenCalled();
    expect(f.tx.$queryRaw.mock.calls.every((entry) => !entry[0]?.sql.includes('<=>'))).toBe(true);
  });
  test('membership revocation during query embedding prevents index read', async () => {
    const f = fixture();
    port().embed.mockImplementation(async () => {
      f.data.active = false;
      return Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    });
    expect((await f.reader.search('owned query', true, ctx)).semantic.status).toBe('abstained');
    expect(f.tx.$queryRaw.mock.calls.every((entry) => !entry[0]?.sql.includes('<=>'))).toBe(true);
  });
  test('membership revocation during current source reads withholds final suggestions', async () => {
    const f = fixture();
    f.tx.programElement.findMany.mockImplementation(async () => {
      f.data.active = false;
      return f.data.current;
    });
    expect((await f.reader.search('owned query', true, ctx)).semantic).toMatchObject({
      status: 'abstained',
      items: [],
    });
  });
  test.each([
    { tenantId: ctx.tenantId },
    { clientId: 'private-client' },
    { ownerUserId: ctx.userId },
    { sourceType: 'memory_item' },
    { model: 'other-v2:0' },
    { dimensions: 512 },
    { score: null },
    { score: NaN },
    { score: Infinity },
    { score: 1.5 },
    { score: 0.34 },
    { contentHash: 'not-a-digest' },
    { contentText: 'stale text' },
    { contentHash: 'b'.repeat(64) },
    { metadata: { modelVersion: 'v3' } },
  ])('excludes private, mismatched and stale index rows %j', async (extra) => {
    const f = fixture();
    Object.assign(f.data.hits[0]!, extra);
    const result = await f.reader.search('owned query', true, ctx);
    expect(result.semantic).toMatchObject({ status: 'abstained', items: [] });
    expect(result.exact.items).toHaveLength(1);
  });
  test.each([
    { pageNumber: 0 },
    { pageNumber: -1 },
    { pageEnd: 2 },
    { pageNumber: 11 },
    { confidence: 0.79 },
    { confidence: 1.1 },
    { sourceDocumentId: null },
    { sourceUrl: '' },
    { sourceUrl: 'http://example.invalid/owned-public.pdf' },
    { sourceUrl: 'javascript:alert(1)' },
    { sourceUrl: 'file:///owned-public.pdf' },
    { sourceUrl: 'https:///owned-public.pdf' },
    { sourceUrl: 'https://user:password@example.invalid/owned-public.pdf' },
    { sourceUrl: 'https://example.invalid/owned\n-public.pdf' },
    { sourceUrl: 'https://example.invalid\\owned-public.pdf' },
    { sourceUrl: 'https://' },
    { observedAt: new Date('2100-01-01') },
    { sourceDocument: { ...proof().sourceDocument, sha256: 'bad' } },
    { sourceDocument: { ...proof().sourceDocument, id: 'wrong' } },
    { sourceDocument: { ...proof().sourceDocument, supersededByDocumentId: 'new' } },
    { sourceDocument: { ...proof().sourceDocument, ingestedAt: new Date('2100-01-01') } },
    { sourceDocument: { ...proof().sourceDocument, sourceKey: '' } },
    { sourceDocument: { ...proof().sourceDocument, archiveBucket: null } },
    { sourceDocument: { ...proof().sourceDocument, archiveS3Key: '' } },
    { sourceDocument: { ...proof().sourceDocument, archiveVersionId: null } },
    { sourceDocument: { ...proof().sourceDocument, archiveVersionId: 'null' } },
    { sourceDocument: { ...proof().sourceDocument, archivedAt: null } },
    { sourceDocument: { ...proof().sourceDocument, archivedAt: new Date('2100-01-01') } },
    { sourceDocument: { ...proof().sourceDocument, retainUntil: new Date('2020-01-01') } },
  ])(
    'withholds a source without current immutable archive and positive locator proof %j',
    async (extra) => {
      const f = fixture();
      Object.assign(f.data.current[0]!.sources[0]!, extra);
      expect((await f.reader.search('owned query', true, ctx)).semantic).toMatchObject({
        status: 'abstained',
        items: [],
      });
    },
  );
  test('preserves a valid HTTPS citation page fragment without claiming a host qualification', async () => {
    const f = fixture();
    const sourceUrl = 'https://example.invalid/owned-public.pdf#page=3';
    Object.assign(f.data.current[0]!.sources[0]!, { sourceUrl });
    const result = await f.reader.search('owned query', true, ctx);
    expect(result.semantic.items).toHaveLength(1);
    expect(result.semantic.items[0]?.evidence[0]?.sourceUrl).toBe(sourceUrl);
    expect(result.semantic.items[0]?.availability).toBe('partial');
  });
  test.each([{ retiredAt: at }, { description: '' }, { description: 'changed canonical mission' }])(
    'withholds retired, unavailable or changed canonical mission %j',
    async (extra) => {
      const f = fixture();
      Object.assign(f.data.current[0]!, extra);
      expect((await f.reader.search('owned query', true, ctx)).semantic).toMatchObject({
        status: 'abstained',
        items: [],
      });
    },
  );
  test.each(['provider', 'index', 'source'])(
    'preserves exact/capability partial responses on %s failure',
    async (kind) => {
      const f = fixture();
      f.prisma.capability.findMany.mockResolvedValue([
        {
          name: 'owned query',
          slug: 'owned-query',
          aliases: [],
          taxonomyPath: 'Owned/Defense',
          matches: [
            {
              peCode: '0600000A',
              confidence: 'high',
              matchedOn: 'owned query',
              status: 'accepted',
            },
          ],
        },
      ]);
      if (kind === 'provider') port().embed.mockRejectedValue(new Error('owned port failure'));
      if (kind === 'index') f.tx.$queryRaw.mockRejectedValue(new Error('owned index failure'));
      if (kind === 'source')
        f.tx.programElement.findMany.mockRejectedValue(new Error('owned proof failure'));
      const result = await f.reader.search('owned query', true, ctx);
      expect(result.semantic).toMatchObject({ status: 'abstained', items: [] });
      expect(result.exact.items).toHaveLength(1);
      expect(result.capability).toMatchObject({
        status: 'available',
        items: [{ matchKind: 'capability' }],
      });
    },
  );
  test.each([{ modelVersion: 'v3' }, { dimensions: 512 }, { model: 'unversioned-model' }])(
    'abstains on incompatible selected model/version/dimensions before provider %j',
    async (extra) => {
      const f = fixture();
      Object.assign(port().metadata, extra);
      expect((await f.reader.search('owned query', true, ctx)).semantic.status).toBe('abstained');
      expect(port().embed).not.toHaveBeenCalled();
    },
  );
  test.each([
    Array.from({ length: 512 }, () => 1),
    Array.from({ length: 1024 }, () => 0),
    Array.from({ length: 1024 }, () => NaN),
  ])('rejects malformed query vectors without index access', async (vector) => {
    const f = fixture();
    port().embed.mockResolvedValue(vector);
    expect((await f.reader.search('owned query', true, ctx)).semantic.status).toBe('abstained');
    expect(f.tx.$queryRaw.mock.calls.every((entry) => !entry[0]?.sql.includes('<=>'))).toBe(true);
  });
  test('bounds a hung query-vector port and leaves no response timer', async () => {
    jest.useFakeTimers();
    const f = fixture();
    port().embed.mockImplementation(() => new Promise(() => {}));
    const pending = f.reader.search('owned query', true, ctx);
    await jest.advanceTimersByTimeAsync(1600);
    const result = await pending;
    expect(result.semantic.status).toBe('abstained');
    expect(result.exact.items).toHaveLength(1);
    expect(f.tx.$queryRaw.mock.calls.every((entry) => !entry[0]?.sql.includes('<=>'))).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
  test('keeps ranking/deduplication deterministic and explicitly bounded', async () => {
    const f = fixture();
    f.data.current = Array.from({ length: 30 }, (_, i) => ({
      ...pe(),
      peCode: '060' + String(i).padStart(4, '0') + 'A',
      title: 'Owned PE ' + i,
      sources: [{ ...proof(), peCode: '060' + String(i).padStart(4, '0') + 'A' }],
    }));
    f.data.hits = f.data.current
      .flatMap((row) => [
        { ...hit(row), score: 0.9 },
        { ...hit(row), score: 0.7 },
      ])
      .reverse();
    const result = await f.reader.search('owned query', true, ctx);
    expect(result.semantic.items).toHaveLength(25);
    expect(new Set(result.semantic.items.map((row) => row.subject.id)).size).toBe(25);
    expect(
      result.semantic.items.every((row) => row.score === 0.9 && row.availability === 'partial'),
    ).toBe(true);
    expect(result.semantic.reason).toContain('100 candidates');
  });
});
