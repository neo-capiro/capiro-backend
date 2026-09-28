import { verifyMeriGovernedContext, type MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { MeriV3ChatClient } from './meriv3-chat.client.js';

const actor = { tenantId: 'tenant-1', userId: 'user-1' };
function input() {
  return {
    messages: [{ role: 'user' as const, text: 'Brief me' }],
    conversationId: 'conversation-1',
    reasoningMode: 'standard' as const,
    governedContext: {
      version: 1,
      operationId: 'meri.chat',
      prompt: 'API compiled evidence',
      contextPacket: {
        packetId: 'packet-1',
        items: [],
        exclusions: [],
        unauthorizedCount: 0,
        degraded: false,
      },
      retrieval: {} as MeriGovernedTurnContext['retrieval'],
      evidence: {
        version: 1,
        ...actor,
        packetId: 'packet-1',
        sourceRecordCount: 0,
        projectedRecordCount: 0,
        truncated: false,
        records: [],
      },
    } as MeriGovernedTurnContext,
  };
}

describe('API authenticated governed context transport', () => {
  const priorSecret = process.env.INTERNAL_SERVICE_SECRET;
  const priorUrl = process.env.MERIV2_ORCHESTRATOR_URL;
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = 'test-only-service-secret';
    process.env.MERIV2_ORCHESTRATOR_URL = 'https://orchestrator.example';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const [key, value] of [
      ['INTERNAL_SERVICE_SECRET', priorSecret],
      ['MERIV2_ORCHESTRATOR_URL', priorUrl],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  it('signs the immutable context for the exact outbound conversation and messages', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    } as Response);
    const original = input();
    await new MeriV3ChatClient().streamChat({
      bearerToken: 'test-user-token',
      input: original,
      onEvent: jest.fn(),
    });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(() =>
      verifyMeriGovernedContext(
        body.governedContext,
        body,
        actor,
        process.env.INTERNAL_SERVICE_SECRET,
      ),
    ).not.toThrow();
    expect(original.governedContext.attestation).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('test-only-service-secret');
  });
  it('signs reauthorized document observations and rejects any altered excerpt', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    } as Response);
    const original = {
      ...input(),
      inheritedDocumentEvidence: [
        {
          n: 56,
          type: 'source',
          tool: 'read_client_documents',
          id: 'doc-page-22',
          title: 'Capiro 2.0.pdf',
          url: null,
          snippet: 'Original snippet',
          documentEvidence: {
            clientId: 'client-1',
            documentId: 'doc-1',
            contentHash: 'a'.repeat(64),
            record: {
              recordId: 'doc-page-22',
              payload: { text: 'Exact earlier excerpt', section: 22 },
            },
            coverage: { complete: false, disclosure: 'Page only' },
            observedAt: '2026-09-07T00:00:00Z',
          },
        },
      ],
    };
    await new MeriV3ChatClient().streamChat({
      bearerToken: 'test-user-token',
      input: original,
      onEvent: jest.fn(),
    });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.governedContext.inheritedDocumentEvidence).toEqual(
      original.inheritedDocumentEvidence,
    );
    expect(() =>
      verifyMeriGovernedContext(
        body.governedContext,
        body,
        actor,
        process.env.INTERNAL_SERVICE_SECRET,
      ),
    ).not.toThrow();
    body.governedContext.inheritedDocumentEvidence[0].documentEvidence.record.payload.text =
      'Forged evidence';
    expect(() =>
      verifyMeriGovernedContext(
        body.governedContext,
        body,
        actor,
        process.env.INTERNAL_SERVICE_SECRET,
      ),
    ).toThrow('authentication_failed');
  });

  it('fails closed before sending evidence if service identity is unavailable', async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    const fetch = jest.spyOn(globalThis, 'fetch');
    await expect(
      new MeriV3ChatClient().streamChat({
        bearerToken: 'test-user-token',
        input: input(),
        onEvent: jest.fn(),
      }),
    ).rejects.toThrow('service_identity_unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });
});
