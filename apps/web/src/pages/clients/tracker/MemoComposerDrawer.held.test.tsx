import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { MemoComposerDrawer } from './MemoComposerDrawer.js';
import type { FeedItem } from './intel-feed-api.js';
import type { AlertMemoResult } from './alert-actions-api.js';

/**
 * Gate A, P0-01 item 5 — held-memo composer UX. Mocks at the `use-api.js`
 * level (same convention as ActionBoardPage.test.tsx) so the real
 * useGenerateAlertMemo/useSaveAlertMemo/useRecordMemoLink hooks run against a
 * controllable api.post, rather than mocking the hook module itself.
 */

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    patch: apiPatchMock,
    post: apiPostMock,
  }),
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

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'alert-1',
    clientId: 'client-1',
    sourceType: 'bill',
    kind: 'bill_update',
    severity: 'high',
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
    ...overrides,
  } as FeedItem;
}

function baseMemoResult(overrides: Partial<AlertMemoResult> = {}): AlertMemoResult {
  return {
    title: 'Client memo — H.R. 8800',
    markdown: '# Client memo\n\nBody text.',
    sections: [],
    sources: [],
    document: { attachmentId: 'att-1', fileName: 'memo.docx' },
    usedTenantKey: false,
    model: 'claude-sonnet-5',
    lowConfidence: false,
    memoryFilesUsed: [],
    held: false,
    reviewRequestId: null,
    heldReason: '',
    ...overrides,
  };
}

function renderDrawer(item: FeedItem) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter initialEntries={['/clients']}>
          <MemoComposerDrawer
            open={true}
            onClose={() => {}}
            clientId="client-1"
            clientName="Acme Corp"
            item={item}
          />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe('MemoComposerDrawer — held-for-review state (Gate A, P0-01 item 5)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPostMock.mockReset();
    setupBrowserMocks();
  });

  test('1. a held generate result shows the red "Held for review" tag, disables Save, and renders View review request', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/alert-memo')) {
        return {
          data: baseMemoResult({
            held: true,
            document: null,
            reviewRequestId: 'r1',
            heldReason: 'x',
          }),
        };
      }
      return { data: {} };
    });

    renderDrawer(makeItem());

    await waitFor(() =>
      expect(screen.getByText('Held for review — unapproved draft')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Save to Documents' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'View review request' })).toBeInTheDocument();
  });

  test('2. the same held state leaves the markdown textarea enabled and editable', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/alert-memo')) {
        return {
          data: baseMemoResult({
            held: true,
            document: null,
            reviewRequestId: 'r1',
            heldReason: 'x',
            markdown: 'Original held markdown.',
          }),
        };
      }
      return { data: {} };
    });

    renderDrawer(makeItem());

    const textarea = await screen.findByDisplayValue('Original held markdown.');
    expect(textarea).not.toBeDisabled();
  });

  test('3. a normal filed memo shows the green "Saved to Documents" tag, Save enabled, and no review button', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/alert-memo')) {
        return { data: baseMemoResult({ held: false, document: { attachmentId: 'att-1', fileName: 'm.docx' } }) };
      }
      return { data: {} };
    });

    renderDrawer(makeItem());

    await waitFor(() => expect(screen.getByText('Saved to Documents ✓')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save to Documents' })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: 'View review request' })).not.toBeInTheDocument();
  });

  test('4. a non-held memo whose auto-file failed shows "Not yet filed", Save enabled, and the auto-file-failed warning (c-4 ordering did not swallow it)', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/alert-memo')) {
        return { data: baseMemoResult({ held: false, document: null }) };
      }
      return { data: {} };
    });

    renderDrawer(makeItem());

    await waitFor(() => expect(screen.getByText('Not yet filed')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save to Documents' })).not.toBeDisabled();
    await waitFor(() =>
      expect(
        screen.getByText('Memo drafted (auto-file to Documents failed — use Save to retry)'),
      ).toBeInTheDocument(),
    );
  });

  test('5. saving a non-held memo sends alertId equal to item.id', async () => {
    const item = makeItem({ id: 'alert-42' });
    apiPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/alert-memo')) {
        return { data: baseMemoResult({ held: false, document: null }) };
      }
      if (url.endsWith('/alert-memo/save')) {
        return { data: { document: { attachmentId: 'att-2', fileName: 'm.docx' }, title: 'Client memo — H.R. 8800' } };
      }
      return { data: {} };
    });

    renderDrawer(item);

    await waitFor(() => expect(screen.getByText('Not yet filed')).toBeInTheDocument());
    const saveButton = screen.getByRole('button', { name: 'Save to Documents' });
    saveButton.click();

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        expect.stringContaining('/alert-memo/save'),
        expect.objectContaining({ alertId: 'alert-42' }),
      ),
    );
  });
});

/**
 * Gate D phase f (P2-06), f-6 case 8 — the clipboard write was un-awaited AND
 * optional-chained (`void navigator.clipboard?.writeText(...)`), so on an
 * insecure origin (navigator.clipboard undefined) or a rejected permission it
 * copied nothing and still reported "Copied".
 */
