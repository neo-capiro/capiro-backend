import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, Modal } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { MemoComposerDrawer } from './MemoComposerDrawer.js';
import type { FeedItem } from './intel-feed-api.js';

/**
 * RB-04 / Gate H a-2, a-3, a-4: opening the composer for an alert that
 * ALREADY has a memo must never silently regenerate (and so replace) the
 * filed document. It must load the saved content instead, and only an
 * explicit, confirmed Regenerate may fire the generate/replace call.
 *
 * Before this fix, the open effect called runGenerate(existingAttachmentId)
 * unconditionally — a repo-wide grep across every *.spec.ts / *.test.ts(x)
 * confirmed this path had zero test coverage anywhere.
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

function renderDrawer(item: FeedItem) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter initialEntries={['/clients']}>
          <MemoComposerDrawer open={true} onClose={() => {}} clientId="client-1" clientName="Acme Corp" item={item} />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe('MemoComposerDrawer — opening an existing memo loads, never regenerates (Gate H a-2/a-4)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    apiPostMock.mockReset();
    setupBrowserMocks();
  });

  // Modal.confirm mounts imperatively on its OWN antd-managed root, separate
  // from the tree RTL's render()/cleanup() unmounts — a confirmed/cancelled
  // dialog from one test otherwise leaks into the next test's DOM and breaks
  // its "exactly one Regenerate button" queries. destroyAll() signals the
  // close, but its animated removal never completes in jsdom (no
  // transitionend ever fires), so it's still in the DOM after the default
  // waitFor timeout. Force-remove ONLY confirm roots (identified by the
  // .ant-modal-confirm descendant that a plain <Modal> never has) — the
  // drawer's OWN Modal is left for React to unmount normally, so this can't
  // race React's reconciler the way blanket-removing every .ant-modal-root did.
  afterEach(() => {
    Modal.destroyAll();
    document.querySelectorAll('.ant-modal-root').forEach((root) => {
      if (root.querySelector('.ant-modal-confirm')) root.remove();
    });
  });

  test('loads the saved content via GET memo-link and never calls the generate endpoint', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/memo-link')) {
        return { data: { documentAttachmentId: 'att-1', title: 'Client memo — H.R. 8800', text: '# Saved memo\n\nOriginal body.' } };
      }
      return { data: {} };
    });
    const item = makeItem({ actions: { inReport: false, talkingPoints: 0, memo: { documentAttachmentId: 'att-1', title: 'Client memo — H.R. 8800' } } });

    renderDrawer(item);

    await waitFor(() => expect(screen.getByDisplayValue(/Original body\./)).toBeTruthy());
    expect(screen.getByText(/Loaded from Documents/i)).toBeTruthy();
    expect(screen.getByText(/Saved to Documents/i)).toBeTruthy();
    expect(apiPostMock).not.toHaveBeenCalledWith(expect.stringContaining('/alert-memo'), expect.anything());
  });

  test('Regenerate on a loaded, filed memo shows a confirm naming the consequence and does nothing until confirmed', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/memo-link')) {
        return { data: { documentAttachmentId: 'att-1', title: 'Client memo', text: 'Original body.' } };
      }
      return { data: {} };
    });
    apiPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/alert-memo')) return { data: null };
      return { data: {} };
    });
    const item = makeItem({ actions: { inReport: false, talkingPoints: 0, memo: { documentAttachmentId: 'att-1', title: 'Client memo' } } });

    renderDrawer(item);
    await waitFor(() => expect(screen.getByDisplayValue(/Original body\./)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Regenerate/i }));

    // H-2: the confirm names the consequence in plain words. antd's Modal.confirm
    // renders the title twice (generic header + confirm-body span) — assert
    // presence via getAllByText rather than getByText's exactly-one contract.
    // Modal.confirm renders to a separate imperative DOM root; under the full
    // 224-file vitest suite jsdom is slower than in isolation (and even a 5s
    // budget can flake after hundreds of prior files). Timing tolerance only.
    await waitFor(
      () => expect(screen.getAllByText(/Regenerate this memo\?/i).length).toBeGreaterThan(0),
      { timeout: 15000 },
    );
    expect(screen.getByText(/will no longer appear/i)).toBeTruthy();
    // Not confirmed yet — no generate call fired.
    expect(apiPostMock).not.toHaveBeenCalledWith(expect.stringContaining('/alert-memo'), expect.anything());
  });

  test('confirming Regenerate calls generate with the existing attachment id as replaceAttachmentId', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/memo-link')) {
        return { data: { documentAttachmentId: 'att-1', title: 'Client memo', text: 'Original body.' } };
      }
      return { data: {} };
    });
    const generateCalls: unknown[] = [];
    apiPostMock.mockImplementation(async (url: string, body: unknown) => {
      if (url.endsWith('/alert-memo')) {
        generateCalls.push(body);
        return {
          data: {
            title: 'Client memo',
            markdown: '# New body',
            sections: [],
            sources: [],
            document: { attachmentId: 'att-2', fileName: 'memo.docx' },
            usedTenantKey: false,
            model: 'claude-sonnet-5',
            lowConfidence: false,
            memoryFilesUsed: [],
            held: false,
            reviewRequestId: null,
            heldReason: '',
          },
        };
      }
      if (url.endsWith('/memo-link')) return { data: {} };
      return { data: {} };
    });
    const item = makeItem({ actions: { inReport: false, talkingPoints: 0, memo: { documentAttachmentId: 'att-1', title: 'Client memo' } } });

    renderDrawer(item);
    await waitFor(() => expect(screen.getByDisplayValue(/Original body\./)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Regenerate/i }));
    await waitFor(
      () => expect(screen.getAllByText(/Regenerate this memo\?/i).length).toBeGreaterThan(0),
      { timeout: 15000 },
    );
    // Two "Regenerate" buttons are on screen now: the drawer's footer button and
    // the confirm dialog's OK button. The confirm's is the one appended last.
    const regenButtons = screen.getAllByRole('button', { name: /^Regenerate$/ });
    fireEvent.click(regenButtons[regenButtons.length - 1]!);

    await waitFor(() => expect(generateCalls.length).toBe(1));
    expect(generateCalls[0]).toMatchObject({ replaceAttachmentId: 'att-1' });
    // After a confirmed regenerate, the fresh AI content replaces the loaded view.
    await waitFor(() => expect(screen.getByDisplayValue(/New body/)).toBeTruthy());
    expect(screen.queryByText(/Loaded from Documents/i)).toBeNull();
  });

  test('a-4: a memo-link with NO filed attachment loads without a confirm and Regenerate never files a duplicate silently', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/memo-link')) {
        return { data: { documentAttachmentId: null, title: 'Client memo', text: 'Orphaned content, never filed.' } };
      }
      return { data: {} };
    });
    const generateCalls: unknown[] = [];
    apiPostMock.mockImplementation(async (url: string, body: unknown) => {
      if (url.endsWith('/alert-memo')) {
        generateCalls.push(body);
        return {
          data: {
            title: 'Client memo',
            markdown: '# New body',
            sections: [],
            sources: [],
            document: { attachmentId: 'att-9', fileName: 'memo.docx' },
            usedTenantKey: false,
            model: 'claude-sonnet-5',
            lowConfidence: false,
            memoryFilesUsed: [],
            held: false,
            reviewRequestId: null,
            heldReason: '',
          },
        };
      }
      return { data: {} };
    });
    const item = makeItem({ actions: { inReport: false, talkingPoints: 0, memo: { documentAttachmentId: null, title: 'Client memo' } } });

    renderDrawer(item);

    // The inconsistent state (memo present, nothing filed) is surfaced, not hidden.
    await waitFor(() => expect(screen.getByDisplayValue(/Orphaned content/)).toBeTruthy());
    expect(screen.getByText(/^Not yet filed$/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Regenerate/i }));

    // Nothing to replace — no confirm dialog, generate fires directly with no replaceAttachmentId.
    await waitFor(() => expect(generateCalls.length).toBe(1));
    expect(screen.queryByText(/Regenerate this memo\?/i)).toBeNull();
    // The key may still be present with value `undefined` (dropped by JSON
    // serialization on the wire) — what matters is nothing meaningful was sent.
    expect((generateCalls[0] as { replaceAttachmentId?: string }).replaceAttachmentId).toBeUndefined();
  });

  test('a-4: when the saved content cannot be read, the drawer warns instead of silently generating', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/memo-link')) return { data: { documentAttachmentId: 'att-1', title: 'Client memo', text: null } };
      return { data: {} };
    });
    const item = makeItem({ actions: { inReport: false, talkingPoints: 0, memo: { documentAttachmentId: 'att-1', title: 'Client memo' } } });

    renderDrawer(item);

    await waitFor(() =>
      expect(screen.getByText(/No saved memo content on record/i)).toBeTruthy(),
    );
    expect(apiPostMock).not.toHaveBeenCalledWith(expect.stringContaining('/alert-memo'), expect.anything());
  });
});
