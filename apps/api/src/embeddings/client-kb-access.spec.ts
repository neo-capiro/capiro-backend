import { ClientKbService } from './client-kb.service.js';
import { embedAndUpsert } from './embedder.js';
import { ownMailMessageWhere, ownMeetingWhere } from '../engagement/engagement-access.helpers.js';

jest.mock('./embedder.js', () => ({
  EMBEDDING_MODEL: 'test-model', embedText: jest.fn().mockResolvedValue([0]),
  vectorLiteral: () => '[0]', normalize: (text: string) => text,
  embedAndUpsert: jest.fn().mockResolvedValue(undefined),
}));

const TENANT = 'tenant';
const CLIENT = 'client';
const OWNER = 'owner';
const COLLEAGUE = 'colleague';

function document(id: string, overrides: Record<string, unknown> = {}) {
  return { id, clientId: CLIENT, tenantId: TENANT, prospectId: null, fileName: `${id}.txt`,
    contentType: 'text/plain', lifecycleStatus: 'ready', scanStatus: 'clean',
    viewerMode: 'all', viewerUserIds: [] as string[], uploadedByUserId: OWNER,
    supersededByAttachmentId: null, meetingId: null, mailMessageId: null,
    s3Key: `${TENANT}/${id}`, createdAt: new Date(), ...overrides };
}

function fixture() {
  const rows = [document('public'), document('private', { viewerMode: 'restricted', viewerUserIds: [OWNER] }),
    document('pending', { lifecycleStatus: 'quarantined', scanStatus: 'pending' }),
    document('threat', { scanStatus: 'threat' }),
    document('unscanned', { scanStatus: null }),
    document('superseded', { supersededByAttachmentId: 'replacement' })];
  let wallAllowed = true;
  let scanRequired = true;
  const findMany = jest.fn(async ({ where, take }) => {
    const viewer = where.AND[0].OR[2].uploadedByUserId;
    expect(where).toEqual({ tenantId: TENANT, clientId: CLIENT, prospectId: null, supersededByAttachmentId: null,
      ...(take === undefined ? {} : {
        lifecycleStatus: { in: ['ready', 'legacy_ready'] },
        ...(scanRequired ? { scanStatus: 'clean' }
          : { OR: [{ scanStatus: null }, { scanStatus: { not: 'threat' } }] }),
      }),
      AND: [
        { OR: [{ viewerMode: 'all' }, { viewerMode: 'restricted', viewerUserIds: { has: viewer } }, { uploadedByUserId: viewer }] },
        { OR: [{ meetingId: null }, { meeting: ownMeetingWhere(viewer) }] },
        { OR: [{ mailMessageId: null }, { mailMessage: ownMailMessageWhere(viewer) }] },
      ] });
    const visible = rows.filter(row => !row.supersededByAttachmentId
      && (row.viewerMode === 'all' || row.uploadedByUserId === viewer || row.viewerUserIds.includes(viewer))
      && (!where.lifecycleStatus || where.lifecycleStatus.in.includes(row.lifecycleStatus))
      && (!where.scanStatus || row.scanStatus === where.scanStatus)
      && (!where.OR || row.scanStatus !== 'threat'));
    return take === undefined ? visible : visible.slice(0, take);
  });
  const query = jest.fn(async (sql: string, ...parameters: unknown[]) => {
    if (sql.includes('AS allowed')) return [{ allowed: wallAllowed }];
    expect(sql).toContain("source_type <> 'client_doc_chunk' OR split_part(source_id, ':', 1) = ANY($5::text[])");
    const allowed = parameters[4] as string[];
    // The index includes OLD content for every fixture, including now-private,
    // blocked and superseded documents. Only authorized IDs may reach SQL.
    return rows.filter(row => allowed.includes(row.id)).map(row => ({
      source_type: 'client_doc_chunk', source_id: `${row.id}:0`,
      content_text: `${row.id} confidential body`, score: 0.9,
    }));
  });
  const execute = jest.fn().mockResolvedValue(1);
  const update = jest.fn().mockResolvedValue({});
  const tx = { $queryRawUnsafe: query, $executeRawUnsafe: execute,
    engagementAttachment: { findMany, findFirst: jest.fn().mockResolvedValue(rows[0]), update },
    client: { findFirst: jest.fn().mockResolvedValue({ id: CLIENT, name: 'Client' }) },
    clientPerson: { findMany: jest.fn().mockResolvedValue([]) },
    clientFacility: { findMany: jest.fn().mockResolvedValue([]) } };
  const service = Object.create(ClientKbService.prototype) as ClientKbService;
  const extract = jest.fn().mockResolvedValue({ text: 'Document body', truncated: false });
  Object.assign(service, { prisma: { withTenant: jest.fn(async (_tenant, fn) => fn(tx)) },
    config: { get: jest.fn(key => key === 'CLIO_CLIENT_KB_ENABLED' ? true : scanRequired) },
    extractAttachmentTextForKb: extract,
    countClientChunks: jest.fn().mockResolvedValue(0), clientName: jest.fn().mockResolvedValue('Client') });
  return { service, rows, tx, query, findMany, execute, extract,
    denyWall: () => { wallAllowed = false; }, optionalScan: () => { scanRequired = false; } };
}

