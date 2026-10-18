import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { EngagementService } from '../../engagement/engagement.service.js';
import { readWithCurrentMondayMapping } from './monday-current-source.js';
import { readWithCurrentDocumentFacts } from './document-current-source.js';
import type { DocumentPricingEvidence, TrustedClientReadContext } from './documents-monday.js';
import { NO_DOCUMENT_PROVIDER_CALLS } from './documents-monday.js';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const C = id('a'), T = id('1'), A = id('2');
const ctx = { tenantId: T, userId: A } as TenantContext;
const current: TrustedClientReadContext = {
  selectedClientId: C,
  binding: { tenantId: T, actorId: A, conversationId: id('3'), runId: id('4'), attemptId: id('5'), workerId: id('6'), writerFence: 1 },
  subject: { kind: 'client', entityType: 'client', entityIds: [C], tenantId: T, actorId: A, authorizationDecisionId: id('7'), policyRevision: 'policy-1', rosterVersionId: null,
    scopes: [{ tenantId: T, kind: 'client', resourceId: C, policyRevision: 'policy-1' }] },
};
const pin = 'a'.repeat(64);
const pricing: DocumentPricingEvidence = {
  vision: { model: 'gpt-6-astra', inputMicrousdPerMillionTokens: 1000, outputMicrousdPerMillionTokens: 1000,
    maxInputTokens: 1000, coreSourceCommit: pin.slice(0, 40), coreImageDigest: `sha256:${pin}`, configurationSha256: pin },
  transcription: { model: 'whisper-1', microusdPerMinute: 6000, maxAudioSeconds: 600,
    coreSourceCommit: pin.slice(0, 40), coreImageDigest: `sha256:${pin}`, configurationSha256: pin },
  runtimeMaxAudioSeconds: 600, runtimeCapEnforced: true,
};
const mondayInput = { clientId: C, boardContext: null, cursor: null, pageSize: null, requireComplete: true };
const mondayBody = () => ({
  tool: 'read_monday_client_boards', authoritativeOwner: 'managed_monday_mcp', currentStatus: 'healthy', clientId: C,
  records: [{ domain: 'monday', recordId: '101:202', payload: {
    clientId: C, sourceActorUserId: A, title: 'Task', status: 'Working', owners: [], dueDate: null,
    updatedAt: '2026-10-18T09:00:00.000Z', description: null, updates: [], columns: [], url: null,
    origin: { provider: 'monday', boardId: '101', itemId: '202', itemType: 'item', scope: 'saved_mapping' },
  }, provenance: { source: 'managed_monday_mcp', boardId: '101', itemId: '202' } }],
  coverage: {
    requestedDomains: ['monday'], searchedDomains: ['monday'], requestedEntityCount: 1,
    searchedEntityCount: 1, recordsEvaluated: 1, recordsReturned: 1,
    paginationComplete: true, unavailableSources: [], complete: true, stopReason: 'complete',
    sources: [{ domain: 'monday', sourceStatus: 'healthy', returned: 1, recordsEvaluated: 1,
      requestedEntityCount: 1, searchedEntityCount: 1, pagesRead: 1, hasMore: false,
      truncated: false, paginationComplete: true, coverageComplete: true, stopReason: 'complete' }],
  },
});
const mappingRow = (boards = ['101']) => ({ id: id('9'), updatedAt: new Date('2026-10-18T09:00:00Z'), boardIds: boards });
function mondayDb(rows: Array<ReturnType<typeof mappingRow> | null>) {
  const findFirst = jest.fn().mockImplementation(async () => rows.shift() ?? null);
  const db = { withTenantUser: jest.fn(async (_tenant: string, _actor: string, run: (tx: unknown) => unknown) =>
    run({ meetingPrepMondayMapping: { findFirst } })) } as unknown as PrismaService;
  return { db, findFirst };
}
const documentInput = { mode: 'list', clientId: C, documentId: null, query: '', section: 1,
  characterOffset: 0, limit: 25, cursor: null, cursorBinding: null, listAfter: null };
const attachment = (suffix = '1') => ({ id: `doc-${suffix}`, clientId: C, fileName: `File-${suffix}.txt`,
  contentType: 'text/plain', byteSize: 10, calculatedSha256: null, s3Key: `stored/${suffix}`,
  lifecycleStatus: 'ready', usable: true, viewerMode: 'all', viewerUserIds: [], blockedReason: null });
const documents = (ids: string[]) => ({ tool: 'read_client_documents', generatedAt: '2026-10-18T09:59:00Z',
  clientId: C, coverage: { total: ids.length, returned: ids.length, truncated: false, nextCursor: null,
    complete: true, paginationComplete: true, query: null, queryAppliesTo: 'fileName' }, note: 'Inventory only',
  documents: ids.map((id) => ({ ...attachment(id.slice(-1)), id, createdAt: '2026-10-18T09:00:00Z',
    indexedAt: null, extractionStatus: null, extractionMetadata: null, disclosure: null })).map(
      ({id,fileName,contentType,byteSize,createdAt,indexedAt,extractionStatus,extractionMetadata,usable,blockedReason,disclosure}) =>
      ({id,fileName,contentType,byteSize,createdAt,indexedAt,extractionStatus,extractionMetadata,usable,blockedReason,disclosure})) });
