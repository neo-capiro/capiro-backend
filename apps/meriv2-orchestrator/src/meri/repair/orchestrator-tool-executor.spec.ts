import { buildClaimLedgerFromToolResults, ledgerToToolResultMap } from '@capiro/meriv2-core';
import { validateCitationMarkers, validateFormBCitations } from '@capiro/shared';
import * as contextEvidence from '../meriv3/meriv3-context-evidence';
import {
  createOrchestratorToolExecutor,
  documentContentReadable,
  projectRemedyArgs,
  requestIdentities,
} from './orchestrator-tool-executor';

const schema = {
  name: 'get_bill_status',
  input_schema: { properties: { billId: {}, clientId: {} }, required: ['billId'] },
};
const documentSchema = {
  name: 'read_client_documents',
  input_schema: { properties: { clientId: {}, documentId: {}, query: {} }, required: ['clientId'] },
};

/** The exact shape production passes: scope ids plus the governed request text; no `identities`. */
function productionContext(request?: string) {
  return {
    tenantId: 'tenant',
    clientId: 'client-1',
    conversationId: 'conversation-1',
    ...(request ? { request } : {}),
  };
}

/** Arguments plan-remedy actually emits: abstract fields plus scope and an optional route. */
function remedyArgs(route: Record<string, unknown> = {}) {
  return {
    claimIds: ['c'],
    evidenceClass: 'official_government_data',
    requiredFields: [],
    freshness: null,
    tenantId: 'tenant',
    clientId: 'client-1',
    ...route,
  };
}

function registry(readOnly = true, metadata = true) {
  return {
    get: jest.fn(() => ({ readOnly })),
    executionMetadata: jest.fn(() => (metadata ? { executionMode: 'read' } : undefined)),
  } as never;
}

const contentRead = {
  tool: 'read_client_documents',
  clientId: 'client-1',
  document: { id: 'doc-7', fileName: 'hearing.txt', contentHash: 'abc' },
  coverage: { complete: true, truncated: false },
  records: [
    {
      recordId: 'doc-7:abc:1:0-38',
      payload: {
        id: 'doc-7:abc:1:0-38',
        documentId: 'doc-7',
        text: 'The chair promised action on the bill.',
      },
    },
  ],
};
const metadataOnlyRead = {
  tool: 'read_client_documents',
  clientId: 'client-1',
  document: { id: 'doc-7', fileName: 'hearing.txt', contentHash: 'abc' },
  coverage: { extractedSectionEmpty: true, continuationBlocked: true, missingContent: true },
  records: [],
};
const fileListing = {
  tool: 'read_client_documents',
  clientId: 'client-1',
  coverage: { total: 2, returned: 2, truncated: false },
  documents: [{ id: 'doc-7', fileName: 'hearing.txt', usable: true }],
};

