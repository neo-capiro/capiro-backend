import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { HearingWatchPanel } from './HearingWatchPage.js';

/**
 * P8 web wiring: the New-Hearing modal's "Resolve stream" button + conditional
 * consent field. The intel feature flag + api client are mocked.
 */
const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const navigateMock = vi.fn();

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureEnabled: () => true,
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
  Object.defineProperty(window, 'getComputedStyle', {
    value: () => ({ getPropertyValue: () => '' }),
  });
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter>
          <HearingWatchPanel />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

async function openNewHearingModal() {
  const btn = await screen.findByRole('button', { name: /Add hearing manually/i });
  fireEvent.click(btn);
  await screen.findByText('Start a hearing session');
}

describe('HearingWatchPage — New Hearing modal (P8)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    navigateMock.mockReset();
    setupBrowserMocks();
    apiGetMock.mockResolvedValue({ data: [] });
  });

  test('Resolve stream prefills the source URL and shows provenance', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/hearings/resolve-stream') {
        return {
          data: {
            status: 'resolved',
            media: {
              url: 'https://www-senate-gov-media-srs.akamaized.net/hls/live/2036788/judiciary/x/master.m3u8',
              kind: 'hls',
              provider: 'senate-isvp',
            },
            note: 'via Senate ISVP (judiciary)',
          },
        };
      }
      return { data: {} };
    });

    renderPanel();
    await openNewHearingModal();

    const urlInput = screen.getByPlaceholderText(/Resolve/i);
    fireEvent.change(urlInput, {
      target: { value: 'https://www.senate.gov/isvp/?comm=judiciary&filename=x' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Resolve stream/i }));

    await waitFor(() => expect(screen.getByText(/via Senate ISVP/i)).toBeInTheDocument());
    await waitFor(() => expect((urlInput as HTMLInputElement).value).toContain('master.m3u8'));
  }, 15000);

  test('My Sessions pages past the former 100-row cap with a stable cursor', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/intel-api/hearings/history')) {
        const second = url.includes('cursor=cursor-50');
        return {
          data: second
            ? {
                items: [
                  { id: 's2', title: 'Older session', status: 'ended', sourceType: 'hearing' },
                ],
                total: 51,
                nextCursor: null,
                hasMore: false,
              }
            : {
                items: [
                  { id: 's1', title: 'Newest session', status: 'ended', sourceType: 'markup' },
                ],
                total: 51,
                nextCursor: 'cursor-50',
                hasMore: true,
              },
        };
      }
      if (url === '/intel-api/upcoming-hearings') return { data: [] };
      if (url.startsWith('/intel-api/upcoming-hearings/browse')) {
        return { data: { items: [], total: 0 } };
      }
      return { data: [] };
    });

    renderPanel();
    fireEvent.click(await screen.findByText('My Sessions'));

    expect(await screen.findByText('Newest session')).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 51 sessions/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Load more sessions/i }));

    expect(await screen.findByText('Older session')).toBeInTheDocument();
    expect(screen.getByText(/Showing 2 of 51 sessions/i)).toBeInTheDocument();
    expect(
      apiGetMock.mock.calls.some((args: unknown[]) =>
        String(args[0]).includes('/intel-api/hearings/history?limit=50&cursor=cursor-50'),
      ),
    ).toBe(true);
  }, 15000);

  test('consent field appears only for a private source type', async () => {
    renderPanel();
    await openNewHearingModal();

    // Default source type is "hearing" (public) → no consent field.
    expect(screen.queryByText("Confirm you're authorized to capture this session.")).toBeNull();

    // Switch source type to "Meeting" (private) via the antd Select.
    const selects = document.querySelectorAll('.ant-select-selector');
    // The first Select in the form is "Source type".
    fireEvent.mouseDown(selects[0]!);
    const option = await screen.findByText('Meeting', {
      selector: '.ant-select-item-option-content',
    });
    fireEvent.click(option);

    await waitFor(() =>
      expect(
        screen.getByPlaceholderText("Confirm you're authorized to capture this session."),
      ).toBeInTheDocument(),
    );
  }, 15000);

  test('unresolvable outcome shows the note + reference link (no silent no-op)', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/hearings/resolve-stream') {
        return {
          data: {
            status: 'unresolvable',
            reference: 'https://www.c-span.org/search/?searchtype=Videos&query=armed+services',
            note: 'No direct stream resolved — search C-SPAN or paste the stream URL',
          },
        };
      }
      return { data: {} };
    });

    renderPanel();
    await openNewHearingModal();

    const urlInput = screen.getByPlaceholderText(/Resolve/i);
    fireEvent.change(urlInput, { target: { value: 'https://www.congress.gov/event/x' } });
    fireEvent.click(screen.getByRole('button', { name: /Resolve stream/i }));

    // The note renders in the assisted-paste fallback…
    await waitFor(() => expect(screen.getByText(/No direct stream resolved/i)).toBeInTheDocument());
    // …and the reference link is offered (C-SPAN ↗).
    expect(screen.getByRole('link', { name: /C-SPAN/i })).toBeInTheDocument();
  }, 15000);

  test('unresolvable outcome persists the reference URL as sourceUrl on Create', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/hearings/resolve-stream') {
        return {
          data: {
            status: 'unresolvable',
            reference: 'https://www.c-span.org/search/?searchtype=Videos&query=armed+services',
            note: 'No direct stream resolved — search C-SPAN or paste the stream URL',
          },
        };
      }
      if (url === '/intel-api/hearings') {
        return {
          data: { id: 's1', title: 'Test hearing', status: 'created', sourceType: 'hearing' },
        };
      }
      return { data: {} };
    });

    renderPanel();
    await openNewHearingModal();

    const urlInput = screen.getByPlaceholderText(/Resolve/i);
    fireEvent.change(urlInput, { target: { value: 'https://www.congress.gov/event/x' } });
    fireEvent.click(screen.getByRole('button', { name: /Resolve stream/i }));
    await waitFor(() => expect(screen.getByText(/No direct stream resolved/i)).toBeInTheDocument());

    // The user gives up on finding a direct stream and clears the paste —
    // exercising the case that actually needs the fallback: no media URL was
    // ever resolved AND the visible field is empty at submit time (this is
    // also what happens on the real "Watch" path, which auto-resolves a
    // preset URL without ever writing a non-media URL into this field).
    fireEvent.change(urlInput, { target: { value: '' } });

    // Title is required and isn't preset on the manual "Add hearing" path.
    const titleInput = screen.getByPlaceholderText(/Senate Energy Committee/i);
    fireEvent.change(titleInput, { target: { value: 'Test hearing' } });

    fireEvent.click(screen.getByRole('button', { name: /Create and open/i }));

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        '/intel-api/hearings',
        expect.objectContaining({
          sourceUrl: 'https://www.c-span.org/search/?searchtype=Videos&query=armed+services',
          // The only implemented capture path, sent unconditionally now that the
          // dishonest stream_url/upload/bridge choices are gone from the form.
          audioSource: 'browser_mic',
          // `audio_and_transcript` is no longer offerable — there is no audio sink.
          recordingPolicy: 'transcript_only',
        }),
      ),
    );

    // Creating a session opens the room instead of stranding the analyst on the
    // schedule to hunt for the row they just made in My Sessions.
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/intelligence/hearing-watch/s1'),
    );
  }, 15000);

  test('the form never offers an audio-retention or non-browser capture option', async () => {
    renderPanel();
    await openNewHearingModal();

    // No "Audio source" field at all — every value it used to offer except tab
    // capture was unimplemented, so a chosen session could never transcribe.
    expect(screen.queryByText('Audio source')).toBeNull();
    expect(screen.getByText('Transcript retention')).toBeInTheDocument();

    // The retention Select is the second one in the form (after Source type).
    const selects = document.querySelectorAll('.ant-select-selector');
    fireEvent.mouseDown(selects[1]!);
    await waitFor(() =>
      expect(
        screen.getByText(/Save transcript \(audio is never stored\)/i, {
          selector: '.ant-select-item-option-content',
        }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/Store transcript \+ audio/i, {
        selector: '.ant-select-item-option-content',
      }),
    ).toBeNull();
  }, 15000);

  test('setting up a scheduled markup keeps its source type and hearing id', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/upcoming-hearings') {
        return {
          data: [
            {
              id: 'ch-77',
              title: 'Markup of H.R. 1234',
              committee: 'House Energy and Commerce',
              chamber: 'house',
              scheduledAt: '2026-08-04',
              type: 'Markup',
              url: 'https://docs.house.gov/meetings/x',
            },
          ],
        };
      }
      return { data: [] };
    });
    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/hearings/resolve-stream') {
        return { data: { status: 'unresolvable', note: 'No direct media found' } };
      }
      if (url === '/intel-api/hearings') {
        return { data: { id: 's-markup', title: 'Markup', status: 'scheduled' } };
      }
      return { data: {} };
    });

    renderPanel();
    const setup = await screen.findByRole('button', { name: /Set up transcription/i });
    fireEvent.click(setup);
    await screen.findByText('Start a hearing session');

    fireEvent.click(screen.getByRole('button', { name: /Create and open/i }));

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        '/intel-api/hearings',
        expect.objectContaining({
          // A markup used to be filed as a plain `hearing`, losing the
          // distinction the recap and bill-linking passes read back.
          sourceType: 'markup',
          // The schedule row id used to be dropped when the modal closed.
          hearingId: 'ch-77',
          sourceUrl: 'https://docs.house.gov/meetings/x',
        }),
      ),
    );
  }, 15000);

  test('empty-candidates is treated as unresolvable and still gives feedback', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/hearings/resolve-stream') {
        return {
          data: {
            status: 'candidates',
            candidates: [],
            reference: 'https://www.c-span.org/search/?searchtype=Videos&query=x',
            note: 'No direct stream resolved — search C-SPAN or paste the stream URL',
          },
        };
      }
      return { data: {} };
    });

    renderPanel();
    await openNewHearingModal();

    const urlInput = screen.getByPlaceholderText(/Resolve/i);
    fireEvent.change(urlInput, { target: { value: 'https://www.congress.gov/event/y' } });
    fireEvent.click(screen.getByRole('button', { name: /Resolve stream/i }));

    // No "Pick the matching video" (empty list) — instead the fallback note.
    await waitFor(() => expect(screen.getByText(/No direct stream resolved/i)).toBeInTheDocument());
    expect(screen.queryByText('Pick the matching video')).toBeNull();
  }, 15000);

  test('IP-bound resolved source is NOT autofilled into the URL field', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/hearings/resolve-stream') {
        return {
          data: {
            status: 'resolved',
            media: {
              url: 'https://rr5---sn-abc.googlevideo.com/hls/live/expiring.m3u8',
              kind: 'hls',
              provider: 'youtube-live',
              ipBound: true,
              expiresAt: '2030-01-01T00:00:00.000Z',
            },
            note: 'via YouTube live (IP-bound, short-lived — re-resolve at ingest)',
          },
        };
      }
      return { data: {} };
    });

    renderPanel();
    await openNewHearingModal();

    const urlInput = screen.getByPlaceholderText(/Resolve/i) as HTMLInputElement;
    fireEvent.change(urlInput, {
      target: { value: 'https://www.youtube.com/watch?v=abcdefghijk' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Resolve stream/i }));

    // The UI explains the real browser-capture fallback; it must not claim
    // a connect-time re-resolver that does not exist.
    await waitFor(() => expect(screen.getByText(/Source found — not saved/i)).toBeInTheDocument());
    expect(screen.getByText(/open it and share that tab’s audio/i)).toBeInTheDocument();
    expect(screen.queryByText(/resolves at connect time/i)).not.toBeInTheDocument();
    // The expiring googlevideo URL is NOT written into the field.
    expect(urlInput.value).not.toContain('googlevideo.com');
    expect(urlInput.value).not.toContain('expiring.m3u8');
  }, 15000);

  test('candidates outcome renders a pick-list', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/hearings/resolve-stream') {
        return {
          data: {
            status: 'candidates',
            candidates: [
              {
                title: 'Armed Services Hearing',
                pageUrl: 'https://www.c-span.org/program/x/y/1',
                programId: '1',
              },
            ],
          },
        };
      }
      return { data: {} };
    });

    renderPanel();
    await openNewHearingModal();

    const urlInput = screen.getByPlaceholderText(/Resolve/i);
    fireEvent.change(urlInput, { target: { value: 'https://www.c-span.org/search/?query=x' } });
    fireEvent.click(screen.getByRole('button', { name: /Resolve stream/i }));

    await waitFor(() => expect(screen.getByText('Pick the matching video')).toBeInTheDocument());
    expect(screen.getByText('Armed Services Hearing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Use/i })).toBeInTheDocument();
  }, 15000);
});
