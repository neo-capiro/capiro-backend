/**
 * LegiWatch Archive search — superseded-response behavior (LW-QA-014).
 *
 * Separate from wave1-workflows.integration.test.tsx on purpose. That suite's
 * `useApi` stub takes only a URL and resolves on the next microtask, so it can
 * neither observe an AbortSignal nor let two responses land out of order — an
 * abort assertion written against it would pass vacuously.
 *
 * The stub here NEVER settles on its own. Every response is released by name,
 * which is what makes the out-of-order race identical on every run. It also
 * keeps delivering a superseded payload after that request was aborted: a
 * transport that ignores cancellation is the worst case, and the surface has to
 * be right even then.
 */
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface PendingRequest {
  url: string;
  signal: AbortSignal | undefined;
  aborted: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const pending: PendingRequest[] = [];

vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: (url: string, config?: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const entry: PendingRequest = {
          url,
          signal: config?.signal,
          aborted: config?.signal?.aborted ?? false,
          resolve: (value) => resolve({ data: value }),
          reject,
        };
        config?.signal?.addEventListener('abort', () => {
          entry.aborted = true;
        });
        pending.push(entry);
      }),
    put: async () => ({ data: {} }),
    post: async () => ({ data: {} }),
    delete: async () => ({ data: {} }),
  }),
}));

import { ArchiveSubTab } from './ArchiveSubTab.js';

const DEBOUNCE_MS = 300;

function paramsOf(url: string): URLSearchParams {
  return new URLSearchParams(url.split('?')[1] ?? '');
}

/** Exact `q` match — `army` must never be confused with `army robotics`. */
function requestsFor(q: string, page = 1): PendingRequest[] {
  return pending.filter((r) => {
    const p = paramsOf(r.url);
    return (p.get('q') ?? '') === q && Number(p.get('page') ?? '1') === page;
  });
}

function latest(q: string, page = 1): PendingRequest {
  const matches = requestsFor(q, page);
  const found = matches[matches.length - 1];
  if (!found) throw new Error(`no request in flight for q=${JSON.stringify(q)} page=${page}`);
  return found;
}

function archiveRow(id: string, title: string) {
  return {
    id,
    title,
    chamber: 'House',
    committeeName: 'House Armed Services',
    committeeSystemCode: 'hsas00',
    calendarDate: '2026-09-02',
    scheduledStart: null,
    time: null,
    timeZone: null,
    location: null,
    officialPageUrl: null,
    eventStatus: 'completed',
    eventType: 'hearing',
    witnesses: [],
    captureStatus: 'COMPLETE',
    transcript: { available: true, segmentCount: 1, officialTranscriptId: null, gapSeconds: 0 },
    intelligenceCount: 0,
    transcriptHit: null,
    intelligenceHit: null,
    detailPath: `/legiwatch/hearings/${id}`,
  };
}

function archivePage(overrides: Record<string, unknown> = {}) {
  return {
    rows: [],
    total: 0,
    corpusTotal: 12,
    page: 1,
    pageSize: 20,
    hasMore: false,
    query: null,
    facets: { chamber: [], committee: [], eventStatus: [] },
    ...overrides,
  };
}

