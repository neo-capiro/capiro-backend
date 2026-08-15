// Workspace Reasoning Gateway spec — tests that the gateway correctly
// delegates to the HTTP client and handles errors. The fetch implementation
// is mocked; tests never call a live model provider.

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { WorkspaceReasoningGateway } from './workspace-reasoning.gateway.js';

function makeGateway(url: string | undefined): WorkspaceReasoningGateway {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'MERIV3_ORCHESTRATOR_URL') return url;
      if (key === 'WORKSPACE_REASONING_TIMEOUT_MS') return '5000';
      return undefined;
    }),
  } as unknown as ConfigService;
  return new WorkspaceReasoningGateway(config);
}

describe('WorkspaceReasoningGateway', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('reports not configured when MERIV3_ORCHESTRATOR_URL is empty', () => {
    const gw = makeGateway('');
    expect(gw.configured).toBe(false);
  });

  it('reports configured when URL is set', () => {
    const gw = makeGateway('http://orchestrator.test');
    expect(gw.configured).toBe(true);
  });

  it('throws 503 when not configured', async () => {
    const gw = makeGateway('');
    await expect(
      gw.recommendDocumentSetup('t1', 'system', 'prompt'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('sends structured request to the orchestrator and returns parsed output', async () => {
    const gw = makeGateway('http://orchestrator.test');
    const mockOutput = {
      documentType: { id: 'ndaa', label: 'NDAA Paper', product: 'NDAA' },
      recommendedBlueprints: [],
      recommendedTheme: { id: 'default', name: 'Default' },
      questions: [],
      rationale: 'Test rationale',
    };
    const fetchMock = (jest.fn() as any).mockResolvedValue({
      ok: true,
      json: async () => ({ output: mockOutput, usage: { inputTokens: 10, outputTokens: 20 } }),
    });
    (globalThis as any).fetch = fetchMock as any;

    const result = await gw.recommendDocumentSetup('t1', 'system', 'prompt');
    expect(result).toEqual(mockOutput);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = (fetchMock.mock.calls[0] as [string, Record<string, unknown>]);
    expect(call[0]).toBe('http://orchestrator.test/meri-api/reasoning');
    const body = JSON.parse(String(call[1].body));
    expect(body.toolName).toBe('recommendDocumentSetup');
    expect(body.tenantId).toBe('t1');
    expect(body.inputSchema).toBeDefined();
  });

  it('throws 503 on HTTP error', async () => {
    const gw = makeGateway('http://orchestrator.test');
    const fetchMock = (jest.fn() as any).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal' }),
    });
    (globalThis as any).fetch = fetchMock as any;
    await expect(
      gw.recommendDocumentSetup('t1', 'system', 'prompt'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('throws 503 on network error', async () => {
    const gw = makeGateway('http://orchestrator.test');
    const fetchMock = (jest.fn() as any).mockRejectedValue(new Error('network error'));
    (globalThis as any).fetch = fetchMock as any;
    await expect(
      gw.recommendDocumentSetup('t1', 'system', 'prompt'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('does not return raw provider errors in the exception message', async () => {
    const gw = makeGateway('http://orchestrator.test');
    const fetchMock = (jest.fn() as any).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'SECRET_INTERNAL_ERROR' } }),
    });
    (globalThis as any).fetch = fetchMock as any;
    try {
      await gw.recommendDocumentSetup('t1', 'system', 'prompt');
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const msg = (err as ServiceUnavailableException).message;
      expect(msg).not.toContain('SECRET_INTERNAL_ERROR');
    }
  });
});

// Fail helper for jest
function fail(msg: string): never {
  throw new Error(msg);
}
