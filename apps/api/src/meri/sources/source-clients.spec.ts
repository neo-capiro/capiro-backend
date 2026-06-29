import { CongressClient } from './congress.client.js';
import { FederalRegisterClient } from './federal-register.client.js';
import { GovInfoClient } from './govinfo.client.js';
import { SourceClientError } from './http.js';
import { LdaClient } from './lda.client.js';
import type { SearchResult } from './types.js';

const CONGRESS_API_KEY = 'congress-secret-value';
const GOVINFO_API_KEY = 'govinfo-secret-value';

interface ClientCase {
  name: string;
  apiKey?: string;
  happyBody: unknown;
  runSearch: () => Promise<SearchResult[]>;
  expectedResult: Partial<SearchResult>;
  assertRequest: (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => void;
}

const CLIENT_CASES: ClientCase[] = [
  {
    name: 'Federal Register',
    happyBody: {
      results: [
        {
          document_number: '2026-05314',
          title: 'Request for Information on Climate-Related Financial Risk; Withdrawal',
          abstract: 'The Commission is withdrawing a request for information.',
          excerpts: '<span class="match">climate</span> financial risk',
          html_url:
            'https://www.federalregister.gov/documents/2026/03/18/2026-05314/request-for-information',
          publication_date: '2026-03-18',
          agencies: [{ name: 'Commodity Futures Trading Commission' }],
        },
      ],
    },
    runSearch: () => new FederalRegisterClient().search('climate', { limit: 1 }),
    expectedResult: {
      id: '2026-05314',
      source: 'federal_register',
      publishedAt: '2026-03-18',
      title: 'Request for Information on Climate-Related Financial Risk; Withdrawal',
    },
    assertRequest: (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://www.federalregister.gov');
      expect(url.searchParams.get('conditions[term]')).toBe('climate');
      expect(url.searchParams.get('per_page')).toBe('1');
    },
  },
  {
    name: 'Congress',
    apiKey: CONGRESS_API_KEY,
    happyBody: {
      bills: [
        {
          congress: 117,
          type: 'HR',
          number: '3076',
          title: 'Postal Service Reform Act of 2022',
          latestAction: { actionDate: '2022-04-06', text: 'Became Public Law No: 117-108.' },
          updateDateIncludingText: '2026-01-21T04:29:58Z',
          url: 'https://api.congress.gov/v3/bill/117/hr/3076?format=json',
        },
      ],
    },
    runSearch: () => new CongressClient(CONGRESS_API_KEY).search('postal', { congress: 117, limit: 1 }),
    expectedResult: {
      id: '117-hr-3076',
      source: 'congress',
      publishedAt: '2022-04-06',
      title: 'Postal Service Reform Act of 2022',
    },
    assertRequest: (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.congress.gov');
      expect(url.pathname).toBe('/v3/bill/117');
      expect(url.searchParams.get('api_key')).toBe(CONGRESS_API_KEY);
      expect(url.searchParams.get('format')).toBe('json');
    },
  },
  {
    name: 'LDA',
    happyBody: {
      results: [
        {
          url: 'https://lda.gov/api/v1/filings/16a8d94f-657d-4e9f-b49d-b98a49b8687e/',
          filing_uuid: '16a8d94f-657d-4e9f-b49d-b98a49b8687e',
          filing_type: 'Q1',
          filing_type_display: '1st Quarter - Report',
          filing_year: 2024,
          filing_period_display: '1st Quarter (Jan 1 - Mar 31)',
          filing_document_url:
            'https://lda.gov/filings/public/filing/16a8d94f-657d-4e9f-b49d-b98a49b8687e/print/',
          expenses: '330000.00',
          dt_posted: '2024-04-09T13:49:43-04:00',
          registrant: { name: 'SHIELD AI' },
          client: { name: 'SHIELD AI' },
          lobbying_activities: [
            {
              general_issue_code_display: 'Budget/Appropriations',
              description: 'National Defense Authorization Act and Defense Appropriations',
            },
          ],
        },
      ],
    },
    runSearch: () => new LdaClient().search('Shield AI', { year: 2024, limit: 1 }),
    expectedResult: {
      id: '16a8d94f-657d-4e9f-b49d-b98a49b8687e',
      source: 'lda',
      publishedAt: '2024-04-09T13:49:43-04:00',
      title: 'SHIELD AI - 1st Quarter - Report 2024',
    },
    assertRequest: (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://lda.gov');
      expect(url.searchParams.get('client_name')).toBe('Shield AI');
      expect(url.searchParams.get('filing_year')).toBe('2024');
      expect(url.searchParams.get('page_size')).toBe('1');
    },
  },
  {
    name: 'GovInfo',
    apiKey: GOVINFO_API_KEY,
    happyBody: {
      results: [
        {
          title: 'Climate Science: Empowering Our Response to Climate Change',
          packageId: 'CHRG-111shrg52159',
          granuleId: 'CHRG-111shrg52159',
          collectionCode: 'CHRG',
          collectionName: 'Congressional Hearings',
          governmentAuthor: ['Congress', 'Senate'],
          dateIssued: '2009-03-12',
          lastModified: '2025-03-18T21:12:20Z',
          resultLink: 'https://api.govinfo.gov/packages/CHRG-111shrg52159/granules/CHRG-111shrg52159/summary',
        },
      ],
    },
    runSearch: () => new GovInfoClient(GOVINFO_API_KEY).search('climate', { limit: 1, collections: ['CHRG'] }),
    expectedResult: {
      id: 'CHRG-111shrg52159',
      source: 'govinfo',
      publishedAt: '2009-03-12',
      title: 'Climate Science: Empowering Our Response to Climate Change',
    },
    assertRequest: (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.govinfo.gov');
      expect(url.pathname).toBe('/search');
      expect(url.searchParams.get('api_key')).toBe(GOVINFO_API_KEY);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({ query: 'climate', pageSize: 1, collection: 'CHRG' });
    },
  },
];

describe('government source clients', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>;
  let originalFetch: typeof fetch | undefined;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: jest.fn(),
    });
    fetchMock = globalThis.fetch as jest.MockedFunction<typeof fetch>;
  });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      return;
    }

    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  test.each(CLIENT_CASES)('$name maps a happy-path search response', async (clientCase) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(clientCase.happyBody));

    const results = await clientCase.runSearch();

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining(clientCase.expectedResult));
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    clientCase.assertRequest(firstCall![0], firstCall![1]);
  });

  test.each(CLIENT_CASES)('$name retries a 429 once and returns normalized results', async (clientCase) => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'rate limited' }, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(clientCase.happyBody));

    const results = await clientCase.runSearch();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results[0]).toEqual(expect.objectContaining(clientCase.expectedResult));
  });

  test.each(CLIENT_CASES)('$name retries 500 responses three times before failing', async (clientCase) => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ message: `temporary outage ${clientCase.apiKey ?? ''}` }, { status: 500 })),
    );

    const error = await captureError(clientCase.runSearch);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(SourceClientError);
    expect(error.message).toContain('500');
    if (clientCase.apiKey) {
      expect(error.message).not.toContain(clientCase.apiKey);
      expect(error.message).toContain('[REDACTED]');
    }
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const status = init.status ?? 200;
  const headers = new Map<string, string>([['content-type', 'application/json']]);
  const rawHeaders = init.headers as Record<string, string> | undefined;
  if (rawHeaders) {
    for (const [key, value] of Object.entries(rawHeaders)) headers.set(key.toLowerCase(), value);
  }

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? '',
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
    } as Headers,
    text: async () => JSON.stringify(body),
  } as Response;
}

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Error) return error;
    return new Error(String(error));
  }

  throw new Error('Expected function to throw');
}