function renderArchive() {
  // Deliberately NOT `retry: false` at the client level: the hook's own
  // `retry: false` is what has to hold, so leave the default 3 retries in place
  // and let the request count prove it.
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/legiwatch']}>
        <Routes>
          <Route path="*" element={<ArchiveSubTab clientId="" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Run pending timers, then let react-query's notify queue drain. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText('Search the hearing archive'), { target: { value } });
}

/** Type, then cross the debounce so the query is actually committed. */
async function search(value: string) {
  type(value);
  await settle(DEBOUNCE_MS);
}

beforeEach(() => {
  pending.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  pending.length = 0;
});

describe('LW-QA-014 · archive search request identity', () => {
  it('renders the newest query even when superseded responses land last', async () => {
    renderArchive();
    await settle();

    // Seed the unfiltered corpus so there is something real to go stale.
    latest('').resolve(
      archivePage({
        rows: [archiveRow('h-corpus', 'Unfiltered corpus hearing')],
        total: 40,
        hasMore: true,
      }),
    );
    await settle();
    expect(screen.getByText('Unfiltered corpus hearing')).toBeTruthy();

    await search('army');
    await search('army robotics');
    await search('army robotics funding');

    expect(requestsFor('army')).toHaveLength(1);
    expect(requestsFor('army robotics')).toHaveLength(1);
    expect(requestsFor('army robotics funding')).toHaveLength(1);

    // Nothing has answered the typed query yet, so nothing may be shown as if
    // it had — least of all the unfiltered corpus and its 40-result count.
    expect(screen.queryByText('Unfiltered corpus hearing')).toBeNull();
    expect(screen.queryByText(/40 archived proceedings/)).toBeNull();
    expect(screen.getByText('Searching…')).toBeTruthy();

    // Newest first.
    latest('army robotics funding').resolve(
      archivePage({
        rows: [archiveRow('h-arf', 'Army robotics funding posture')],
        total: 1,
        query: 'army robotics funding',
      }),
    );
    await settle();
    expect(screen.getByText('Army robotics funding posture')).toBeTruthy();

    // Now the superseded ones, out of order, oldest LAST.
    latest('army robotics').resolve(
      archivePage({ rows: [archiveRow('h-ar', 'Army robotics oversight')], total: 7 }),
    );
    await settle();
    latest('army').resolve(
      archivePage({ rows: [archiveRow('h-a', 'Army posture hearing')], total: 31 }),
    );
    await settle();

    expect(screen.getByText('Army robotics funding posture')).toBeTruthy();
    expect(screen.queryByText('Army robotics oversight')).toBeNull();
    expect(screen.queryByText('Army posture hearing')).toBeNull();
    expect(screen.queryByText('Unfiltered corpus hearing')).toBeNull();
    // The count and pagination describe the same query as the rows.
    expect(screen.getByText(/^1 archived proceeding$/)).toBeTruthy();
    expect(screen.getByText('Page 1 of 1')).toBeTruthy();
  });

  it('aborts every superseded request and leaves the newest one running', async () => {
    renderArchive();
    await settle();

    await search('army');
    expect(latest('').aborted).toBe(true);

    await search('army robotics');
    expect(latest('army').aborted).toBe(true);

    await search('army robotics funding');
    expect(latest('army robotics').aborted).toBe(true);
    expect(latest('army robotics funding').aborted).toBe(false);
    expect(latest('army robotics funding').signal).toBeInstanceOf(AbortSignal);
  });

  it('never retries a superseded request', async () => {
    renderArchive();
    await settle();

    await search('army');
    await search('army robotics');

    // A superseded request that fails outright: still exactly one attempt, and
    // no user-facing error, because the user already moved on from it.
    latest('army').reject({ response: { status: 500, data: { message: 'boom' } } });
    await settle();
    await settle(30_000);

    expect(requestsFor('army')).toHaveLength(1);
    expect(screen.queryByText(/Archive search is unavailable/)).toBeNull();

    latest('army robotics').resolve(
      archivePage({ rows: [archiveRow('h-ar', 'Army robotics oversight')], total: 1 }),
    );
    await settle();
    expect(screen.getByText('Army robotics oversight')).toBeTruthy();
    expect(screen.queryByText(/Archive search is unavailable/)).toBeNull();
  });

  it('shows an explicit searching state instead of the previous corpus while typing', async () => {
    renderArchive();
    await settle();
    latest('').resolve(
      archivePage({ rows: [archiveRow('h-corpus', 'Unfiltered corpus hearing')], total: 40 }),
    );
    await settle();
    expect(screen.getByText('Unfiltered corpus hearing')).toBeTruthy();

    // Inside the debounce window the committed query is still behind the input.
    type('army');
    await settle(DEBOUNCE_MS - 1);
    expect(screen.getByText('Searching…')).toBeTruthy();
    expect(screen.queryByText('Unfiltered corpus hearing')).toBeNull();
    expect(requestsFor('army')).toHaveLength(0);

    // And after it commits, while the request is in flight.
    await settle(1);
    expect(requestsFor('army')).toHaveLength(1);
    expect(screen.getByText('Searching…')).toBeTruthy();
    expect(screen.queryByText('Unfiltered corpus hearing')).toBeNull();
  });

  it('clears back to the corpus without leaving stale rows behind', async () => {
    renderArchive();
    await settle();

    await search('army');
    latest('army').resolve(archivePage({ rows: [], total: 0, corpusTotal: 12 }));
    await settle();
    expect(screen.getByText(/No results match/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await settle();
    expect(screen.getByText('Searching…')).toBeTruthy();
    expect(screen.queryByText(/No results match/)).toBeNull();

    latest('').resolve(
      archivePage({ rows: [archiveRow('h-corpus', 'Unfiltered corpus hearing')], total: 40 }),
    );
    await settle();
    expect(screen.getByText('Unfiltered corpus hearing')).toBeTruthy();
  });

  it('does not leave an intermediate query on screen through a delete and retype', async () => {
    renderArchive();
    await settle();

    await search('army robotics');
    latest('army robotics').resolve(
      archivePage({ rows: [archiveRow('h-ar', 'Army robotics oversight')], total: 7 }),
    );
    await settle();
    expect(screen.getByText('Army robotics oversight')).toBeTruthy();

    await search('army');
    expect(screen.queryByText('Army robotics oversight')).toBeNull();
    expect(screen.getByText('Searching…')).toBeTruthy();
    latest('army').resolve(
      archivePage({ rows: [archiveRow('h-a', 'Army posture hearing')], total: 31 }),
    );
    await settle();
    expect(screen.getByText('Army posture hearing')).toBeTruthy();

    await search('army robotics');
    expect(screen.queryByText('Army posture hearing')).toBeNull();
    expect(screen.getByText('Searching…')).toBeTruthy();
  });

  it('keeps the previous page on screen while paging within the same search', async () => {
    renderArchive();
    await settle();

    await search('army');
    latest('army').resolve(
      archivePage({
        rows: [archiveRow('h-a1', 'Army posture hearing')],
        total: 40,
        hasMore: true,
      }),
    );
    await settle();

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await settle();

    // Deliberate: same search, next page — the rows stay put rather than blank.
    expect(screen.getByText('Army posture hearing')).toBeTruthy();
    expect(screen.getByText(/updating…/)).toBeTruthy();
    expect(screen.queryByText('Searching…')).toBeNull();
    // `hasMore` still describes page 1, so Next is not clickable again yet.
    expect(screen.getByRole('button', { name: /Next/ }).hasAttribute('disabled')).toBe(true);

    latest('army', 2).resolve(
      archivePage({
        rows: [archiveRow('h-a2', 'Army readiness hearing')],
        total: 40,
        page: 2,
        hasMore: false,
      }),
    );
    await settle();
    expect(screen.getByText('Army readiness hearing')).toBeTruthy();
    expect(screen.queryByText('Army posture hearing')).toBeNull();
  });

  it('aborts an in-flight search on unmount without surfacing an error', async () => {
    const view = renderArchive();
    await settle();
    await search('army');

    const inFlight = latest('army');
    expect(inFlight.aborted).toBe(false);

    await act(async () => {
      view.unmount();
    });
    expect(inFlight.aborted).toBe(true);

    // A late failure from the abandoned request must not blow anything up.
    inFlight.reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }));
    await settle();
    expect(screen.queryByText(/Archive search is unavailable/)).toBeNull();
  });

  it('does not re-query while idle', async () => {
    renderArchive();
    await settle();
    await search('army');
    latest('army').resolve(
      archivePage({ rows: [archiveRow('h-a', 'Army posture hearing')], total: 1 }),
    );
    await settle();

    const settledCount = pending.length;
    await settle(60_000);
    expect(pending.length).toBe(settledCount);
    expect(screen.getByText('Army posture hearing')).toBeTruthy();
  });
});
