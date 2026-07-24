import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import {
  ExecutionArtifactClient,
  ExecutionArtifactError,
} from './execution-artifact.client.js';

/*
 * Stage G artifact hop. Mocks global fetch to assert the EXACT two-call
 * workspace sequence (bodies + Bearer + x-internal-service-secret headers), the
 * 240-char outreach title clamp, that timeouts / non-2xx surface as a typed
 * ExecutionArtifactError (never a silent success), that a missing bearer never
 * touches the network, and — the safety boundary — that ONLY the two known
 * creation endpoints are ever hit (no /send or dispatch URL).
 */

const BASE = 'https://internal.capiro.test';
const SECRET = 'shh-internal-secret';
const BEARER = 'user-jwt-abc';

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  const values: Record<string, string | undefined> = {
    API_INTERNAL_URL: BASE,
    INTERNAL_SERVICE_SECRET: SECRET,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    statusText: 'stub',
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: jest.Mock;
let calls: FetchCall[];

const nthCall = (i: number): FetchCall => {
  const c = calls[i];
  if (!c) throw new Error(`expected a fetch call at index ${i}`);
  return c;
};

function recordCall(url: unknown, init: unknown): FetchCall {
  const i = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string };
  return {
    url: String(url),
    method: i.method ?? 'GET',
    headers: i.headers ?? {},
    body: i.body ? JSON.parse(i.body) : undefined,
  };
}

