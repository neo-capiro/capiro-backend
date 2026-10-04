import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import {
  encodeMeriMemoryCaptureRequest,
  MERI_FIXTURE_SEMANTIC_INSTANT,
  MERI_FIXTURE_SEMANTIC_ZONE,
  MERI_MEMORY_CAPTURE_REQUEST_HEADER,
  verifyMeriMemoryCaptureSources,
  type MeriMemoryCaptureRequest,
  type MeriServerReadonlyCapturePolicy,
} from '@capiro/meriv2-core';
import type { RetrievalRecord } from '../retrieval/retrieval-v2.types.js';
import { projectMemoryContent } from './meri-memory-content.helpers.js';
import { withMeriToolRequestControl } from './meri-tool-request-control.js';
import { MeriToolsService } from './meri-tools.service.js';

// Keep the actual memory service, projection and signing path. These unrelated
// program-element imports have package subpaths that ts-jest CJS cannot resolve.
jest.mock('../program-element/program-element-read.service.js', () => ({
  ProgramElementReadService: class {},
}));
jest.mock('./meri-defense-budget-tool.helpers.js', () => ({}));

const id = (n: number) =>
  `${n}`.repeat(8) + '-' + `${n}`.repeat(4) + '-4' + `${n}`.repeat(3) +
  '-8' + `${n}`.repeat(3) + '-' + `${n}`.repeat(12);
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const secret = 'synthetic-memory-source-service-unit-secret';
const ctx = { tenantId: id(1), userId: id(2) } as TenantContext;
const clientId = id(3);
const itemId = id(4);
const text = 'The approved client constraint is to retain the existing launch date.';
const sourceVersion = `candidate:${id(5)}`;
type Method = 'searchMemory' | 'readGovernedMemorySource';

function policy(caseId: '01' | '14'): MeriServerReadonlyCapturePolicy {
  const issuedAt = Date.now();
  return {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: id(5),
    requestId: id(6),
    traceId: id(7),
    turnId: id(8),
    caseId,
    captureRunId: id(9),
    fixtureVersion: 'meri-live-v1-2026-09-26.1',
    physicalMapSha256: 'a'.repeat(64),
    resetReceiptId: id(5),
    seedReceiptId: id(6),
    fixtureNamespace: 'meri-foundation-20260928',
    tenantId: ctx.tenantId,
    tenantSlug: 'meri-foundation-20260928-t1',
    actorUserId: ctx.userId,
    conversationId: id(7),
    clientId,
    issuedAt,
    expiresAt: issuedAt + 60_000,
    toolAuthority: 'shared_static_registry_read_only',
    toolCatalogSha256: 'b'.repeat(64),
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    expectedCaptureWrites: [
      'context_packet_and_evidence',
      'conversation_user_message',
      'conversation_assistant_message',
    ],
    semanticClock: {
      version: 1,
      kind: 'qualified_original_fixture_semantic_clock',
      instant: MERI_FIXTURE_SEMANTIC_INSTANT,
      timeZone: MERI_FIXTURE_SEMANTIC_ZONE,
      caseId,
      captureRunId: id(9),
      observedAt: issuedAt,
      currentVerifySha256: 'c'.repeat(64),
    },
  };
}

function canonicalRecord(): RetrievalRecord & {
  provenance: NonNullable<RetrievalRecord['provenance']>;
} {
  return {
    domain: 'institutional_knowledge',
    recordId: itemId,
    provenance: {
      source: 'memory_items',
      recordId: itemId,
      canonicalTenantId: ctx.tenantId,
      sourceType: 'synthetic_fixture',
      sourceId: id(5),
      sourceRef: 'fixture:approved-memory',
      sourceVersion,
      contentHash: 'd'.repeat(64),
    },
    payload: {
      key: 'Approved launch constraint',
      value: text,
      type: 'constraint',
      scope: 'client',
      clientId,
      contentStatus: 'available',
      governance: { status: 'approved' },
    },
  };
}

