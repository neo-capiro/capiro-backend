import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { MeriV3ResearchRunner } from './meri-v3-research-runner.js';
import type { MeriV3ChatClient, MeriV3ChatStreamEvent, MeriV3RetrievalStreamSummary } from './meriv3-chat.client.js';
import { researchHandoffPrompt, type MeriResearchHandoff } from './meri-research-handoff.js';

// Infrastructure is replaced at its constructor boundary; the production runner
// and its actual event/credential/evidence logic execute unchanged.
jest.mock('../ai-credentials/ai-credential-resolver.service.js', () => ({ AiCredentialResolverService: class {} }));
jest.mock('./meri-conversation-evidence.service.js', () => ({ MeriConversationEvidenceService: class {} }));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('./meri-feature-flags.service.js', () => ({ MeriFeatureFlagsService: class {} }));

const ctx = { tenantId: 'tenant-a', userId: 'user-a', tenantSlug: 'internal' } as TenantContext;
const governedContext = { version: 1, prompt: 'Authorized client evidence', operationId: 'research.generate-report' } as MeriGovernedTurnContext;
const auth = { bearerToken: 'caller-token', impersonateTenantId: 'tenant-a', governedContext };
const handoff: MeriResearchHandoff = {
  version: 1, capturedAt: '2026-09-06T00:00:00.000Z', conversationId: 'thread-a', clientId: 'client-a', reasoningMode: 'max',
  requestedDeliverable: 'Client briefing', summary: 'Only discuss enacted funding.', summaryUpToMessageId: 'early-1', messages: [], attachments: [],
};
const input = { sessionId: 'research-a', clientId: 'client-a', system: 'Write a sourced briefing', user: 'The complete immutable handoff', handoff };

function fixture(events?: MeriV3ChatStreamEvent[]) {
  const done = { type: 'done', reply: '# Briefing\n\nEnacted funding matters.', runtime: 'meriv3', model: 'configured-chat-model', reasoningMode: 'max', reasoningEffort: 'high', steps: [{ tool: 'get_client_context', label: 'Client', status: 'done' }], ledgerEntries: [{ tool: 'get_client_context', result: { id: 'client-a' }, serialized: '{"id":"client-a"}' }], citations: [] } as MeriV3ChatStreamEvent;
  const client = {
    configured: true,
    streamChat: jest.fn(async (params: Parameters<MeriV3ChatClient['streamChat']>[0]) => {
      for (const event of events ?? [done]) params.onEvent(event);
    }),
  };
  const flags = { isMeriV3ChatEnabled: jest.fn(async () => true) };
  const credentials = { resolveProvider: jest.fn(async () => ({ provider: 'openai', apiKey: 'tenant-key', model: 'configured-chat-model' })) };
  const tx = { clioAttachment: { findMany: jest.fn(async () => [] as Array<{ id: string; data: Buffer; mediaType: string; status: string }>) } };
  const prisma = { withTenantUser: jest.fn(async (_tenant: string, _user: string, callback: (db: typeof tx) => unknown) => callback(tx)) };
  const conversationEvidence = { load: jest.fn(async () => ({ citations: [], unavailable: 0, omitted: 0 })) };
  const runner = new MeriV3ResearchRunner(client as never, flags as never, credentials as never, prisma as never, conversationEvidence as never);
  return { runner, client, flags, credentials, tx, prisma, done, conversationEvidence };
}

