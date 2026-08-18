import type { AxiosInstance } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { listOutreachV3ContextDocuments, searchOutreachV3ContextAll } from './outreach-v3-api.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_CLIENT = '22222222-2222-4222-8222-222222222222';
const SESSION = '99999999-9999-4999-8999-999999999999';

function memoryEnvelope() {
  return {
    capability: 'search_memory',
    schemaVersion: 1,
    data: {
      candidates: [
        {
          title: 'Staff writing style',
          summary: 'Concise and direct.',
          memoryType: 'writing_preference',
          clientId: CLIENT,
          verificationClass: 'first_party',
          sensitivity: 'normal',
          instructionsAllowed: true,
          lastVerifiedAt: '2026-08-01T12:00:00.000Z',
          selection: {
            locator: { source: 'memory_item', id: 'memory-1', clientId: CLIENT },
            contextClass: 'campaign_fact',
            scope: { kind: 'campaign' },
          },
        },
      ],
      totalConsidered: 1,
    },
  };
}

function governmentEnvelope() {
  return {
    capability: 'research_government',
    schemaVersion: 1,
    data: {
      candidates: [
        {
          category: 'bill',
          id: 'hr-1234',
          title: 'H.R. 1234',
          subtitle: 'Ground robotics',
          date: '2026-06-01T12:00:00.000Z',
          href: 'https://example.test/hr-1234',
          selection: {
            locator: { source: 'government_record', category: 'bill', id: 'hr-1234' },
            contextClass: 'campaign_fact',
            scope: { kind: 'campaign' },
          },
        },
      ],
      byCategory: { bill: 1 },
    },
  };
}

/**
 * Routes each POST by URL so the two legs can succeed/fail independently.
 *
 * `body` is declared even though the router ignores it: the assertions below read
 * `post.mock.calls[n][1]`, and a one-argument mock would type that index as
 * out of range.
 */
function postRouter(handlers: Record<string, () => Promise<unknown>>) {
  const post = vi.fn(async (url: string, _body?: unknown) => {
    for (const [fragment, handler] of Object.entries(handlers)) {
      if (url.includes(fragment)) return { data: await handler() };
    }
    throw new Error(`unexpected POST ${url}`);
  });
  return { api: { post } as unknown as AxiosInstance, post };
}

describe('searchOutreachV3ContextAll', () => {
  it('queries memory and government in parallel and merges both source kinds', async () => {
    const { api, post } = postRouter({
      'context/memory/search': async () => memoryEnvelope(),
      'context/government/search': async () => governmentEnvelope(),
    });

    const result = await searchOutreachV3ContextAll(api, SESSION, {
      query: 'ground robotics',
      clientId: CLIENT,
    });

    expect(post).toHaveBeenCalledTimes(2);
    expect(result.skipped).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.sourceKind)).toEqual([
      'memory',
      'government',
    ]);
  });

  it('probes memory with the one class that applies no filter', async () => {
    const { api, post } = postRouter({
      'context/memory/search': async () => memoryEnvelope(),
      'context/government/search': async () => governmentEnvelope(),
    });

    await searchOutreachV3ContextAll(api, SESSION, { query: 'robotics', clientId: CLIENT });

    // campaign_fact is the branch of the server's compatibleWithClass that
    // returns true unconditionally, making this an unfiltered read rather than a
    // taxonomy-narrowed one.
    const memoryCall = post.mock.calls.find(([url]) =>
      String(url).includes('context/memory/search'),
    );
    expect(memoryCall?.[1]).toMatchObject({
      intendedClass: 'campaign_fact',
      scope: { kind: 'campaign' },
      clientId: CLIENT,
    });
  });

  it('keeps the surviving source when the other one fails', async () => {
    const { api } = postRouter({
      'context/memory/search': async () => memoryEnvelope(),
      'context/government/search': async () => {
        throw { response: { status: 404, data: { statusCode: 404, message: 'Not Found' } } };
      },
    });

    const result = await searchOutreachV3ContextAll(api, SESSION, {
      query: 'robotics',
      clientId: CLIENT,
    });

    // A dead government leg must not read as "no context exists".
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.sourceKind).toBe('memory');
    expect(result.failures).toEqual([{ source: 'government', message: 'Not Found' }]);
  });

  it('sends nothing when the query is under the server minimum', async () => {
    const { api, post } = postRouter({});

    for (const query of ['', ' ', 'a']) {
      const result = await searchOutreachV3ContextAll(api, SESSION, { query, clientId: CLIENT });
      expect(result).toEqual({ candidates: [], failures: [], skipped: true });
    }
    // Both DTOs enforce MinLength(2); a blank campaign topic must not 400 the
    // stage the moment it opens.
    expect(post).not.toHaveBeenCalled();
  });
});

describe('listOutreachV3ContextDocuments', () => {
  const library = {
    documents: [
      { id: 'doc-attach-1', clientId: CLIENT, clientName: 'Acme', title: 'Brief.pdf', date: 'x' },
      { id: 'doc-attach-2', clientId: OTHER_CLIENT, clientName: 'Other', title: 'Other.pdf' },
      { id: 'clientnote-abc', clientId: CLIENT, clientName: 'Acme', title: 'Profile notes' },
      { id: 'debrief-1', clientId: CLIENT, clientName: 'Acme', title: 'Debrief' },
      { id: 'doc-', clientId: CLIENT, clientName: 'Acme', title: 'Malformed' },
    ],
  };

  it('keeps only real attachment rows for the sole sponsor client', async () => {
    const api = {
      get: vi.fn().mockResolvedValue({ data: library }),
    } as unknown as AxiosInstance;

    const documents = await listOutreachV3ContextDocuments(api, CLIENT);

    // Only doc-attach-1 survives: another client's document, the non-attachment
    // prefixes, and the empty id would each 404 on accept.
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      attachmentId: 'attach-1',
      clientId: CLIENT,
      title: 'Brief.pdf',
    });
    expect(documents[0]?.selection.locator).toEqual({
      source: 'document',
      id: 'attach-1',
      clientId: CLIENT,
    });
  });

  it('reads the main-API library route, which carries no preview header', async () => {
    const get = vi.fn().mockResolvedValue({ data: library });
    await listOutreachV3ContextDocuments({ get } as unknown as AxiosInstance, CLIENT);
    // Not under /api/engagement/outreach-v3/, so engagementPreviewHeader leaves
    // it alone and the main API serves it.
    expect(get).toHaveBeenCalledWith('/api/engagement/outreach/context-library');
  });

  it('degrades to an empty list on a malformed envelope', async () => {
    const api = {
      get: vi.fn().mockResolvedValue({ data: { documents: null } }),
    } as unknown as AxiosInstance;
    await expect(listOutreachV3ContextDocuments(api, CLIENT)).resolves.toEqual([]);
  });
});
