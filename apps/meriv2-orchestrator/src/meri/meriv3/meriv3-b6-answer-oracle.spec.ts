import type { MeriContext, ToolRegistry } from '@capiro/meriv2-core';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { MeriV3AssistantService } from './meriv3-assistant.service.js';
import { projectMeriToolEvidence } from './meriv3-tool-evidence.js';

const context = {
  tenantId: 'fixture-tenant',
  userId: 'fixture-user',
  firmMemory: null,
  userVoice: null,
  clientSteering: null,
  clientRoster: [],
} as unknown as MeriContext;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: 'synthetic-provider-response',
    status: 'completed',
    output: [],
    outputText: '',
    functionCalls: [],
    usage,
    model: 'synthetic-provider',
    usedTenantKey: false,
    incompleteReason: null,
    telemetry: {
      requestedModel: 'synthetic-provider',
      effectiveModel: 'synthetic-provider',
      requestedReasoningEffort: 'medium',
      effectiveReasoningEffort: 'medium',
      reasoningFallbackReasons: [],
      finishReason: 'completed',
      partial: false,
    },
    ...overrides,
  };
}

function functionCall(name: string, args: Record<string, unknown>, callId: string) {
  return {
    type: 'function_call' as const,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
}

function toolRound(name: string, args: Record<string, unknown>, callId: string) {
  const call = functionCall(name, args, callId);
  return response({ output: [call], functionCalls: [call] });
}

function buildAssistant(
  names: string[],
  invoke: jest.Mock,
  complete: jest.Mock,
): MeriV3AssistantService {
  const definitions = new Map(names.map((name) => [name, { name, readOnly: true }]));
  const registry = {
    list: () => names,
    get: (name: string) => definitions.get(name),
    executionMetadata: (name: string) => definitions.has(name)
      ? { name, readOnly: true, executionMode: 'read', externalEffect: 'none',
          reversible: true, riskTier: 'low', displayVerb: name }
      : undefined,
    invoke,
  } as unknown as ToolRegistry;
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, callback: (tx: unknown) => unknown) =>
      callback({
        aiUsageEvent: { create: jest.fn(async () => ({})) },
        meriAuditLedger: { create: jest.fn(async () => ({})) },
      })),
  };
  return new MeriV3AssistantService(
    { registry, llm: { completeJson: jest.fn(), completeWithSchema: jest.fn() } } as never,
    { complete } as never,
    { create: jest.fn() } as never,
    prisma as never,
    { get: jest.fn(() => 'http://fixture-api.test') } as never,
  );
}

function schema(name: string, properties: Record<string, unknown>) {
  return {
    name,
    description: `Synthetic ${name} fixture`,
    input_schema: { type: 'object', properties },
  };
}

function installToolSchemas(schemas: ReturnType<typeof schema>[]) {
  global.fetch = jest.fn(async (url) => {
    if (String(url) !== 'http://fixture-api.test/api/clio/tool-schemas') {
      throw new Error(`Unexpected network request: ${String(url)}`);
    }
    return new Response(JSON.stringify({ schemas }), { status: 200 });
  }) as typeof fetch;
}

function toolOutputs(input: unknown): Array<{ call_id: string; output: string }> {
  if (!Array.isArray(input)) return [];
  return input.filter((item): item is { call_id: string; output: string } =>
    typeof item === 'object' && item !== null &&
    (item as { type?: unknown }).type === 'function_call_output' &&
    typeof (item as { output?: unknown }).output === 'string');
}

function visiblePayload(output: string): unknown {
  return JSON.parse(output.slice(output.lastIndexOf('\n') + 1));
}

