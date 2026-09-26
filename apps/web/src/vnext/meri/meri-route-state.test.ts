import { describe, expect, test } from 'vitest';
import {
  legacyMeriWindowRedirect,
  mapPersistedAttachments,
  mapPersistedCharts,
  mapPersistedDocuments,
  mapPersistedContextPacketId,
  mapPersistedWorkPerformed,
  meriContextRequest,
  newestConversation,
  normalizeConversation,
  threadIdFromPath,
  withoutMeriContext,
} from './meri-route-state.js';

describe('vNext Meri route state', () => {
  test('canonicalizes legacy popup URLs and preserves only documented context', () => {
    expect(legacyMeriWindowRedirect('?meriWindow=1')).toBe('/meri');
    expect(
      legacyMeriWindowRedirect(
        '?meriWindow=1&meriPrompt=Analyze%20this&meriClient=client-123&other=discard-me',
      ),
    ).toBe('/meri/new?meriPrompt=Analyze+this&meriClient=client-123');
    expect(legacyMeriWindowRedirect('?meriWindow=0')).toBeNull();
    expect(legacyMeriWindowRedirect('?other=1')).toBeNull();
  });

  test('parses prompt and client launch context without accepting blank values', () => {
    expect(
      meriContextRequest('?meriPrompt=%20Analyze%20this%20&meriClient=%20client-123%20'),
    ).toEqual({ prompt: 'Analyze this', clientId: 'client-123', prospectId: null, researchPortfolioId: null });
    expect(meriContextRequest('?meriClient=client-123')).toEqual({
      prompt: '',
      clientId: 'client-123',
      prospectId: null,
      researchPortfolioId: null,
    });
    expect(meriContextRequest('?meriPrompt=%20&meriClient=%20')).toBeNull();
    expect(meriContextRequest('?other=1')).toBeNull();
  });

  test('parses a UUID prospect launch without accepting or inheriting client scope', () => {
    expect(
      meriContextRequest(
        '?meriPrompt=Prepare&meriProspect=11111111-1111-4111-8111-111111111111&meriClient=stale',
      ),
    ).toEqual({
      prompt: 'Prepare',
      clientId: null,
      prospectId: '11111111-1111-4111-8111-111111111111',
      researchPortfolioId: null,
    });
    expect(meriContextRequest('?meriPrompt=Prepare&meriProspect=not-a-uuid')).toBeNull();
    expect(withoutMeriContext('?meriProspect=11111111-1111-4111-8111-111111111111')).toBe('');
  });

  it('parses a distinct Research Portfolio launch without changing all-client portfolio scope', () => {
    expect(
      meriContextRequest(
        '?meriPrompt=Analyze&meriResearchPortfolio=22222222-2222-4222-8222-222222222222&meriClient=stale-client',
      ),
    ).toEqual({
      prompt: 'Analyze',
      clientId: null,
      prospectId: null,
      researchPortfolioId: '22222222-2222-4222-8222-222222222222',
    });
    expect(
      meriContextRequest('?meriResearchPortfolio=not-a-uuid'),
    ).toBeNull();
    expect(
      withoutMeriContext('?meriResearchPortfolio=22222222-2222-4222-8222-222222222222&other=1'),
    ).toBe('?other=1');
  });

  test('removes one-time context while retaining unrelated query state', () => {
    expect(withoutMeriContext('?meriPrompt=Analyze&meriClient=client-123&source=launcher')).toBe(
      '?source=launcher',
    );
    expect(withoutMeriContext('?meriPrompt=Analyze')).toBe('');
  });

  test('parses only durable thread routes and fails closed on malformed encodings', () => {
    expect(threadIdFromPath('/meri/t/abc-123')).toBe('abc-123');
    expect(threadIdFromPath('/meri/t/thread%20one')).toBe('thread one');
    expect(threadIdFromPath('/meri/new')).toBeNull();
    expect(threadIdFromPath('/meri/t/%E0%A4%A')).toBeNull();
  });

  test('normalizes server conversation rows without inventing scope or previews', () => {
    expect(
      normalizeConversation({
        id: 'conv-1',
        title: '',
        clientId: null,
        client: null,
        latestMessage: null,
        updatedAt: '2026-08-12T20:00:00.000Z',
      }),
    ).toEqual({
      id: 'conv-1',
      title: 'Untitled thread',
      clientId: null,
      client: null,
      latestMessage: null,
      updatedAt: '2026-08-12T20:00:00.000Z',
    });
    expect(normalizeConversation({ title: 'missing id' })).toBeNull();
  });

  test('retains only the bounded Research Portfolio scope needed to lock client switching', () => {
    expect(normalizeConversation({
      id: 'conv-rp',
      title: 'Portfolio analysis',
      updatedAt: '2026-09-26T05:00:00.000Z',
      metadata: {
        researchPortfolioScope: {
          kind: 'research_portfolio',
          researchPortfolioId: '33333333-3333-4333-8333-333333333333',
          researchPortfolioName: 'Autonomous Maritime Systems',
          researchPortfolioRevision: 9,
          scopeVersion: 'a'.repeat(64),
        },
      },
    })?.researchPortfolioScope).toEqual({
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Autonomous Maritime Systems',
      revision: 9,
    });
  });

  test('resolves the newest durable conversation by server updatedAt', () => {
    const older = normalizeConversation({
      id: 'older',
      title: 'Older',
      updatedAt: '2026-08-11T20:00:00.000Z',
    });
    const newer = normalizeConversation({
      id: 'newer',
      title: 'Newer',
      updatedAt: '2026-08-12T20:00:00.000Z',
    });
    expect(older).toBeTruthy();
    expect(newer).toBeTruthy();
    expect(newestConversation([older!, newer!])?.id).toBe('newer');
  });

  test('uses only UUID-shaped response-persisted context packet ids', () => {
    const packetId = 'de305d54-75b4-431b-adb2-eb6b9e546014';
    expect(mapPersistedContextPacketId({ metadata: { contextPacketId: packetId } })).toBe(packetId);
    expect(mapPersistedContextPacketId({ metadata: { contextPacket: { packetId } } })).toBe(
      packetId,
    );
    expect(
      mapPersistedContextPacketId({ metadata: { contextPacketId: 'not-a-uuid' } }),
    ).toBeUndefined();
    expect(
      mapPersistedContextPacketId({ metadata: { contextPacket: { packetId: 42 } } }),
    ).toBeUndefined();
    expect(mapPersistedContextPacketId({ metadata: {} })).toBeUndefined();
  });

  test('restores only persisted attachments and analysis chart artifacts with ids', () => {
    const message = {
      metadata: {
        attachments: [
          { id: 'att-1', filename: 'memo.pdf', kind: 'document', status: 'parsed' },
          { filename: 'missing-id.pdf' },
        ],
      },
      artifacts: [
        { id: 'chart-1', kind: 'analysis_chart', title: 'Funding by year' },
        { id: 'doc-1', kind: 'document', title: 'Draft' },
      ],
    };
    expect(mapPersistedAttachments(message)).toEqual([
      { id: 'att-1', filename: 'memo.pdf', kind: 'document', status: 'parsed' },
    ]);
    expect(mapPersistedCharts(message)).toEqual([{ id: 'chart-1', title: 'Funding by year' }]);
  });

  test('restores saved Word and PDF specs for canvas reopening without promoting charts or malformed rows', () => {
    const bodyText = JSON.stringify({ title: 'Saved briefing', sections: [{ heading: 'Facts', paragraphs: ['BLUE-ORBIT-47'] }] });
    const word = { id: 'word-1', kind: 'word_document', title: 'Saved briefing', bodyText };
    const pdf = { ...word, id: 'pdf-1', kind: 'pdf_document' };
    const restored = mapPersistedDocuments(JSON.parse(JSON.stringify({ artifacts: [
      word, pdf, word,
      { ...word, id: undefined }, { ...word, id: '../other' }, { ...word, bodyText: {} },
      { ...word, kind: 'analysis_chart' }, null,
    ] })));
    expect(restored).toEqual([word, pdf]);
    expect(mapPersistedDocuments({})).toEqual([]);
  });
});

