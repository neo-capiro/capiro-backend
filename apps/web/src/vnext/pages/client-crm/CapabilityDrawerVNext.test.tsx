/**
 * Capability editor — vNext (re-skin of the canonical CapabilityDrawer).
 *
 * Covers the canonical contract the re-skin must preserve: null renders
 * nothing, the TRL ladder PATCHes (set + clear), token lists save ONCE on blur
 * with normalization, click-to-edit text saves on blur, and the Documents tab
 * reads the shared engagement-attachment store filtered to this capability.
 * Values are absent from every fixture file so assertions cannot pass
 * vacuously.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityDrawerVNext } from './CapabilityDrawerVNext.js';
import type { Capability } from '../../../pages/clients/capability-types.js';

const getMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, patch: patchMock, post: postMock }),
}));

const capability: Capability = {
  id: 'cap-9',
  clientId: 'client-4',
  name: 'Maritime sensing mesh',
  type: 'technology',
  description: 'Buoy-hosted passive sonar mesh.',
  sector: 'Maritime',
  tags: ['undersea'],
  trl: 4,
  mrl: null,
  peNumber: null,
  peNumbers: ['0603713N'],
  keywords: [],
  appropriationAccount: null,
  serviceBranch: null,
  targetSubcommittee: null,
  fundingAsk: null,
  fundingAskLabel: null,
  justification: null,
  districtNexus: null,
  existingContracts: null,
  notes: null,
  sortOrder: 0,
  createdAt: '2026-02-02T00:00:00.000Z',
  updatedAt: '2026-02-02T00:00:00.000Z',
};

function renderDrawer(overrides: Partial<Parameters<typeof CapabilityDrawerVNext>[0]> = {}) {
  const onClose = vi.fn();
  const onUpdated = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <div className="capiro-vnext-root">
        <CapabilityDrawerVNext
          capability={capability}
          clientId="client-4"
          onClose={onClose}
          onUpdated={onUpdated}
          {...overrides}
        />
      </div>
    </QueryClientProvider>,
  );
  return { ...utils, onClose, onUpdated };
}

beforeEach(() => {
  getMock.mockReset();
  patchMock.mockReset();
  postMock.mockReset();
  patchMock.mockResolvedValue({ data: {} });
  getMock.mockResolvedValue({ data: [] });
});

describe('CapabilityDrawerVNext', () => {
  it('renders nothing for a null capability (canonical contract)', () => {
    const { container } = renderDrawer({ capability: null });
    expect(container.querySelector('.capiro-capd')).toBeNull();
  });

  it('renders the header identity and current TRL state', () => {
    renderDrawer();
    expect(screen.getByText('Maritime sensing mesh')).toBeInTheDocument();
    expect(screen.getByText('technology')).toBeInTheDocument();
    expect(screen.getByText('Maritime')).toBeInTheDocument();
    expect(screen.getByText(/TRL 4 · Lab validated/)).toBeInTheDocument();
  });

  it('PATCHes the TRL on ladder click and clears it when the active step is clicked', async () => {
    const { onUpdated } = renderDrawer();

    fireEvent.click(screen.getByRole('button', { name: /TRL 7: System prototype/ }));
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-4/capabilities/cap-9', { trl: 7 }),
    );
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());

    // Clicking the ACTIVE step clears (the drawer still shows trl=4 — props
    // did not change — so 4 is the active step).
    fireEvent.click(screen.getByRole('button', { name: /TRL 4: Lab validated/ }));
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-4/capabilities/cap-9', {
        trl: null,
      }),
    );
  });

  it('saves a PE-number token list once on blur, uppercased and de-duped', async () => {
    renderDrawer();
    const input = screen.getByLabelText('PE numbers');

    fireEvent.change(input, { target: { value: '0604402f' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // No PATCH per keystroke/commit — save happens on blur.
    expect(patchMock).not.toHaveBeenCalled();

    fireEvent.blur(input);
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-4/capabilities/cap-9', {
        peNumbers: ['0603713N', '0604402F'],
      }),
    );
    expect(patchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * D3 — the inline editor must hold its draft until the server ACKNOWLEDGES
   * the save. The old blur handler fired the PATCH and immediately cleared
   * `dirty`, re-arming the resync-from-props while `values` still held the
   * PRE-save list: the just-added chip vanished, the sections below (Notes)
   * jumped mid-click, and the click landed on the body. Probe-reproduced 3×.
   */
  it('D3: keeps the added chip until the PATCH acknowledges — no stale resync mid-click', async () => {
    // Hold the PATCH open so we can observe the window between fire and ack.
    let resolvePatch!: (v: { data: unknown }) => void;
    patchMock.mockImplementation(() => new Promise((resolve) => { resolvePatch = resolve; }));
    renderDrawer();

    const input = screen.getByLabelText('Match keywords');
    fireEvent.change(input, { target: { value: 'orchid autonomy' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // The chip is staged locally before any save.
    expect(screen.getByText('orchid autonomy')).toBeInTheDocument();

    // Blur (what clicking Notes produces) fires the save.
    fireEvent.blur(input);
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-4/capabilities/cap-9', {
        keywords: ['orchid autonomy'],
      }),
    );

    // CRITICAL: while the PATCH is still in flight — props unchanged (keywords
    // still [] in the fixture) — the chip must NOT be resynced away.
    expect(screen.getByText('orchid autonomy')).toBeInTheDocument();

    // Acknowledge: the save resolves, dirty clears, and the draft is now safe
    // to follow fresh props. The chip remains (no flicker-and-lose).
    resolvePatch({ data: {} });
    await waitFor(() => expect(screen.getByText('orchid autonomy')).toBeInTheDocument());
  });

  it('D3: a failed save keeps the draft and surfaces a retryable error — edits are not lost', async () => {
    patchMock.mockRejectedValue(new Error('Request failed with status code 503'));
    renderDrawer();

    const input = screen.getByLabelText('Match keywords');
    fireEvent.change(input, { target: { value: 'orchid autonomy' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);

    // The failure is visible and the chip is NOT silently dropped.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not save|503|Request failed/);
    expect(screen.getByText('orchid autonomy')).toBeInTheDocument();

    // Retry re-issues the same write once the server recovers.
    patchMock.mockResolvedValue({ data: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-4/capabilities/cap-9', {
        keywords: ['orchid autonomy'],
      }),
    );
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  /**
   * Pending-edit race (native Playwright regression): an older PATCH
   * acknowledgement must not overwrite a newer in-progress draft. Edit alpha,
   * blur (PATCH A held), immediately re-focus and commit beta while A is still
   * in flight, release A, then RERENDER with the acknowledged alpha props (the
   * refetch result) — the false-confidence gap in the prior test was never
   * re-rendering, so the resync never ran. Beta must survive, and the final
   * blur must persist the merged ['alpha','beta'].
   */
  it('D3-race: an older acknowledgement + refetch cannot clobber a newer in-progress draft', async () => {
    let resolveA!: (v: { data: unknown }) => void;
    let call = 0;
    patchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          call += 1;
          if (call === 1) resolveA = resolve; // hold PATCH A
          else resolve({ data: {} });
        }),
    );
    const onUpdated = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (cap: Capability) => (
      <QueryClientProvider client={queryClient}>
        <div className="capiro-vnext-root">
          <CapabilityDrawerVNext capability={cap} clientId="client-4" onClose={() => {}} onUpdated={onUpdated} />
        </div>
      </QueryClientProvider>
    );
    const { rerender } = render(view(capability));

    const input = screen.getByLabelText('Match keywords');
    // Commit alpha, blur -> PATCH A (held open).
    fireEvent.change(input, { target: { value: 'alpha' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenLastCalledWith(expect.anything(), { keywords: ['alpha'] });

    // While A is in flight, commit beta (still focused/dirty).
    fireEvent.change(input, { target: { value: 'beta' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();

    // Release PATCH A (200), then the parent refetch delivers the A state
    // (['alpha']) — rerender with those acknowledged props, exactly like the
    // live invalidate+refetch. The stale ack must NOT remove beta.
    resolveA({ data: {} });
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    rerender(view({ ...capability, keywords: ['alpha'] }));
    await waitFor(() => expect(screen.getByText('beta')).toBeInTheDocument());
    expect(screen.getByText('alpha')).toBeInTheDocument();

    // Final blur commits the merged draft as a second PATCH (newest intent wins).
    fireEvent.blur(input);
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
    expect(patchMock).toHaveBeenLastCalledWith(expect.anything(), {
      keywords: ['alpha', 'beta'],
    });
  });

  /**
   * Tag canonicalization (native probe regression): the API canonicalizes tags
   * on write (normalizeCapabilityTags — lowercase/trim/collapse/dedupe) and the
   * PATCH response carries the canonical row. The drawer must acknowledge the
   * CANONICAL list, not the raw sent one: entering ORCHID persists orchid, and
   * once the refetch delivers ['orchid'] the held ack must clear — a later
   * clean external update (['orchid','external-beta'] plus a real TRL change)
   * has to reach the open editor instead of staying blocked behind a stale
   * 'ORCHID' ack.
   */
  it('D3-canonical: acknowledges the server-canonical tag list, so later clean server updates still land', async () => {
    // Realistic sequential API replies — the first ORCHID PATCH can only
    // acknowledge what the server actually holds at that moment ('orchid');
    // the external addition does not exist until the later props arrive.
    patchMock.mockResolvedValueOnce({ data: { ...capability, tags: ['orchid'] } });
    const onUpdated = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (cap: Capability) => (
      <QueryClientProvider client={queryClient}>
        <div className="capiro-vnext-root">
          <CapabilityDrawerVNext capability={cap} clientId="client-4" onClose={() => {}} onUpdated={onUpdated} />
        </div>
      </QueryClientProvider>
    );
    const { rerender } = render(view({ ...capability, tags: [] }));

    const input = screen.getByLabelText('Tags');
    fireEvent.change(input, { target: { value: 'ORCHID' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // The chip shows what the user typed until the server state arrives.
    expect(screen.getByText('ORCHID')).toBeInTheDocument();
    fireEvent.blur(input);
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-4/capabilities/cap-9', {
        tags: ['ORCHID'],
      }),
    );
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));

    // The refetch delivers the canonical list — the draft adopts it.
    rerender(view({ ...capability, tags: ['orchid'] }));
    await waitFor(() => expect(screen.getByText('orchid')).toBeInTheDocument());
    expect(screen.queryByText('ORCHID')).not.toBeInTheDocument();
    expect(patchMock).toHaveBeenCalledTimes(1);

    // A later EXTERNAL update plus a real mutation refetch: with no unsaved
    // edits the clean server state must land (previously blocked forever by
    // the never-matching 'ORCHID' ack).
    rerender(view({ ...capability, tags: ['orchid', 'external-beta'], trl: 5 }));
    await waitFor(() => expect(screen.getByText('external-beta')).toBeInTheDocument());
    expect(screen.getByText('orchid')).toBeInTheDocument();
    expect(screen.getByText(/TRL 5/)).toBeInTheDocument();

    // A subsequent local edit keeps every server tag: the saved list is
    // built from the canonical draft, not a stale pre-external one.
    patchMock.mockResolvedValueOnce({ data: { ...capability, tags: ['orchid', 'external-beta', 'gamma'], trl: 5 } });
    fireEvent.change(input, { target: { value: 'gamma' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(patchMock).toHaveBeenLastCalledWith('/api/clients/client-4/capabilities/cap-9', {
        tags: ['orchid', 'external-beta', 'gamma'],
      }),
    );
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(2));
    expect(patchMock).toHaveBeenCalledTimes(2);
    // The canonical ack arrives and the saved chip stays — nothing is dropped.
    rerender(view({ ...capability, tags: ['orchid', 'external-beta', 'gamma'], trl: 5 }));
    await waitFor(() => expect(screen.getByText('gamma')).toBeInTheDocument());
    expect(screen.getByText('external-beta')).toBeInTheDocument();
    expect(screen.getByText('orchid')).toBeInTheDocument();
  });

  it('D3-order: overlapping saves apply in issue order — a newer save never resolves before an older one', async () => {
    // Two blurs in quick succession produce two PATCHes; the second must not be
    // issued until the first has resolved (serialization), so the server can
    // never apply the newer list then have the older ack overwrite it.
    const resolutions: Array<() => void> = [];
    patchMock.mockImplementation(() => new Promise<{ data: unknown }>((resolve) => resolutions.push(() => resolve({ data: {} }))));
    renderDrawer();

    const input = screen.getByLabelText('Match keywords');
    fireEvent.change(input, { target: { value: 'alpha' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input); // PATCH 1: ['alpha']
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));

    fireEvent.change(input, { target: { value: 'beta' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input); // wants to PATCH ['alpha','beta']
    // The second PATCH must NOT fire while the first is still unresolved.
    expect(patchMock).toHaveBeenCalledTimes(1);

    // Resolve the first; only then does the second go out.
    resolutions[0]!();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
    expect(patchMock).toHaveBeenLastCalledWith(expect.anything(), { keywords: ['alpha', 'beta'] });
  });

  it('D3-tags-order: a second Tags blur waits for the actual first PATCH acknowledgement', async () => {
    let acknowledgeFirst!: (response: { data: unknown }) => void;
    const firstPatch = new Promise<{ data: unknown }>((resolve) => { acknowledgeFirst = resolve; });
    patchMock.mockImplementationOnce(() => firstPatch);
    patchMock.mockResolvedValue({ data: {} });
    const { onUpdated } = renderDrawer();
    const input = screen.getByLabelText('Tags');

    try {
      fireEvent.change(input, { target: { value: 'alpha' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.blur(input);
      await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
      expect(patchMock).toHaveBeenLastCalledWith('/api/clients/client-4/capabilities/cap-9', {
        tags: ['undersea', 'alpha'],
      });

      // Flush the promise queue after the second blur. An immediate assertion
      // could pass vacuously before a void onSave callback dispatches PATCH 2.
      await act(async () => {
        fireEvent.change(input, { target: { value: 'beta' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        fireEvent.blur(input);
      });
      expect(screen.getByRole('button', { name: 'Remove beta' })).toBeInTheDocument();
      expect(patchMock).toHaveBeenCalledTimes(1);
      expect(onUpdated).not.toHaveBeenCalled();

      await act(async () => { acknowledgeFirst({ data: {} }); });
      await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
      expect(patchMock).toHaveBeenLastCalledWith('/api/clients/client-4/capabilities/cap-9', {
        tags: ['undersea', 'alpha', 'beta'],
      });
      await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(2));
      expect(screen.getByRole('button', { name: 'Remove beta' })).toBeInTheDocument();
    } finally {
      // Settle the held mutation even when the pre-ack assertion fails, so
      // the regression cannot leak pending work into the other drawer tests.
      await act(async () => { acknowledgeFirst({ data: {} }); });
    }
  });

  /**
   * Q05 — removing a PE chip leaves an inconsistent capability list.
   *
   * Repro: click an existing chip's × WITHOUT ever focusing the token input
   * (the ordinary way to remove one — you don't need to type anything).
   * Root cause: removal only updated local `draft` state and relied on the
   * input's blur handler to PATCH — but a plain chip click never focuses
   * that input, so no blur ever fires, so the removal was silently dropped
   * on the floor (confirmed live by reopening the capability afterward,
   * where the stale PE number was still there). Fixed: removal PATCHes
   * immediately, with no dependency on a later blur that may never come.
   */
  it('Q05: removing a PE chip persists immediately, even with no input focus/blur', async () => {
    renderDrawer();

    // The starting chip from the fixture — remove it via its × ONLY, exactly
    // the QA repro (no typing, no focusing the token input at all).
    expect(screen.getByText('0603713N')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove 0603713N' }));

    // Must not depend on a later blur: the PATCH lands right away, and the
    // chip is gone from the DOM immediately (the draft updates on removal).
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-4/capabilities/cap-9', {
        peNumbers: [],
      }),
    );
    expect(screen.queryByText('0603713N')).not.toBeInTheDocument();
    // No stray blur-triggered second PATCH for this field.
    expect(patchMock).toHaveBeenCalledTimes(1);

    // After the ack, the held draft stays empty — the removal is not undone by
    // a stale resync (the fixture's peNumbers prop is unchanged, still
    // ['0603713N'], so a pre-ack-style resync would resurrect the chip).
    await waitFor(() => expect(screen.queryByText('0603713N')).not.toBeInTheDocument());
    expect(patchMock).toHaveBeenCalledTimes(1);
  });

  it('saves Description on blur through click-to-edit', async () => {
    renderDrawer();
    fireEvent.click(screen.getByText('Buoy-hosted passive sonar mesh.'));
    const area = screen.getByPlaceholderText('Describe this capability...');
    fireEvent.change(area, { target: { value: 'Distributed acoustic array, surface-recoverable.' } });
    fireEvent.blur(area);
    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/clients/client-4/capabilities/cap-9', {
        description: 'Distributed acoustic array, surface-recoverable.',
      }),
    );
  });

  it('lists only this capability documents on the Documents tab and shows the real empty state', async () => {
    getMock.mockResolvedValue({
      data: [
        {
          id: 'att-1',
          clientId: 'client-4',
          meetingId: null,
          mailMessageId: null,
          fileName: 'mesh-white-paper.pdf',
          contentType: 'application/pdf',
          byteSize: 1024,
          source: 'capability:cap-9',
          createdAt: '2026-02-03T00:00:00.000Z',
          downloadUrl: 'https://files.example/mesh-white-paper.pdf',
          indexedAt: null,
          uploadedByUserId: null,
          uploadedByName: null,
        },
        {
          id: 'att-2',
          clientId: 'client-4',
          meetingId: null,
          mailMessageId: null,
          fileName: 'unrelated-meeting-notes.pdf',
          contentType: 'application/pdf',
          byteSize: 2048,
          source: 'meeting',
          createdAt: '2026-02-03T00:00:00.000Z',
          downloadUrl: null,
          indexedAt: null,
          uploadedByUserId: null,
          uploadedByName: null,
        },
      ],
    });
    renderDrawer();

    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    expect(await screen.findByText('mesh-white-paper.pdf')).toBeInTheDocument();
    // Attachments from other sources on the same client must not leak in.
    expect(screen.queryByText('unrelated-meeting-notes.pdf')).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Download mesh-white-paper.pdf' }),
    ).toHaveAttribute('href', 'https://files.example/mesh-white-paper.pdf');
    expect(getMock).toHaveBeenCalledWith('/api/engagement/attachments', {
      params: { clientId: 'client-4' },
    });
  });

  it('uploads a file the browser reported no type for under its inferred content type (Q03)', async () => {
    // Regression for Q03: an empty file.type — real on some OS pickers for
    // .txt/.csv/.docx — must not fall back to 'application/octet-stream',
    // the one content type the server's allowlist rejects with a 400. That
    // 400 previously surfaced with no visible error (see attachment-content-type.ts).
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    postMock.mockImplementation((url: string) => {
      if (url === '/api/engagement/attachments/upload-url') {
        return Promise.resolve({
          data: {
            url: 'https://s3.example.com/upload',
            fields: { key: 'tenants/x' },
            s3Key: 'tenants/x/qa-client-profile-disposable.txt',
          },
        });
      }
      if (url === '/api/engagement/attachments/confirm') {
        return Promise.resolve({ data: { id: 'att-3', fileName: 'qa-client-profile-disposable.txt' } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    renderDrawer();

    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    const fileInput = screen.getByLabelText('Upload document') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: {
        files: [
          new File(['synthetic qa content'], 'qa-client-profile-disposable.txt', { type: '' }),
        ],
      },
    });

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/api/engagement/attachments/upload-url',
        expect.objectContaining({ contentType: 'text/plain' }),
      ),
    );
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/api/engagement/attachments/confirm',
        expect.objectContaining({ contentType: 'text/plain', source: 'capability:cap-9' }),
      ),
    );

    vi.unstubAllGlobals();
  });

  it('shows the delete control only when a handler is provided, and wires it', () => {
    const onDelete = vi.fn();
    const { unmount } = renderDrawer({ onDelete });
    fireEvent.click(screen.getByRole('button', { name: 'Delete capability' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    unmount();

    renderDrawer();
    expect(screen.queryByRole('button', { name: 'Delete capability' })).not.toBeInTheDocument();
  });

  it('D5: a failed documents read is not shown as the empty state', async () => {
    // A 503 from the attachments read used to fall through to
    // "No documents yet for this capability." — indistinguishable from a
    // capability with genuinely nothing uploaded.
    getMock.mockRejectedValue(Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } }));
    renderDrawer();

    fireEvent.click(screen.getByRole('tab', { name: 'Documents' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Documents could not be loaded.');
    expect(screen.queryByText('No documents yet for this capability.')).not.toBeInTheDocument();

    // Retry recovers once the read succeeds.
    getMock.mockResolvedValue({ data: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No documents yet for this capability.')).toBeInTheDocument();
  });

  it('closes from the header control', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