describe('client KB document authorization and readiness', () => {
  beforeEach(() => jest.clearAllMocks());

  it('filters an old private embedding for a colleague but permits its owner', async () => {
    const f = fixture();
    const owner = await f.service.search(TENANT, { clientId: CLIENT, userId: OWNER, query: 'notes' });
    expect(owner.map(row => row.id)).toEqual(['public:0', 'private:0']);
    const colleague = await f.service.search(TENANT, { clientId: CLIENT, userId: COLLEAGUE, query: 'notes' });
    expect(colleague.map(row => row.id)).toEqual(['public:0']);
    expect(f.query.mock.calls.at(-1)?.[5]).toEqual(['public']);
  });

  it('does not return previously indexed pending, threat, unscanned or superseded content', async () => {
    const f = fixture();
    const result = await f.service.search(TENANT, { clientId: CLIENT, userId: OWNER, query: 'all evidence' });
    expect(result.map(row => row.id)).toEqual(['public:0', 'private:0']);
    f.rows[0]!.scanStatus = 'threat';
    const afterRevocation = await f.service.search(TENANT, { clientId: CLIENT, userId: OWNER, query: 'all evidence' });
    expect(afterRevocation.map(row => row.id)).toEqual(['private:0']);
  });

  it('keeps optional scanning policy but never admits a known threat or quarantine', async () => {
    const f = fixture(); f.optionalScan();
    const result = await f.service.search(TENANT, { clientId: CLIENT, userId: OWNER, query: 'notes' });
    expect(result.map(row => row.id)).toEqual(['public:0', 'private:0', 'unscanned:0']);
  });

  it('fails closed for a walled client or a missing document reader identity', async () => {
    const f = fixture();
    expect(await f.service.search(TENANT, { clientId: CLIENT, query: 'notes' })).toEqual([]);
    expect(f.findMany).not.toHaveBeenCalled();
    f.denyWall(); f.query.mockClear();
    expect(await f.service.search(TENANT, { clientId: CLIENT, userId: OWNER, query: 'notes' })).toEqual([]);
    expect(f.query).toHaveBeenCalledTimes(1);
  });

  it.each(['private', 'pending', 'threat', 'unscanned', 'superseded'])(
    'purges stale %s chunks without reading bytes or calling the embedding provider', async id => {
      const f = fixture();
      f.tx.engagementAttachment.findFirst.mockResolvedValue(f.rows.find(row => row.id === id)!);
      await f.service.indexAttachment(TENANT, id);
      expect(f.extract).not.toHaveBeenCalled();
      expect(embedAndUpsert).not.toHaveBeenCalled();
      expect(f.execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM context_embeddings'),
        TENANT, 'client_doc_chunk', id, `${id}:%`);
    },
  );

  it('omits private and blocked filenames from another user’s always-on snapshot', async () => {
    const f = fixture();
    const snapshot = await f.service.buildSnapshot(TENANT, CLIENT, COLLEAGUE);
    expect(snapshot).toContain('public.txt');
    expect(snapshot).not.toMatch(/private\.txt|pending\.txt|threat\.txt|unscanned\.txt|superseded\.txt/);
    f.denyWall();
    expect(await f.service.buildSnapshot(TENANT, CLIENT, OWNER)).toBeNull();
  });

  it.each([true, false])('bounds snapshot reads before materializing documents when scanning is required=%s', async scanRequired => {
    const f = fixture();
    if (!scanRequired) f.optionalScan();
    f.rows.splice(0, f.rows.length,
      ...Array.from({ length: 6 }, (_, index) => document(`new-pending-${index}`, { lifecycleStatus: 'quarantined', scanStatus: 'pending' })),
      document('new-threat', { scanStatus: 'threat' }),
      ...Array.from({ length: 6 }, (_, index) => document(`readable-${index}`, {
        lifecycleStatus: index === 0 ? 'legacy_ready' : 'ready',
        scanStatus: scanRequired ? 'clean' : null,
      })),
    );
    const snapshot = await f.service.buildSnapshot(TENANT, CLIENT, COLLEAGUE);
    expect(f.findMany).toHaveBeenCalledTimes(1);
    expect(f.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5 }));
    for (let index = 0; index < 5; index += 1) expect(snapshot).toContain(`readable-${index}.txt`);
    expect(snapshot).not.toMatch(/new-pending|new-threat|readable-5/);
    // Semantic search still authorizes the entire current document set.
    f.findMany.mockClear();
    await f.service.search(TENANT, { clientId: CLIENT, userId: COLLEAGUE, query: 'notes' });
    expect(f.findMany.mock.calls[0]?.[0]).not.toHaveProperty('take');
  });
});
