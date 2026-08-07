import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { OpportunityRequirementsPanel } from './OpportunityRequirementsPanel.js';
import type { OpportunityRequirementsResponse } from './funding-opportunities-api.js';

/**
 * The requirements panel (P31).
 *
 * Two rules carry it: no requirement renders without its citation, and an empty
 * panel says WHICH kind of empty — only one of the four is a fact about the
 * solicitation.
 */

const { apiGetMock, flags } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  flags: { funding_opportunities_documents: true } as Record<string, boolean>,
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: vi.fn(), patch: vi.fn() }),
}));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => ({ enabled: flags[feature] === true, ready: true }),
  useIntelFeatureEnabled: (feature: string) => flags[feature] === true,
}));

const SAM_ID = '11111111-1111-1111-1111-111111111111';
const EXCERPT = 'The Contractor shall hold a TOP SECRET facility clearance at time of award.';

function payload(
  partial: Partial<OpportunityRequirementsResponse> = {},
): OpportunityRequirementsResponse {
  return {
    source: 'sam_gov',
    sourceRecordId: SAM_ID,
    requirements: [
      {
        id: 'req-1',
        requirementType: 'clearance_security',
        statement: 'A TOP SECRET facility clearance is required at time of award.',
        sourceExcerpt: EXCERPT,
        excerptStart: 32,
        excerptEnd: 32 + EXCERPT.length,
        sourcePage: 3,
        fileName: 'Statement of Work.pdf',
        extractionMethod: 'model',
        extractionModel: 'claude-opus-5',
        confidence: 'high',
        reviewStatus: 'pending',
        supersededAt: null,
      },
    ],
    coverage: 'available',
    coverageExplanation: '1 requirement extracted, each quoting the document it came from.',
    documentTextStatus: [],
    generatedAt: '2026-08-07T12:00:00.000Z',
    ...partial,
  };
}

function setupBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, 'getComputedStyle', {
    writable: true,
    value: () => ({ getPropertyValue: () => '' }),
  });
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>{node}</AntApp>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setupBrowserMocks();
  apiGetMock.mockReset();
  flags.funding_opportunities_documents = true;
});

describe('THE RULE: no requirement renders without its citation', () => {
  test('every row shows the verbatim excerpt, the document and the offsets', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(<OpportunityRequirementsPanel source="sam_gov" sourceRecordId={SAM_ID} />);
    const row = await screen.findByTestId('fo-requirement-req-1');
    expect(row).toHaveTextContent(EXCERPT);
    expect(row).toHaveTextContent('Statement of Work.pdf');
    expect(row).toHaveTextContent('page 3');
    expect(row).toHaveTextContent(/characters 32–107/);
  });

  test('the panel states that nothing here is a summary', async () => {
    // A compliance list nobody can check against the source invites a team to
    // build a proposal against Capiro's paraphrase.
    apiGetMock.mockResolvedValue({ data: payload() });
    const { container } = wrap(
      <OpportunityRequirementsPanel source="sam_gov" sourceRecordId={SAM_ID} />,
    );
    await screen.findByTestId('fo-requirement-req-1');
    expect(container.textContent ?? '').toMatch(/Nothing here is a summary/i);
  });

  test('a model’s assertion and a human’s acceptance are DIFFERENT badges', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    const pending = wrap(<OpportunityRequirementsPanel source="sam_gov" sourceRecordId={SAM_ID} />);
    expect(await screen.findByText(/Candidate — unreviewed/)).toBeTruthy();
    pending.unmount();

    apiGetMock.mockResolvedValue({
      data: payload({
        requirements: [{ ...payload().requirements[0]!, reviewStatus: 'accepted' }],
      }),
    });
    wrap(<OpportunityRequirementsPanel source="sam_gov" sourceRecordId={SAM_ID} />);
    expect(await screen.findByText('Accepted by review')).toBeTruthy();
    expect(screen.queryByText(/Candidate — unreviewed/)).toBeNull();
  });

  test('a document that changed after extraction is flagged, not silently trusted', async () => {
    apiGetMock.mockResolvedValue({
      data: payload({
        requirements: [
          { ...payload().requirements[0]!, supersededAt: '2026-08-01T00:00:00.000Z' },
        ],
      }),
    });
    wrap(<OpportunityRequirementsPanel source="sam_gov" sourceRecordId={SAM_ID} />);
    expect(await screen.findByText('Document changed since')).toBeTruthy();
  });

  test('confidence is labelled as evidence quality, never as a probability', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(<OpportunityRequirementsPanel source="sam_gov" sourceRecordId={SAM_ID} />);
    const row = await screen.findByTestId('fo-requirement-req-1');
    expect(row).toHaveTextContent('Confidence: high');
    expect(row.textContent ?? '').not.toMatch(/\d+%/);
  });
});