beforeEach(() => {
  calls = [];
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createWorkspaceDraft', () => {
  it('replays the web two-call sequence with correct bodies + headers', async () => {
    fetchMock.mockImplementation((url: unknown, init: unknown) => {
      calls.push(recordCall(url, init));
      if (String(url).endsWith('/workspace-api/drafts')) {
        return Promise.resolve(jsonResponse({ id: 'draft-1', config: { sections: ['Analysis', 'Background'] } }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const client = new ExecutionArtifactClient(makeConfig());
    const result = await client.createWorkspaceDraft(BEARER, {
      docTitle: 'Q3 posture memo',
      clientName: 'Acme Defense',
      product: 'Strategy memo',
      sections: { Analysis: '<p>context</p>', Background: '<p>more</p>' },
    });

    expect(result).toEqual({ ref: 'draft-1' });
    expect(calls).toHaveLength(2);

    // (1) POST /workspace-api/drafts { docTitle, client: NAME, product }
    expect(nthCall(0).method).toBe('POST');
    expect(nthCall(0).url).toBe(`${BASE}/workspace-api/drafts`);
    expect(nthCall(0).body).toEqual({
      docTitle: 'Q3 posture memo',
      client: 'Acme Defense',
      product: 'Strategy memo',
    });
    expect(nthCall(0).headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(nthCall(0).headers['x-internal-service-secret']).toBe(SECRET);
    expect(nthCall(0).headers['content-type']).toBe('application/json');

    // (2) PATCH /workspace-api/drafts/:id { config: { sections: [...], sectionContent: {...} } }
    // — the FULL ordered heading list + every heading's HTML (a multi-section
    // grounded draft needs every heading rendered, not just one default section).
    expect(nthCall(1).method).toBe('PATCH');
    expect(nthCall(1).url).toBe(`${BASE}/workspace-api/drafts/draft-1`);
    expect(nthCall(1).body).toEqual({
      config: {
        sections: ['Analysis', 'Background'],
        sectionContent: { Analysis: '<p>context</p>', Background: '<p>more</p>' },
      },
    });
    expect(nthCall(1).headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(nthCall(1).headers['x-internal-service-secret']).toBe(SECRET);
  });

  it("falls back to a single 'Background' section when the caller passes an empty section map", async () => {
    fetchMock.mockImplementation((url: unknown, init: unknown) => {
      calls.push(recordCall(url, init));
      if (String(url).endsWith('/workspace-api/drafts')) {
        return Promise.resolve(jsonResponse({ id: 'draft-2' }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ExecutionArtifactClient(makeConfig());
    await client.createWorkspaceDraft(BEARER, {
      docTitle: 'T',
      clientName: 'C',
      product: 'White paper',
      sections: {},
    });

    expect(nthCall(1).url).toBe(`${BASE}/workspace-api/drafts/draft-2`);
    expect(nthCall(1).body).toEqual({
      config: { sections: ['Background'], sectionContent: { Background: '' } },
    });
  });

  it('does not send x-internal-service-secret when it is not configured', async () => {
    fetchMock.mockImplementation((url: unknown, init: unknown) => {
      calls.push(recordCall(url, init));
      if (String(url).endsWith('/workspace-api/drafts')) {
        return Promise.resolve(jsonResponse({ id: 'd', config: { sections: ['S'] } }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ExecutionArtifactClient(makeConfig({ INTERNAL_SERVICE_SECRET: undefined }));
    await client.createWorkspaceDraft(BEARER, {
      docTitle: 'T',
      clientName: 'C',
      product: 'P',
      sections: { Background: '<p/>' },
    });
    expect(nthCall(0).headers['x-internal-service-secret']).toBeUndefined();
    expect(nthCall(0).headers.authorization).toBe(`Bearer ${BEARER}`);
  });

  it('throws a typed error (no network) when the caller bearer is missing', async () => {
    const client = new ExecutionArtifactClient(makeConfig());
    await expect(
      client.createWorkspaceDraft(undefined, {
        docTitle: 'T',
        clientName: 'C',
        product: 'P',
        sections: { Background: '<p/>' },
      }),
    ).rejects.toMatchObject({ name: 'ExecutionArtifactError', kind: 'missing_bearer' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws ExecutionArtifactError(malformed) when the create returns no id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ notAnId: true }) as never);
    const client = new ExecutionArtifactClient(makeConfig());
    await expect(
      client.createWorkspaceDraft(BEARER, {
        docTitle: 'T',
        clientName: 'C',
        product: 'P',
        sections: { Background: '<p/>' },
      }),
    ).rejects.toMatchObject({ name: 'ExecutionArtifactError', kind: 'malformed' });
    // No PATCH attempted after a malformed create.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a non-2xx upstream response to ExecutionArtifactError(upstream) with status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 502 }) as never);
    const client = new ExecutionArtifactClient(makeConfig());
    const err = await client
      .createWorkspaceDraft(BEARER, { docTitle: 'T', clientName: 'C', product: 'P', sections: { Background: '<p/>' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutionArtifactError);
    expect((err as ExecutionArtifactError).kind).toBe('upstream');
    expect((err as ExecutionArtifactError).status).toBe(502);
  });

  it('maps an aborted (timeout) fetch to ExecutionArtifactError(timeout)', async () => {
    fetchMock.mockImplementation(() => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      return Promise.reject(e);
    });
    const client = new ExecutionArtifactClient(makeConfig());
    await expect(
      client.createWorkspaceDraft(BEARER, { docTitle: 'T', clientName: 'C', product: 'P', sections: { Background: '<p/>' } }),
    ).rejects.toMatchObject({ name: 'ExecutionArtifactError', kind: 'timeout' });
  });
});

describe('createOutreachRecord', () => {
  it('posts a campaign with the 240-char title clamp + clientId + metadata', async () => {
    fetchMock.mockImplementation((url: unknown, init: unknown) => {
      calls.push(recordCall(url, init));
      return Promise.resolve(jsonResponse({ id: 'outreach-9' }));
    });

    const longTitle = 'x'.repeat(300);
    const client = new ExecutionArtifactClient(makeConfig());
    const result = await client.createOutreachRecord(BEARER, {
      title: longTitle,
      subject: 'Subject line',
      clientId: 'client-uuid',
      metadata: { strategyNodeId: 'n1' },
    });

    expect(result).toEqual({ ref: 'outreach-9' });
    expect(calls).toHaveLength(1);
    expect(nthCall(0).method).toBe('POST');
    expect(nthCall(0).url).toBe(`${BASE}/api/engagement/outreach`);
    const body = nthCall(0).body as { type: string; title: string; subject: string; clientId: string; metadata: unknown };
    expect(body.type).toBe('campaign');
    expect(body.title).toHaveLength(240);
    expect(body.title).toBe(longTitle.slice(0, 240));
    expect(body.subject).toBe('Subject line');
    expect(body.clientId).toBe('client-uuid');
    expect(body.metadata).toEqual({ strategyNodeId: 'n1' });
    expect(nthCall(0).headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(nthCall(0).headers['x-internal-service-secret']).toBe(SECRET);
  });

  it('defaults metadata to {} and throws typed error without a bearer', async () => {
    const client = new ExecutionArtifactClient(makeConfig());
    await expect(
      client.createOutreachRecord(undefined, { title: 'T', subject: 'S', clientId: 'c' }),
    ).rejects.toMatchObject({ name: 'ExecutionArtifactError', kind: 'missing_bearer' });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockImplementation((url: unknown, init: unknown) => {
      calls.push(recordCall(url, init));
      return Promise.resolve(jsonResponse({ id: 'o1' }));
    });
    await client.createOutreachRecord(BEARER, { title: 'T', subject: 'S', clientId: 'c' });
    expect((nthCall(0).body as { metadata: unknown }).metadata).toEqual({});
  });
});

describe('safety boundary — only creation endpoints are ever hit', () => {
  it('never fetches a /send or dispatch URL across a full workspace + outreach flow', async () => {
    fetchMock.mockImplementation((url: unknown, init: unknown) => {
      calls.push(recordCall(url, init));
      if (String(url).endsWith('/workspace-api/drafts')) {
        return Promise.resolve(jsonResponse({ id: 'd', config: { sections: ['S'] } }));
      }
      return Promise.resolve(jsonResponse({ id: 'o' }));
    });

    const client = new ExecutionArtifactClient(makeConfig());
    await client.createWorkspaceDraft(BEARER, { docTitle: 'T', clientName: 'C', product: 'P', sections: { Background: '<p/>' } });
    await client.createOutreachRecord(BEARER, { title: 'T', subject: 'S', clientId: 'c', metadata: {} });

    const allowedPaths = new Set([
      '/workspace-api/drafts',
      '/workspace-api/drafts/d',
      '/api/engagement/outreach',
    ]);
    for (const call of calls) {
      const path = new URL(call.url).pathname;
      expect(allowedPaths.has(path)).toBe(true);
      expect(call.url).not.toMatch(/send|dispatch|deliver|transmit/i);
    }
    // Exactly the 3 creation calls (2 workspace + 1 outreach), nothing else.
    expect(calls).toHaveLength(3);
  });
});