function inputFor(method: Method) {
  return method === 'searchMemory'
    ? { query: 'approved launch constraint', clientId }
    : { memoryItemId: itemId, clientId };
}

function request(input: Record<string, unknown>, capture?: MeriServerReadonlyCapturePolicy) {
  const binding: MeriMemoryCaptureRequest = {
    callId: 'search-memory-call-1',
    nonce: id(8),
    inputSha256: hash(JSON.stringify(input)),
  };
  const req = Object.assign(new EventEmitter(), {
    params: { name: 'search_memory' },
    body: input,
    headers: capture
      ? { [MERI_MEMORY_CAPTURE_REQUEST_HEADER]: encodeMeriMemoryCaptureRequest(capture, binding, secret) }
      : {},
    aborted: false,
    res: Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false }),
  }) as unknown as Request;
  return { req, binding };
}

function service(record = canonicalRecord()) {
  const contextPacket = { packetId: id(6), persisted: true };
  const searchToolData = jest.fn().mockResolvedValue({
    records: [record],
    coverage: {
      sources: [{ domain: 'institutional_knowledge', sourceStatus: 'healthy', nextCursor: null }],
    },
    contextPacket,
  });
  const tools = Object.create(MeriToolsService.prototype) as any;
  tools.contextPlane = { searchToolData };
  return { tools, searchToolData, contextPacket };
}

