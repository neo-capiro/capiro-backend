import { afterEach, describe, expect, jest, test } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema.js';
import { PublicWebEntityResolutionProvider } from './canonical-public-web-entity-resolution.provider.js';
import { decideEntityResolutionStagePolicy } from './entity-resolution-stage-policy.js';
import type { EntityResolutionFallbackLookupInput } from './universal-entity-resolution-orchestrator.types.js';

function config(
  overrides: Partial<{
    CLIO_WEB_SEARCH_PROVIDER: 'duckduckgo' | 'tavily' | 'serper';
    TAVILY_API_KEY: string | undefined;
    SERPER_API_KEY: string | undefined;
  }> = {},
): ConfigService<AppConfig, true> {
  const values: Record<string, unknown> = {
    CLIO_WEB_SEARCH_PROVIDER: 'tavily',
    TAVILY_API_KEY: 'tvly-test-key',
    SERPER_API_KEY: undefined,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<AppConfig, true>;
}

function lookupInput(
  overrides: Partial<EntityResolutionFallbackLookupInput> = {},
): EntityResolutionFallbackLookupInput {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    actorUserId: null,
    query: 'Victory Six',
    normalizedQuery: 'victory six',
    entityTypeHint: 'organization',
    identifiers: [],
    priorCandidates: [],
    ...overrides,
  };
}

function mockFetchResolves(status: number, body: unknown): void {
  global.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

function mockFetchRejects(error: Error): void {
  global.fetch = jest.fn(async () => {
    throw error;
  }) as unknown as typeof fetch;
}

describe('PublicWebEntityResolutionProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('converts distinct results into candidate-only public_web_claim candidates', async () => {
    mockFetchResolves(200, {
      results: [
        {
          title: 'Victory Six, Inc. — Official Site',
          url: 'https://victorysix.example/',
          content: 'Defense contractor based in Virginia.',
          published_date: '2026-01-01',
        },
        {
          title: 'Victory Six wins new contract',
          url: 'https://news.example/victory-six-contract',
          content: 'Victory Six announced a new award.',
        },
      ],
    });

    const provider = new PublicWebEntityResolutionProvider(config());
    const result = await provider.lookup(lookupInput());

    expect(result.stage).toBe('public_web');
    expect(result.sourceStatus).toBe('complete');
    expect(result.candidates).toHaveLength(2);
    for (const candidate of result.candidates) {
      expect(candidate.canonicalName).toBe('Victory Six');
      expect(candidate.entityType).toBe('organization');
      expect(candidate.evidenceKinds).toEqual(['public_web_claim']);
      expect(candidate.sourceType).toBe('public_web:tavily');
      expect(candidate.sourceUrl).toMatch(/^https:\/\//);
      expect(candidate.confidence).toBeGreaterThan(0);
      expect(candidate.confidence).toBeLessThan(1);
    }
  });

  test('deduplicates results that resolve to the same normalized URL', async () => {
    mockFetchResolves(200, {
      results: [
        { title: 'Victory Six', url: 'https://victorysix.example/about/', content: 'a' },
        { title: 'Victory Six (duplicate)', url: 'https://victorysix.example/about', content: 'b' },
      ],
    });

    const provider = new PublicWebEntityResolutionProvider(config());
    const result = await provider.lookup(lookupInput());

    expect(result.sourceStatus).toBe('complete');
    expect(result.candidates).toHaveLength(1);
  });

  test('reports unavailable and never calls fetch when no provider key is configured', async () => {
    mockFetchResolves(200, { results: [] });
    const fetchSpy = global.fetch as jest.Mock;

    const provider = new PublicWebEntityResolutionProvider(
      config({ CLIO_WEB_SEARCH_PROVIDER: 'duckduckgo', TAVILY_API_KEY: undefined, SERPER_API_KEY: undefined }),
    );
    const result = await provider.lookup(lookupInput());

    expect(result.sourceStatus).toBe('unavailable');
    expect(result.stopReason).toBe('public_web_search_not_configured');
    expect(result.candidates).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('reports error on a non-2xx provider response', async () => {
    mockFetchResolves(500, { error: 'boom' });

    const provider = new PublicWebEntityResolutionProvider(config());
    const result = await provider.lookup(lookupInput());

    expect(result.sourceStatus).toBe('error');
    expect(result.stopReason).toBe('public_web_provider_http_500');
    expect(result.candidates).toEqual([]);
  });

  test('reports error when the response body is not valid JSON', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token');
      },
    })) as unknown as typeof fetch;

    const provider = new PublicWebEntityResolutionProvider(config());
    const result = await provider.lookup(lookupInput());

    expect(result.sourceStatus).toBe('error');
    expect(result.stopReason).toBe('public_web_provider_malformed_response');
    expect(result.candidates).toEqual([]);
  });

  test('reports error and a distinct reason on request timeout', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetchRejects(abortError);

    const provider = new PublicWebEntityResolutionProvider(config());
    const result = await provider.lookup(lookupInput());

    expect(result.sourceStatus).toBe('error');
    expect(result.stopReason).toBe('public_web_provider_timeout');
    expect(result.candidates).toEqual([]);
  });

  test('reports error on a network failure that is not a timeout', async () => {
    mockFetchRejects(new Error('getaddrinfo ENOTFOUND'));

    const provider = new PublicWebEntityResolutionProvider(config());
    const result = await provider.lookup(lookupInput());

    expect(result.sourceStatus).toBe('error');
    expect(result.stopReason).toBe('public_web_provider_network_error');
    expect(result.candidates).toEqual([]);
  });

  test('returns no candidates when the provider has no results', async () => {
    mockFetchResolves(200, { results: [] });

    const provider = new PublicWebEntityResolutionProvider(config());
    const result = await provider.lookup(lookupInput());

    expect(result.sourceStatus).toBe('complete');
    expect(result.candidates).toEqual([]);
  });

  test('returns no candidates for an empty query without calling fetch', async () => {
    mockFetchResolves(200, { results: [] });
    const fetchSpy = global.fetch as jest.Mock;

    const provider = new PublicWebEntityResolutionProvider(config());
    const result = await provider.lookup(lookupInput({ query: '   ' }));

    expect(result.sourceStatus).toBe('complete');
    expect(result.candidates).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('public-web evidence alone can never force a canonical resolution', async () => {
    mockFetchResolves(200, {
      results: [{ title: 'Victory Six, Inc.', url: 'https://victorysix.example/', content: 'x' }],
    });

    const provider = new PublicWebEntityResolutionProvider(config());
    const result = await provider.lookup(lookupInput());
    expect(result.candidates).toHaveLength(1);

    // Whatever this provider returns, the shared stage policy that the real
    // orchestrator consults hard-codes public_web as candidate-only — it can
    // never itself decide to auto-resolve, no matter the candidate count or
    // confidence.
    const decision = decideEntityResolutionStagePolicy('public_web', {
      candidateCount: result.candidates.length,
      evidenceKinds: result.candidates.flatMap((candidate) => candidate.evidenceKinds),
    });
    expect(decision.autoResolve).toBe(false);
    expect(decision.candidateOnly).toBe(true);
    expect(decision.mayRegisterGlobalPublic).toBe(false);
  });
});