describe('orchestrator repair tool executor', () => {
  it('projects identities present in the governed request and refuses unfillable required fields', () => {
    expect(
      projectRemedyArgs(
        { name: schema.name, args: remedyArgs() },
        schema,
        productionContext('What is the status of H.R. 1 for this client?'),
      ),
    ).toEqual({ billId: 'H.R. 1', clientId: 'client-1' });
    expect(
      projectRemedyArgs(
        { name: schema.name, args: remedyArgs() },
        schema,
        productionContext('What changed this week?'),
      ),
    ).toBeNull();
    expect(
      projectRemedyArgs({ name: schema.name, args: remedyArgs() }, schema, { tenantId: 'tenant' }),
    ).toBeNull();
  });

  it.each([
    ['PE code', 'peCode', 'Compare the marks for PE 0601234A this cycle', {}, '0601234A'],
    ['award PIID', 'piid', 'Was award FA1234-26-C-0001 modified?', {}, 'FA1234-26-C-0001'],
    ['document id', 'documentId', 'Summarize the transcript', { documentId: 'doc-7' }, 'doc-7'],
    [
      'opportunity id',
      'opportunityId',
      'Is opportunity id W912DY-26-R-0009 still open?',
      {},
      'W912DY-26-R-0009',
    ],
    ['bill', 'billId', 'Did S. 2296 pass?', {}, 'S. 2296'],
  ])(
    'projects the %s family from the request text or the planned route',
    (_family, field, request, route, value) => {
      const familySchema = {
        name: `family_${field}`,
        input_schema: { properties: { [field]: {} }, required: [field] },
      };
      expect(
        projectRemedyArgs(
          { name: familySchema.name, args: remedyArgs(route) },
          familySchema,
          productionContext(request),
        ),
      ).toEqual({ [field]: value });
      expect(
        projectRemedyArgs(
          { name: familySchema.name, args: remedyArgs() },
          familySchema,
          productionContext('Tell me about the program.'),
        ),
      ).toBeNull();
    },
  );

  it('never guesses a committee id, and explicit identities still win over request text', () => {
    const committee = {
      name: 'get_committee_roster',
      input_schema: { properties: { committeeId: {} }, required: ['committeeId'] },
    };
    expect(
      projectRemedyArgs(
        { name: committee.name, args: remedyArgs() },
        committee,
        productionContext('Who sits on HASC?'),
      ),
    ).toBeNull();
    expect(
      projectRemedyArgs({ name: committee.name, args: remedyArgs() }, committee, {
        ...productionContext('Who sits on HASC?'),
        identities: { committeeId: 'HSAS' },
      }),
    ).toEqual({ committeeId: 'HSAS' });
    expect(requestIdentities('The award summary is due')).toEqual({});
  });

  it('refuses an unfillable schema with no_concrete_route rather than guessing', async () => {
    const invoke = jest.fn();
    const executor = createOrchestratorToolExecutor({
      registry: registry(),
      schemas: [schema],
      context: productionContext('What changed this week?'),
      citations: [],
      ledgerEntries: [],
      invoke,
    });
    await expect(
      executor.execute({ name: schema.name, args: remedyArgs() }, {}),
    ).resolves.toMatchObject({
      ok: false,
      state: 'retrieval_failed',
      reason: 'no_concrete_route',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', undefined, true],
    ['write', false, true],
    ['missing metadata', true, false],
  ])(
    'refuses %s tools',
    async (_label: string, readOnly: boolean | undefined, metadata: boolean) => {
      const invoke = jest.fn();
      const executor = createOrchestratorToolExecutor({
        registry:
          readOnly === undefined
            ? ({ get: () => undefined, executionMetadata: () => undefined } as never)
            : registry(readOnly, metadata),
        schemas: [schema],
        context: productionContext('Status of H.R. 1?'),
        citations: [],
        ledgerEntries: [],
        invoke,
      });
      expect(await executor.execute({ name: schema.name, args: remedyArgs() }, {})).toMatchObject({
        ok: false,
        reason: 'tool_not_read_only',
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  describe('document routes', () => {
    function documentExecutor(invoke: jest.Mock, extra: Record<string, unknown> = {}) {
      return createOrchestratorToolExecutor({
        registry: registry(),
        schemas: [documentSchema],
        context: productionContext('Summarize the transcript'),
        citations: [],
        ledgerEntries: [],
        invoke,
        ...extra,
      });
    }

    it('refuses a document read without the document id instead of issuing a listing', async () => {
      const invoke = jest.fn();
      const result = await documentExecutor(invoke).execute(
        { name: documentSchema.name, args: remedyArgs() },
        {},
      );
      expect(result).toMatchObject({
        ok: false,
        state: 'retrieval_failed',
        reason: 'no_concrete_route',
      });
      expect(invoke).not.toHaveBeenCalled();
    });

    it('returns content evidence for a readable document', async () => {
      const invoke = jest.fn(async () => contentRead);
      const result = await documentExecutor(invoke).execute(
        { name: documentSchema.name, args: remedyArgs({ documentId: 'doc-7' }) },
        {},
      );
      expect(invoke).toHaveBeenCalledWith(
        documentSchema.name,
        { clientId: 'client-1', documentId: 'doc-7' },
        undefined,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.evidence.length).toBeGreaterThan(0);
    });

    it.each([
      ['metadata-only extraction', metadataOnlyRead],
      ['a file listing', fileListing],
    ])('reports document_unavailable when a concrete route yields %s', async (_label, payload) => {
      const invoke = jest.fn(async () => payload);
      const result = await documentExecutor(invoke).execute(
        { name: documentSchema.name, args: remedyArgs({ documentId: 'doc-7' }) },
        {},
      );
      expect(result).toMatchObject({
        ok: false,
        state: 'document_unavailable',
        reason: 'document_content_unavailable',
      });
    });

    it('reports document_unavailable when the document read itself fails', async () => {
      const invoke = jest.fn(async () => {
        throw new Error('document_content_unavailable');
      });
      const result = await documentExecutor(invoke).execute(
        { name: documentSchema.name, args: remedyArgs({ documentId: 'doc-7' }) },
        {},
      );
      expect(result).toMatchObject({
        ok: false,
        state: 'document_unavailable',
        reason: 'document_content_unavailable',
      });
    });

    it('keeps an ordinary transport outage separate from unavailable document content', async () => {
      const invoke = jest.fn(async () => {
        throw new Error('upstream timeout');
      });
      const call = { name: documentSchema.name, args: remedyArgs({ documentId: 'doc-7' }) };
      expect(await documentExecutor(invoke).execute(call, {})).toMatchObject({
        ok: false,
        state: 'retrieval_failed',
        reason: 'upstream timeout',
      });
      const logicalError = documentExecutor(jest.fn(async () => ({ error: 'gateway timeout' })));
      expect(await logicalError.execute(call, {})).toMatchObject({
        ok: false,
        state: 'retrieval_failed',
      });
    });

    it('retains the owner document hash without inventing a section', async () => {
      const result = await documentExecutor(jest.fn(async () => contentRead)).execute(
        { name: documentSchema.name, args: remedyArgs({ documentId: 'doc-7' }) },
        {},
      );
      expect(result).toMatchObject({
        ok: true,
        evidence: [
          expect.objectContaining({
            sourceId: 'doc-7:abc:1:0-38',
            clientId: 'client-1',
            documentId: 'doc-7',
            version: 'abc',
            contentHash: expect.any(String),
            evidenceKind: 'source_passage',
            acquisitionState: 'consulted',
            ownerVerified: true,
          }),
        ],
      });
      if (result.ok) expect(result.evidence[0]?.locator).toBeUndefined();
    });

    it('keeps a large canonical document read useful and owner-bound after projection', async () => {
      const result = await documentExecutor(
        jest.fn(async () => ({
          ...contentRead,
          coverage: {
            ...contentRead.coverage,
            nextCursor: null,
            section: 1,
            characterStart: 0,
            characterEnd: 38,
            extractionMetadata: 'diagnostic '.repeat(2_000),
          },
        })),
      ).execute({ name: documentSchema.name, args: remedyArgs({ documentId: 'doc-7' }) }, {});
      expect(result).toMatchObject({
        ok: true,
        evidence: [
          expect.objectContaining({
            sourceId: 'doc-7:abc:1:0-38',
            clientId: 'client-1',
            documentId: 'doc-7',
            version: 'abc',
            evidenceKind: 'source_passage',
            acquisitionState: 'consulted',
            ownerVerified: true,
          }),
        ],
      });
    });

    it('refuses a document the turn already knows is unreadable without a tool call', async () => {
      const invoke = jest.fn(async () => contentRead);
      const executor = documentExecutor(invoke, {
        documentReferences: [
          { id: 'doc-7', filename: 'hearing.txt', readable: false, contentState: 'metadata_only' },
        ],
      });
      const result = await executor.execute(
        { name: documentSchema.name, args: remedyArgs({ documentId: 'doc-7' }) },
        {},
      );
      expect(result).toMatchObject({
        ok: false,
        state: 'document_unavailable',
        reason: 'document_not_readable',
      });
      expect(invoke).not.toHaveBeenCalled();
    });

    it('classifies document payloads by extracted text, never by metadata', () => {
      expect(documentContentReadable(contentRead)).toBe(true);
      expect(documentContentReadable(metadataOnlyRead)).toBe(false);
      expect(documentContentReadable(fileListing)).toBe(false);
      expect(documentContentReadable({ error: 'forbidden' })).toBe(false);
    });
  });

  it.each(['search_public_web', 'search_intel_articles'])(
    'registers a %s summary as discovery but refuses to use it as repair evidence',
    async (toolName) => {
      const citations: import('@capiro/shared').MeriCitation[] = [];
      const ledgerEntries: import('@capiro/meriv2-core').LedgerEntry[] = [];
      const searchSchema = {
        name: toolName,
        input_schema: { properties: { query: {} }, required: ['query'] },
      };
      const executor = createOrchestratorToolExecutor({
        registry: registry(),
        schemas: [searchSchema],
        context: productionContext('What is the status of H.R. 1?'),
        citations,
        ledgerEntries,
        invoke: async () => ({
          data: [{ id: 'web-1', title: 'Official-looking result', snippet: 'H.R. 1 passed.' }],
        }),
      });
      await expect(
        executor.execute(
          { name: searchSchema.name, args: { ...remedyArgs(), query: 'H.R. 1 status' } },
          {},
        ),
      ).resolves.toMatchObject({
        ok: false,
        state: 'retrieval_failed',
        reason: 'discovery_requires_consulted_source',
      });
      expect(citations).toHaveLength(1);
      expect(ledgerEntries).toHaveLength(1);
    },
  );

  it('numbers repaired evidence with the mode the caller resolved, defaulting to stable numbering', async () => {
    const spy = jest.spyOn(contextEvidence, 'numberMeriEvidenceCitationsForMode');
    try {
      const invoke = async () => ({
        data: [
          {
            id: '119-hr-1',
            title: 'H.R. 1',
            url: 'https://example.test/hr1',
            snippet: 'Status: Enacted',
          },
        ],
      });
      await createOrchestratorToolExecutor({
        registry: registry(),
        schemas: [schema],
        context: productionContext('Status of H.R. 1?'),
        citations: [],
        ledgerEntries: [],
        invoke,
        evidenceAccuracyMode: 'off',
      }).execute({ name: schema.name, args: remedyArgs() }, {});
      expect(spy).toHaveBeenLastCalledWith(expect.any(Array), expect.any(Array), 'off');
      await createOrchestratorToolExecutor({
        registry: registry(),
        schemas: [schema],
        context: productionContext('Status of H.R. 1?'),
        citations: [],
        ledgerEntries: [],
        invoke,
      }).execute({ name: schema.name, args: remedyArgs() }, {});
      expect(spy).toHaveBeenLastCalledWith(expect.any(Array), expect.any(Array), 'enforce');
    } finally {
      spy.mockRestore();
    }
  });

  it('registers projected evidence with a stable citation marker', async () => {
    const citations: import('@capiro/shared').MeriCitation[] = [];
    const ledgerEntries: import('@capiro/meriv2-core').LedgerEntry[] = [];
    const executor = createOrchestratorToolExecutor({
      registry: registry(),
      schemas: [schema],
      context: productionContext('Status of H.R. 1?'),
      citations,
      ledgerEntries,
      invoke: async () => ({
        data: [
          {
            id: '119-hr-1',
            title: 'H.R. 1',
            url: 'https://example.test/hr1',
            snippet: 'Status: Enacted',
          },
        ],
      }),
    });
    const result = await executor.execute({ name: schema.name, args: remedyArgs() }, {});
    if (!result.ok) throw new Error(result.reason);
    expect(result).toMatchObject({
      ok: true,
      evidence: [expect.objectContaining({ sourceId: '119-hr-1' })],
    });
    if (result.ok) expect(result.evidence[0]?.locator).toBeUndefined();
    expect(citations).toHaveLength(1);
    expect(ledgerEntries).toEqual([
      expect.objectContaining({
        tool: schema.name,
        result: expect.any(Object),
        rowCount: 1,
      }),
    ]);

    const marker = `[S:${schema.name}:119-hr-1]`;
    const revised = `H.R. 1 was enacted [1] ${marker}.`;
    const formA = validateCitationMarkers(revised, citations);
    const formB = validateFormBCitations(formA.cleanedText, ledgerToToolResultMap(ledgerEntries));
    expect(formB).toMatchObject({ invalid: [], valid: [marker], sanitizedText: revised });
    const claimLedger = buildClaimLedgerFromToolResults({
      output: formB.sanitizedText,
      ledgerEntries,
      citations,
    });
    expect(claimLedger.claims.flatMap((claim) => claim.sourceIds)).toEqual(
      expect.arrayContaining(['citation:1:get_bill_status:119-hr-1']),
    );

    const withoutRegistration = validateFormBCitations(formA.cleanedText, {});
    expect(withoutRegistration.invalid).toEqual([marker]);
    expect(withoutRegistration.sanitizedText).not.toContain(marker);
  });
});
