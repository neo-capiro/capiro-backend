import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDocumentReadPage, parseDocumentReadInput } from '../meri-document-read.helpers.js';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import {
  assertDocumentPricing,
  NO_DOCUMENT_PROVIDER_CALLS,
  prepareDocumentRead,
  prepareMondayRead,
  projectDocumentRead,
  projectMondayRead,
  type CurrentManagedBoardMapping,
  type DocumentPricingEvidence,
  type TrustedClientReadContext,
} from './documents-monday.js';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const clientId = id('a');
const current: TrustedClientReadContext = {
  selectedClientId: clientId,
  binding: { tenantId: id('1'), actorId: id('2'), conversationId: id('3'), runId: id('4'), attemptId: id('5'), workerId: id('6'), writerFence: 1 },
  subject: { kind: 'client', entityType: 'client', entityIds: [clientId], tenantId: id('1'), actorId: id('2'), authorizationDecisionId: id('7'), policyRevision: 'policy-1', rosterVersionId: null,
    scopes: [{ tenantId: id('1'), kind: 'client', resourceId: clientId, policyRevision: 'policy-1' }] },
};
const mapping: CurrentManagedBoardMapping = {
  tenantId: id('1'), userId: id('2'), clientId, mappingVersionId: 'mapping-revision-1', boardIds: ['101'],
};
const digest = (value: unknown) => createHash('sha256').update(canonicalizeCoreRetainedJson(value)).digest('hex');
const receipt = (body: unknown, mappingVersionId?: string) => ({
  resultSha256: digest(body), observedAt: '2026-10-18T10:00:00.000Z', ...(mappingVersionId ? { mappingVersionId } : {}),
});
const mondayInput = { clientId, boardContext: null, cursor: null, pageSize: null, requireComplete: true };
const documentInput = (documentId: string | null = null) => ({
  mode: documentId === null ? 'list' : 'read', clientId, documentId, query: '', section: 1,
  characterOffset: 0, limit: documentId === null ? 25 : 5000, cursor: null, cursorBinding: null, listAfter: null,
});
const mondayBody = () => ({
  tool: 'read_monday_client_boards', authoritativeOwner: 'managed_monday_mcp', currentStatus: 'healthy', clientId,
  records: [{ domain: 'monday', recordId: '101:202', payload: {
    clientId, sourceActorUserId: id('2'), title: 'Task', status: 'Working', owners: [], dueDate: null,
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
const pin = 'a'.repeat(64);
const pricing: DocumentPricingEvidence = {
  vision: { model: 'gpt-6-astra', inputMicrousdPerMillionTokens: 1000, outputMicrousdPerMillionTokens: 1000,
    maxInputTokens: 1000, coreSourceCommit: pin.slice(0, 40), coreImageDigest: `sha256:${pin}`, configurationSha256: pin },
  transcription: { model: 'whisper-1', microusdPerMinute: 6000, maxAudioSeconds: 600,
    coreSourceCommit: pin.slice(0, 40), coreImageDigest: `sha256:${pin}`, configurationSha256: pin },
  runtimeMaxAudioSeconds: 600, runtimeCapEnforced: true,
};

describe('retained 0.2 Monday and document source projections', () => {
  it('pins the exact Meri PR158 Monday output schema and its data-search references', () => {
    const pins = {
      'monday.schema.json': '20bb7df536c0ae285b609f974619a6c910e35748f2a51c3f552e82c4f260afb1',
      'monday-data-search.schema.json': 'b390270625b4662df487f04b13df745f422d10a2a8aa90e79e90a7ce75219d60',
    };
    for (const [name, expected] of Object.entries(pins))
      expect(createHash('sha256').update(readFileSync(join(__dirname, name))).digest('hex')).toBe(expected);
  });

  it('requires the task-selected client and an exact current managed board mapping', () => {
    expect(prepareMondayRead(mondayInput, current, mapping)).toEqual({ clientId });
    expect(() => prepareMondayRead({ ...mondayInput, clientId: id('b') }, current, mapping)).toThrow();
    expect(() => prepareMondayRead(mondayInput, current, { ...mapping, tenantId: id('b') })).toThrow();
    expect(() => prepareMondayRead(mondayInput, current, { ...mapping, boardIds: [] })).toThrow();
  });

  it('checks actual row boards, request scope, mapping version and source hash', () => {
    const body = mondayBody();
    expect(projectMondayRead(body, mondayInput, current, mapping, receipt(body, mapping.mappingVersionId))).toBe(body);
    const wrongBoard = mondayBody();
    wrongBoard.records[0]!.payload.origin.boardId = '999';
    expect(() => projectMondayRead(wrongBoard, mondayInput, current, mapping,
      receipt(wrongBoard, mapping.mappingVersionId))).toThrow();
    const requestBoard = mondayBody();
    requestBoard.records[0]!.payload.origin.scope = 'request';
    expect(() => projectMondayRead(requestBoard, mondayInput, current, mapping,
      receipt(requestBoard, mapping.mappingVersionId))).toThrow();
    expect(projectMondayRead(requestBoard, mondayInput, current, { ...mapping, requestBoardIds: ['101'] },
      receipt(requestBoard, mapping.mappingVersionId))).toBe(requestBoard);
    expect(() => projectMondayRead(body, mondayInput, current, { ...mapping, requestBoardIds: ['101'] },
      receipt(body, mapping.mappingVersionId))).toThrow();
    expect(() => projectMondayRead(body, mondayInput, current, mapping, receipt(body, 'newer-revision'))).toThrow();
    expect(() => projectMondayRead(body, mondayInput, current, mapping,
      { ...receipt(body, mapping.mappingVersionId), resultSha256: 'b'.repeat(64) })).toThrow();
  });

  it('rejects schema gaps and Monday-specific row correlations even with a matching result hash', () => {
    const base = mondayBody();
    const mutate = (change: (body: ReturnType<typeof mondayBody>) => void) => {
      const body = structuredClone(base);
      change(body);
      expect(() => projectMondayRead(body, mondayInput, current, mapping,
        receipt(body, mapping.mappingVersionId))).toThrow();
    };
    mutate((body) => { (body as Record<string, unknown>).extra = true; });
    mutate((body) => { delete (body.records[0]!.payload as Record<string, unknown>).owners; });
    mutate((body) => { body.coverage.sources[0]!.sourceStatus = 'fictional'; });
    mutate((body) => { body.records[0]!.payload.status = ' Working '; });
    mutate((body) => { (body.records[0]!.payload as Record<string, unknown>).url = 'https://other.example/item'; });
    mutate((body) => { body.records[0]!.payload.origin.itemType = 'subitem'; });
    mutate((body) => { (body.records[0]!.payload.origin as Record<string, unknown>).parentItemId = '303'; });
  });

  it('requires measured prices and a matching enforced whisper cap even for a list', () => {
    expect(() => assertDocumentPricing(undefined)).toThrow();
    expect(() => assertDocumentPricing({ ...pricing, runtimeCapEnforced: false as true })).toThrow();
    expect(() => assertDocumentPricing({ ...pricing, runtimeMaxAudioSeconds: 300 })).toThrow();
    expect(prepareDocumentRead(documentInput(), current, pricing)).toEqual({ clientId, limit: 25 });
    expect(() => prepareDocumentRead({ ...documentInput(), clientId: id('b') }, current, pricing)).toThrow();
  });

  it('uses a Git SHA40 source pin and exact bounded integer tariff inputs', () => {
    expect(() => assertDocumentPricing(pricing)).not.toThrow();
    expect(() => assertDocumentPricing({ ...pricing, vision: { ...pricing.vision, coreSourceCommit: pin } })).toThrow();
    expect(() => assertDocumentPricing({ ...pricing, vision: { ...pricing.vision, maxInputTokens: 2000001 } })).toThrow();
    expect(() => assertDocumentPricing({ ...pricing, transcription: { ...pricing.transcription, microusdPerMinute: 0.5 } })).toThrow();
    expect(prepareDocumentRead(documentInput(), current, NO_DOCUMENT_PROVIDER_CALLS)).toEqual({ clientId, limit: 25 });
    expect(() => prepareDocumentRead({ ...documentInput(), allowPaidExtraction: true }, current,
      NO_DOCUMENT_PROVIDER_CALLS)).toThrow();
  });

  it('translates a source-bound document cursor without repeating explicit section fields', () => {
    const cursorBinding = { version: 1, documentId: 'doc-1', clientId, contentHash: 'c'.repeat(64),
      query: '', section: 2, offset: 500 };
    const cursor = `document:${Buffer.from(JSON.stringify(cursorBinding)).toString('base64url')}`;
    const input = { ...documentInput('doc-1'), section: 2, characterOffset: 500, cursor, cursorBinding };
    expect(prepareDocumentRead(input, current, pricing)).toEqual({ clientId, documentId: 'doc-1', limit: 5000, cursor });
    expect(() => prepareDocumentRead({ ...input, cursorBinding: { ...cursorBinding, clientId: id('b') } },
      current, pricing)).toThrow();
  });

  it('wraps a canonical inventory only with source hash and selected-client lineage', () => {
    const body = { tool: 'read_client_documents', clientId, generatedAt: '2026-10-18T09:59:00.000Z',
      coverage: { total: 1, returned: 1, truncated: false, nextCursor: null, complete: true,
        paginationComplete: true, query: null, queryAppliesTo: 'fileName' }, note: 'Inventory only',
      documents: [{ id: 'doc-1', fileName: 'Evidence.txt', contentType: 'text/plain', byteSize: 10,
        createdAt: '2026-10-18T09:00:00Z', indexedAt: null, extractionStatus: null, extractionMetadata: null,
        usable: true, blockedReason: null, disclosure: null }] };
    expect(projectDocumentRead(body, documentInput(), current, pricing, receipt(body))).toEqual({
      binding: current.binding, subject: current.subject, data: body,
    });
    expect(() => projectDocumentRead({ ...body, clientId: id('b') }, documentInput(), current, pricing,
      receipt({ ...body, clientId: id('b') }))).toThrow();
  });

  it('rejects a document section whose source hash or full-section hash differs', () => {
    const text = 'Bound, stored section text';
    const sectionHash = createHash('sha256').update(text).digest('hex');
    const contentHash = 'c'.repeat(64);
    const body = JSON.parse(JSON.stringify(buildDocumentReadPage(clientId,
      parseDocumentReadInput({ documentId: 'doc-1' }, clientId), { attachmentId: 'doc-1',
        fileName: 'Evidence.txt', contentType: 'text/plain', contentHash, text, source: 'text' })));
    body.generatedAt = '2026-10-18T09:59:00.000Z';
    expect(projectDocumentRead(body, documentInput('doc-1'), current, pricing, receipt(body))).toMatchObject({ data: body });
    const altered = structuredClone(body);
    altered.records[0]!.provenance.sectionHash = 'd'.repeat(64);
    expect(() => projectDocumentRead(altered, documentInput('doc-1'), current, pricing, receipt(altered))).toThrow();
  });
});