describe('Meri memory tool canonical capture source proof', () => {
  const previousSecret = process.env.INTERNAL_SERVICE_SECRET;
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = secret;
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in memory service test'));
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    if (previousSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = previousSecret;
  });

  describe.each<Method>(['searchMemory', 'readGovernedMemorySource'])('%s', method => {
    it.each(['01', '14'] as const)('signs the actual projected canonical record for case %s', async caseId => {
      const capture = policy(caseId);
      const input = inputFor(method);
      const { req, binding } = request(input, capture);
      const { tools, searchToolData, contextPacket } = service();
      const result = await withMeriToolRequestControl(req, () => tools[method](ctx, input), capture) as any;

      expect(searchToolData).toHaveBeenCalledTimes(1);
      expect(searchToolData).toHaveBeenCalledWith(ctx, expect.objectContaining({
        query: method === 'searchMemory' ? input.query : 'Read this governed memory',
        requestedDomains: ['institutional_knowledge'],
        queryClass: method === 'searchMemory' ? 'semantic_recall' : 'lookup',
        clientId,
        ...(method === 'readGovernedMemorySource' ? { memoryItemId: itemId } : {}),
      }), { policy: capture, tool: 'search_memory' });
      expect(result.records[0].provenance.canonicalTenantId).toBe(ctx.tenantId);
      expect(result.records[0].payload.content).toMatchObject({
        hash: hash(text + '\0' + sourceVersion), truncated: false, nextRead: null,
      });
      expect(result.contextPackets).toEqual([contextPacket]);
      expect(verifyMeriMemoryCaptureSources(capture, result.records, result.memoryCaptureSources, secret, binding))
        .toEqual([{
          sourceId: itemId, tenantId: ctx.tenantId, clientId, sourceVersion,
          currentVersion: 'content:' + hash(text + '\0' + sourceVersion),
          passageSha256: hash(text), offset: 0, endOffset: text.length,
          totalCharacters: text.length, fullRead: true,
        }]);
      expect(() => verifyMeriMemoryCaptureSources(capture, result.records, result.memoryCaptureSources,
        secret, { ...binding, nonce: id(9) })).toThrow('meri_memory_capture_source_unproved');
      expect(req.listenerCount('aborted')).toBe(0);
      expect(req.res!.listenerCount('close')).toBe(0);
    });

    it.each(['missing-owner', 'foreign-owner', 'foreign-client'] as const)(
      'refuses %s instead of substituting request/policy ownership', async fault => {
        const capture = policy('14');
        const input = inputFor(method);
        const { req } = request(input, capture);
        const record = canonicalRecord();
        if (fault === 'missing-owner') delete record.provenance.canonicalTenantId;
        if (fault === 'foreign-owner') record.provenance.canonicalTenantId = id(9);
        if (fault === 'foreign-client') record.payload.clientId = id(9);
        const projected = projectMemoryContent(ctx, record, { captureSourceOwner: true, clientId });
        expect(projected.provenance).toBeDefined();
        expect(projected.provenance!.canonicalTenantId)
          .toBe(fault === 'missing-owner' ? null : record.provenance.canonicalTenantId);
        const { tools, searchToolData } = service(record);

        await expect(withMeriToolRequestControl(req, () => tools[method](ctx, input), capture))
          .rejects.toThrow('meri_memory_capture_source_unproved');
        expect(searchToolData).toHaveBeenCalledTimes(1);
        expect(req.listenerCount('aborted')).toBe(0);
      },
    );

    it('rejects a header signed for different input before the service callback', async () => {
      const capture = policy('14');
      const input = inputFor(method);
      const { req } = request({ ...input, clientId: id(9) }, capture);
      req.body = input;
      const { tools, searchToolData } = service();
      const run = jest.fn(() => tools[method](ctx, input));

      await expect(withMeriToolRequestControl(req, run, capture))
        .rejects.toThrow('meri_memory_capture_source_unproved');
      expect(run).not.toHaveBeenCalled();
      expect(searchToolData).not.toHaveBeenCalled();
    });

    it('requires the signed per-call header before entering a capture callback', async () => {
      const input = inputFor(method);
      const { req } = request(input);
      const run = jest.fn();
      await expect(withMeriToolRequestControl(req, run, policy('01')))
        .rejects.toThrow('meri_memory_capture_source_unproved');
      expect(run).not.toHaveBeenCalled();
    });

    it('preserves the ordinary projected response without proof or owner fields', async () => {
      const input = inputFor(method);
      const { req } = request(input);
      const record = canonicalRecord();
      const { tools, searchToolData } = service(record);
      const result = await withMeriToolRequestControl(req, () => tools[method](ctx, input)) as any;

      expect(result).not.toHaveProperty('memoryCaptureSources');
      expect(result).not.toHaveProperty('contextPackets');
      expect(result.records[0].provenance).not.toHaveProperty('canonicalTenantId');
      expect(result.records).toEqual([projectMemoryContent(ctx, record, { clientId,
        ...(method === 'readGovernedMemorySource' ? { memoryItemId: itemId } : {}),
      })]);
      expect(result).toMatchObject({ tool: 'search_memory', contentStatus: 'available', contentTruncated: false });
      expect(searchToolData.mock.calls[0]).toHaveLength(2);
    });
  });

  it('keeps a search excerpt partial while an exact governed read proves the full source', async () => {
    const capture = policy('14');
    const record = canonicalRecord();
    record.payload.value = 'Approved source sentence. '.repeat(40);
    const { tools } = service(record);
    for (const method of ['searchMemory', 'readGovernedMemorySource'] as const) {
      const input = inputFor(method);
      const { req, binding } = request(input, capture);
      const result = await withMeriToolRequestControl(req, () => tools[method](ctx, input), capture) as any;
      const proofs = verifyMeriMemoryCaptureSources(capture, result.records,
        result.memoryCaptureSources, secret, binding);
      expect(proofs).toHaveLength(1);
      const proof = proofs[0]!;
      expect(proof.fullRead).toBe(method === 'readGovernedMemorySource');
      expect(proof.totalCharacters).toBe(String(record.payload.value).length);
      expect(proof.passageSha256).toBe(hash(result.records[0].payload.value));
      if (method === 'searchMemory') expect(result.records[0].payload.content.nextRead).toHaveProperty('contentCursor');
    }
  });
});