describe('B6 local V3 answer oracle with synthetic provider and tool results', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('carries a source-qualified bill resolution into the exact status reader and cited answer', async () => {
    const prompt = 'What happened to H.R. 8800 in the 119th Congress? Cite the source record.';
    const sourceUrl = 'https://www.congress.gov/bill/119th-congress/house-bill/8800';
    const resolved = {
      tool: 'resolve_entity',
      query: 'H.R. 8800',
      matchesFound: 1,
      resolution: 'resolved',
      matches: [{
        entityType: 'bill', canonicalId: '119-hr-8800', displayName: 'H.R. 8800',
        jurisdiction: 'US', congress: 119, matchedBy: 'bill-id',
        sourceRef: {
          namespace: 'congress_bill', recordId: '119-hr-8800', sourceUrl,
          eventDate: '2026-06-01T00:00:00.000Z',
          sourceUpdatedAt: '2026-06-01T15:00:00.000Z',
          sourceCheckedAt: null, syncedAt: '2026-06-02T00:00:00.000Z',
        },
      }],
    };
    const status = {
      tool: 'get_bill_status', billId: '119-hr-8800', found: true,
      title: 'National Defense Authorization Act FY2027', congress: 119,
      status: 'referred', statusLabel: 'Referred to committee',
      latestAction: { text: 'Referred to the Committee on Armed Services.',
        date: '2026-06-01T00:00:00.000Z' },
      floorVotes: [], note: 'No recorded roll-call vote on this bill itself.',
    };
    const source = {
      tool: 'search_congress_bills',
      generatedAt: '2026-06-02T00:00:00.000Z',
      data: [{ id: '119-hr-8800', title: 'National Defense Authorization Act FY2027',
        congress: 119, status: 'referred',
        latestAction: 'Referred to the Committee on Armed Services.',
        latestActionDate: '2026-06-01T00:00:00.000Z', url: sourceUrl }],
      total: 1, page: 1, limit: 20, resolvedBy: 'bill-id',
    };
    const rawResults = [resolved, status, source];
    const callArgs = [
      { query: 'H.R. 8800', type: 'bill', congress: 119 },
      { billId: '119-hr-8800' },
      { query: '119-hr-8800', congress: 119 },
    ];
    const expectedAnswer =
      'H.R. 8800 in the 119th Congress was referred to the Committee on Armed Services on June 1, 2026 [1]. No roll-call vote on the bill was recorded in this result.';
    const scripted = [
      toolRound('resolve_entity', callArgs[0]!, 'resolve'),
      toolRound('get_bill_status', callArgs[1]!, 'status'),
      toolRound('search_congress_bills', callArgs[2]!, 'source'),
      response({ outputText: expectedAnswer }),
    ];
    const providerInputs: unknown[] = [];
    const complete = jest.fn(async (request: { input: unknown }) => {
      providerInputs.push(JSON.parse(JSON.stringify(request.input)));
      return scripted.shift()!;
    });
    const invoke = jest.fn(async (_name: string, _args: Record<string, unknown>) => rawResults.shift()!);
    installToolSchemas([
      schema('resolve_entity', { query: {}, type: {}, congress: {} }),
      schema('get_bill_status', { billId: {} }),
      schema('search_congress_bills', { query: {}, congress: {} }),
    ]);
    const assistant = buildAssistant(
      ['resolve_entity', 'get_bill_status', 'search_congress_bills'], invoke, complete,
    );
    const result = await RequestCredentialsStore.run({ bearerToken: 'synthetic-bearer' }, () =>
      assistant.run(context, {
        conversationId: 'b6-source-oracle', toolPolicy: 'read-only',
        messages: [{ role: 'user', text: prompt }],
      }));

    // Assert independent owner facts and the dependent reader route first.
    expect(invoke.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ['resolve_entity', callArgs[0]],
      ['get_bill_status', callArgs[1]],
      ['search_congress_bills', callArgs[2]],
    ]);
    expect(result.ledgerEntries?.map((entry) => entry.result)).toEqual([resolved, status, source]);
    expect(toolOutputs(providerInputs[1])).toHaveLength(1);
    expect(toolOutputs(providerInputs[2])).toHaveLength(2);
    const outputs = toolOutputs(providerInputs[3]);
    expect(outputs.map((item) => item.call_id)).toEqual(['resolve', 'status', 'source']);
    expect(outputs.map((item) => visiblePayload(item.output))).toEqual([resolved, status, source]);
    expect(outputs[2]?.output).toContain('Citable sources (cite these in prose as [N]');
    const modelVisible = JSON.stringify(providerInputs[3]);
    expect(modelVisible).toContain('119-hr-8800');
    expect(modelVisible).toContain('2026-06-01T00:00:00.000Z');
    expect(modelVisible).toContain('Referred to the Committee on Armed Services.');
    expect(modelVisible).toContain(sourceUrl);
    expect(result.citations).toEqual([
      expect.objectContaining({ n: 1, tool: 'search_congress_bills',
        id: '119-hr-8800', url: sourceUrl }),
    ]);
    expect(result.toolCoverage).toContainEqual(expect.objectContaining({
      source: 'legiwatch_bills', tool: 'search_congress_bills', status: 'partial',
      recordsReturned: 1, recordsDisplayed: 1, recordsMatched: 1,
      paginationComplete: null, truncated: false,
    }));
    expect(result.reply).toBe(expectedAnswer);
    expect(result.reply).toContain('[1]');
    expect(result.reply).not.toMatch(/passed|enacted|signed/i);
  });

  it('shows an identity-only clipped result as partial and releases an explicit limitation', async () => {
    const prompt = 'What does the source say about H.R. 8800?';
    const recordId = 'US:119:HR:8800';
    const sourceUrl = 'https://www.congress.gov/bill/119th-congress/house-bill/8800';
    const raw = {
      tool: 'search_capiro_data',
      scope: { query: 'H.R. 8800', jurisdiction: 'US', from: '2026-01-01' },
      totalMatches: 1, recordsEvaluated: 12, returned: 1,
      nextCursor: 'source-after-one',
      coverage: { complete: false, paginationComplete: false, sources: [{
        domain: 'legiwatch_bills', sourceStatus: 'degraded',
        stopReason: 'source_sync_stale', returned: 1,
      }] },
      records: [{
        domain: 'legiwatch_bills', recordId, sourceRevision: 'sha256-known',
        observedAt: '2026-09-24T00:00:00.000Z', sourceUrl,
        title: 'Known bill', text: 'Unread owner body. '.repeat(2_000),
      }],
    };
    const expectedAnswer =
      'I found one matching source record, but its body was clipped from the evidence I could review. The source is partial, so I cannot verify what it says yet. Please narrow the request for another read.';
    const callArgs = { query: 'H.R. 8800', domains: ['legiwatch_bills'], pageSize: 50 };
    const scripted = [
      toolRound('search_capiro_data', callArgs, 'clipped-read'),
      response({ outputText: expectedAnswer }),
    ];
    const providerInputs: unknown[] = [];
    const complete = jest.fn(async (request: { input: unknown }) => {
      providerInputs.push(JSON.parse(JSON.stringify(request.input)));
      return scripted.shift()!;
    });
    const invoke = jest.fn(async (_name: string, _args: Record<string, unknown>) => raw);
    installToolSchemas([
      schema('search_capiro_data', { query: {}, domains: {}, pageSize: {}, cursors: {} }),
    ]);
    const assistant = buildAssistant(['search_capiro_data'], invoke, complete);
    const result = await RequestCredentialsStore.run({ bearerToken: 'synthetic-bearer' }, () =>
      assistant.run(context, {
        conversationId: 'b6-clipped-oracle', toolPolicy: 'read-only',
        messages: [{ role: 'user', text: prompt }],
      }));

    expect(invoke.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ['search_capiro_data', callArgs],
    ]);
    expect(raw.records).toHaveLength(1);
    expect(raw.records[0]!.text).toContain('Unread owner body.');
    const visible = result.ledgerEntries?.[0]?.result as Record<string, any>;
    expect(visible).toMatchObject({
      scope: raw.scope, totalMatches: 1, recordsEvaluated: 12,
      returned: 0, records: [], complete: false, truncated: true, partial: true,
      nextCursor: null, coverage: { complete: false, paginationComplete: false },
      projection: {
        sourceRecordCount: 1, shownRecordCount: 0, omittedRecordCount: 1,
        identitiesAreNotEvidence: true, sourceNextCursor: 'source-after-one',
        omittedRecordIdentities: [{ recordId, sourceRevision: 'sha256-known', sourceUrl }],
      },
    });
    expect(JSON.stringify(visible)).not.toContain('Unread owner body.');
    const visibleToolOutput = toolOutputs(providerInputs[1])[0]?.output;
    expect(visibleToolOutput).toContain(recordId);
    expect(visibleToolOutput).toContain('source-after-one');
    expect(visibleToolOutput).not.toContain('Unread owner body.');
    expect(visiblePayload(visibleToolOutput!)).toEqual(visible);
    expect(result.toolCoverage).toEqual([
      expect.objectContaining({
        source: 'legiwatch_bills', tool: 'search_capiro_data', status: 'partial',
        recordsReturned: 1, recordsDisplayed: 0, recordsOmitted: 1,
        paginationComplete: false, truncated: true,
      }),
    ]);
    expect(result.citations ?? []).toEqual([]);
    expect(result.reply).toBe(expectedAnswer);
    expect(result.reply).not.toContain(recordId);
    expect(result.reply).not.toMatch(/\[\d+\]/);
  });

  it('rejects a valid-looking citation URL for the wrong Congress and bill', async () => {
    const prompt = 'Summarize the indexed H.R. 8800 record in the 119th Congress.';
    const unrelatedUrl = 'https://www.congress.gov/bill/118th-congress/house-bill/1';
    const wrongBillUrl = 'https://www.congress.gov/bill/119th-congress/house-bill/8801';
    const raw = {
      tool: 'search_congress_bills',
      data: [{ id: '119-hr-8800', title: 'Synthetic H.R. 8800', congress: 119,
        status: 'referred', latestAction: 'Referred to committee.',
        url: unrelatedUrl, sourceUrl: wrongBillUrl, billUrl: wrongBillUrl }],
      total: 1, page: 1, limit: 20, resolvedBy: 'bill-id',
    };
    const callArgs = { query: '119-hr-8800', congress: 119 };
    const scripted = [
      toolRound('search_congress_bills', callArgs, 'wrong-url'),
      response({ outputText: 'The indexed bill was referred to committee [1].' }),
    ];
    const providerInputs: unknown[] = [];
    const complete = jest.fn(async (request: { input: unknown }) => {
      providerInputs.push(JSON.parse(JSON.stringify(request.input)));
      return scripted.shift()!;
    });
    const invoke = jest.fn(async (_name: string, _args: Record<string, unknown>) => raw);
    installToolSchemas([schema('search_congress_bills', { query: {}, congress: {} })]);
    const assistant = buildAssistant(['search_congress_bills'], invoke, complete);
    const result = await RequestCredentialsStore.run({ bearerToken: 'synthetic-bearer' }, () =>
      assistant.run(context, {
        conversationId: 'b6-wrong-url-oracle', toolPolicy: 'read-only',
        messages: [{ role: 'user', text: prompt }],
      }));

    expect(invoke.mock.calls[0]?.slice(0, 2)).toEqual(['search_congress_bills', callArgs]);
    expect(raw.data[0]?.url).toBe(unrelatedUrl);
    expect(raw.data[0]?.sourceUrl).toBe(wrongBillUrl);
    expect(raw.data[0]?.billUrl).toBe(wrongBillUrl);
    const expectedVisible = {
      ...raw,
      data: [{ ...raw.data[0], url: null, sourceUrl: null, billUrl: null }],
    };
    expect(result.ledgerEntries?.[0]?.result).toEqual(expectedVisible);
    const output = toolOutputs(providerInputs[1])[0]!.output;
    expect(visiblePayload(output)).toEqual(expectedVisible);
    expect(output).not.toContain(unrelatedUrl);
    expect(output).not.toContain(wrongBillUrl);
    // A 118th-Congress URL cannot source a 119th-Congress row. The record ID
    // remains citable, but the unrelated link must never enter the citation.
    expect(result.citations).toEqual([
      expect.objectContaining({ id: '119-hr-8800', url: null }),
    ]);
    expect(result.reply).toBe('The indexed bill was referred to committee [1].');
  });

  it('scrubs bill URL aliases from supported row arrays and evidence envelopes', () => {
    const wrongUrl = 'https://www.congress.gov/bill/118th-congress/house-bill/1';
    const row = { id: '119-hr-8800', link: wrongUrl, htmlUrl: wrongUrl,
      pdfLink: wrongUrl, xmlLink: wrongUrl, documentUrl: wrongUrl, webUrl: wrongUrl };
    const raw = {
      data: [row], results: [row], items: [row], rows: [row],
      records: [{ recordId: '119-hr-8800', payload: row }],
    };
    const visible = projectMeriToolEvidence({
      toolName: 'search_congress_bills', result: raw,
      maxCharacters: 12_000, readOnly: true,
    }) as Record<string, any>;
    expect(JSON.stringify(visible)).not.toContain(wrongUrl);
    expect(visible.data[0]).toMatchObject({
      id: '119-hr-8800', link: null, htmlUrl: null,
      pdfLink: null, xmlLink: null, documentUrl: null, webUrl: null,
    });
    expect(visible.records[0].payload).toMatchObject({
      id: '119-hr-8800', link: null, htmlUrl: null,
      pdfLink: null, xmlLink: null, documentUrl: null, webUrl: null,
    });
    expect(raw.data[0]?.link).toBe(wrongUrl);
    expect(raw.records[0]?.payload.link).toBe(wrongUrl);
    const arrayVisible = projectMeriToolEvidence({
      toolName: 'search_congress_bills', result: [row],
      maxCharacters: 12_000, readOnly: true,
    }) as Array<Record<string, unknown>>;
    expect(arrayVisible).toEqual([{
      ...row, link: null, htmlUrl: null, pdfLink: null,
      xmlLink: null, documentUrl: null, webUrl: null,
    }]);
    expect(row.link).toBe(wrongUrl);
  });
});