describe('persisted Meri work receipts', () => {
  test('rehydrates canonical work with public details and counts', () => {
    expect(
      mapPersistedWorkPerformed({
        metadata: {
          intent: 'client_brief',
          tier: 'deep',
          plan: ['Check client evidence'],
          trustSteps: [
            {
              tool: 'search_memory',
              label: 'Client memory',
              status: 'done',
              detail: 'Found three approved facts',
              count: 3,
              confidence: 'high',
            },
          ],
        },
      }),
    ).toEqual({
      orchestratorIntent: 'client_brief',
      orchestratorTier: 'deep',
      planSteps: ['Check client evidence'],
      trustSteps: [
        {
          tool: 'search_memory',
          label: 'Client memory',
          status: 'done',
          detail: 'Found three approved facts',
          count: 3,
          confidence: 'high',
        },
      ],
    });
  });

  test('restores older V3 traces and held/blocked statuses without inventing success', () => {
    const work = mapPersistedWorkPerformed({
      metadata: {
        runtime: 'meriv3',
        reasoningMode: 'max',
        trace: [
          { tool: 'lookup', label: 'Lookup', status: 'done', detail: 'Found evidence' },
          { tool: 'send', label: 'Send message', status: 'pending_approval' },
          { tool: 'write', label: 'Write record', status: 'blocked', detail: 'Access denied' },
        ],
      },
    });
    expect(work.orchestratorTier).toBe('deep');
    expect(work.trustSteps).toEqual([
      { tool: 'lookup', label: 'Lookup', status: 'done', detail: 'Found evidence' },
      { tool: 'send', label: 'Send message', status: 'error', detail: 'Held for your approval' },
      { tool: 'write', label: 'Write record', status: 'error', detail: 'Access denied' },
    ]);
  });

  test('ignores malformed work and never hydrates private reasoning as public work', () => {
    const work = mapPersistedWorkPerformed({
      metadata: {
        intent: 42,
        tier: 'invented',
        plan: ['Public plan', null, 42],
        thinking: 'private thought',
        reasoning: 'private reasoning',
        trustSteps: [
          null,
          {},
          { tool: 'lookup', label: 'Lookup', status: 'invented' },
          {
            tool: 'lookup',
            label: 'Lookup',
            status: 'done',
            count: NaN,
            confidence: 'invented',
            detail: 42,
            reasoning: 'private detail',
          },
        ],
      },
    });
    expect(work).toEqual({
      orchestratorIntent: null,
      orchestratorTier: null,
      planSteps: ['Public plan'],
      trustSteps: [{ tool: 'lookup', label: 'Lookup', status: 'done' }],
    });
    expect(JSON.stringify(work)).not.toContain('private');
  });
});