function engagementPages(pages: Array<Array<ReturnType<typeof attachment>>>) {
  const listAttachments = jest.fn().mockImplementation(async () => pages.shift() ?? []);
  return { engagement: { listAttachments } as unknown as EngagementService, listAttachments };
}

describe('current Core source facts around retained 0.2 reads', () => {
  it('uses actual mapping row on both sides of the canonical Monday call', async () => {
    const { db, findFirst } = mondayDb([mappingRow(), mappingRow()]);
    const read = jest.fn(async () => mondayBody());
    await expect(readWithCurrentMondayMapping(db, ctx, current, mondayInput, read,
      () => Date.parse('2026-10-18T10:00:00Z'))).resolves.toMatchObject({ tool: 'read_monday_client_boards' });
    expect(read).toHaveBeenCalledWith({ clientId: C });
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(findFirst).toHaveBeenCalledWith({ where: { tenantId: T, userId: A, clientId: C },
      select: { id: true, updatedAt: true, boardIds: true } });
  });

  it('refuses a mapping change during retrieval, even if the provider reported success', async () => {
    const { db } = mondayDb([mappingRow(), mappingRow(['999'])]);
    await expect(readWithCurrentMondayMapping(db, ctx, current, mondayInput,
      async () => mondayBody())).rejects.toThrow('mapping changed');
  });

  it('checks exact explicit board scope against saved mapping before provider work', async () => {
    const { db } = mondayDb([mappingRow()]);
    const read = jest.fn(async () => mondayBody());
    await expect(readWithCurrentMondayMapping(db, ctx, current,
      { ...mondayInput, boardContext: 'board:999' }, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it('uses the existing attachment owner before and after a canonical list read', async () => {
    const { engagement, listAttachments } = engagementPages([[attachment()], [attachment()]]);
    const read = jest.fn(async () => documents(['doc-1']));
    await expect(readWithCurrentDocumentFacts(engagement, ctx, current, documentInput, pricing,
      read, () => Date.parse('2026-10-18T10:00:00Z'))).resolves.toMatchObject({
      binding: current.binding, subject: current.subject, data: { documents: [{ id: 'doc-1' }] },
    });
    expect(read).toHaveBeenCalledWith({ clientId: C, limit: 25 });
    expect(listAttachments).toHaveBeenCalledTimes(2);
    expect(listAttachments).toHaveBeenCalledWith(ctx, { clientId: C });
  });

  it('does not return a document removed from the visible owner inventory during the read', async () => {
    const { engagement } = engagementPages([[attachment()], []]);
    await expect(readWithCurrentDocumentFacts(engagement, ctx, current, documentInput, pricing,
      async () => documents(['doc-1']))).rejects.toThrow('changed');
  });

  it('refuses before any document owner call while the real audio cap evidence is absent', async () => {
    const { engagement, listAttachments } = engagementPages([[attachment()]]);
    const read = jest.fn(async () => documents(['doc-1']));
    await expect(readWithCurrentDocumentFacts(engagement, ctx, current, documentInput, undefined,
      read)).rejects.toThrow('Measured document prices');
    expect(listAttachments).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('allows a provider-forbidden inventory only while owner metadata and deadline remain current', async () => {
    const { engagement } = engagementPages([[attachment()], [attachment()]]);
    const data = documents(['doc-1']);
    data.documents[0]!.fileName = 'Foreign title.txt';
    await expect(readWithCurrentDocumentFacts(engagement, ctx, current, documentInput, NO_DOCUMENT_PROVIDER_CALLS,
      async () => data)).rejects.toThrow('metadata differs');
    const next = engagementPages([[attachment()], [attachment()]]);
    let checks = 0;
    const assertActive = () => { if (++checks === 3) throw new Error('deadline'); };
    await expect(readWithCurrentDocumentFacts(next.engagement, ctx, current, documentInput, NO_DOCUMENT_PROVIDER_CALLS,
      async () => documents(['doc-1']), Date.now, assertActive)).rejects.toThrow('deadline');
    expect(next.listAttachments).toHaveBeenCalledTimes(1);
  });

  it('reports malformed canonical coverage as a source refusal', async () => {
    const { engagement } = engagementPages([[attachment()], [attachment()]]);
    const body = documents(['doc-1']) as Record<string, unknown>;
    delete body.coverage;
    await expect(readWithCurrentDocumentFacts(engagement, ctx, current, documentInput, NO_DOCUMENT_PROVIDER_CALLS,
      async () => body)).rejects.toMatchObject({ code: 'RETAINED_SOURCE_UNAVAILABLE',
      message: 'Canonical document coverage is malformed' });
  });
});
