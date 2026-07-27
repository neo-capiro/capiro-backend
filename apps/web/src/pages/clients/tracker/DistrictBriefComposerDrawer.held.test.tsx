import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { DistrictBriefComposerDrawer } from './DistrictBriefComposerDrawer.js';
import type { FeedItem } from './intel-feed-api.js';
import type { DistrictBriefResult } from './alert-actions-api.js';

/**
 * Gate C c-9 case 8, which also resolves Gate A b-6's deferral.
 *
 * The audit implied this drawer shared the memo's save bypass. It does not: the service
 * has no saveEdited and the footer is Regenerate / Copy / Close — there is NO filing path
 * here and therefore no bypass. What it DID share was the mislabeling: a held brief has
 * document === null, and the old two-branch check reported that as "auto-file to
 * Documents failed" — a deliberate governance hold presented to the analyst as a bug.
 */

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, patch: apiPatchMock, post: apiPostMock }),
}));

vi.mock('../facilities-api.js', () => ({
  getClientFacilities: vi.fn(async () => [
    {
      id: 'fac-1',
      name: 'Huntsville Plant',
      city: 'Huntsville',
      state: 'AL',
      geocodeStatus: 'matched',
    },
  ]),
}));

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
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  }
}

function makeItem(): FeedItem {
  return {
    id: 'alert-1',
    clientId: 'client-1',
    sourceType: 'bill',
    kind: 'bill_update',
    severity: 'critical',
    materiality: 'high',
    score: 80,
    clientImpact: null,
    urgency: null,
    title: 'H.R. 8800: Rule granted',
    whyItMatters: 'Directly affects the client.',
    recommendedAction: null,
    evidence: {},
    status: 'new',
    createdAt: '2026-07-01T00:00:00.000Z',
  } as FeedItem;
}

function baseBrief(overrides: Partial<DistrictBriefResult> = {}): DistrictBriefResult {
  return {
    title: 'District brief — H.R. 8800',
    markdown: '# District brief\n\nBody text.',
    sections: [],
    sources: [],
    document: { attachmentId: 'att-1', fileName: 'brief.docx' },
    usedTenantKey: false,
    model: 'claude-sonnet-5',
    lowConfidence: false,
    memoryFilesUsed: [],
    held: false,
    reviewRequestId: null,
    heldReason: '',
    facility: { id: 'fac-1', name: 'Huntsville Plant', city: 'Huntsville', state: 'AL' },
    ...overrides,
  };
}

function renderDrawer() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter initialEntries={['/clients']}>
          <DistrictBriefComposerDrawer
            open={true}
            onClose={() => {}}
            clientId="client-1"
            item={makeItem()}
          />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe('DistrictBriefComposerDrawer — held-for-review state (Gate C c-8)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPostMock.mockReset();
    setupBrowserMocks();
  });

  test('a held brief shows the red held tag and a review link, NOT "auto-file failed"', async () => {
    apiPostMock.mockImplementation(async () => ({
      data: baseBrief({
        held: true,
        document: null,
        reviewRequestId: 'r1',
        heldReason: 'Grounding auditor: checkFailedRuleFraming (critical): stale rule framing',
      }),
    }));

    renderDrawer();

    await waitFor(() =>
      expect(screen.getByText(/Held for review — unapproved draft/i)).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: /View review request/i })).toBeTruthy();
    // The governance hold must NOT be reported as a filing bug.
    expect(screen.queryByText(/auto-file to Documents failed/i)).toBeNull();
    expect(screen.queryByText(/Saved to Documents/i)).toBeNull();
  });

  test('a normally filed brief shows Saved to Documents and no held tag or review link', async () => {
    apiPostMock.mockImplementation(async () => ({ data: baseBrief() }));

    renderDrawer();

    await waitFor(() => expect(screen.getByText(/Saved to Documents/i)).toBeTruthy());
    expect(screen.queryByText(/Held for review/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /View review request/i })).toBeNull();
  });

  test('a genuine auto-file failure (not held) still reports the failure honestly', async () => {
    apiPostMock.mockImplementation(async () => ({
      data: baseBrief({ held: false, document: null }),
    }));

    renderDrawer();

    await waitFor(() => expect(screen.getByText(/Not yet filed/i)).toBeTruthy());
    expect(screen.queryByText(/Held for review/i)).toBeNull();
  });

  test('there is no Save button on this surface at all (no filing path to bypass)', async () => {
    apiPostMock.mockImplementation(async () => ({ data: baseBrief() }));

    renderDrawer();

    await waitFor(() => expect(screen.getByText(/Saved to Documents/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^Save/i })).toBeNull();
    // Regenerate / Copy / Close is the whole footer. (Close is asserted with
    // getAllByRole because antd's Modal X button is also named "Close".)
    expect(screen.getByRole('button', { name: /Regenerate/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy/i })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Close/i }).length).toBeGreaterThan(0);
  });
});

/** Renders whatever route navigate() actually lands on, as visible text. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}{location.search}</div>;
}

describe('DistrictBriefComposerDrawer — View review request lands on the specific review (MP-13 / Gate H phase b)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPostMock.mockReset();
    setupBrowserMocks();
  });

  test("clicking View review request navigates to /reviews?id=<the held brief's reviewRequestId>", async () => {
    apiPostMock.mockImplementation(async () => ({
      data: baseBrief({ held: true, document: null, reviewRequestId: 'rr-77', heldReason: 'x' }),
    }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AntApp>
          <MemoryRouter initialEntries={['/clients']}>
            <DistrictBriefComposerDrawer open={true} onClose={() => {}} clientId="client-1" item={makeItem()} />
            <Routes>
              <Route path="*" element={<LocationProbe />} />
            </Routes>
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    );

    const reviewBtn = await screen.findByRole('button', { name: /View review request/i });
    fireEvent.click(reviewBtn);

    await waitFor(() =>
      expect(screen.getByTestId('location-probe')).toHaveTextContent('/reviews?id=rr-77'),
    );
  });
});