describe('MeriV3ResearchRunner primary runtime', () => {
  it('uses the same V3 gate and caller OpenAI credential, forwarding server scope, reasoning and governed context', async () => {
    const { runner, client, flags, credentials } = fixture();
    expect(await runner.enabled(ctx)).toBe(true);
    const result = await runner.run(ctx, input, auth, () => {});
    expect(flags.isMeriV3ChatEnabled).toHaveBeenCalledWith('tenant-a', 'internal');
    expect(credentials.resolveProvider).toHaveBeenCalledWith(ctx, 'openai');
    expect(client.streamChat).toHaveBeenCalledWith(expect.objectContaining({
      bearerToken: 'caller-token', impersonateTenantId: 'tenant-a',
      input: expect.objectContaining({ conversationId: 'thread-a', clientId: 'client-a', reasoningMode: 'max', governedContext, toolPolicy: 'read-only', messages: [{ role: 'user', text: input.user }] }),
    }));
    expect(result.model).toBe('configured-chat-model');
    expect(result.ledgerEntries).toHaveLength(1);
  });

  it('passes reauthorized inherited document observations into the same research runtime', async () => {
    const { runner, client, conversationEvidence } = fixture();
    const citation = { n: 56, id: 'doc-page-22', tool: 'read_client_documents', title: 'Capiro 2.0.pdf' };
    conversationEvidence.load.mockResolvedValue({ citations: [citation], unavailable: 0, omitted: 0 } as never);
    await runner.run(ctx, input, auth, () => {});
    expect(conversationEvidence.load).toHaveBeenCalledWith(ctx, 'thread-a', 'client-a', undefined, handoff.messages);
    expect(client.streamChat).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ inheritedDocumentEvidence: [citation] }) }));
  });

  it('does not leak a captured full document excerpt to the provider after replay authorization fails', async () => {
    const { runner, client, conversationEvidence } = fixture();
    const captured: MeriResearchHandoff = { ...handoff, messages: [{ id: 'earlier', role: 'assistant', body: 'Earlier briefing.', createdAt: '2026-09-07T00:00:00Z',
      metadata: { citations: [{ n: 56, tool: 'read_client_documents', id: 'doc-page-22', title: 'Document', snippet: 'REVOKED_SNIPPET',
        documentEvidence: { record: { payload: { text: 'REVOKED_EXACT_EXCERPT' } } } }] } }] };
    conversationEvidence.load.mockResolvedValue({ citations: [], unavailable: 1, omitted: 0 });
    await runner.run(ctx, { ...input, handoff: captured, user: researchHandoffPrompt(captured) }, auth, () => {});
    const outbound = client.streamChat.mock.calls[0]?.[0].input;
    expect(outbound?.inheritedDocumentEvidence).toEqual([]);
    expect(JSON.stringify(outbound)).not.toContain('REVOKED_EXACT_EXCERPT');
    expect(JSON.stringify(outbound)).not.toContain('REVOKED_SNIPPET');
    expect(captured.messages[0]?.metadata).toHaveProperty('citations.0.documentEvidence');
  });

  it('plans on the same runtime with tools disabled and honors Standard explicitly', async () => {
    const { runner, client } = fixture();
    await runner.plan(ctx, { ...input, handoff: { ...handoff, reasoningMode: 'standard' } }, auth);
    expect(client.streamChat).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ toolPolicy: 'none', reasoningMode: 'standard' }) }));
  });
  it('retains reconciled turn coverage in the research result rather than reverting to the initial packet', async () => {
    const base = fixture();
    const initial = {
      version: 1 as const, complete: false, requestedDomains: ['institutional_knowledge'], searchedDomains: [],
      missingDomains: ['institutional_knowledge'], partialDomains: [],
      requestedEntityCount: 1, searchedEntityCount: 0, recordsReturned: 0, recordsEvaluated: 0,
      paginationComplete: false, truncated: false, sourceHealth: [], unavailableSources: [], toolsInvoked: [], stopReason: 'source_error',
    };
    const retrieval: MeriV3RetrievalStreamSummary = {
      plan: { version: 1, queryClass: 'lookup', subjectScope: 'client', targetHint: null, recipeTool: null,
        requireCompleteCoverage: true, requiredDomains: ['institutional_knowledge'], timeWindow: null },
      coverage: { ...initial, phase: 'turn', complete: false, missingDomains: [], partialDomains: ['institutional_knowledge'],
        restoredSources: ['institutional_knowledge'],
        initialContext: initial,
        toolReads: [{ source: 'institutional_knowledge', tool: 'search_memory', status: 'partial', recordsReturned: 3, recordsEvaluated: 404, paginationComplete: false, truncated: false }],
      },
    };
    const { runner } = fixture([{ ...base.done, retrieval } as MeriV3ChatStreamEvent]);
    const result = await runner.run(ctx, input, auth, () => {});
    expect(result.retrieval).toEqual(retrieval);
  });

  it('does not fall back to another provider when V3 is missing its credential or configuration', async () => {
    const { runner, client, credentials } = fixture();
    client.configured = false;
    await expect(runner.run(ctx, input, auth, () => {})).rejects.toThrow('not configured');
    expect(credentials.resolveProvider).not.toHaveBeenCalled();
    expect(client.streamChat).not.toHaveBeenCalled();
  });

  it('rejects missing authentication or governed context before model execution', async () => {
    const { runner, client } = fixture();
    await expect(runner.run(ctx, input, { bearerToken: 'caller-token' }, () => {})).rejects.toThrow('authenticated conversation context');
    expect(client.streamChat).not.toHaveBeenCalled();
  });

  it.each([
    ['missing done', [{ type: 'text', text: 'partial' }]],
    ['provider error', [{ type: 'error', message: 'Provider unavailable' }]],
    ['held report', [{ type: 'done', reply: 'Held', held: true }]],
    ['missing evidence ledger', [{ type: 'done', reply: 'Report' }]],
    ['aborted response', [{ type: 'done', reply: 'partial', aborted: true }]],
    ['incomplete provider response', [{ type: 'done', reply: 'partial', ledgerEntries: [], telemetry: { partial: true, finishReason: 'max_output_tokens' } }]],
  ])('rejects %s instead of claiming a completed report', async (_name, events) => {
    const { runner } = fixture(events as MeriV3ChatStreamEvent[]);
    await expect(runner.run(ctx, input, auth, () => {})).rejects.toThrow();
  });

  it('forwards verified image bytes from the captured attachment and rejects later mutation', async () => {
    const { runner, client, tx } = fixture();
    const bytes = Buffer.from('original-image-bytes');
    tx.clioAttachment.findMany.mockResolvedValue([{ id: 'image-a', data: bytes, mediaType: 'image/png', status: 'image_ready' }]);
    const imageInput = { ...input, handoff: { ...handoff, attachments: [{ id: 'image-a', sourceMessageId: null, filename: 'budget.png', kind: 'image', status: 'image_ready', mediaType: 'image/png', byteSize: bytes.length, textContent: null, reason: null, source: 'clio_attachment:image-a', contentSha256: createHash('sha256').update(bytes).digest('hex') }] } };
    await runner.run(ctx, imageInput, auth, () => {});
    expect(tx.clioAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: ctx.tenantId, userId: ctx.userId }) }));
    expect(client.streamChat).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ currentTurnImages: [{ mediaType: 'image/png', dataBase64: bytes.toString('base64') }] }) }));
    const request = client.streamChat.mock.calls[0]?.[0];
    expect(request?.input.skillAddendum).toContain('get_research_evidence with sessionId="research-a"');
    expect(request?.input.skillAddendum).toContain('[S:get_research_evidence:ID]');
    tx.clioAttachment.findMany.mockResolvedValue([{ id: 'image-a', data: Buffer.from('changed'), mediaType: 'image/png', status: 'image_ready' }]);
    await expect(runner.run(ctx, imageInput, auth, () => {})).rejects.toThrow('changed since the handoff');
    expect(client.streamChat).toHaveBeenCalledTimes(1);
  });

  it('translates V3 tool progress into the established research UI events', async () => {
    const base = fixture();
    const { runner } = fixture([
      { type: 'tool_call', tool: 'get_client_context', label: 'Client' },
      { type: 'tool_done', tool: 'get_client_context', label: 'Client', status: 'done', detail: '3 capabilities' },
      base.done,
    ]);
    const onEvent = jest.fn();
    await runner.run(ctx, input, auth, onEvent);
    expect(onEvent).toHaveBeenCalledWith({ type: 'step', tool: 'get_client_context', label: 'Client' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'source', source: { tool: 'get_client_context', label: 'Client', summary: '3 capabilities', confidence: 'high' } });
  });
});