describe('P2-06 — Copy tells the truth', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPostMock.mockReset();
    setupBrowserMocks();
  });

  /** The drawer generates on open, so waiting for Copy to enable is enough. */
  async function renderWithMemo() {
    apiPostMock.mockResolvedValue({ data: baseMemoResult() });
    renderDrawer(makeItem());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy' })).not.toBeDisabled());
  }

  test('a rejected clipboard write shows the fallback, not "Copied"', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    await renderWithMemo();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(await screen.findByText(/Could not copy automatically/i)).toBeInTheDocument();
    expect(screen.queryByText('Copied')).toBeNull();
  });

  test('a successful clipboard write reports success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    await renderWithMemo();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});

/** Renders whatever route MemoComposerDrawer's navigate() actually lands on, as
 *  visible text — proving the destination rather than just that the button exists. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}{location.search}</div>;
}

describe('MemoComposerDrawer — View review request lands on the specific review (MP-13 / Gate H phase b)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPostMock.mockReset();
    setupBrowserMocks();
  });

  test('clicking View review request navigates to /reviews?id=<the held memo\'s reviewRequestId>', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/alert-memo')) {
        return { data: baseMemoResult({ held: true, document: null, reviewRequestId: 'rr-42', heldReason: 'x' }) };
      }
      return { data: {} };
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AntApp>
          <MemoryRouter initialEntries={['/clients']}>
            <MemoComposerDrawer open={true} onClose={() => {}} clientId="client-1" clientName="Acme Corp" item={makeItem()} />
            <Routes>
              <Route path="*" element={<LocationProbe />} />
            </Routes>
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    );

    const reviewBtn = await screen.findByRole('button', { name: 'View review request' });
    fireEvent.click(reviewBtn);

    await waitFor(() =>
      expect(screen.getByTestId('location-probe')).toHaveTextContent('/reviews?id=rr-42'),
    );
  });
});

/**
 * Gate I (CG-01) phase c — `held: true, reviewRequestId: null` means
 * reviews.createSystem() failed (I_GOVERNANCE.md S1-S4): no review row exists
 * anywhere for a reviewer to find. The composer must say filing is blocked, not
 * imply a retry ("auto-file failed") or offer a dead-end "View review request".
 */
describe('MemoComposerDrawer — filing blocked, no reviewer notified (Gate I, CG-01 phase c)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPostMock.mockReset();
    setupBrowserMocks();
  });

  test('a held result with no reviewRequestId shows "Filing blocked — no reviewer notified", not the ordinary held tag', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/alert-memo')) {
        return {
          data: baseMemoResult({
            held: true,
            document: null,
            reviewRequestId: null,
            heldReason: 'Entailment gate: every paragraph failed entailment against its cited claims.',
            generationId: 'gen-1',
          }),
        };
      }
      return { data: {} };
    });

    renderDrawer(makeItem());

    await waitFor(() =>
      expect(screen.getByText('Filing blocked — no reviewer notified')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Held for review — unapproved draft')).not.toBeInTheDocument();
    expect(
      screen.getByText(/This draft could not be filed for review/i),
    ).toBeInTheDocument();
  });

  test('the same state disables Save but renders no "View review request" (there is nothing to view)', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/alert-memo')) {
        return {
          data: baseMemoResult({ held: true, document: null, reviewRequestId: null, heldReason: 'x' }),
        };
      }
      return { data: {} };
    });

    renderDrawer(makeItem());

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save to Documents' })).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'View review request' })).not.toBeInTheDocument();
  });

  test('the markdown textarea stays enabled and editable (blocking filing must not block editing)', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/alert-memo')) {
        return {
          data: baseMemoResult({
            held: true,
            document: null,
            reviewRequestId: null,
            heldReason: 'x',
            markdown: 'Blocked-but-editable markdown.',
          }),
        };
      }
      return { data: {} };
    });

    renderDrawer(makeItem());

    const textarea = await screen.findByDisplayValue('Blocked-but-editable markdown.');
    expect(textarea).not.toBeDisabled();
  });

  test('a fresh generate()\'s returned generationId is round-tripped on save', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/alert-memo')) {
        return { data: baseMemoResult({ held: false, document: null, generationId: 'gen-77' }) };
      }
      if (url.endsWith('/alert-memo/save')) {
        return { data: { document: { attachmentId: 'att-2', fileName: 'm.docx' }, title: 'Client memo — H.R. 8800' } };
      }
      return { data: {} };
    });

    renderDrawer(makeItem());

    await waitFor(() => expect(screen.getByText('Not yet filed')).toBeInTheDocument());
    screen.getByRole('button', { name: 'Save to Documents' }).click();

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        expect.stringContaining('/alert-memo/save'),
        expect.objectContaining({ generationId: 'gen-77' }),
      ),
    );
  });
});