describe('four kinds of empty, and only one is about the solicitation', () => {
  test('the flag off says so, and never asks the API', async () => {
    flags.funding_opportunities_documents = false;
    wrap(<OpportunityRequirementsPanel source="sam_gov" sourceRecordId={SAM_ID} />);
    const el = await screen.findByTestId('fo-requirements-not-enabled');
    expect(el).toHaveTextContent(/says nothing about what this solicitation requires/i);
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('no documents archived is a Capiro gap, stated as one', async () => {
    apiGetMock.mockResolvedValue({
      data: payload({
        requirements: [],
        coverage: 'no_documents',
        coverageExplanation:
          'No documents have been archived for this solicitation, so nothing has been read. This is not a statement that it has no requirements.',
      }),
    });
    wrap(<OpportunityRequirementsPanel source="sam_gov" sourceRecordId={SAM_ID} />);
    expect(await screen.findByTestId('fo-requirements-no_documents')).toHaveTextContent(
      /not a statement that it has no requirements/i,
    );
  });

  test('no text carries P30’s PER-DOCUMENT reason through verbatim', async () => {
    // "The account's plan excludes extracted text" and "this file is a scan
    // with no text layer" are different facts, and only P30 knows which.
    apiGetMock.mockResolvedValue({
      data: payload({
        requirements: [],
        coverage: 'no_text',
        coverageExplanation: 'Documents are archived but their text is not available.',
        documentTextStatus: [
          {
            fileName: 'Scanned Amendment.pdf',
            status: 'not_provided',
            explanation:
              'The provider holds no extracted text for this document. Commonly a scanned or image-only file with no text layer.',
          },
        ],
      }),
    });
    wrap(<OpportunityRequirementsPanel source="sam_gov" sourceRecordId={SAM_ID} />);
    const el = await screen.findByTestId('fo-requirements-text-status');
    expect(el).toHaveTextContent('Scanned Amendment.pdf');
    expect(el).toHaveTextContent(/scanned or image-only/i);
  });

  test('read-and-none-found is the ONLY case about the solicitation, and even it is qualified', async () => {
    apiGetMock.mockResolvedValue({
      data: payload({
        requirements: [],
        coverage: 'read_none_found',
        coverageExplanation:
          'The documents were read and no requirement of a kind Capiro extracts was found. Requirements stated in a form Capiro does not yet recognise would not appear here.',
      }),
    });
    wrap(<OpportunityRequirementsPanel source="sam_gov" sourceRecordId={SAM_ID} />);
    const el = await screen.findByTestId('fo-requirements-read_none_found');
    expect(el).toHaveTextContent(/of a kind Capiro extracts/i);
    expect(el.textContent ?? '').not.toMatch(/has no requirements/i);
  });

  test('a request failure is NOT reported as an empty requirement list', async () => {
    apiGetMock.mockRejectedValue(new Error('network down'));
    wrap(<OpportunityRequirementsPanel source="sam_gov" sourceRecordId={SAM_ID} />);
    expect(await screen.findByTestId('fo-requirements-error')).toHaveTextContent(
      /request failure, not an empty requirement list/i,
    );
  });
});
