import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { MemoComposerDrawer } from './MemoComposerDrawer.js';
import type { FeedItem } from './intel-feed-api.js';
import type { AlertMemoResult } from './alert-actions-api.js';

/**
 * P1-14 (Gate C e-8 cases 1-4).
 *
 * Filing the memo document and linking it to the alert are TWO durable writes. The
 * composer used to do `recordLink.mutateAsync(...).catch(() => undefined)` and then
 * unconditionally say "Memo drafted and filed in Documents" — so when the link write
 * failed, the document existed in the client's Documents with no association, the Feed
 * never showed "memo drafted", and reopening the composer saw a null
 * documentAttachmentId and generated a SECOND document.
 */

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, patch: apiPatchMock, post: apiPostMock }),
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

function renderDrawer(item: FeedItem = makeItem()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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

/** Counts calls per endpoint so "exactly one link write" is assertable. */
function wireApi(opts: { linkFails: boolean | (() => boolean); saveFails?: boolean }) {
  const calls = { generate: 0, link: 0, save: 0 };
  apiPostMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/memo-link')) {
      calls.link += 1;
      const fail = typeof opts.linkFails === 'function' ? opts.linkFails() : opts.linkFails;
      if (fail) throw new Error('memo-link 500');
      return { data: {} };
    }
    if (url.endsWith('/alert-memo/save')) {
      calls.save += 1;
      if (opts.saveFails) throw new Error('save 500');
      return { data: { document: { attachmentId: 'att-2', fileName: 'memo.docx' }, title: 'Client memo — H.R. 8800' } };
    }
    if (url.endsWith('/alert-memo')) {
      calls.generate += 1;
      return { data: baseMemoResult() };
    }
    return { data: {} };
  });
  return calls;
}

describe('MemoComposerDrawer — alert↔document link failure (P1-14)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPostMock.mockReset();
    setupBrowserMocks();
  });

  // Case 1
  test('a failed link says "not yet linked", offers Link to alert, and does NOT claim success', async () => {
    wireApi({ linkFails: true });

    renderDrawer();

    await waitFor(() => expect(screen.getByText(/not yet linked to this alert/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Link to alert/i })).toBeTruthy();
    expect(screen.getByText(/Filed, not linked to this alert/i)).toBeTruthy();
    // The old behavior: a full-success toast over a broken association.
    expect(screen.queryByText(/Memo drafted and filed in Documents/i)).toBeNull();
  });

  // Case 2
  test('clicking Link to alert retries and, on success, confirms and removes the button', async () => {
    let attempts = 0;
    const calls = wireApi({
      linkFails: () => {
        attempts += 1;
        return attempts === 1; // first attempt fails, retry succeeds
      },
    });

    renderDrawer();

    const retry = await waitFor(() => screen.getByRole('button', { name: /Link to alert/i }));
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByText(/Linked to this alert/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Link to alert/i })).toBeNull();
    expect(screen.queryByText(/Filed, not linked to this alert/i)).toBeNull();
    expect(calls.link).toBe(2); // the original attempt + exactly one retry
  });

  // Case 4
  test('a successful link writes exactly once, shows success, and offers no retry', async () => {
    const calls = wireApi({ linkFails: false });

    renderDrawer();

    await waitFor(() => expect(screen.getByText(/Memo drafted and filed in Documents/i)).toBeTruthy());
    expect(calls.link).toBe(1);
    expect(screen.queryByRole('button', { name: /Link to alert/i })).toBeNull();
    expect(screen.queryByText(/not yet linked/i)).toBeNull();
  });

  // Case 3
  test('a failed link during Save behaves the same way and never says "Saved to Documents"', async () => {
    let attempts = 0;
    wireApi({
      linkFails: () => {
        attempts += 1;
        return attempts >= 2; // generate's link succeeds; the save's link fails
      },
    });

    renderDrawer();
    await waitFor(() => expect(screen.getByText(/Memo drafted and filed in Documents/i)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Save to Documents/i }));

    await waitFor(() => expect(screen.getByText(/not yet linked to this alert/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Link to alert/i })).toBeTruthy();
    expect(screen.queryByText(/^Saved to Documents$/)).toBeNull();
  });
});
