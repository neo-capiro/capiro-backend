import { ClientKbService } from './client-kb.service.js';

jest.mock('./embedding-provider.factory.js', () => ({
  getDefaultEmbeddingProvider: () => ({
    metadata: { provider: 'test', model: 'test-model', modelVersion: '1', dimensions: 1024 },
    embed: (input: string) => mockEmbed(input),
  }),
}));
const mockEmbed = jest.fn();

function fixture() {
  const snapshot = { id: 'document-1', clientId: 'client-1' as string | null, meetingId: 'meeting-1',
    s3Key: 'tenant/doc', fileName: 'Evidence.txt', contentType: 'text/plain',
    viewerMode: 'all', lifecycleStatus: 'ready', scanStatus: 'clean', supersededByAttachmentId: null };
  const state = { attachment: { ...snapshot }, meeting: { clientId: 'client-1' as string | null, isInternal: false },
    chunks: [] as string[], indexedAt: null as Date | null };
  const operations: string[] = [];
  let inTransaction = false;
  let afterEmbeddingCommit: (() => void) | undefined;
  const update = jest.fn(async ({ data }) => {
    expect(inTransaction).toBe(true);
    operations.push('stamp');
    state.indexedAt = data.indexedAt;
    return {};
  });
  const execute = jest.fn(async (sql: string, ...values: unknown[]) => {
    expect(inTransaction).toBe(true);
    if (sql.startsWith('DELETE')) { operations.push('purge'); state.chunks = []; }
    if (sql.includes('INSERT INTO')) { operations.push('insert'); state.chunks.push(String(values[1])); }
    return 1;
  });
  const query = jest.fn(async (sql: string) => {
    expect(inTransaction).toBe(true);
    expect(sql).toContain('FOR UPDATE');
    if (sql.includes('FROM meetings')) { operations.push('lock-meeting'); return [{ ...state.meeting }]; }
    operations.push('lock-attachment');
    return [{ ...state.attachment }];
  });
  const tx = { $queryRawUnsafe: query, $executeRawUnsafe: execute,
    engagementAttachment: { findFirst: jest.fn().mockResolvedValue(snapshot), update },
    meeting: { findFirst: jest.fn().mockResolvedValue({ subject: 'Meeting' }) } };
  async function transaction(fn: (value: typeof tx) => Promise<unknown>) {
    expect(inTransaction).toBe(false);
    inTransaction = true;
    try { return await fn(tx); } finally { inTransaction = false; }
  }
  const prisma = {
    withTenant: jest.fn((_tenant, fn) => transaction(fn)),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(async (fn) => { const result = await transaction(fn); afterEmbeddingCommit?.(); return result; }),
  };
  const extract = jest.fn().mockResolvedValue({ text: 'Current document content with traceable evidence', truncated: false });
  const service = Object.create(ClientKbService.prototype) as ClientKbService;
  Object.assign(service, { prisma, extractAttachmentTextForKb: extract,
    config: { get: jest.fn().mockReturnValue(false) },
    countClientChunks: jest.fn().mockResolvedValue(0), clientName: jest.fn().mockResolvedValue('Client One') });
  function reassign(clientId: string | null, isInternal = false) {
    expect(inTransaction).toBe(false);
    state.meeting = { clientId, isInternal };
    state.attachment.clientId = clientId;
    state.chunks = [];
    state.indexedAt = null;
  }
  return { service, state, operations, extract, execute, query, update, reassign,
    afterCommit: (fn: () => void) => { afterEmbeddingCommit = fn; } };
}

describe('in-flight document indexing during meeting reassignment', () => {
  beforeEach(() => {
    mockEmbed.mockReset().mockResolvedValue(Array(1024).fill(0));
  });

  it('locks parent then attachment for purge, chunk insert, and final stamp during ordinary indexing', async () => {
    const f = fixture();
    await f.service.indexAttachment('tenant-1', 'document-1');
    expect(f.state.chunks).toEqual(['client-1']);
    expect(f.state.indexedAt).toBeInstanceOf(Date);
    for (let i = 0; i < f.operations.length; i += 1) {
      if (['purge', 'insert', 'stamp'].includes(f.operations[i]!)) {
        expect(f.operations.slice(i - 2, i)).toEqual(['lock-meeting', 'lock-attachment']);
      }
    }
  });

  it('does not purge a new client’s chunks when reassignment occurs during extraction', async () => {
    const f = fixture();
    f.extract.mockImplementation(async () => {
      f.reassign('client-2');
      f.state.chunks = ['client-2'];
      return { text: 'Old client content', truncated: false };
    });
    await f.service.indexAttachment('tenant-1', 'document-1');
    expect(f.state.chunks).toEqual(['client-2']);
    expect(f.operations).not.toContain('purge');
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledTimes(1);
  });

  it.each([['client-2', false], [null, false], [null, true]] as const)(
    'does not recreate old-client chunks when assignment changes during embedding to %s / internal %s',
    async (clientId, internal) => {
      const f = fixture();
      mockEmbed.mockImplementation(async () => {
        f.reassign(clientId, internal);
        if (clientId) f.state.chunks = [clientId];
        return Array(1024).fill(0);
      });
      await f.service.indexAttachment('tenant-1', 'document-1');
      expect(f.state.chunks).toEqual(clientId ? [clientId] : []);
      expect(f.operations).not.toContain('insert');
      expect(f.update).toHaveBeenCalledTimes(1);
      expect(f.state.indexedAt).toBeNull();
    },
  );

  it('rechecks later chunks after an earlier chunk committed, and stops the stale job', async () => {
    const f = fixture();
    f.extract.mockResolvedValue({ text: 'Document evidence '.repeat(1400), truncated: false });
    mockEmbed.mockImplementation(async () => {
      if (mockEmbed.mock.calls.length === 2) { f.reassign('client-2'); f.state.chunks = ['client-2']; }
      return Array(1024).fill(0);
    });
    await f.service.indexAttachment('tenant-1', 'document-1');
    expect(mockEmbed).toHaveBeenCalledTimes(2);
    expect(f.state.chunks).toEqual(['client-2']);
    expect(f.operations.filter((operation) => operation === 'insert')).toHaveLength(1);
    expect(f.update).toHaveBeenCalledTimes(1);
  });

  it('does not mark the new association indexed if reassignment happens after the final chunk commits', async () => {
    const f = fixture();
    f.afterCommit(() => f.reassign(null, true));
    await f.service.indexAttachment('tenant-1', 'document-1');
    expect(f.state.chunks).toEqual([]);
    expect(f.state.indexedAt).toBeNull();
    expect(f.update).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite newer extraction status if old extraction fails after reassignment', async () => {
    const f = fixture();
    f.extract.mockImplementation(async () => { f.reassign('client-2'); throw new Error('S3 unavailable'); });
    await expect(f.service.indexAttachment('tenant-1', 'document-1')).rejects.toThrow('S3 unavailable');
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.operations).not.toContain('purge');
  });

  it.each(['private', 'quarantined'])(
    'does not write a chunk if the document becomes %s during provider work', async change => {
      const f = fixture();
      mockEmbed.mockImplementation(async () => {
        if (change === 'private') f.state.attachment.viewerMode = 'restricted';
        else {
          f.state.attachment.lifecycleStatus = 'quarantined';
          f.state.attachment.scanStatus = 'pending';
        }
        return Array(1024).fill(0);
      });
      await f.service.indexAttachment('tenant-1', 'document-1');
      expect(f.operations).not.toContain('insert');
      expect(f.state.indexedAt).toBeNull();
    },
  );
});
